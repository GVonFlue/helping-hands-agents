import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, agentDb, count, fakeLlm, run } from './helpers.ts';

const PAULA = '50000000-0000-0000-0000-000000000001';
const TOM = '50000000-0000-0000-0000-000000000002';
const CORA = '50000000-0000-0000-0000-000000000003';
const OLIVE = '50000000-0000-0000-0000-000000000004';
const RITA = '50000000-0000-0000-0000-000000000006';

const emailLlm = () => fakeLlm(() => '{"subject": "Your place on Elm St", "body": "Hi Paula, ... Helping Hands"}');

test('message.draft writes one email draft, source agent, status draft', async () => {
  const llm = emailLlm();
  const job = await run({ llm }, { type: 'message.draft', agent: 'contact', input: { person_id: PAULA, purpose: 'cold', channel: 'email' } });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.written, true);
  assert.ok(Number(job.house_cost_cents) > 0, 'AI spend recorded in house_cost_cents');
  assert.equal(job.cost_cents, 0, "no charge to Francis's lookup budget");
  const d = (await admin.query(`select * from public.outbound_drafts where person_id = $1`, [PAULA])).rows;
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].channel, d[0].purpose, d[0].source, d[0].status], ['email', 'cold', 'agent', 'draft']);
  assert.equal(d[0].agent_job_id, job.id);
  assert.equal(d[0].message_id, null, 'nothing was sent');
  // The prompt only carries this person's context.
  assert.equal(JSON.parse(llm.calls[0]!.prompt).person.first_name, 'Paula');
});

test('a second draft job for the same person writes nothing while one waits', async () => {
  const llm = emailLlm();
  const job = await run({ llm }, { type: 'message.draft', agent: 'contact', input: { person_id: PAULA, purpose: 'cold', channel: 'email' } });
  assert.equal(job.status, 'done');
  assert.match(job.result.skipped, /already waiting/);
  assert.equal(llm.calls.length, 0);
  assert.equal(await count(`select 1 from public.outbound_drafts where person_id = $1`, [PAULA]), 1);
});

test('the worker cannot approve or send its own draft', async () => {
  await assert.rejects(agentDb.query(`update public.outbound_drafts set status = 'approved' where person_id = $1`, [PAULA]), /permission denied/);
});

test('no cold texts: SMS to a seller who never texted us is refused (no email to fall back to)', async () => {
  const llm = fakeLlm();
  const job = await run({ llm }, { type: 'message.draft', agent: 'contact', input: { person_id: CORA, purpose: 'cold', channel: 'sms' } });
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /No cold texts/);
  assert.equal(llm.calls.length, 0);
  assert.equal(await count(`select 1 from public.outbound_drafts where person_id = $1`, [CORA]), 0);
});

test('no cold texts: SMS asked for a list seller with an email becomes an email draft', async () => {
  await admin.query(`delete from public.outbound_drafts where person_id = $1`, [PAULA]);
  const job = await run({ llm: emailLlm() }, { type: 'message.draft', agent: 'contact', input: { person_id: PAULA, purpose: 'cold', channel: 'sms' } });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.channel, 'email');
  assert.equal((await admin.query(`select channel from public.outbound_drafts where person_id = $1`, [PAULA])).rows[0].channel, 'email');
});

test('someone who texted us first can get a text draft', async () => {
  const llm = fakeLlm(() => '{"body": "Hi Tom, yes it is. When is a good time to talk? - Helping Hands"}');
  const job = await run({ llm }, { type: 'message.draft', agent: 'contact', input: { person_id: TOM, purpose: 'warm', channel: 'sms' } });
  assert.equal(job.status, 'done', job.error);
  const d = (await admin.query(`select channel, status from public.outbound_drafts where person_id = $1`, [TOM])).rows[0];
  assert.deepEqual([d.channel, d.status], ['sms', 'draft']);
});

test('an opted-out person gets no draft', async () => {
  const llm = fakeLlm();
  const job = await run({ llm }, { type: 'message.draft', agent: 'contact', input: { person_id: OLIVE, purpose: 'cold', channel: 'email' } });
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /not allowed/);
  assert.equal(llm.calls.length, 0);
});

test('without an API key, drafting is blocked with a reason', async () => {
  await admin.query(`delete from public.outbound_drafts where person_id = $1`, [PAULA]);
  const job = await run({ llm: null }, { type: 'message.draft', agent: 'contact', input: { person_id: PAULA } });
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /ANTHROPIC_API_KEY/);
});

test("a contact from Francis's phone (not a seller list) can get a text draft: can_text() rule 3", async () => {
  const llm = fakeLlm(() => '{"body": "Hi Rita, do you have anything coming up in west Wichita? - Helping Hands"}');
  const job = await run({ llm }, { type: 'message.draft', agent: 'contact', input: { person_id: RITA, purpose: 'warm', channel: 'sms' } });
  assert.equal(job.status, 'done', job.error);
  assert.equal((await admin.query(`select channel from public.outbound_drafts where person_id = $1`, [RITA])).rows[0].channel, 'sms');
});

test("the worker's text check matches the CRM's can_text() for every test person", async () => {
  const { rows } = await agentDb.query(`select p.id, public.can_text(p.id, r.business_id) as ok from public.people p join public.relationships r on r.person_id = p.id`);
  const by = Object.fromEntries(rows.map((r) => [r.id, r.ok]));
  assert.equal(by[CORA], false, 'cold list seller: no texts');
  assert.equal(by[TOM], true, 'texted us first');
  assert.equal(by[RITA], true, "Francis's own contact");
});
