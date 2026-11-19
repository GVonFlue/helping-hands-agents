import { test, before } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { admin, config, count, fakeSearch, HH, run } from './helpers.ts';
import type { Tracerfy } from '../src/tracerfy.ts';

// run.custom only needs Tracerfy to be connected; the batches it queues are
// sent by skiptrace.submit (tested in db.08).
const tf = {} as Tracerfy;
const search = fakeSearch(() => []);
const IMP = '10000000-0000-0000-0000-0000000000c1';
// Tracerfy's test server: the budget gate is skipped (budget limits are tested with max_spend_cents).
const cfg = config({ tracerfyBase: 'https://mock.tracerfy.com' });

// The CRM's preview function (crm-requests/agent_run_preview.sql), called the way the
// Control page will: as a signed-in user, under RLS.
async function preview(input: Record<string, unknown>) {
  const biz = await HH();
  const c = await admin.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000f001', 'role', 'authenticated')::text, true)`);
    await c.query('set local role authenticated');
    const r = await c.query(`select public.agent_run_preview($1, $2, $3, $4, $5, $6) as p`,
      [biz, input.list_import_id, input.rank_from, input.rank_to, input.owner_types, input.include_mailed ?? false]);
    return r.rows[0].p;
  } finally {
    await c.query('rollback');
    c.release();
  }
}

before(async () => {
  await admin.query(readFileSync(new URL('../crm-requests/agent_run_preview.sql', import.meta.url), 'utf8'));
  const biz = await HH();
  await admin.query(
    `insert into public.list_imports (id, business_id, file_name, vendor, status, row_count)
     values ($1, $2, 'control-test.csv', 'vendor', 'done', 7)`,
    [IMP, biz],
  );
  await admin.query(
    `insert into public.list_rows (import_id, business_id, row_num, owner_name, mailing_address, mailing_city, mailing_state, mailing_zip,
       property_address, property_city, property_state, property_zip, vendor_rank, owner_key, property_key, bucket, mail_selected, raw)
     select $1, $2, v.n, v.owner, '1 Mail St', 'WICHITA', 'KS', '67202', v.addr, 'WICHITA', 'KS', '67202', v.rank, v.okey, v.pkey,
            v.bucket, v.mailed, v.raw::jsonb
       from (values
         (1, 'ANNA ABLE',          '11 Run St', 1,    'c-able',  'cp-1', 'individual_investor', false, '{"FIRST NAME":"ANNA","OWNER TOTAL PROPERTIES":"1"}'),
         (2, 'BIG RENTALS LLC',    '12 Run St', 2,    'c-big',   'cp-2', 'entity',              false, '{"OWNER TOTAL PROPERTIES":"45"}'),
         (3, 'EDNA ESTATE',        '13 Run St', 3,    'c-edna',  'cp-3', 'owner_occupied',      false, '{"FIRST NAME":"EDNA","PROBATE ADDRESS ID":"123.0"}'),
         (4, 'MARK MAILED',        '14 Run St', 4,    'c-mark',  'cp-4', 'individual_investor', true,  '{"FIRST NAME":"MARK"}'),
         (5, 'SMALL HOLDINGS LLC', '15 Run St', 5,    'c-small', 'cp-5', 'entity',              false, '{"OWNER TOTAL PROPERTIES":"2"}'),
         (6, 'PETE PERSON',        '16 Run St', 6,    'c-pete',  'cp-6', 'individual_investor', false, '{"FIRST NAME":"PETE"}'),
         (7, 'FAR AWAY',           '17 Run St', 1200, 'c-far',   'cp-7', 'individual_investor', false, '{"FIRST NAME":"FAR"}')
       ) as v(n, owner, addr, rank, okey, pkey, bucket, mailed, raw)`,
    [IMP, biz],
  );
});


const top1000 = { list_import_id: IMP, rank_from: 1, rank_to: 1000 };

