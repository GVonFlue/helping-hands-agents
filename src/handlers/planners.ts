import { z } from 'zod';
import { DOORS_SQL, PRIORITY_SQL, PROBATE_SQL } from '../listSignals.ts';
import type { Handler } from '../types.ts';

// plan.facebook (Manager, daily): queue the next owners to search, one job per
// owner, never one already searched. Order: owners not yet mailed first, then
// owners with 2+ doors, then the vendor's score (TOTAL, higher first; see
// listSignals.ts for why not vendor_rank). Probate owners are never searched. Mailed owners are still searched,
// after the unmailed ones. The idempotency key is per owner, so an owner can only
// ever be queued once by the planner.
export const planFacebook: Handler = async ({ db, job, config, search }) => {
  if (!search) return { status: 'done', result: { skipped: 'no search provider configured' } };
  const limit = Math.max(0, Math.min(500, Number(z.object({ limit: z.number().optional() }).parse(job.input).limit ?? config.facebookDailyLimit)));
  if (!limit) return { status: 'done', result: { skipped: 'daily limit is 0' } };

  const { rows } = await db.query(
    `with owners as (
       select r.owner_key,
              min(r.vendor_rank) as best_rank,
              max(${PRIORITY_SQL('r')}) as priority,
              greatest(count(distinct r.property_key), max(${DOORS_SQL('r')})) as doors,
              bool_or(${PROBATE_SQL('r')}) as probate,
              bool_or(exists (select 1 from public.mailing_pieces mp where mp.list_row_id = r.id)) as mailed,
              bool_or(r.bucket = 'entity') as is_entity,
              bool_or(p.facebook_url is not null) as has_fb
         from public.list_rows r left join public.people p on p.id = r.person_id
        where r.business_id = $1 and r.owner_key is not null and r.owner_name is not null
        group by r.owner_key
     ),
     todo as (
       select o.* from owners o
        where not o.is_entity and not o.has_fb and not o.probate
          and not exists (select 1 from public.agent_jobs j
                           where j.idempotency_key = 'person.facebook:' || $1 || ':' || o.owner_key)
          and not exists (select 1 from public.agent_jobs j join public.list_rows r2 on j.input ->> 'list_row_id' = r2.id::text
                           where j.business_id = $1 and j.job_type = 'person.facebook'
                             and j.status in ('queued', 'running', 'done') and r2.owner_key = o.owner_key)
        order by o.mailed, (o.doors >= 2) desc, o.priority desc nulls last, o.best_rank nulls last
        limit $2
     )
     select t.owner_key, t.mailed, t.doors,
            (select r.id from public.list_rows r
              where r.business_id = $1 and r.owner_key = t.owner_key
              order by ${PRIORITY_SQL('r')} desc nulls last, r.vendor_rank nulls last, r.id limit 1) as list_row_id
       from todo t
      order by t.mailed, (t.doors >= 2) desc, t.priority desc nulls last, t.best_rank nulls last`,
    [job.business_id, limit],
  );

  return {
    status: 'done',
    result: { candidates: rows.length },
    write: async (tx) => {
      let queued = 0;
      for (const [i, r] of rows.entries()) {
        const res = await tx.query(
          `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status, run_after)
           values ($1, 'scrub', 'person.facebook', $2::jsonb, $3, 'queued', now() + make_interval(secs => $4))
           on conflict (idempotency_key) do nothing`,
          [job.business_id, JSON.stringify({ list_row_id: r.list_row_id }), `person.facebook:${job.business_id}:${r.owner_key}`, i],
        );
        queued += res.rowCount ?? 0;
      }
      return { queued, unmailed: rows.filter((r) => !r.mailed).length };
    },
  };
};

// plan.drafts (Manager, hourly): when Francis promotes a finding onto a person,
// queue a first draft for them. Email when they have one; a text only when
// can_text() is true (message.draft and the CRM's sender check it again). One first draft per
// person, ever, by idempotency key.
export const planDrafts: Handler = async ({ db, job }) => {
  const { rows } = await db.query(
    `select distinct on (e.person_id) e.person_id,
            exists (select 1 from public.messages m where m.person_id = e.person_id and m.business_id = $1 and m.direction = 'in') as warm,
            exists (select 1 from public.contact_points c where c.person_id = e.person_id and c.kind = 'email' and not c.do_not_contact) as has_email,
            public.can_text(e.person_id, $1) as can_text,
            exists (select 1 from public.list_rows lr where lr.business_id = $1
                     and (lr.person_id = e.person_id or lr.id = e.list_row_id) and ${PROBATE_SQL('lr')}) as probate
       from public.enrichment_results e
      where e.business_id = $1 and e.status = 'promoted' and e.person_id is not null
        and e.reviewed_at > now() - interval '30 days'
        and not exists (select 1 from public.outbound_drafts d where d.person_id = e.person_id and d.business_id = $1 and d.source = 'agent')
      order by e.person_id, e.reviewed_at desc
      limit 200`,
    [job.business_id],
  );
  const wanted = rows
    .map((r) => {
      if (r.probate) return null; // estate or heir situation: Francis writes those himself
      if (r.has_email) return { person_id: r.person_id, purpose: r.warm ? 'warm' : 'cold', channel: 'email' };
      if (r.can_text) return { person_id: r.person_id, purpose: 'warm', channel: 'sms' };
      return null; // e.g. only a Facebook link: Francis messages those by hand
    })
    .filter((x): x is { person_id: string; purpose: string; channel: string } => x !== null);

  return {
    status: 'done',
    result: { promoted_people: rows.length },
    write: async (tx) => {
      let queued = 0;
      for (const w of wanted) {
        const res = await tx.query(
          `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status)
           values ($1, 'contact', 'message.draft', $2::jsonb, $3, 'queued') on conflict (idempotency_key) do nothing`,
          [job.business_id, JSON.stringify(w), `message.draft:first:${job.business_id}:${w.person_id}`],
        );
        queued += res.rowCount ?? 0;
      }
      return { queued, not_queued: rows.length - wanted.length, probate: rows.filter((r) => r.probate).length };
    },
  };
};
