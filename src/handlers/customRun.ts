import { z } from 'zod';
import { DOORS_SQL, LIST_DONE_SQL, PROBATE_SQL } from '../listSignals.ts';
import { firstNameFromRaw, parseOwnerName } from '../names.ts';
import type { TraceType } from '../tracerfy.ts';
import { UUID_RE, type Handler } from '../types.ts';
import { budgetLeft, estimateCents, isTestMode, TRACED_SQL } from './skiptrace.ts';

// run.custom (Manager): Francis picks exactly what to run from the CRM's Control
// page: which list, which ranks (e.g. the top 1,000), which kinds of owners, whether
// to include owners he's mailing, and what to find (phones and emails, Facebook).
// It runs now, outside the daily amounts, because he chose it and saw the cost first.
//
// Guard rails that still apply:
//   - never looks up an owner twice (same check as the daily planner)
//   - phone and email lookups stop at his monthly budget (and at max_spend_cents
//     if he set one for this run); the rest are reported as "over budget", not sent
//   - companies with 20+ properties are skipped
//   - Facebook only for people (not companies or estates), never logged in
//   - every paid batch checks the budget again right before it's sent
//
// Every job it creates carries run_id (this job's id), so the CRM can show progress.

const OwnerType = z.enum(['person', 'company', 'estate']);
const Find = z.enum(['contact', 'facebook']);
export const RunInput = z.object({
  list_import_id: z.string().regex(UUID_RE),
  rank_from: z.number().int().min(1).default(1),
  rank_to: z.number().int().min(1).max(500_000),
  owner_types: z.array(OwnerType).min(1),
  include_mailed: z.boolean().default(false),
  find: z.array(Find).min(1),
  max_spend_cents: z.number().int().min(0).optional(),
  // Practice: phone and email lookups go to Tracerfy's free test server ($0, nothing
  // saved, nobody marked as looked up); Facebook is only counted, not searched.
  practice: z.boolean().default(false),
});

const BATCH = 500; // Tracerfy rows per upload (skiptrace.submit's limit)

type Owner = {
  id: string;
  owner_key: string;
  owner_name: string | null;
  raw: Record<string, unknown> | null;
  vendor_rank: number;
  owner_type: z.infer<typeof OwnerType>;
  doors: number;
  mailed: boolean;
  traced: boolean;
  fb_done: boolean;
};

