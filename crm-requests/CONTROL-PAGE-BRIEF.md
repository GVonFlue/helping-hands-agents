# Brief for Garrett's Claude: the "AI team" page (Helping Hands)

You're working in **GVonFlue/baalmann-suite**. Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first and follow them.

Francis (Helping Hands Homebuyers) runs his seller-list agents from scattered places today: list-page buttons, Settings → Agents, and a review table with one row per phone or email (1,389 rows for 150 owners). He is **not comfortable with technology**. He wants one page where he can:

- see whether everything is working,
- start a lookup he chooses himself (for example "the top 1,000, people and LLCs, phones and Facebook"), with the cost shown before it starts,
- turn agents on and off and set his monthly budget, and
- review findings one owner at a time.

**Mockup:** https://claude.ai/artifact/UwNjjPn5JbWHTw4Yyi6Mws (desktop page, confirm dialog, phone layout, review screen). Match its layout, wording and sizes. Colors and fonts should follow the CRM's existing theme, not the mockup's hex values.

The worker side is already built and live (GVonFlue/helping-hands-agents, `run.custom`, commit 2a2384a and later). This brief is only the CRM side.

## Repo rules that apply

- Schema changes go in a **new** numbered migration. Never edit a migration that has run in production.
- Nothing client-specific is hardcoded. Agent names, the list, the budget presets and wording that mentions Helping Hands come from the database or settings.
- Never send a text or email from this page. Nothing here sends anything.
- Add tests to `supabase/tests/test_rls.sql`. `npm run build`, `npm run test:db` and `npm run test:api` must all pass.
- Test logins use testgvonflue@gmail.com.
- Gate the page the same way other agent screens are gated, so CRM installs without the agents don't show it.

## 1. Migration: one read-only function

Copy `crm-requests/agent_run_preview.sql` from the worker repo into a new migration, as is. It gives the page live counts and cost for a lookup Francis is setting up. It is `security invoker`, so RLS applies and it can't read another business. It mirrors the worker's rules exactly, and the worker's test suite runs this same SQL against the worker to prove they agree. **Don't change its logic.** If something needs to change, tell Logan so the worker changes with it.

Tests to add in `test_rls.sql`:

- A member of the business gets counts.
- A user with no membership gets zero owners for that business, not an error that leaks data.
- `anon` can't execute it.

## 2. The page

A new sidebar item, **AI team**, under Weekly report. It gets a red count badge when something needs attention: the status banner is red, or drafts are waiting.

Wording rule for this page: plain words only. Never show "job", "enrichment", "skip trace", "run.custom", "queued" or "cents". Body text 16px or larger, every button and checkbox at least 48px tall, and the layout must work at phone width (see the Phone artboard).

### 2a. Status banner (top)

Show one banner, checked in this order:

