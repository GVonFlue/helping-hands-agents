import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, config, count, HH, run, runExisting } from './helpers.ts';
import { isTestMode } from '../src/handlers/skiptrace.ts';
import type { DncResult, TraceRecord, TraceType, Tracerfy } from '../src/tracerfy.ts';

// A fake Tracerfy that behaves like the docs: batches finish after one poll,
// results are flat rows, and the address comes back standardised.
function fakeTracerfy() {
  const submissions: { type: TraceType; records: TraceRecord[] }[] = [];
  const dncSubmissions: string[][] = [];
  const polls = new Map<number, number>();
  let nextId = 100;
  const t: Tracerfy & { submissions: typeof submissions; dncSubmissions: typeof dncSubmissions } = {
    submissions,
    dncSubmissions,
    async submitTrace(type, records) {
      submissions.push({ type, records });
      return { queueId: nextId++, creditsPerLead: type === 'normal' ? 1 : 2 };
    },
    async getQueue(id) {
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (n === 1) return { pending: true, creditsDeducted: null }; // first poll: still running
      const sub = submissions[id - 100]!;
      const hits = sub.records.filter((r) => !r.address.startsWith('9 Pine')).length; // Smith: a miss
      return { pending: false, creditsDeducted: hits * (sub.type === 'normal' ? 1 : 2) };
    },
    async getQueueRows(id) {
      const sub = submissions[id - 100]!;
      return sub.records.flatMap((r): Record<string, unknown>[] => {
        if (r.address.startsWith('9 Pine')) return []; // no hit
        if (r.address.startsWith('400 Oak')) {
          // No ref passed through, address standardised: matched by address.
          return [{ address: '400 OAK STREET', city: 'WICHITA', state: 'KS', first_name: 'Karl', last_name: 'Stoltenberg',
            primary_phone: '(316) 555-0001', primary_phone_type: 'Mobile', mobile_1: '3165550002', landline_1: '316-555-0001',
            email_1: 'karl@example.test', email_2: 'not-an-email', litigator: 'false' }];
        }
        if (r.address.startsWith('77 Main')) {
          return [{ ref: r.ref, address: r.address, city: r.city, owner_1_first_name: 'Pat', owner_1_last_name: 'Prairie',
            primary_phone: '3165550077', email_1: 'pat@acme.test' }];
        }
        if (r.address.startsWith('3 Willow')) {
          return [{ ref: r.ref, address: r.address, city: r.city, first_name: 'June', last_name: 'Elderberry', mobile_1: '3165550033' }];
        }
        if (r.address.startsWith('1 Maple')) {
          return [{ ref: r.ref, address: r.address, city: r.city, first_name: 'Brent', last_name: 'Zimmerle', death: 'true', primary_phone: '3165550066' }];
        }
        return [{ ref: r.ref, address: r.address, city: r.city, first_name: r.first_name, last_name: r.last_name, mobile_1: '3165550055' }];
      });
    },
    async submitDnc(phones) {
      dncSubmissions.push(phones);
      return { dncQueueId: 900 + dncSubmissions.length };
    },
    async getDncQueue(id) {
      const phones = dncSubmissions[id - 901] ?? [];
      const results: DncResult[] = phones
        .filter((p) => p !== '3165550033') // missing from the scrub = unknown
        .map((p) => ({ phone: p, clean: p !== '3165550002', litigator: false }));
      return { pending: false, creditsDeducted: phones.length, results };
    },
  };
  return t;
}

const ROW = {
  stoltenberg: '20000000-0000-0000-0000-000000000001',
  smith: '20000000-0000-0000-0000-000000000003',
  acme: '20000000-0000-0000-0000-000000000004',
  quint: '20000000-0000-0000-0000-000000000005',
  zimm: '20000000-0000-0000-0000-000000000006',
  elder: '20000000-0000-0000-0000-000000000007',
};
const tf = fakeTracerfy();
const setCap = async (cents: number) => {
  const biz = await HH();
  await admin.query(`update public.agent_settings set monthly_cap_cents = $2 where business_id = $1 and agent = 'scrub'`, [biz, cents]);
};

