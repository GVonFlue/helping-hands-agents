import { z } from 'zod';
import { pickMatch, type Subject } from '../facebook.ts';
import { houseSpendThisMonth, addSearch } from '../spend.ts';
import { firstNameFromRaw, parseOwnerName, titleCase } from '../names.ts';
import { isProbate } from '../listSignals.ts';
import type { SearchHit } from '../search.ts';
import { UUID_RE, type Handler } from '../types.ts';

const Input = z.object({ list_row_id: z.string().regex(UUID_RE) });

// Finds a list owner's public Facebook profile link with logged-out web search.
// Never opens facebook.com, never logs in, never messages. Writes at most one
// pending finding per owner for Francis to review.
export const personFacebook: Handler = async ({ db, job, config, search, spend }) => {
  const parsed = Input.safeParse(job.input);
  if (!parsed.success) return { status: 'failed', error: 'input needs list_row_id (uuid)' };

  const { rows } = await db.query(
    `select r.id, r.business_id, r.owner_name, r.owner_key, r.bucket, r.mailing_city, r.mailing_state,
            r.property_city, r.property_state, r.raw, p.facebook_url
       from public.list_rows r left join public.people p on p.id = r.person_id
      where r.id = $1`,
    [parsed.data.list_row_id],
  );
  const row = rows[0];
  if (!row || row.business_id !== job.business_id) return { status: 'failed', error: 'list row not found in this business' };
  if (row.bucket === 'entity') return { status: 'done', result: { skipped: 'owner is a company or trust' } };
  if (!row.owner_key) return { status: 'done', result: { skipped: 'row has no owner key' } };
  if (row.facebook_url) return { status: 'done', result: { skipped: 'person already has a Facebook link' } };
  // The owner of record may have died; a profile match would be the wrong person
  // to reach, or a memorial page. Heirs come through skip trace instead.
  if (isProbate(row.raw)) return { status: 'done', result: { skipped: 'probate: owner may be deceased' } };

  const people = parseOwnerName(row.owner_name, firstNameFromRaw(row.raw));
  if (!people[0]) return { status: 'done', result: { skipped: 'owner name is not one person' } };

  // Never search the same owner twice (lists repeat 50–70% month to month).
  if (await alreadySearched(db, job.business_id, row.owner_key, job.id)) {
    return { status: 'done', result: { skipped: 'owner already searched' } };
  }

  if (!search) {
    return {
      status: 'blocked',
      error: 'Facebook search is off until a search provider is signed off and its key is set.',
      result: { reason: 'no_search_provider' },
    };
  }

  const cities = uniq([row.mailing_city, row.property_city].filter(Boolean).map((c: string) => titleCase(c.trim())));
  const queries = (cities.length ? cities : ['Kansas']).slice(0, 2).map(
    // Name in quotes, city not: a quoted city drops most results; scoring still
    // requires the city (or state) to appear in the result.
    (c) => `"${titleCase(`${people[0]!.first} ${people[0]!.last}`)}" ${c} site:facebook.com`,
  );
  const needed = queries.length * config.searchCentsPerQuery;
  const house = await houseSpendThisMonth(db);
  if (house.search_cents + needed > config.searchMonthlyCeilingCents) {
    return {
      status: 'blocked',
      error: `ProyTech's search budget for this month ($${(config.searchMonthlyCeilingCents / 100).toFixed(2)}) is used up.`,
      result: { reason: 'house_search_ceiling' },
    };
  }

  const hits: SearchHit[] = [];
  for (const q of queries) {
    addSearch(spend, config.searchCentsPerQuery); // counted even if the call fails
    hits.push(...(await search.search(q)));
  }

  const subject: Subject = {
    person: people[0],
    coOwnerFirst: people[1]?.first ?? null,
    cities,
    states: uniq([row.mailing_state, row.property_state].filter(Boolean).map((s: string) => s.trim().toUpperCase().slice(0, 2))),
  };
  const { match, reason, considered } = pickMatch(hits, subject, config.facebookMinConfidence);
  const result = { owner_key: row.owner_key, queries: queries.length, profiles_considered: considered, outcome: reason };
  if (!match) return { status: 'done', result };

  return {
    status: 'done',
    lockKey: `facebook:${job.business_id}:${row.owner_key}`,
    result: { ...result, confidence: match.score, signals: match.signals },
    write: async (tx) => {
      // Re-check under the lock: another job for the same owner may have just written.
      const dup = await tx.query(
        `select 1 from public.enrichment_results e
           left join public.list_rows r on r.id = e.list_row_id
          where e.business_id = $1 and e.kind = 'facebook' and (r.owner_key = $2 or e.value = $3)
          limit 1`,
        [job.business_id, row.owner_key, match.url],
      );
      if (dup.rowCount) return { written: false, note: 'finding already exists for this owner or profile' };
      await tx.query(
        `insert into public.enrichment_results
           (business_id, job_id, list_row_id, kind, value, confidence, source, cost_cents, status)
         values ($1, $2, $3, 'facebook', $4, $5, $6, 0, 'pending')`,
        [job.business_id, job.id, row.id, match.url, match.score, search.name],
      );
      return { written: true };
    },
  };
};

async function alreadySearched(db: import('../db.ts').Db, businessId: string, ownerKey: string, jobId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `select 1
       from public.agent_jobs j
       join public.list_rows r on j.input ->> 'list_row_id' = r.id::text
      where j.business_id = $1 and j.job_type = 'person.facebook' and j.status = 'done' and j.id <> $3
        and r.owner_key = $2 and (j.result ->> 'skipped') is null
     union all
     select 1
       from public.enrichment_results e join public.list_rows r on r.id = e.list_row_id
      where e.business_id = $1 and e.kind = 'facebook' and r.owner_key = $2
     limit 1`,
    [businessId, ownerKey, jobId],
  );
  return (rowCount ?? 0) > 0;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
