import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, count, run } from './helpers.ts';
import { handlers } from '../src/registry.ts';
import { makeEntityLookup, type EntitySource } from '../src/handlers/entityLookup.ts';

const CACHED = '40000000-0000-0000-0000-000000000001';
const FRESH = '40000000-0000-0000-0000-000000000002';

test('person.lookup is parked as blocked with a clear reason', async () => {
  const job = await run({}, { type: 'person.lookup', agent: 'scrub', input: { list_row_id: '20000000-0000-0000-0000-000000000003' } });
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /skip trace is off/);
  assert.equal(job.result.budget_left_cents, 0);
  assert.equal(job.cost_cents, 0);
});

test('entity.lookup: an LLC checked in the last 90 days is skipped', async () => {
  const job = await run({}, { type: 'entity.lookup', agent: 'scrub', input: { entity_id: CACHED } });
  assert.equal(job.status, 'done');
  assert.match(job.result.skipped, /90 days/);
});

test('entity.lookup: with no source (SOS CAPTCHA) the job is blocked with the reason', async () => {
  const job = await run({}, { type: 'entity.lookup', agent: 'scrub', input: { entity_id: FRESH } });
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /CAPTCHA/);
});

test('entity.lookup with a source writes members once and stamps the cache', async () => {
  let calls = 0;
  const source: EntitySource = {
    name: 'test source',
    async lookup() {
      calls++;
      return { sosId: '1234567', status: 'Active', filingUrl: 'https://example.test/f', sourceUrl: 'https://example.test/f',
        members: [{ name: 'Pat Prairie', title: 'Member' }, { name: 'Pat Prairie', title: 'Member' }] };
    },
  };
  const original = handlers['entity.lookup'];
  handlers['entity.lookup'] = makeEntityLookup(source);
  try {
    const job = await run({}, { type: 'entity.lookup', agent: 'scrub', input: { entity_id: FRESH } });
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.members_added, 1);
    const e = (await admin.query(`select sos_id, last_checked_at from public.entities where id = $1`, [FRESH])).rows[0];
    assert.equal(e.sos_id, '1234567');
    assert.ok(e.last_checked_at);
    const again = await run({}, { type: 'entity.lookup', agent: 'scrub', input: { entity_id: FRESH } });
    assert.match(again.result.skipped, /90 days/);
    assert.equal(calls, 1, 'cached: no second lookup');
    assert.equal(await count(`select 1 from public.entity_members where entity_id = $1`, [FRESH]), 1);
  } finally {
    handlers['entity.lookup'] = original!;
  }
});
