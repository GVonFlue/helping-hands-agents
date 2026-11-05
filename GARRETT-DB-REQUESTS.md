# Database requests for Garrett (Baalmann Suite)

## Status, Nov 4 (after migration 14)

| # | Request | Status |
| --- | --- | --- |
| 0 | List import mis-reads the vendor's RANK score | **Open.** September list imported Nov 4 with the workaround (sorted by TOTAL, rank = Not in file, score = TOTAL, properties = OWNER TOTAL PROPERTIES); the code fix is still needed for future uploads. See below. |
| 7 | **New: `process_import` times out from the browser on a full list** | **Open.** See below. |
| 1 | Duplicate guards | Done. Worker treats SQLSTATE 23505 as "already done". |
| 2 | ProyTech's own spend | Done. Worker writes `house_cost_cents`; `result.spend` keeps the AI/search split. |
| 3 | Texting rule | Done as `can_text()`. Worker calls it before any SMS draft and when planning drafts. |
| 4 | Stuck jobs | Stays in the worker (requeue after 30 min, fail after 3 attempts). |
| 5 | Stale config | Done. |
| 6 | Production login | Done. Password goes only in Railway. |

Worker tests now run against all 14 migrations (CRM at 7b5c6db).

## 7. NEW: `process_import` times out on a 28,586-row list

Uploading Francis's September list from the Seller lists page: all 28,586 rows inserted fine, then the `process_import` RPC failed with "canceling statement due to statement timeout" (the `authenticated` role's short statement timeout on Supabase). The function rolled back cleanly, leaving the import in `uploading` with unkeyed rows.

I finished it from the SQL editor as the same user (`testgvonflue@gmail.com`), with a longer timeout:

```sql
begin;
set local statement_timeout = '10min';
select set_config('request.jwt.claims', (select json_build_object('sub', id::text, 'role', 'authenticated')::text
  from auth.users where email = 'testgvonflue@gmail.com'), true);
select public.process_import('c1b016f1-fb6f-4874-a36f-3fef1d7d4d91');
commit;
```

Result: `{"new":28586,"rows":28586,"repeat":0,"buckets":{"entity":1500,"owner_occupied":23868,"individual_investor":3218}}`, status `done`, ranks 1–28,586 in TOTAL order, 2,833 owners with 2+ doors, 1,272 entities.

Every monthly upload will hit this (the repeat check gets slower as lists pile up). Options: run `process_import` from a server route (`api/`) with a longer timeout; split it into steps the browser calls one at a time; or `alter role authenticated set statement_timeout = '120s'` (simplest, but applies to every browser query).

## 0. URGENT: the list import mis-reads Francis's vendor file (affects which owners get mailed)

Checked against `Baalmann_Francis_Sep_2026.csv` (28,586 rows):

- The file has `RANK`, but it's a **decimal score from 0 to 4.58**, not a position. `TOTAL = RANK + MOTIVATION POINTS` on every row, and higher means more likely to sell. There is no "1 = best" column.
- `src/lib/csv.ts` auto-maps any header matching `/rank/` to `vendor_rank`, and `toInt()` strips non-digits, so `"3.06"` becomes `306` and `"0.0"` becomes `0`.
- `select_for_mail()` orders by `vendor_rank` ascending, so it marks the **lowest-scoring** owners first.
- `vendor_score` (`/score|motivation/`) likely lands on `MOTIVATIONS` (text) or `MOTIVATION POINTS`, not `TOTAL`.
- `OWNER TOTAL PROPERTIES` isn't auto-mapped to `vendor_property_count`, so door counts come out as 1 for nearly everyone (the list has one row per owner).

What to check: if this list is already imported, look at its `vendor_rank` values. Numbers like 0–458 mean it was mis-mapped, and any mail selection made from it should be redone before printing.

Suggested fix:
- `toInt()` should refuse decimals rather than stripping the dot.
- When the mapped rank column is fractional or there's only a score, set `vendor_rank` to the row's position by `vendor_score` descending (`row_number() over (order by vendor_score desc)` in `process_import`).
- Map `TOTAL` to `vendor_score`, and match `OWNER TOTAL PROPERTIES` in the hints.

Workaround today: on the import screen, map Vendor rank to nothing, Vendor score to `TOTAL`, and Properties to `OWNER TOTAL PROPERTIES`. Upload the file pre-sorted by `TOTAL` descending; the CRM then numbers rows in file order. I can produce that sorted file.

The agents worker no longer depends on this: it reads `TOTAL`, `OWNER TOTAL PROPERTIES`, `FIRST NAME` and probate flags from `list_rows.raw`.

---

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
