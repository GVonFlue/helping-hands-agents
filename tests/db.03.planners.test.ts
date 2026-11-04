import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, fakeSearch, HH, run } from './helpers.ts';

test('plan.facebook queues unmailed owners first (2+ doors, then rank), mailed last, never companies', async () => {
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
  assert.deepEqual(q, ['k-stoltenberg', 'k-smith', 'k-zimm', 'k-quint']);
});

test('plan.facebook never queues the same owner twice', async () => {
  const job = await run({ search: fakeSearch(() => []) }, { type: 'plan.facebook', agent: 'manager', input: { limit: 10 } });
  assert.equal(job.result.queued, 0);
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
  assert.equal(job.result.no_channel, 1, 'Felix has only a Facebook link: Francis messages him by hand');
  const d = (await admin.query(`select input from public.agent_jobs where business_id = $1 and job_type = 'message.draft' and status = 'queued'`, [biz])).rows;
  assert.deepEqual(d[0].input, { person_id: '50000000-0000-0000-0000-000000000001', purpose: 'cold', channel: 'email' });
  const again = await run({}, { type: 'plan.drafts', agent: 'manager', input: {} });
  assert.equal(again.result.queued, 0, 'idempotent');
});
