import { z } from 'zod';
import type { Db, Tx } from '../db.ts';
import { DOORS_SQL, LIST_DONE_SQL, PROBATE_SQL } from '../listSignals.ts';
import { firstNameFromRaw, parseOwnerName, titleCase } from '../names.ts';
import { clientBudgetLeft } from '../spend.ts';
import { addressKey, contactsFromRow, type TraceRecord, type TraceType } from '../tracerfy.ts';
import { UUID_RE, type Ctx, type Handler } from '../types.ts';

// Paid skip trace (Tracerfy), billed to Francis's Scrub cap.
//
//   plan.skiptrace (manager, daily)  picks owners, best first, never twice
//   skiptrace.submit (scrub)         uploads one batch (normal or advanced)
//   skiptrace.collect (scrub)        waits for it, saves emails + LLC members,
//                                    sends every phone to the DNC scrub
//   skiptrace.dnc (scrub)            waits for the scrub, saves phones with
//                                    do_not_call set from the scrub
//   person.lookup (scrub)            a CRM "Find info" click: queues that row
//                                    for the next batch
//
// Normal trace (name + mailing address) for individual owners. Advanced trace
// (address only: finds the current owner) for companies, trusts and probate
// rows, where the person on the list isn't the one to reach.
// Every paid step checks agent_budget_left('scrub') first, and every job records
// what it spent in cost_cents.

const CENTS_PER_CREDIT = 2;
const CREDITS: Record<TraceType, number> = { normal: 1, advanced: 2 };
const DNC_CREDITS_PER_OWNER_ESTIMATE = 3; // up to ~3 phones each

// Tracerfy's mock server (fake data, no charges): skip the budget gate and record $0.
// Against the real server the gate always applies.
export const isTestMode = (config: Ctx['config']) => /(^|\/\/)mock\./.test(config.tracerfyBase);
const budgetLeft = async (db: Db, ctx: { config: Ctx['config']; businessId: string }) =>
  isTestMode(ctx.config) ? Number.MAX_SAFE_INTEGER : clientBudgetLeft(db, ctx.businessId, 'scrub');

export function estimateCents(type: TraceType, rows: number, dnc: boolean): number {
  return rows * (CREDITS[type] + (dnc ? DNC_CREDITS_PER_OWNER_ESTIMATE : 0)) * CENTS_PER_CREDIT;
}

// Owners already sent to Tracerfy (any row with the same owner_key), so a
// repeat owner on next month's list is never paid for twice.
const TRACED_SQL = (r: string) => `exists (
  select 1 from public.agent_jobs j, public.list_rows r2
   where j.business_id = ${r}.business_id and j.job_type = 'skiptrace.submit'
     and j.status in ('queued', 'running', 'done')
     and coalesce((j.result ->> 'test_mode')::boolean, false) = false
     and (j.input -> 'list_row_ids') ? r2.id::text
     and r2.owner_key = ${r}.owner_key)`;

// ---- plan.skiptrace -----------------------------------------------------------

