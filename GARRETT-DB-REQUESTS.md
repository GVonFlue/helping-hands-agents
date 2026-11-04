# Database requests for Garrett (Baalmann Suite)

The agents worker runs today with **no schema changes**. These would make it sturdier. Nothing here is urgent except where marked; each is a new numbered migration plus tests in `supabase/tests/test_rls.sql`, per the repo rules. I haven't touched the CRM repo.

## 1. Duplicate guards in the database (recommended)

Today the worker prevents duplicates with advisory locks and re-checks inside the same transaction that marks the job done. It works and is tested, but the database itself doesn't enforce it. Suggested:

```sql
-- One pending/promoted finding per kind and value per business.
create unique index if not exists enrichment_results_unique_finding
  on public.enrichment_results (business_id, kind, lower(value))
  where status <> 'rejected';
-- One Manager report per business per period.
create unique index if not exists agent_reports_one_per_period
  on public.agent_reports (business_id, agent, period_start, period_end);
-- One draft per agent job.
create unique index if not exists outbound_drafts_one_per_agent_job
  on public.outbound_drafts (agent_job_id) where agent_job_id is not null;
```

Check existing data for duplicates before adding the first one.

## 2. A place for ProyTech's own spend (nice to have)

AI tokens and search queries come out of ProyTech's $249, not Francis's lookup cap. Putting them in `agent_jobs.cost_cents` would eat his cap (`agent_budget_left` sums it), so the worker records them in `agent_jobs.result -> 'spend'` (`ai_cents`, `search_cents`, token counts) and enforces its own monthly ceilings. If you'd like it first-class:

```sql
alter table public.agent_jobs add column if not exists house_cost_cents numeric(10,4) not null default 0;
grant update (house_cost_cents) on public.agent_jobs to agent_service;
```

Then `business_stats.agent_spend_cents` could show both.

## 3. `can_contact()` and texts (please read)

`can_contact(person, business, 'sms')` returns **true when there is no consent record at all**. That's right for email, but for texts it would allow a cold text to a list owner, which the A2P registration forbids. The worker adds its own rule (SMS only if they texted in or have an SMS `opt_in`) and tests it. Worth considering the same rule in `deliver.ts` or a `can_text()` function so the CRM enforces it too.

## 4. Stuck jobs

`claim_agent_jobs` has no recovery for a worker that dies mid-job. The worker now requeues jobs stuck in `running` for 30 minutes and fails them after 3 attempts. If you'd rather own that in SQL, a `reap_agent_jobs()` function granted to `agent_service` would do it.

## 5. Stale config

`agent_settings.config` for Scrub has `"min_confidence_auto_promote": 0.9`. Nothing auto-promotes: the worker can't call `promote_enrichment`, and Francis reviews every finding. Suggest removing the key so nobody assumes otherwise.

## 6. Production login (needed to go live)

Per handoff section 5, when we're ready:

```sql
create role agents_worker login password '<long random>' in role agent_service;
```

The password goes only in Railway's variables.