test('setup: Acme is linked to its LLC record', async () => {
  await admin.query(`update public.list_rows set entity_id = '40000000-0000-0000-0000-000000000001' where id = $1`, [ROW.acme]);
});

test("with Francis's cap at $0 nothing paid runs", async () => {
  await setCap(0);
  const plan = await run({ tracerfy: tf }, { type: 'plan.skiptrace', agent: 'manager', input: { limit: 50 } });
  assert.match(plan.result.skipped, /budget is \$0/);
  const ask = await run({ tracerfy: tf }, { type: 'person.lookup', agent: 'scrub', input: { list_row_id: ROW.quint } });
  assert.equal(ask.status, 'blocked');
  assert.match(ask.error, /Scrub budget/);
  assert.equal(tf.submissions.length, 0);
});

test('a CRM "Find info" click puts that owner at the front of the next batch', async () => {
  await setCap(1000);
  const ask = await run({ tracerfy: tf }, { type: 'person.lookup', agent: 'scrub', input: { list_row_id: ROW.quint } });
  assert.equal(ask.status, 'done');
  assert.equal(ask.result.queued_for_next_batch, true);
});

test('"Find the people behind an LLC" goes through skip trace (SOS is behind a CAPTCHA) and queues a batch soon', async () => {
  const job = await run({ tracerfy: tf }, { type: 'entity.lookup', agent: 'scrub', input: { entity_id: '40000000-0000-0000-0000-000000000001' } });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.queued_for_next_batch, true);
  assert.equal(job.result.rows, 1);
  // (the Find info test above already made this quarter-hour's planner; the harness cancels leftovers between tests)
  const p = (await admin.query(`select input, run_after > now() + interval '14 minutes' as later from public.agent_jobs where job_type = 'plan.skiptrace' and idempotency_key like 'plan.skiptrace:asked:%' order by created_at desc limit 1`)).rows[0];
  assert.deepEqual(p.input, { limit: 0 });
  assert.equal(p.later, true, 'runs after the slot ends');
});

test('the LLC button skips big companies (20+ properties): no batch, nothing spent', async () => {
  const biz = await HH();
  const ent = '40000000-0000-0000-0000-0000000000b1';
  await admin.query(`insert into public.entities (id, name, normalized_name) values ($1, 'Big Rentals LLC', 'big rentals')`, [ent]);
  await admin.query(
    `insert into public.list_rows (import_id, business_id, row_num, owner_name, mailing_address, mailing_city, mailing_state, mailing_zip,
       property_address, property_city, property_state, property_zip, vendor_rank, owner_key, property_key, bucket, entity_id, raw)
     values ('10000000-0000-0000-0000-000000000001', $1, 99, 'BIG RENTALS LLC', 'PO Box 9', 'DALLAS', 'TX', '75201',
             '5 Oak Ct', 'WICHITA', 'KS', '67202', 2600, 'k-big', 'p-oakct', 'entity', $2, '{"OWNER TOTAL PROPERTIES":"45"}')`,
    [biz, ent],
  );
  try {
    const job = await run({ tracerfy: tf }, { type: 'entity.lookup', agent: 'scrub', input: { entity_id: ent } });
    assert.equal(job.status, 'done', job.error);
    assert.match(job.result.skipped, /big company \(45 properties\)/);
    assert.equal(job.result.queued_for_next_batch, undefined);
  } finally {
    await admin.query(`delete from public.agent_jobs where input ->> 'entity_id' = $1`, [ent]);
    await admin.query(`delete from public.list_rows where owner_key = 'k-big'`);
    await admin.query(`delete from public.entities where id = $1`, [ent]);
  }
});

test('owners Francis asked about go out even with a daily limit of 0', async () => {
  const biz = await HH();
  const plan = await run({ tracerfy: tf }, { type: 'plan.skiptrace', agent: 'manager', input: { limit: 0 } });
  assert.equal(plan.status, 'done', plan.error);
  assert.equal(plan.result.asked, 2, 'Quintanilla (Find info) + Acme (LLC button)');
  const subs = (await admin.query(`select input from public.agent_jobs where business_id = $1 and job_type = 'skiptrace.submit' and status = 'queued'`, [biz])).rows;
  const ids = subs.flatMap((x) => x.input.list_row_ids);
  assert.deepEqual(new Set(ids), new Set([ROW.quint, ROW.acme]));
  // Park these so the next test sees a clean plan.
  await admin.query(`update public.agent_jobs set status = 'cancelled' where job_type = 'skiptrace.submit' and status = 'queued'`);
});