export const planSkiptrace: Handler = async ({ db, job, config, tracerfy }) => {
  if (!tracerfy) return { status: 'done', result: { skipped: 'Tracerfy is not connected' } };
  const left = await budgetLeft(db, { config, businessId: job.business_id });
  const perRow = estimateCents('advanced', 1, config.skiptraceDnc); // worst case per owner
  const affordable = Math.floor(left / perRow);
  // Owners Francis asked about (CRM buttons) go first, up to SKIPTRACE_ASKED_DAILY_LIMIT a day
  // and the budget; the rest wait for the next day. The daily limit caps the automatic picks.
  const autoLimit = Math.max(0, Number((job.input as { limit?: number }).limit ?? config.skiptraceDailyLimit));
  // Clicked owners are capped per day (Central time) so one click can't spend the month's budget.
  const { rows: today } = await db.query(
    `select coalesce(sum((result ->> 'asked')::int), 0)::int as n from public.agent_jobs
      where business_id = $1 and job_type = 'plan.skiptrace' and status = 'done' and id <> $2
        and coalesce(result ->> 'budget_left_cents', '') <> 'test mode'
        and finished_at >= (date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago')`,
    [job.business_id, job.id],
  );
  const askedLeftToday = Math.max(0, config.skiptraceAskedDailyLimit - (today[0]?.n ?? 0));
  const askedLimit = Math.min(affordable, askedLeftToday, 500);
  if (affordable <= 0) {
    return { status: 'done', result: { skipped: "Francis's Scrub budget is $0 or used up", budget_left_cents: left } };
  }
  const [bandLo, bandHi] = config.skiptraceFirstBand;

  const { rows: candidates } = await db.query(
    `with owners as (
       select distinct on (r.owner_key)
              r.id, r.owner_key, r.bucket, r.vendor_rank, r.owner_name, r.raw,
              ${PROBATE_SQL('r')} as probate,
              ${DOORS_SQL('r')} as doors,
              exists (select 1 from public.agent_jobs pl
                       where pl.business_id = r.business_id and pl.job_type = 'person.lookup' and pl.status = 'done'
                         and pl.input ->> 'list_row_id' = r.id::text) as asked_person,
              (r.entity_id is not null and exists (
                     select 1 from public.agent_jobs el
                      where el.business_id = r.business_id and el.job_type = 'entity.lookup' and el.status = 'done'
                        and (el.result ->> 'queued_for_next_batch')::boolean
                        and el.input ->> 'entity_id' = r.entity_id::text)) as asked_entity
         from public.list_rows r
        where r.business_id = $1 and r.owner_key is not null and r.property_address is not null
          and ${LIST_DONE_SQL('r')}
          and not ${TRACED_SQL('r')}
        order by r.owner_key, r.vendor_rank nulls last
     )
     select o.*, (o.asked_person or o.asked_entity) as asked from owners o
      -- Big companies (20+ doors) are skipped unless that one owner was asked
      -- about; the list-wide LLC button doesn't override it.
      where o.asked_person or not (o.bucket = 'entity' and o.doors >= $5)
      order by (o.asked_person or o.asked_entity) desc,
               case when o.vendor_rank between $3 and $4 then 0 when o.vendor_rank < $3 then 1 else 2 end,
               (o.doors >= 2) desc, o.vendor_rank nulls last
      limit $2`,
    [job.business_id, askedLimit + autoLimit, bandLo, bandHi, config.skipBigCompanyDoors],
  );
  const askedRows = candidates.filter((r) => r.asked).slice(0, askedLimit);
  const autoRows = candidates.filter((r) => !r.asked).slice(0, Math.max(0, Math.min(autoLimit, affordable - askedRows.length)));
  const rows = [...askedRows, ...autoRows];

  const normal: string[] = [];
  const advanced: string[] = [];
  for (const r of rows) {
    const person = parseOwnerName(r.owner_name, firstNameFromRaw(r.raw))[0];
    if (r.bucket === 'entity' || r.probate || !person) advanced.push(r.id);
    else normal.push(r.id);
  }
  const day = new Date().toISOString().slice(0, 10);
  return {
    status: 'done',
    result: {
      normal: normal.length, advanced: advanced.length, asked: askedRows.length,
      asked_left_today: askedLeftToday - askedRows.length,
      budget_left_cents: isTestMode(config) ? 'test mode' : left,
    },
    write: async (tx) => {
      let queued = 0;
      for (const [type, ids] of [['normal', normal], ['advanced', advanced]] as const) {
        if (!ids.length) continue;
        const r = await tx.query(
          `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status)
           values ($1, 'scrub', 'skiptrace.submit', $2::jsonb, $3, 'queued') on conflict (idempotency_key) do nothing`,
          [job.business_id, JSON.stringify({ trace_type: type, list_row_ids: ids }), `skiptrace.submit:${job.business_id}:${day}:${type}:${job.id}`],
        );
        queued += r.rowCount ?? 0;
      }
      return { batches_queued: queued };
    },
  };
};

