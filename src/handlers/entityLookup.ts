import { z } from 'zod';
import type { Tx } from '../db.ts';
import { UUID_RE, type Handler } from '../types.ts';
import { entityViaSkiptrace } from './skiptrace.ts';

const Input = z.object({ entity_id: z.string().regex(UUID_RE) });

// Where LLC members come from. The Kansas SOS search sits behind an AWS WAF
// CAPTCHA ("Human Verification"), so it can't be automated without getting
// around the CAPTCHA, which we don't do. Until a source is chosen (see README),
// no source is configured and jobs park as blocked.
export type EntityMember = { name: string; title: string | null };
export type EntityRecord = {
  sosId: string | null;
  status: string | null;
  filingUrl: string | null;
  members: EntityMember[];
  sourceUrl: string;
};
export interface EntitySource {
  readonly name: string;
  lookup(entityName: string): Promise<EntityRecord | null>;
}

export function makeEntityLookup(source: EntitySource | null): Handler {
  return async (ctx) => {
    const { db, job, config } = ctx;
    const parsed = Input.safeParse(job.input);
    if (!parsed.success) return { status: 'failed', error: 'input needs entity_id (uuid)' };
    const { rows } = await db.query(
      `select id, name, last_checked_at, last_checked_at > now() - make_interval(days => $2) as fresh
         from public.entities where id = $1`,
      [parsed.data.entity_id, config.entityCacheDays],
    );
    const entity = rows[0];
    if (!entity) return { status: 'failed', error: 'entity not found' };
    // Skip trace has its own never-twice check per owner; the 90-day cache is for SOS lookups.
    if (!source && ctx.tracerfy) return entityViaSkiptrace(ctx, entity.id);
    if (entity.fresh) {
      return { status: 'done', result: { skipped: 'checked within 90 days', last_checked_at: entity.last_checked_at } };
    }
    if (!source) {
      return {
        status: 'blocked',
        error:
          'LLC lookups are paused: the Kansas SOS search now requires a human CAPTCHA, ' +
          'so it cannot be automated. Waiting on a decision about another source.',
        result: { reason: 'sos_captcha', entity: entity.name },
      };
    }

    const rec = await source.lookup(entity.name);
    return {
      status: 'done',
      lockKey: `entity:${entity.id}`,
      result: { source: source.name, found: !!rec },
      write: async (tx: Tx) => {
        let added = 0;
        for (const m of rec?.members ?? []) {
          const r = await tx.query(
            `insert into public.entity_members (entity_id, member_name, title, source_url)
             values ($1, $2, $3, $4) on conflict (entity_id, member_name) do nothing`,
            [entity.id, m.name, m.title, rec!.sourceUrl],
          );
          added += r.rowCount ?? 0;
        }
        // Stamp the check even when nothing was found, so it isn't repeated for 90 days.
        await tx.query(
          `update public.entities
              set sos_id = coalesce($2, sos_id), sos_status = coalesce($3, sos_status),
                  filing_url = coalesce($4, filing_url), last_checked_at = now()
            where id = $1`,
          [entity.id, rec?.sosId ?? null, rec?.status ?? null, rec?.filingUrl ?? null],
        );
        return { members_added: added };
      },
    };
  };
}