test('plan.skiptrace: normal trace for people, advanced for companies and probate; nothing spent yet', async () => {
  const biz = await HH();
  // A list the CRM is still processing must not be traced (ranks and keys may not be set yet).
  const halfDone = '10000000-0000-0000-0000-0000000000f8';
  await admin.query(`insert into public.list_imports (id, business_id, file_name, vendor, status, row_count)
                     values ($1, $2, 'half-done.csv', 'vendor', 'processing', 1)`, [halfDone, biz]);
  const pending = (await admin.query(
    `insert into public.list_rows (import_id, business_id, row_num, owner_name, mailing_address, mailing_city, mailing_state,
       mailing_zip, property_address, property_city, property_state, property_zip, vendor_rank, owner_key, property_key, bucket)
     values ($1, $2, 1, 'PAULA NEWBERRY', '3 Ash St', 'WICHITA', 'KS', '67202', '90 Ash St', 'WICHITA', 'KS', '67202',
             3000, 'k-newberry', 'p-ash', 'individual_investor') returning id`, [halfDone, biz])).rows[0].id;
  const plan = await run({ tracerfy: tf }, { type: 'plan.skiptrace', agent: 'manager', input: { limit: 50 } });
  await admin.query(`delete from public.list_imports where id = $1`, [halfDone]);
  assert.equal(plan.status, 'done', plan.error);
  assert.equal(plan.result.batches_queued, 2);
  assert.equal(tf.submissions.length, 0, 'planning spends nothing');
  const subs = (await admin.query(`select input from public.agent_jobs where business_id = $1 and job_type = 'skiptrace.submit' and status = 'queued'`, [biz])).rows;
  const normal = subs.find((s) => s.input.trace_type === 'normal')!.input.list_row_ids;
  const advanced = subs.find((s) => s.input.trace_type === 'advanced')!.input.list_row_ids;
  assert.equal(normal[0], ROW.quint, 'the owner Francis asked about goes first');
  assert.ok(normal.includes(ROW.stoltenberg) && normal.includes(ROW.smith) && normal.includes(ROW.zimm));
  assert.equal(normal.filter((id: string) => id === '20000000-0000-0000-0000-000000000002').length, 0, "Stoltenberg's second property: same owner, traced once");
  assert.deepEqual(new Set(advanced), new Set([ROW.acme, ROW.elder]), 'company + probate get the address-only trace');
  assert.ok(![...normal, ...advanced].includes(pending), 'rows from an unfinished list are never traced');
});

test('submit: checks the budget, sends one batch, holds its max cost, queues collect', async () => {
  const biz = await HH();
  const sub = (await admin.query(`select id from public.agent_jobs where business_id = $1 and job_type = 'skiptrace.submit' and status = 'queued' and input->>'trace_type' = 'normal'`, [biz])).rows[0];
  const job = await runExisting({ tracerfy: tf }, sub.id);
  assert.equal(job.status, 'done', job.error);
  const sent = tf.submissions[0]!;
  assert.equal(sent.type, 'normal');
  const karl = sent.records.find((r) => r.ref === ROW.stoltenberg)!;
  assert.deepEqual([karl.first_name, karl.last_name, karl.mail_address, karl.zip], ['Karl', 'Stoltenberg', '12 Elm St', '67202']);
  assert.equal(job.cost_cents, sent.records.length * 2, 'held at 2¢ a row until the real charge is known');
  assert.equal(await count(`select 1 from public.agent_jobs where job_type = 'skiptrace.collect' and status = 'queued'`), 1);
});