// ---- skiptrace.submit -------------------------------------------------------

const SubmitInput = z.object({ trace_type: z.enum(['normal', 'advanced']), list_row_ids: z.array(z.string().regex(UUID_RE)).min(1).max(500) });

export const skiptraceSubmit: Handler = async ({ db, job, config, tracerfy }) => {
  const parsed = SubmitInput.safeParse(job.input);
  if (!parsed.success) return { status: 'failed', error: 'input needs trace_type and list_row_ids' };
  if (!tracerfy) return { status: 'blocked', error: 'Tracerfy is not connected (TRACERFY_API_KEY not set).' };
  const { trace_type, list_row_ids } = parsed.data;

  const { rows } = await db.query(
    `select id, owner_name, raw, property_address, property_city, property_state, property_zip,
            mailing_address, mailing_city, mailing_state, mailing_zip
       from public.list_rows where business_id = $1 and id = any($2::uuid[])`,
    [job.business_id, list_row_ids],
  );
  const records: TraceRecord[] = [];
  for (const r of rows) {
    const rec: TraceRecord = {
      ref: r.id, address: r.property_address ?? '', city: r.property_city ?? '',
      state: (r.property_state ?? 'KS').slice(0, 2), zip: String(r.property_zip ?? '').slice(0, 5),
    };
    if (trace_type === 'normal') {
      const p = parseOwnerName(r.owner_name, firstNameFromRaw(r.raw))[0];
      if (!p || !r.mailing_address) continue;
      Object.assign(rec, {
        first_name: titleCase(p.first), last_name: titleCase(p.last),
        mail_address: r.mailing_address, mail_city: r.mailing_city ?? '',
        mail_state: (r.mailing_state ?? '').slice(0, 2), mail_zip: String(r.mailing_zip ?? '').slice(0, 5),
      });
    }
    if (rec.address && rec.city) records.push(rec);
  }
  if (!records.length) return { status: 'done', result: { skipped: 'no rows with enough address data' } };

  // The budget check right before the paid call (handoff rule).
  const estimate = estimateCents(trace_type, records.length, config.skiptraceDnc);
  const left = await budgetLeft(db, { config, businessId: job.business_id });
  if (left < estimate) {
    return { status: 'blocked', error: `Not enough Scrub budget left this month ($${(left / 100).toFixed(2)} left, batch needs up to $${(estimate / 100).toFixed(2)}).`, result: { budget_left_cents: left, estimate_cents: estimate } };
  }

  const { queueId } = await tracerfy.submitTrace(trace_type, records);
  const traceCents = isTestMode(config) ? 0 : records.length * CREDITS[trace_type] * CENTS_PER_CREDIT;
  return {
    status: 'done',
    // Held at the most this batch can cost until collect records the real charge.
    costCents: traceCents,
    result: { queue_id: queueId, trace_type, rows_sent: records.length, max_trace_cents: traceCents, test_mode: isTestMode(config) || undefined },
    write: async (tx) => {
      await tx.query(
        `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status, run_after)
         values ($1, 'scrub', 'skiptrace.collect', $2::jsonb, $3, 'queued', now() + interval '90 seconds')
         on conflict (idempotency_key) do nothing`,
        [job.business_id, JSON.stringify({ submit_job_id: job.id, queue_id: queueId, trace_type }), `skiptrace.collect:${job.id}`],
      );
    },
  };
};

// ---- skiptrace.collect ------------------------------------------------------

const CollectInput = z.object({ submit_job_id: z.string().regex(UUID_RE), queue_id: z.number(), trace_type: z.enum(['normal', 'advanced']) });

