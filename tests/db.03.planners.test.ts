import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, fakeSearch, HH, run } from './helpers.ts';

test('plan.facebook: unmailed first, 2+ doors (vendor count), then TOTAL score; mailed last; never companies or probate', async () => {
  const biz = await HH();
  const search = fakeSearch(() => []);
  const job = await run({ search }, { type: 'plan.facebook', agent: 'manager', input: { limit: 10 } });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.queued, 4);
  assert.equal(search.queries.length, 0, 'planning spends nothing');
  const q = (
    await admin.query(
      `select r.owner_key from public.agent_jobs j join public.list_rows r on r.id::text = j.input ->> 'list_row_id'
        where j.business_id = $1 and j.job_type = 'person.facebook' and j.status = 'queued' order by j.run_after`,
      [biz],
    )
  ).rows.map((r) => r.owner_key);
  // Smith has vendor_rank 1 but a lower TOTAL than Zimmerle; Elderberry is probate.
  assert.deepEqual(q, ['k-stoltenberg', 'k-zimm', 'k-smith', 'k-quint']);
});

test('plan.facebook never queues the same owner twice', async () => {
  const job = await run({ search: fakeSearch(() => []) }, { type: 'plan.facebook', agent: 'manager', input: { limit: 10 } });
  assert.equal(job.result.queued, 0);
});

test('plan.facebook skips lists that are still processing (or failed), and picks them up once done', async () => {
  const biz = await HH();
  const imp = '10000000-0000-0000-0000-0000000000f9';
  await admin.query(
    `insert into public.list_imports (id, business_id, file_name, vendor, status, row_count)
     values ($1, $2, 'half-done.csv', 'vendor', 'processing', 1)`,
    [imp, biz],
  );
  await admin.query(
    `insert into public.list_rows (import_id, business_id, row_num, owner_name, mailing_address, mailing_city, mailing_state,
       mailing_zip, property_address, property_city, property_state, property_zip, owner_key, property_key, bucket, raw)
     values ($1, $2, 1, 'PAULA NEWBERRY', '3 Ash St', 'WICHITA', 'KS', '67202', '90 Ash St', 'WICHITA', 'KS', '67202',
             'k-newberry', 'p-ash', 'individual_investor', '{"TOTAL":"99"}')`,
    [imp, biz],
  );
  try {
    for (const status of ['processing', 'failed']) {
      await admin.query(`update public.list_imports set status = $2 where id = $1`, [imp, status]);
      const fb = await run({ search: fakeSearch(() => []) }, { type: 'plan.facebook', agent: 'manager', input: { limit: 10 } });
      assert.equal(fb.result.queued, 0, `facebook ignores a ${status} list`);
    }
    await admin.query(`update public.list_imports set status = 'done' where id = $1`, [imp]);
    const fb = await run({ search: fakeSearch(() => []) }, { type: 'plan.facebook', agent: 'manager', input: { limit: 10 } });
    assert.equal(fb.result.queued, 1, 'picked up once the list is done');
  } finally {
    await admin.query(`delete from public.agent_jobs where business_id = $1 and (idempotency_key like '%k-newberry%'
                         or input::text like '%' || coalesce((select id::text from public.list_rows where owner_key = 'k-newberry'), 'none') || '%')`, [biz]);
    await admin.query(`delete from public.list_imports where id = $1`, [imp]);
  }
});

test('plan.facebook does nothing without a search provider', async () => {
  const job = await run({ search: null }, { type: 'plan.facebook', agent: 'manager', input: { limit: 10 } });
  assert.match(job.result.skipped, /no search provider/);
});

test('plan.drafts queues one first email draft per promoted person, and skips Facebook-only people', async () => {
  const biz = await HH();
  const job = await run({}, { type: 'plan.drafts', agent: 'manager', input: {} });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.queued, 1);
  assert.equal(job.result.not_queued, 1, 'Felix has only a Facebook link: Francis messages him by hand');
  const d = (await admin.query(`select input from public.agent_jobs where business_id = $1 and job_type = 'message.draft' and status = 'queued'`, [biz])).rows;
  assert.deepEqual(d[0].input, { person_id: '50000000-0000-0000-0000-000000000001', purpose: 'cold', channel: 'email' });
  const again = await run({}, { type: 'plan.drafts', agent: 'manager', input: {} });
  assert.equal(again.result.queued, 0, 'idempotent');
});

test('plan.drafts never auto-drafts to a person tied to a probate row', async () => {
  const biz = await HH();
  await admin.query(`insert into public.people (id, full_name, first_name) values ('50000000-0000-0000-0000-000000000007', 'Ruth Elderberry', 'Ruth')`);
  await admin.query(`insert into public.relationships (person_id, business_id, role_key, source) values ('50000000-0000-0000-0000-000000000007', $1, 'seller_occupant', 'seller list')`, [biz]);
  await admin.query(`insert into public.contact_points (person_id, kind, value, is_primary) values ('50000000-0000-0000-0000-000000000007', 'email', 'ruth@example.test', true)`);
  await admin.query(`update public.list_rows set person_id = '50000000-0000-0000-0000-000000000007' where id = '20000000-0000-0000-0000-000000000007'`);
  await admin.query(`insert into public.enrichment_results (business_id, person_id, list_row_id, kind, value, source, status, reviewed_at)
                     values ($1, '50000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000007', 'email', 'ruth@example.test', 'test', 'promoted', now())`, [biz]);
  const job = await run({}, { type: 'plan.drafts', agent: 'manager', input: {} });
  assert.equal(job.result.queued, 0);
  assert.equal(job.result.probate, 1);
});