test('collect: waits without using an attempt, then saves emails, sends phones to DNC, fixes the cost', async () => {
  const col = (await admin.query(`select id from public.agent_jobs where job_type = 'skiptrace.collect' and status = 'queued'`)).rows[0];
  const first = await runExisting({ tracerfy: tf }, col.id);
  assert.equal(first.status, 'queued', 'batch still running: back in the queue');
  assert.equal(first.attempts, 0, 'waiting does not use up attempts');

  const done = await runExisting({ tracerfy: tf }, col.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.result.unmatched, 0, 'standardised address still matched');
  assert.equal(done.result.deceased_skipped, 1, 'Zimmerle flagged deceased: nothing saved');
  assert.equal(await count(`select 1 from public.enrichment_results where kind = 'phone'`), 0, 'no phone saved before the DNC scrub');
  const karlEmails = (await admin.query(`select value, status, confidence from public.enrichment_results where kind = 'email' and list_row_id = $1`, [ROW.stoltenberg])).rows;
  assert.deepEqual(karlEmails.map((e) => e.value), ['karl@example.test'], 'junk email dropped');
  assert.equal(karlEmails[0].status, 'pending', 'waits for Francis');
  assert.deepEqual(tf.dncSubmissions[0]!.sort(), ['3165550001', '3165550002', '3165550055'], 'deduped, 10 digits');
  const sub = (await admin.query(`select cost_cents from public.agent_jobs where id = $1`, [done.input.submit_job_id])).rows[0];
  assert.equal(sub.cost_cents, 3 * 2, 'submit job now shows what Tracerfy charged (3 hits, Smith was a free miss)');
});

test('dnc: saves phones with Do Not Call from the scrub and records its cost', async () => {
  const dnc = (await admin.query(`select id from public.agent_jobs where job_type = 'skiptrace.dnc' and status = 'queued'`)).rows[0];
  const job = await runExisting({ tracerfy: tf }, dnc.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.cost_cents, 3 * 2);
  const phones = Object.fromEntries((await admin.query(`select value, do_not_call from public.enrichment_results where kind = 'phone'`)).rows.map((r) => [r.value, r.do_not_call]));
  assert.deepEqual(phones, { '3165550001': false, '3165550002': true, '3165550055': false });
});

test('advanced batch: people behind the LLC saved as members; a phone the scrub skipped is Do Not Call', async () => {
  const biz = await HH();
  const sub = (await admin.query(`select id from public.agent_jobs where business_id = $1 and job_type = 'skiptrace.submit' and status = 'queued'`, [biz])).rows[0];
  const s = await runExisting({ tracerfy: tf }, sub.id);
  assert.equal(s.status, 'done', s.error);
  assert.equal(tf.submissions[1]!.type, 'advanced');
  assert.equal(tf.submissions[1]!.records[0]!.first_name, undefined, 'address only');
  const col = (await admin.query(`select id from public.agent_jobs where job_type = 'skiptrace.collect' and status = 'queued'`)).rows[0];
  await runExisting({ tracerfy: tf }, col.id); // waits
  const c = await runExisting({ tracerfy: tf }, col.id);
  assert.equal(c.status, 'done', c.error);
  const m = (await admin.query(`select value, entity_id from public.enrichment_results where kind = 'entity_member'`)).rows;
  assert.deepEqual(m.map((x) => [x.value, x.entity_id]), [['Pat Prairie', '40000000-0000-0000-0000-000000000001']]);
  const dnc = (await admin.query(`select id from public.agent_jobs where job_type = 'skiptrace.dnc' and status = 'queued'`)).rows[0];
  await runExisting({ tracerfy: tf }, dnc.id);
  const june = (await admin.query(`select do_not_call from public.enrichment_results where value = '3165550033'`)).rows[0];
  assert.equal(june.do_not_call, true, 'missing from scrub results = treated as Do Not Call');
});

test('nobody is paid for twice: the next plan finds no one new', async () => {
  const plan = await run({ tracerfy: tf }, { type: 'plan.skiptrace', agent: 'manager', input: { limit: 50 } });
  assert.equal(plan.result.batches_queued, 0);
  const again = await run({ tracerfy: tf }, { type: 'person.lookup', agent: 'scrub', input: { list_row_id: ROW.stoltenberg } });
  assert.match(again.result.skipped, /already looked up/);
});