type PendingPhone = { list_row_id: string; entity_id: string | null; phone: string; rank: number; flagged_dnc: boolean; litigator: boolean };

export const skiptraceCollect: Handler = async ({ db, job, config, tracerfy }) => {
  const parsed = CollectInput.safeParse(job.input);
  if (!parsed.success) return { status: 'failed', error: 'input needs submit_job_id, queue_id, trace_type' };
  if (!tracerfy) return { status: 'blocked', error: 'Tracerfy is not connected (TRACERFY_API_KEY not set).' };
  const { submit_job_id, queue_id, trace_type } = parsed.data;

  const q = await tracerfy.getQueue(queue_id);
  if (!q || q.pending) {
    if (await olderThan(db, job.id, '3 hours')) return { status: 'failed', error: `Tracerfy batch ${queue_id} still not finished after 3 hours.` };
    return { status: 'wait', delaySec: 90, result: { queue_id, waiting: q ? 'pending' : 'not listed yet', note: q?.note } };
  }

  const resultRows = await tracerfy.getQueueRows(queue_id);
  const sub = await db.query(`select input from public.agent_jobs where id = $1`, [submit_job_id]);
  const ids: string[] = sub.rows[0]?.input?.list_row_ids ?? [];
  const { rows: listRows } = await db.query(
    `select id, entity_id, property_address, property_city from public.list_rows where id = any($1::uuid[])`,
    [ids],
  );
  const byRef = new Map(listRows.map((r) => [r.id as string, r]));
  const byAddr = new Map(listRows.map((r) => [addressKey(r.property_address ?? '', r.property_city ?? ''), r]));

  const confFactor = trace_type === 'advanced' ? 0.9 : 1;
  const conf = (rank: number) => Math.round(Math.max(0.5, 0.9 - 0.1 * (rank - 1)) * confFactor * 100) / 100;
  const emails: { list_row_id: string; entity_id: string | null; email: string; confidence: number }[] = [];
  const members: { list_row_id: string; entity_id: string; name: string }[] = [];
  const phones: PendingPhone[] = [];
  let matched = 0;
  let unmatched = 0;
  let deceased = 0;
  // What Tracerfy actually sent, to check the column mapping (no personal data).
  const parsedAll = resultRows.map((r) => contactsFromRow(r));
  const shape = {
    columns: Object.keys(resultRows[0] ?? {}).slice(0, 40),
    rows_with_phones: parsedAll.filter((c) => c.phones.length).length,
    rows_with_emails: parsedAll.filter((c) => c.emails.length).length,
    rows_with_names: parsedAll.filter((c) => c.names.length).length,
    rows_with_ref: parsedAll.filter((c) => c.ref).length,
    // Mock data is fake, so in test mode show addresses side by side to check matching.
    ...(isTestMode(config)
      ? {
          sample_returned: parsedAll.slice(0, 3).map((c) => `${c.address} | ${c.city}`),
          sample_sent: listRows.slice(0, 3).map((r) => `${r.property_address} | ${r.property_city}`),
        }
      : {}),
  };

  for (const raw of resultRows) {
    const c = contactsFromRow(raw);
    const lr = (c.ref && byRef.get(c.ref)) || byAddr.get(addressKey(c.address, c.city));
    if (!lr) { unmatched++; continue; }
    matched++;
    // Normal trace on a person who has died: no one to reach at these numbers.
    if (c.deceased && trace_type === 'normal') { deceased++; continue; }
    for (const e of c.emails) emails.push({ list_row_id: lr.id, entity_id: lr.entity_id, email: e.email, confidence: conf(e.rank) });
    for (const p of c.phones) phones.push({ list_row_id: lr.id, entity_id: lr.entity_id, phone: p.phone, rank: p.rank, flagged_dnc: p.flaggedDnc, litigator: c.litigator });
    if (lr.entity_id) for (const n of c.names) members.push({ list_row_id: lr.id, entity_id: lr.entity_id, name: titleCase(n) });
  }

  const actualCents = isTestMode(config) ? 0 : q.creditsDeducted !== null ? q.creditsDeducted * CENTS_PER_CREDIT : null;
  const uniquePhones = [...new Set(phones.map((p) => p.phone))];
  let dncQueueId: number | null = null;
  if (config.skiptraceDnc && uniquePhones.length) {
    const est = uniquePhones.length * CENTS_PER_CREDIT;
    const left = await budgetLeft(db, { config, businessId: job.business_id });
    if (left >= est) dncQueueId = (await tracerfy.submitDnc(uniquePhones)).dncQueueId;
  }
  const source = `tracerfy ${trace_type} trace`;

  return {
    status: 'done',
    lockKey: `skiptrace:${submit_job_id}`,
    result: {
      queue_id, rows_returned: resultRows.length, matched, unmatched, deceased_skipped: deceased, shape,
      emails: emails.length, entity_members: members.length, phones: phones.length,
      dnc_queue_id: dncQueueId,
      // Phones wait here until the DNC scrub comes back (skiptrace.dnc saves them).
      pending_phones: phones,
      phones_held_back: config.skiptraceDnc && !dncQueueId && phones.length ? 'budget ran out before the DNC scrub' : undefined,
    },
    write: async (tx) => {
      // Test mode: mock data must never land on Francis's real owners.
      if (isTestMode(config)) {
        if (dncQueueId) {
          await tx.query(
            `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status, run_after)
             values ($1, 'scrub', 'skiptrace.dnc', $2::jsonb, $3, 'queued', now() + interval '60 seconds')
             on conflict (idempotency_key) do nothing`,
            [job.business_id, JSON.stringify({ collect_job_id: job.id, dnc_queue_id: dncQueueId, trace_type }), `skiptrace.dnc:${job.id}`],
          );
        }
        return { test_mode: true, findings_saved: 0, would_save: { emails: emails.length, entity_members: members.length, phones: phones.length } };
      }
      // The submit job held the most the batch could cost; set what Tracerfy actually charged.
      if (actualCents !== null) {
        await tx.query(`update public.agent_jobs set cost_cents = $2 where id = $1`, [submit_job_id, actualCents]);
      }
      let saved = 0;
      for (const e of emails) saved += await insertFinding(tx, job, { kind: 'email', value: e.email, list_row_id: e.list_row_id, entity_id: null, confidence: e.confidence, source, dnc: false });
      for (const m of members) saved += await insertFinding(tx, job, { kind: 'entity_member', value: m.name, list_row_id: m.list_row_id, entity_id: m.entity_id, confidence: 0.7, source, dnc: false });
      // DNC scrub off: save phones with Tracerfy's own flags (litigators always do-not-call).
      if (!config.skiptraceDnc) {
        for (const p of phones) saved += await insertFinding(tx, job, { kind: 'phone', value: p.phone, list_row_id: p.list_row_id, entity_id: null, confidence: conf(p.rank), source, dnc: p.flagged_dnc || p.litigator });
      }
      if (dncQueueId) {
        await tx.query(
          `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status, run_after)
           values ($1, 'scrub', 'skiptrace.dnc', $2::jsonb, $3, 'queued', now() + interval '60 seconds')
           on conflict (idempotency_key) do nothing`,
          [job.business_id, JSON.stringify({ collect_job_id: job.id, dnc_queue_id: dncQueueId, trace_type }), `skiptrace.dnc:${job.id}`],
        );
      }
      return { findings_saved: saved, trace_cents: actualCents };
    },
  };
};

