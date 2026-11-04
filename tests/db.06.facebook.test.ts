import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, config, count, fakeSearch, run } from './helpers.ts';
import type { SearchHit } from '../src/search.ts';

const ROW = {
  stoltenberg: '20000000-0000-0000-0000-000000000001',
  stoltenberg2: '20000000-0000-0000-0000-000000000002',
  smith: '20000000-0000-0000-0000-000000000003',
  acme: '20000000-0000-0000-0000-000000000004',
  quint: '20000000-0000-0000-0000-000000000005',
  zimm: '20000000-0000-0000-0000-000000000006',
  elder: '20000000-0000-0000-0000-000000000007',
};

const RESULTS: Record<string, SearchHit[]> = {
  Stoltenberg: [
    { url: 'https://www.facebook.com/karl.stoltenberg.7', title: 'Karl J. Stoltenberg | Facebook', snippet: 'Lives in Wichita, Kansas. Married to Diane Stoltenberg.' },
    { url: 'https://de-de.facebook.com/karl.stoltenberg.de', title: 'Karl Stoltenberg - Facebook', snippet: 'Lives in Hamburg, Germany.' },
    { url: 'https://www.facebook.com/groups/1234567', title: 'Stoltenberg family | Facebook', snippet: 'Group' },
  ],
  Smith: [{ url: 'https://www.facebook.com/john.smith.4455', title: 'John Smith | Facebook', snippet: 'Lives in Wichita, Kansas.' }],
  Zimmerle: [
    { url: 'https://www.facebook.com/brent.zimmerle', title: 'Brent Zimmerle | Facebook', snippet: 'Lives in Wichita, Kansas.' },
    { url: 'https://www.facebook.com/brent.zimmerle.12', title: 'Brent Zimmerle | Facebook', snippet: 'Lives in Wichita, Kansas.' },
  ],
  Quintanilla: [{ url: 'https://m.facebook.com/maria.quintanilla.33?ref=br', title: 'Maria Quintanilla - Facebook', snippet: 'Lives in Derby, Kansas.' }],
};
const provider = () => fakeSearch((q) => Object.entries(RESULTS).find(([k]) => q.includes(k))?.[1] ?? []);

test('strong match: one pending finding linked to the list row, with confidence and source', async () => {
  const search = provider();
  const job = await run({ search }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.stoltenberg } });
  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(search.queries, ['"Karl Stoltenberg" "Wichita" site:facebook.com']);
  const f = (await admin.query(`select * from public.enrichment_results where list_row_id = $1`, [ROW.stoltenberg])).rows;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'facebook');
  assert.equal(f[0].value, 'https://www.facebook.com/karl.stoltenberg.7');
  assert.equal(f[0].status, 'pending');
  assert.equal(f[0].source, 'logged out search (test)');
  assert.ok(f[0].confidence >= 0.9 && f[0].confidence < 1);
  assert.equal(f[0].job_id, job.id);
  assert.equal(job.cost_cents, 0, "search is ProyTech's cost, not Francis's lookup budget");
  assert.equal(job.result.spend.searches, 1);
  assert.equal(job.result.spend.search_cents, 0.5);
});

test('running it again, or for the same owner on another row, finds nothing new and searches nothing', async () => {
  for (const row of [ROW.stoltenberg, ROW.stoltenberg2]) {
    const search = provider();
    const job = await run({ search }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: row } });
    assert.equal(job.status, 'done');
    assert.match(job.result.skipped, /already searched/);
    assert.equal(search.queries.length, 0);
  }
  assert.equal(await count(`select 1 from public.enrichment_results where kind = 'facebook' and status = 'pending'`), 1);
});

test('common name with only a city match is left out, and the owner counts as searched', async () => {
  const job = await run({ search: provider() }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.smith } });
  assert.equal(job.status, 'done');
  assert.match(job.result.outcome, /too weak/);
  assert.equal(await count(`select 1 from public.enrichment_results where list_row_id = $1`, [ROW.smith]), 0);
  const again = provider();
  const job2 = await run({ search: again }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.smith } });
  assert.match(job2.result.skipped, /already searched/);
  assert.equal(again.queries.length, 0, 'no money spent searching twice');
});

test('two equally good profiles: nothing is written', async () => {
  const job = await run({ search: provider() }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.zimm } });
  assert.match(job.result.outcome, /about equally/);
  assert.equal(await count(`select 1 from public.enrichment_results where list_row_id = $1`, [ROW.zimm]), 0);
});

test('companies are skipped without searching', async () => {
  const search = provider();
  const job = await run({ search }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.acme } });
  assert.match(job.result.skipped, /company or trust/);
  assert.equal(search.queries.length, 0);
});

test('no provider configured: blocked with a reason, not counted as searched', async () => {
  const job = await run({ search: null }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.quint } });
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /search provider/);
});

test("ProyTech's monthly search ceiling reached: blocked before any search", async () => {
  const search = provider();
  const job = await run({ search, config: config({ searchMonthlyCeilingCents: 0 }) }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.quint } });
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /search budget/);
  assert.equal(search.queries.length, 0);
});

test('mailed owners are still searched; mobile links are normalised', async () => {
  const job = await run({ search: provider() }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.quint } });
  assert.equal(job.status, 'done', job.error);
  const f = (await admin.query(`select value from public.enrichment_results where list_row_id = $1`, [ROW.quint])).rows;
  assert.deepEqual(f.map((x) => x.value), ['https://www.facebook.com/maria.quintanilla.33']);
});

test('probate owners are skipped without searching (owner may be deceased)', async () => {
  const search = provider();
  const job = await run({ search }, { type: 'person.facebook', agent: 'scrub', input: { list_row_id: ROW.elder } });
  assert.match(job.result.skipped, /probate/);
  assert.equal(search.queries.length, 0);
});