| Condition | Banner |
| --- | --- |
| The newest `skiptrace.submit` or `skiptrace.collect` job in the last 26 hours failed with an error containing `not enough credits`, and no `skiptrace.submit` has finished `done` since | Red: "Phone and email lookups are paused. Your Tracerfy account is out of credit, so nothing paid can run. Facebook searches and drafts are still working." Button: **Add credit on Tracerfy** (opens tracerfy.com in a new tab) |
| `agent_budget_left(business, 'scrub')` is under 320 (one morning's 20 owners) | Amber: "This month's lookup budget is used up. Lookups start again on the 1st, or raise your budget." Button: **Raise budget** |
| Any of manager, scrub or contact has `enabled = false` in `agent_settings` | Amber: "<Agent> is turned off." Button: **Turn on** |
| Otherwise | Green: "Everything's running." |

### 2b. Four tiles

- **Waiting for you to review:** count of distinct owners with `pending` findings, plus the count of pending findings as the sub-line. Button **Review now** goes to the review screen (section 3).
- **Messages to approve:** `outbound_drafts` with `status = 'draft'` for the business. Button **Open Approvals**.
- **Lookup money left this month:** `agent_budget_left(business, 'scrub')` in dollars, with a bar for spent / cap (spent = cap minus left). Button **Change budget** opens a small sheet with a few preset amounts (store them per business, defaults $25, $70, $100 and $175) plus a custom amount, and saves to `agent_settings.monthly_cap_cents` for `scrub`. Admin role only, same rule as Settings → Agents.
- **Found so far:** distinct owners with any finding from Tracerfy (`source like 'tracerfy%'`), plus the count of Facebook findings.

### 2c. Start a lookup

The inputs, in this order:

1. **Which list?** A select of `list_imports` with `status = 'done'`, newest first, labeled with the file name or month and the row count.
2. **Which owners?** Buttons for Top 100, Top 250, Top 500 and Top 1,000, plus **Pick a range…**, which shows two number inputs (From rank, To rank). Rank 1 is the best owner.
3. **What kinds of owners?** Three checkbox cards: People, LLCs and trusts, Estates. Each shows its count for the chosen ranks (see below). Then a checkbox, "Also include owners I'm mailing this month (N marked)", off by default.
4. **What should we find?** Two checkbox cards: "Phones and emails" (paid, Do Not Call checked) and "Facebook profiles" (free, public search only, people only).

**Live summary (right side, or below the inputs on a phone).** Call `agent_run_preview(business, list, rank_from, rank_to, types, include_mailed)`, debounced about 300ms after each change. Show:

- Owners to look up: `contact.to_look_up`, shown only if Phones and emails is ticked.
- Facebook searches: `facebook.to_search`, shown only if Facebook is ticked.
- Already looked up, skipped: `contact.already_looked_up`, and "Already on Facebook search, skipped": `facebook.already_searched`. Hide either one when it's 0.
- Big companies, skipped: `contact.skipped_big_companies`. Hide when 0.
- **Cost:** "about $X" from `contact.typical_cents`, with "never more than $Y" from `contact.max_cents`. Show "Free" when only Facebook is ticked.
- If `contact.max_cents > budget_left_cents`, show an amber note: "Your budget covers N of these owners." N = floor(`budget_left_cents` ÷ (`max_cents` ÷ `to_look_up`)). Follow it with a **Raise budget** link (the same sheet as 2b) and the line "or start now and the rest wait."
- An optional field: "Spend at most on this lookup", in dollars.

The type counts on the cards come from the same function, called once per type, or add a breakdown if you like. Don't compute them another way.

**Start lookup** opens the confirm dialog (Confirm artboard). It lists the owners, how many get phones and emails, how many Facebook searches, the cost, and "Results in about an hour". It also says: "Paid lookups can't be undone once they start. Nothing is sent to anyone." Buttons: **Go back** and **Yes, start it**.

**Practice run.** The confirm dialog also has a third button, **Practice run (free)**, shown to admins. It starts the same lookup with `"practice": true` in the input. The worker then:

- sends phone and email lookups to Tracerfy's free test server: $0 charged, the budget is ignored, nothing is saved on real owners, and nobody is marked as looked up;
- only counts Facebook searches, without running them.

Every job the run creates carries `"practice": true`. On the page, show a grey **Practice** badge on that run's row. When it's done, show "Practice run: would have found N emails and N phones", summed from `result.would_save` on its `skiptrace.collect` jobs, plus "No money spent, nothing saved." This lets Logan and Francis test the whole screen on the live CRM before any real money goes in.

On **Yes, start it**, insert one row into `agent_jobs`. Members may already insert queued jobs, so no policy change is needed:

```json
{
  "business_id": "<business>",
  "agent": "manager",
  "job_type": "run.custom",
  "status": "queued",
  "created_by": "<auth.uid()>",
  "idempotency_key": "run.custom:<business>:<new uuid>",
  "input": {
    "list_import_id": "<uuid>",
    "rank_from": 1,
    "rank_to": 1000,
    "owner_types": ["person", "company", "estate"],
    "include_mailed": false,
    "find": ["contact", "facebook"],
    "max_spend_cents": 5000,
    "practice": false
  }
}
```

- `owner_types` is any of `person`, `company`, `estate`. At least one.
- `find` is any of `contact`, `facebook`. At least one.
- Leave `max_spend_cents` out when the field is empty.
- `practice` is `true` only from the Practice run button.
- Disable the button while the insert is in flight, so a double click can't start two runs.

What the worker does with it (you don't build this):

- It runs right away, outside the daily amounts.
- It never looks an owner up twice and skips companies with 20+ properties.
- It stops at the monthly budget, and at `max_spend_cents` if one was set.
- It sends phone and email lookups to Tracerfy in batches of 500 and queues Facebook searches.
- Every job it creates carries `input.run_id` = the `run.custom` job's id.
- Its `result` has the same shape as the preview, plus `contact.over_budget`, `batches_queued` and `searches_queued`.

### 2d. Lookups in progress

For each `run.custom` job from the last 7 days, newest first, show one row. Poll every 15 seconds while the page is open.

- **Waiting to start** while the `run.custom` job is queued or running.
- When it's done: "Looking up 974 owners · 340 done". Every job the run creates carries `input ->> 'run_id'` = the `run.custom` job's id: the Tracerfy batches (`skiptrace.submit`), then `skiptrace.collect` and `skiptrace.dnc` for each batch, and each `person.facebook` search. The done count is the sum of `rows_sent` over this run's `skiptrace.submit` jobs whose `skiptrace.dnc` job is done, plus this run's `person.facebook` jobs that are done. The total is `result.contact.to_look_up` plus `result.facebook.to_search`. A batch with no phones to scrub has no `skiptrace.dnc` job: count it done when its `skiptrace.collect` is done and its result says `phones: 0`.
- When everything for that run is done: "Done · 974 owners · cost $X", where cost is the sum of `cost_cents` of jobs with that `run_id`.
- If the run was trimmed: "N owners were over your budget and didn't run" (`result.contact.over_budget`).
- If the `run.custom` job failed, show its `error` text. It's written in plain words.

### 2e. Your Tracerfy account

A card titled **Your Tracerfy account**, below the lookup builder (mockup: Main and Phone artboards):

- Text: "Where phone and email lookups are paid for. Add credit, check your balance or get receipts there." Under it, smaller: "Keep at least your monthly budget on it, or lookups stop early."
- A big **Open Tracerfy** button, opening the account link in a new tab (`target="_blank" rel="noopener noreferrer"`).
- The same link, labeled **Open Tracerfy account**, under the budget tile in 2b, and on the red "out of credit" banner's button in 2a.
- Store the link per business, editable in Settings → Agents by admins. Default it to `https://tracerfy.com`. Don't hardcode it in the component.
- **Never store or ask for his Tracerfy password in the CRM.** The link just opens Tracerfy, and he signs in there.
- Tracerfy has no published way to read the balance, so don't show a balance number. The out-of-credit banner (2a) covers the "it ran out" case.

### 2f. Your agents

One row each for Manager, Scrub and Contact: a one-sentence description and a big On/Off switch bound to `agent_settings.enabled`. Admin role only. Reuse what Settings → Agents does, with the same descriptions as the mockup. Keep the Settings tab too.

### 2g. Today

Plain-language lines from the last 24 hours of `agent_jobs`, newest first. Each gets a Done, Stopped or Running pill. Examples:

- "8:00am Facebook search · 100 owners searched"
- "9:00am morning lookup · Out of Tracerfy credit. It retries tomorrow at 9."
- "Monday report · Delivered · Read it"

Summarize by job type; don't list every job. Map failures to the same sentences as the status banner.

## 3. Review screen, one card per owner

This replaces wading through the "Agent findings to review" table. Keep the table on the list page for now.

- **Tabs:** Phones and emails (`email` and `phone` findings), Facebook (`facebook`), People behind LLCs (`entity_member`), each with an owner count.
- **One card per owner.** Group `pending` findings by `list_rows.owner_key`. Show the owner name (title-cased), rank, property count, property address and mailing address, then one checkbox row per finding:
  - The value.
  - Phone type, when known.
  - A pill: **Best match** for the highest confidence of its kind, **Do Not Call** (red) when `do_not_call`, **OK to call** for the others, and **Maybe a relative** when confidence is below 0.75.
- **Pre-ticked:** the best email, the best phone that is not Do Not Call, the best LLC person, and the Facebook profile.
- **Add <first name> to CRM:** call `promote_enrichment` once per ticked finding, then mark the owner's unticked findings rejected, so the owner doesn't come back half-reviewed. Sub-line: "Adds N items. A first email draft waits in Approvals within the hour."
- **Not them:** reject every pending finding for that owner.
- **Skip for now:** no database change; move the card to the end.
- Show a progress bar ("12 of 150 owners reviewed"), 10 cards at a time, with "Load the next 10".
- Order: best rank first.

Test in `test_rls.sql` that calling `promote_enrichment` for two findings of the same `owner_key` (an email, then a phone) attaches both to **one** person, through `promote_owner`. If it creates two people, fix it in the new migration before building the screen.

## 4. Done means

- [ ] Migration adds `agent_run_preview` unchanged, with the three RLS tests above.
- [ ] As testgvonflue@gmail.com on a test business with a list: pick Top 100, People only, Phones and emails. The summary matches the function's output, and **Yes, start it** creates exactly one `run.custom` job with the input shape above. A double click still makes only one.
- [ ] With the scrub budget at $5, the amber "covers N" note shows the right N.
- [ ] Turning Scrub off on the page sets `agent_settings.enabled = false`, and the amber banner shows.
- [ ] A `skiptrace.submit` failed with "not enough credits" in the last 26 hours, with no success since, turns the banner red. A later `done` submit clears it.
- [ ] The review screen groups findings by owner. **Add** promotes only the ticked findings onto one person and rejects the rest. **Not them** rejects all of that owner's findings.
- [ ] A viewer-role login can see the page but can't start a lookup, change the budget or flip agents. The buttons are hidden and the database refuses.
- [ ] Usable at 390px wide, with no sideways scrolling.
- [ ] `npm run build`, `npm run test:db` and `npm run test:api` pass.
- [ ] **Open Tracerfy** (card, budget tile and red banner) opens the business's stored link in a new tab. An admin can change the link in Settings → Agents; a viewer can't.
- [ ] A **Practice run** creates a `run.custom` job with `"practice": true`, shows the Practice badge and the "would have found" line, and leaves the budget and the review list unchanged.
- [ ] Reply to Logan with the migration name and a short screen recording of a Top 100 **practice** run.

## 5. Go-live: before any real money (Logan and Francis)

Real lookups stay off until every step below passes on the live CRM:

1. Garrett ships the page and every box in section 4 is ticked.
2. **Logan, practice run:** Top 100, all kinds, phones and Facebook. The counts match the summary, the confirm step reads clearly, progress moves and finishes, the budget doesn't change, and nothing new shows up in review.
3. **Francis, alone, on his phone and on his computer:** he does the same practice run without help while Logan watches. Write down every place he hesitates, and fix those before going on.
4. **Review on real data, still no money:** Francis reviews 10 owners from the 1,389 findings already waiting. Check each added owner becomes one person in People, Do Not Call phones are marked, a first email draft shows up in Approvals within the hour, and nothing is sent.
5. **Switches and budget:** Francis turns Scrub off and on, and changes his budget. The banner and Settings agree.
6. **Fund it:** Francis moves Tracerfy to his name, loads $200, and sets his November budget to $200.
7. **First real lookup, small:** Top 100, people only, about $11 to $14. Logan checks the matches and that the cost landed inside the estimate.
8. **Then the top 1,000:** 974 owners, about $128, never more than $147.