// ---- skiptrace.dnc ----------------------------------------------------------

const DncInput = z.object({ collect_job_id: z.string().regex(UUID_RE), dnc_queue_id: z.number(), trace_type: z.enum(['normal', 'advanced']) });

export const skiptraceDnc: Handler = async ({ db, job, config, tracerfy }) => {
  const parsed = DncInput.safeParse(job.input);
  if (!parsed.success) return { status: 'failed', error: 'input needs collect_job_id, dnc_queue_id, trace_type' };
  if (!tracerfy) return { status: 'blocked', error: 'Tracerfy is not connected (TRACERFY_API_KEY not set).' };
  const { collect_job_id, dnc_queue_id, trace_type } = parsed.data;

  const q = await tracerfy.getDncQueue(dnc_queue_id);
  if (!q || q.pending) {
    if (await olderThan(db, job.id, '3 hours')) return { status: 'failed', error: `DNC scrub ${dnc_queue_id} still not finished after 3 hours.` };
    return { status: 'wait', delaySec: 60, result: { dnc_queue_id, waiting: true } };
  }
  const col = await db.query(`select result from public.agent_jobs where id = $1`, [collect_job_id]);
  const pending: PendingPhone[] = col.rows[0]?.result?.pending_phones ?? [];
  const scrub = new Map(q.results.map((r) => [r.phone, r]));
  const source = `tracerfy ${trace_type} trace, DNC scrubbed`;
  const conf = (rank: number) => Math.round(Math.max(0.5, 0.9 - 0.1 * (rank - 1)) * (trace_type === 'advanced' ? 0.9 : 1) * 100) / 100;
  const charged = q.creditsDeducted !== null ? q.creditsDeducted : new Set(pending.map((p) => p.phone)).size;

  return {
    status: 'done',
    lockKey: `skiptrace-dnc:${collect_job_id}`,
    costCents: isTestMode(config) ? 0 : charged * CENTS_PER_CREDIT,
    result: { dnc_queue_id, phones: pending.length, scrubbed: q.results.length },
    write: async (tx) => {
      let saved = 0;
      let flagged = 0;
      if (isTestMode(config)) {
        flagged = pending.filter((p) => { const s2 = scrub.get(p.phone); return !s2 || !s2.clean || s2.litigator; }).length;
        return { test_mode: true, findings_saved: 0, would_save_phones: pending.length, would_flag_do_not_call: flagged };
      }
      for (const p of pending) {
        const s = scrub.get(p.phone);
        // Not in the scrub results = unknown = treat as Do Not Call.
        const dnc = !s || !s.clean || s.litigator || p.litigator || p.flagged_dnc;
        if (dnc) flagged++;
        saved += await insertFinding(tx, job, { kind: 'phone', value: p.phone, list_row_id: p.list_row_id, entity_id: null, confidence: conf(p.rank), source, dnc });
      }
      return { findings_saved: saved, do_not_call: flagged };
    },
  };
};