test('running a collect again writes no duplicate findings', async () => {
  const biz = await HH();
  const before = await count(`select 1 from public.enrichment_results where business_id = $1`, [biz]);
  const prev = (await admin.query(`select input from public.agent_jobs where job_type = 'skiptrace.collect' and status = 'done' order by created_at limit 1`)).rows[0];
  const again = await run({ tracerfy: tf }, { type: 'skiptrace.collect', agent: 'scrub', input: prev.input });
  if (again.status === 'queued') await runExisting({ tracerfy: tf }, again.id);
  assert.equal(await count(`select 1 from public.enrichment_results where business_id = $1`, [biz]), before);
});

test('submit is blocked when the batch could cost more than the budget left', async () => {
  await setCap(1);
  const job = await run({ tracerfy: tf }, { type: 'skiptrace.submit', agent: 'scrub', input: { trace_type: 'normal', list_row_ids: [ROW.smith] } });
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /Not enough Scrub budget/);
  await setCap(0);
});

test("test mode (Tracerfy's free mock server) runs with a $0 cap and records $0; the real server never does", () => {
  assert.equal(isTestMode(config({ tracerfyBase: 'https://mock.tracerfy.com' })), true);
  assert.equal(isTestMode(config({ tracerfyBase: 'https://tracerfy.com' })), false);
  assert.equal(isTestMode(config({ tracerfyBase: 'https://tracerfy.com/mock.json' })), false);
});

test('test mode end to end: nothing saved on real owners, nobody marked as looked up, $0 recorded', async () => {
  const biz = await HH();
  const mock = fakeTracerfy();
  const cfg = config({ tracerfyBase: 'https://mock.tracerfy.com' });
  await admin.query(`update public.agent_settings set monthly_cap_cents = 0 where business_id = $1 and agent = 'scrub'`, [biz]);
  // A fresh owner nobody has traced.
  await admin.query(`insert into public.list_rows (id, import_id, business_id, row_num, owner_name, mailing_address, mailing_city, mailing_state, property_address, property_city, property_state, vendor_rank, owner_key, property_key, bucket)
                     select '20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', $1, 9, 'OLGA TESTOVA', '5 Fir St', 'WICHITA', 'KS', '5 Fir St', 'WICHITA', 'KS', 9, 'k-olga', 'p-fir', 'owner_occupied'`, [biz]);
  const before = await count(`select 1 from public.enrichment_results where business_id = $1`, [biz]);
  const plan = await run({ tracerfy: mock, config: cfg }, { type: 'plan.skiptrace', agent: 'manager', input: { limit: 50 } });
  assert.equal(plan.result.batches_queued, 1, 'cap is $0 but test mode still plans');
  const sub = (await admin.query(`select id from public.agent_jobs where job_type = 'skiptrace.submit' and status = 'queued'`)).rows[0];
  const s = await runExisting({ tracerfy: mock, config: cfg }, sub.id);
  assert.equal(s.cost_cents, 0);
  assert.equal(s.result.test_mode, true);
  const col = (await admin.query(`select id from public.agent_jobs where job_type = 'skiptrace.collect' and status = 'queued'`)).rows[0];
  await runExisting({ tracerfy: mock, config: cfg }, col.id);
  const c = await runExisting({ tracerfy: mock, config: cfg }, col.id);
  assert.equal(c.status, 'done', c.error);
  assert.ok(c.result.would_save.phones >= 1);
  const d = (await admin.query(`select id from public.agent_jobs where job_type = 'skiptrace.dnc' and status = 'queued'`)).rows[0];
  const dj = await runExisting({ tracerfy: mock, config: cfg }, d.id);
  assert.equal(dj.cost_cents, 0);
  assert.equal(await count(`select 1 from public.enrichment_results where business_id = $1`, [biz]), before, 'no mock data saved');
  // Olga can still be traced for real later.
  const real = await run({ tracerfy: mock, config: config() }, { type: 'person.lookup', agent: 'scrub', input: { list_row_id: '20000000-0000-0000-0000-000000000009' } });
  assert.doesNotMatch(String(real.result?.skipped ?? ''), /already looked up/);
});
