import type { Config } from './config.ts';
import type { Db } from './db.ts';

// The Manager's clock. Every insert has a unique idempotency key, so running this
// often (or from two workers) never queues the same work twice.
//
//   report.weekly  last full Mon–Sun week, from Monday 7am Central
//   plan.drafts    hourly: queue first drafts for findings Francis promoted
//   plan.facebook  daily from 8am Central: queue the next owners to search

let lastRun = 0;

export async function runScheduler(db: Db, config: Config, force = false): Promise<void> {
  if (!force && Date.now() - lastRun < 5 * 60_000) return;
  lastRun = Date.now();
  const facebookOn = !!config.searchProvider && config.facebookDailyLimit > 0;
  await db.query(
    `with biz as (
       select s.business_id from public.agent_settings s
        where s.agent = 'manager' and s.enabled
     ),
     clock as (
       select (now() at time zone 'America/Chicago') as local,
              date_trunc('week', now() at time zone 'America/Chicago') as week_start
     ),
     wanted as (
       select b.business_id, 'report.weekly' as job_type,
              jsonb_build_object('period_start', (c.week_start - interval '7 days')::date,
                                 'period_end', (c.week_start - interval '1 day')::date) as input,
              'report.weekly:' || b.business_id || ':' || (c.week_start - interval '7 days')::date as key
         from biz b, clock c
        where c.local >= c.week_start + interval '7 hours'
       union all
       select b.business_id, 'plan.drafts', '{}'::jsonb,
              'plan.drafts:' || b.business_id || ':' || to_char(c.local, 'YYYY-MM-DD"T"HH24')
         from biz b, clock c
       union all
       select b.business_id, 'plan.facebook', jsonb_build_object('limit', $1::int),
              'plan.facebook:' || b.business_id || ':' || c.local::date
         from biz b, clock c
        where $2::boolean and extract(hour from c.local) >= 8
     )
     insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status)
     select business_id, 'manager', job_type, input, key, 'queued' from wanted
     on conflict (idempotency_key) do nothing`,
    [config.facebookDailyLimit, facebookOn],
  );
}