// ---- person.lookup (CRM "Find info" button) ----------------------------------

const LookupInput = z.object({ list_row_id: z.string().regex(UUID_RE) });

export const personLookup: Handler = async ({ db, job, config, tracerfy }) => {
  const parsed = LookupInput.safeParse(job.input);
  if (!parsed.success) return { status: 'failed', error: 'input needs list_row_id (uuid)' };
  const left = await budgetLeft(db, { config, businessId: job.business_id });
  if (!tracerfy) return { status: 'blocked', error: 'Skip trace is not connected yet (Tracerfy key not set).', result: { budget_left_cents: left } };
  if (left <= 0) {
    return { status: 'blocked', error: "Skip trace is off: Francis's Scrub budget for this month is $0 or used up. Set it in Settings.", result: { budget_left_cents: left } };
  }
  const { rows } = await db.query(
    `select r.id, ${TRACED_SQL('r')} as traced from public.list_rows r where r.id = $1 and r.business_id = $2`,
    [parsed.data.list_row_id, job.business_id],
  );
  if (!rows[0]) return { status: 'failed', error: 'list row not found in this business' };
  if (rows[0].traced) return { status: 'done', result: { skipped: 'owner already looked up' } };
  // Lookups run in batches (2¢ a hit instead of 10¢ one at a time). A batch for
  // everything asked about goes out within about 15 minutes.
  return { status: 'done', result: { queued_for_next_batch: true }, write: (tx) => queueAskedBatch(tx, job.business_id) };
};