test('custom run: top 1,000, every kind of owner, phones+emails and Facebook', async () => {
  const settings = { ...top1000, owner_types: ['person', 'company', 'estate'] };
  const before = await preview(settings);
  const job = await run({ tracerfy: tf, search, config: cfg }, {
    type: 'run.custom', agent: 'manager',
    input: { ...top1000, owner_types: ['person', 'company', 'estate'], find: ['contact', 'facebook'] },
  });
  assert.equal(job.status, 'done', job.error);
  const r = job.result;
  assert.equal(r.owners_in_ranks, 6, 'rank 1200 is outside the top 1,000');
  assert.equal(r.owners_picked, 5);
  assert.equal(r.skipped_mailed, 1, 'owners marked for the mailer are left out unless asked');
  assert.equal(r.contact.to_look_up, 4);
  assert.equal(r.contact.people, 2);
  assert.equal(r.contact.companies_and_estates, 2, 'estate and small LLC get the address-only trace');
  assert.equal(r.contact.skipped_big_companies, 1);
  assert.equal(r.facebook.to_search, 2, 'Facebook for people only');
  assert.equal(r.facebook.not_people, 3);
  assert.equal(r.batches_queued, 2);
  assert.equal(r.searches_queued, 2);

  // The CRM's preview showed exactly what the run did.
  for (const k of ['owners_in_ranks', 'owners_picked', 'skipped_mailed']) assert.equal(before[k], r[k], k);
  for (const k of ['to_look_up', 'people', 'companies_and_estates', 'already_looked_up', 'skipped_big_companies']) {
    assert.equal(before.contact[k], r.contact[k], `contact.${k}`);
  }
  assert.equal(before.contact.max_cents, 2 * 14 + 2 * 16);
  assert.equal(r.contact.estimated_max_cents, 0, 'test mode records $0');
  for (const k of ['to_search', 'already_searched', 'not_people']) assert.equal(before.facebook[k], r.facebook[k], `facebook.${k}`);

  const subs = (await admin.query(
    `select input from public.agent_jobs where job_type = 'skiptrace.submit' and input ->> 'run_id' = $1 order by input ->> 'trace_type'`,
    [job.id],
  )).rows.map((x) => x.input);
  assert.deepEqual(subs.map((s) => [s.trace_type, s.list_row_ids.length]), [['advanced', 2], ['normal', 2]]);
  assert.equal(await count(`select 1 from public.agent_jobs where job_type = 'person.facebook' and input ->> 'run_id' = $1`, [job.id]), 2);
});

test('custom run again: nothing is looked up twice', async () => {
  // The first run's batches went out (run() parks other queued jobs, so mark them sent).
  await admin.query(`update public.agent_jobs set status = 'done' where job_type in ('skiptrace.submit', 'person.facebook') and input ? 'run_id'`);
  const job = await run({ tracerfy: tf, search, config: cfg }, {
    type: 'run.custom', agent: 'manager',
    input: { ...top1000, owner_types: ['person', 'company', 'estate'], find: ['contact', 'facebook'] },
  });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.contact.to_look_up, 0);
  assert.equal(job.result.contact.already_looked_up, 4);
  assert.equal(job.result.facebook.to_search, 0);
  assert.equal(job.result.facebook.already_searched, 2);
  assert.equal(job.result.batches_queued, 0);
  const after = await preview({ ...top1000, owner_types: ['person', 'company', 'estate'] });
  assert.equal(after.contact.to_look_up, 0);
  assert.equal(after.contact.already_looked_up, 4);
  assert.equal(after.facebook.already_searched, 2);
});

test('custom run: a spending limit for the run holds owners back instead of sending them', async () => {
  const job = await run({ tracerfy: tf, search, config: cfg }, {
    type: 'run.custom', agent: 'manager',
    input: { ...top1000, owner_types: ['person'], include_mailed: true, find: ['contact'], max_spend_cents: 0 },
  });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.contact.over_budget, 1, 'Mark (mailed, not yet looked up) is over the $0 limit');
  assert.equal(job.result.contact.to_look_up, 0);
  assert.equal(job.result.batches_queued, 0);
  assert.equal(job.result.facebook, undefined, 'Facebook not asked for');
});

test('custom run: Facebook only for people queues no paid lookups', async () => {
  const job = await run({ tracerfy: tf, search, config: cfg }, {
    type: 'run.custom', agent: 'manager',
    input: { ...top1000, rank_to: 2000, owner_types: ['person'], include_mailed: true, find: ['facebook'] },
  });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.facebook.to_search, 2, 'Mark and the rank-1200 owner');
  assert.equal(job.result.batches_queued, 0);
  assert.equal(job.result.contact, undefined);
});

test('custom run: settings that make no sense fail with a plain reason', async () => {
  const bad = await run({ tracerfy: tf, search, config: cfg }, {
    type: 'run.custom', agent: 'manager', input: { ...top1000, owner_types: [], find: ['contact'] },
  });
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /owner_types/);
  const backwards = await run({ tracerfy: tf, search, config: cfg }, {
    type: 'run.custom', agent: 'manager', input: { list_import_id: IMP, rank_from: 500, rank_to: 10, owner_types: ['person'], find: ['facebook'] },
  });
  assert.equal(backwards.status, 'failed');
});

test('custom run: clean up test data', async () => {
  await admin.query(`delete from public.agent_jobs where job_type = 'run.custom' or input ? 'run_id'`);
  await admin.query(`delete from public.list_imports where id = $1`, [IMP]);
});