export const customRun: Handler = async ({ db, job, config, tracerfy: liveTracerfy, tracerfyPractice, search }) => {
  const parsed = RunInput.safeParse(job.input);
  if (!parsed.success) {
    return { status: 'failed', error: `run settings not understood: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}` };
  }
  const run = parsed.data;
  if (run.rank_to < run.rank_from) return { status: 'failed', error: 'rank_to is below rank_from' };
  const tracerfy = run.practice ? tracerfyPractice : liveTracerfy;
  const free = run.practice || isTestMode(config);

  const { rows: owners } = await db.query<Owner>(
    `with best as (
       select distinct on (r.owner_key) r.id, r.business_id, r.owner_key, r.owner_name, r.raw, r.bucket,
              r.vendor_rank, r.person_id, r.mail_selected,
              ${PROBATE_SQL('r')} as probate, ${DOORS_SQL('r')} as doors
         from public.list_rows r
        where r.business_id = $1 and r.import_id = $2 and r.owner_key is not null
          and r.vendor_rank between $3 and $4
          and ${LIST_DONE_SQL('r')}
        order by r.owner_key, r.vendor_rank
     )
     select o.id, o.owner_key, o.owner_name, o.raw, o.vendor_rank, o.doors::int,
            case when o.probate then 'estate' when o.bucket = 'entity' then 'company' else 'person' end as owner_type,
            (o.mail_selected or exists (
               select 1 from public.mailing_pieces mp join public.list_rows r4 on r4.id = mp.list_row_id
                where r4.business_id = o.business_id and r4.owner_key = o.owner_key)) as mailed,
            ${TRACED_SQL('o')} as traced,
            (exists (select 1 from public.people p where p.id = o.person_id and p.facebook_url is not null)
             or exists (select 1 from public.agent_jobs j
                         where j.idempotency_key = 'person.facebook:' || o.business_id || ':' || o.owner_key)
             or exists (select 1 from public.agent_jobs j join public.list_rows r5 on j.input ->> 'list_row_id' = r5.id::text
                         where j.business_id = o.business_id and j.job_type = 'person.facebook'
                           and j.status in ('queued', 'running', 'done') and r5.owner_key = o.owner_key)) as fb_done
       from best o
      order by o.vendor_rank, o.owner_key`,
    [job.business_id, run.list_import_id, run.rank_from, run.rank_to],
  );

  const picked = owners.filter((o) => run.owner_types.includes(o.owner_type) && (run.include_mailed || !o.mailed));
  const result: Record<string, unknown> = {
    owners_in_ranks: owners.length,
    owners_picked: picked.length,
    skipped_mailed: run.include_mailed ? 0 : owners.filter((o) => run.owner_types.includes(o.owner_type) && o.mailed).length,
    practice: run.practice || undefined,
  };

  // ---- phones and emails (paid) ----
  const normal: string[] = [];
  const advanced: string[] = [];
  if (run.find.includes('contact')) {
    if (!tracerfy) {
      result.contact = { skipped: 'Tracerfy is not connected' };
    } else {
      const left = await budgetLeft(db, { config, businessId: job.business_id, practice: run.practice });
      const cap = run.practice ? Number.MAX_SAFE_INTEGER : Math.min(left, run.max_spend_cents ?? Number.MAX_SAFE_INTEGER);
      const alreadyDone = picked.filter((o) => o.traced).length;
      const bigCompanies = picked.filter((o) => !o.traced && o.owner_type === 'company' && o.doors >= config.skipBigCompanyDoors).length;
      let held = 0;
      let overBudget = 0;
      let people = 0;
      for (const o of picked) {
        if (o.traced || (o.owner_type === 'company' && o.doors >= config.skipBigCompanyDoors)) continue;
        const person = parseOwnerName(o.owner_name ?? '', firstNameFromRaw(o.raw))[0];
        const type: TraceType = o.owner_type === 'person' && person ? 'normal' : 'advanced';
        const cost = estimateCents(type, 1, config.skiptraceDnc);
        if (held + cost > cap) {
          overBudget++;
          continue;
        }
        held += cost;
        if (o.owner_type === 'person') people++;
        (type === 'normal' ? normal : advanced).push(o.id);
      }
      result.contact = {
        to_look_up: normal.length + advanced.length,
        people,
        companies_and_estates: normal.length + advanced.length - people,
        already_looked_up: alreadyDone,
        skipped_big_companies: bigCompanies,
        over_budget: overBudget,
        estimated_max_cents: free ? 0 : held,
        budget_left_cents: run.practice ? 'practice' : isTestMode(config) ? 'test mode' : left,
      };
    }
  }

  // ---- Facebook (free to Francis; ProyTech's search ceiling applies per search) ----
  const facebook: Owner[] = [];
  if (run.find.includes('facebook')) {
    if (!search) {
      result.facebook = { skipped: 'no search provider configured' };
    } else {
      const toSearch = picked.filter((o) => o.owner_type === 'person' && !o.fb_done);
      // Real searches would save real findings, so a practice run only counts them.
      if (!run.practice) facebook.push(...toSearch);
      result.facebook = {
        to_search: toSearch.length,
        searched_in_practice: run.practice ? 0 : undefined,
        already_searched: picked.filter((o) => o.owner_type === 'person' && o.fb_done).length,
        not_people: picked.filter((o) => o.owner_type !== 'person').length,
      };
    }
  }

  return {
    status: 'done',
    result,
    lockKey: `run.custom:${job.business_id}`,
    write: async (tx) => {
      let batches = 0;
      for (const [type, ids] of [['normal', normal], ['advanced', advanced]] as const) {
        for (let i = 0; i < ids.length; i += BATCH) {
          const r = await tx.query(
            `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status)
             values ($1, 'scrub', 'skiptrace.submit', $2::jsonb, $3, 'queued') on conflict (idempotency_key) do nothing`,
            [job.business_id, JSON.stringify({ trace_type: type, list_row_ids: ids.slice(i, i + BATCH), run_id: job.id, run_max_cents: run.practice ? undefined : run.max_spend_cents, practice: run.practice || undefined }),
             `skiptrace.submit:${job.business_id}:run:${job.id}:${type}:${i / BATCH}`],
          );
          batches += r.rowCount ?? 0;
        }
      }
      let searches = 0;
      for (const [i, o] of facebook.entries()) {
        const r = await tx.query(
          `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status, run_after)
           values ($1, 'scrub', 'person.facebook', $2::jsonb, $3, 'queued', now() + make_interval(secs => $4))
           on conflict (idempotency_key) do nothing`,
          [job.business_id, JSON.stringify({ list_row_id: o.id, run_id: job.id }), `person.facebook:${job.business_id}:${o.owner_key}`, i],
        );
        searches += r.rowCount ?? 0;
      }
      return { batches_queued: batches, searches_queued: searches };
    },
  };
};