// entity.lookup (CRM "Find the people behind an LLC"): the Kansas SOS search is
// behind a CAPTCHA, so the LLC's property rows go through Tracerfy's advanced
// trace instead, which finds the people behind the owner of record.
export async function entityViaSkiptrace(ctx: Ctx, entityId: string): Promise<import('../types.ts').Outcome> {
  const { db, job, config } = ctx;
  const left = await budgetLeft(db, { config, businessId: job.business_id });
  if (left <= 0) {
    return { status: 'blocked', error: "LLC lookups use paid skip trace: Francis's Scrub budget for this month is $0 or used up. Set it in Settings.", result: { budget_left_cents: left } };
  }
  const { rows } = await db.query(
    `select count(*)::int as n, count(*) filter (where not ${TRACED_SQL('r')})::int as todo,
            greatest(count(distinct r.property_key), coalesce(max(${DOORS_SQL('r')}), 0))::int as doors
       from public.list_rows r where r.business_id = $1 and r.entity_id = $2 and r.property_address is not null`,
    [job.business_id, entityId],
  );
  if (!rows[0].n) return { status: 'done', result: { skipped: 'no list rows for this LLC' } };
  if (rows[0].doors >= config.skipBigCompanyDoors) {
    return { status: 'done', result: { skipped: `big company (${rows[0].doors} properties): not traced`, doors: rows[0].doors } };
  }
  if (!rows[0].todo) return { status: 'done', result: { skipped: 'LLC already looked up' } };
  return { status: 'done', result: { queued_for_next_batch: true, via: 'skip trace (advanced)', rows: rows[0].todo }, write: (tx) => queueAskedBatch(tx, job.business_id) };
}

async function queueAskedBatch(tx: Tx, businessId: string): Promise<void> {
  // One planner per 5-minute slot, however many owners were clicked; limit 0 = only
  // owners someone asked about. It runs 5 minutes after its slot ends, so every click
  // in the slot has been processed first: a click goes out within about 5-10 minutes.
  const slotStart = Math.floor(Date.now() / 300_000) * 300_000;
  const slot = new Date(slotStart).toISOString().slice(0, 16);
  await tx.query(
    `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status, run_after)
     values ($1, 'manager', 'plan.skiptrace', '{"limit": 0}'::jsonb, $2, 'queued', to_timestamp($3::double precision / 1000))
     on conflict (idempotency_key) do nothing`,
    [businessId, `plan.skiptrace:asked:${businessId}:${slot}`, slotStart + 600_000],
  );
}

// ---- helpers ------------------------------------------------------------------

async function insertFinding(
  tx: Tx,
  job: Ctx['job'],
  f: { kind: 'email' | 'phone' | 'entity_member'; value: string; list_row_id: string; entity_id: string | null; confidence: number; source: string; dnc: boolean },
): Promise<number> {
  // Matches the migration 14 duplicate guard, so a repeat is skipped rather than
  // failing the whole batch.
  const r = await tx.query(
    `insert into public.enrichment_results
       (business_id, job_id, list_row_id, entity_id, kind, value, confidence, source, do_not_call, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     on conflict (business_id, kind, lower(value), coalesce(person_id, entity_id, list_row_id)) where status <> 'rejected'
     do nothing`,
    [job.business_id, job.id, f.list_row_id, f.entity_id, f.kind, f.value, f.confidence, f.source, f.dnc],
  );
  return r.rowCount ?? 0;
}

async function olderThan(db: Db, jobId: string, interval: string): Promise<boolean> {
  const { rows } = await db.query(`select created_at < now() - $2::interval as old from public.agent_jobs where id = $1`, [jobId, interval]);
  return rows[0]?.old === true;
}
