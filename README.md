# Helping Hands agents (Manager, Scrub, Contact)

The background worker for the Baalmann Business Suite (client: Francis, Helping Hands Homebuyers). Runs on Railway, connects to Supabase Postgres as `agents_worker` (a member of the locked-down `agent_service` role), claims jobs from `agent_jobs`, and writes only to the staging tables the handoff allows. It never uses the Supabase service role key, and it refuses to start if its login is privileged.

**Agents never send anything.** Contact writes drafts to `outbound_drafts` (`source = 'agent'`, `status = 'draft'`); a person approves every one in the CRM. No cold texts: SMS drafts only when the CRM's `can_text()` is true (opted in, texted us, or one of Francis's non-list contacts), the same check the CRM's sender runs. List sellers get email.

## Job types

| Job | Agent | Status | What it does |
| --- | --- | --- | --- |
| `report.weekly` | manager | Live | Weekly report into `agent_reports`: numbers from `business_stats` and `mail_results` computed in code; Claude writes the summary from only those numbers. Template fallback without AI. Queued Mondays 7am Central. |
| `message.draft` | contact | Live | One personal draft per person. Checks `can_contact`, the no-cold-text rule, existing waiting drafts. |
| `plan.drafts` | manager | Live | Hourly: when Francis promotes a finding, queues a first draft for that person (email; text only if they texted us). |
| `person.facebook` | scrub | Built, off | Logged-out web search for a public profile link; writes at most one pending finding. Off until a search provider is signed off. |
| `plan.facebook` | manager | Built, off | Daily: queues the next owners to search (unmailed + 2+ doors first, then rank, mailed owners last), each owner once. |
| `entity.lookup` | scrub | Blocked | Kansas SOS search is behind a CAPTCHA (AWS WAF "Human Verification"). Jobs park as `blocked` with the reason; the 90-day cache and writer are built and tested for when a source is chosen. |
| `person.lookup` | scrub | Stub | Paid skip trace. Always `blocked` until the vendor and Francis's budget are approved. |

## Money

- **Francis's money** (paid lookups billed to him): `agent_jobs.cost_cents`, gated by `agent_budget_left()` before every paid call. Currently $0, so nothing paid runs on his budget.
- **ProyTech's money** (out of the flat $249): AI tokens and search queries. Recorded per job in `agent_jobs.house_cost_cents` (split into AI and search in `result -> 'spend'`), shown as `house_spend_cents` in `business_stats`, and capped monthly by `AI_MONTHLY_CEILING_CENTS` ($40) and `SEARCH_MONTHLY_CEILING_CENTS` ($25). To see this month:

```sql
select date_trunc('month', finished_at) as month,
       sum((result->'spend'->>'ai_cents')::numeric) / 100 as ai_dollars,
       sum((result->'spend'->>'search_cents')::numeric) / 100 as search_dollars
from agent_jobs where result ? 'spend' group by 1 order by 1 desc;
```

## Facebook search: pending sign-off

The provider is pluggable (`src/search.ts`). The Brave adapter is written but **should not be turned on yet**: Brave's standard API terms forbid storing results beyond transient use, and we store the profile URL for Francis to review. Pick a provider whose terms allow storing result URLs (or a Brave plan with storage rights), then set `SEARCH_PROVIDER` and its key. The worker only ever calls the search API; it never requests facebook.com, logs in or messages anyone.

Matching (`src/facebook.ts`): the profile name must contain the owner's first name (or a nickname) and last name. Points for city, middle initial, the co-owner named in the snippet, and a rare surname; penalties for a different middle name, another state, or a very common name. Nothing is written below 0.6, when there's no place signal, or when two profiles score within 0.15 of each other.

## Tests

```bash
npm install
npm run test:unit                                  # matching and cost math
CRM_REPO=../baalmann-suite npm run test:db         # full CRM schema in throwaway Postgres
```

`test:db` applies the CRM's migrations (read-only from a checkout), creates `agents_worker` in `agent_service` exactly like production, loads `tests/fixtures.sql`, runs every database test as that login, then smoke-runs the real process. Needs PostgreSQL 16 at `/usr/lib/postgresql/16/bin` (or set `PGBIN`).

## Deploy to Railway (not done yet; needs sign-off)

1. Garrett creates the login: see `GARRETT-DB-REQUESTS.md` item 6.
2. New Railway service from this repo. It uses `railway.json` (`npm start`, 1 replica).
3. Variables from `.env.example`: `DATABASE_URL` (session pooler, user `agents_worker.ylrfaqlxuxujyubjnqnz`), `ANTHROPIC_API_KEY`. Leave `SEARCH_PROVIDER` empty until signed off.
4. Check the logs for `worker started`. The first weekly report is queued the next Monday at 7am Central.
