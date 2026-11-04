import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, config, count, fakeLlm, HH, run } from './helpers.ts';

const input = { period_start: '2026-10-26', period_end: '2026-11-01' };

test('report.weekly writes one report with the mail numbers, and records AI spend', async () => {
  const biz = await HH();
  const llm = fakeLlm(() => 'This week\nQuiet week: 0 replies.\n\nMail\nOctober mailer: 1 piece, no responses yet.');
  const job = await run({ llm }, { type: 'report.weekly', agent: 'manager', input });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.cost_cents, 0, 'no client money spent');
  assert.equal(job.result.writer, 'ai');
  assert.ok(job.result.spend.ai_cents > 0, 'token spend recorded');
  assert.equal(llm.calls.length, 1);
  // The model only gets numbers computed in code.
  const sent = JSON.parse(llm.calls[0]!.prompt);
  assert.equal(sent.mailings[0].name, 'October mailer');
  assert.equal(sent.mailings[0].pieces, 1);
  assert.equal(sent.mailings[0].cost_per_closed_deal, null);

  const rep = (await admin.query(`select * from public.agent_reports where business_id = $1 and period_start = $2`, [biz, input.period_start])).rows;
  assert.equal(rep.length, 1);
  assert.equal(rep[0].agent, 'manager');
  assert.equal(rep[0].title, 'Week of Oct 26 to Nov 1');
  assert.equal(rep[0].metrics.mailings[0].response_rate_pct, 0);
});

test('running report.weekly again for the same week writes nothing new and spends nothing', async () => {
  const llm = fakeLlm();
  const job = await run({ llm }, { type: 'report.weekly', agent: 'manager', input });
  assert.equal(job.status, 'done');
  assert.match(job.result.skipped, /already exists/);
  assert.equal(llm.calls.length, 0);
  assert.equal(await count(`select 1 from public.agent_reports where period_start = $1 and agent = 'manager'`, [input.period_start]), 1);
});

test('with the AI ceiling reached, the report is still written from the template', async () => {
  const llm = fakeLlm();
  const job = await run(
    { llm, config: config({ aiMonthlyCeilingCents: 0 }) },
    { type: 'report.weekly', agent: 'manager', input: { period_start: '2026-10-19', period_end: '2026-10-25' } },
  );
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.writer, 'template');
  assert.equal(llm.calls.length, 0);
  const body = (await admin.query(`select body from public.agent_reports where period_start = '2026-10-19'`)).rows[0].body;
  assert.match(body, /October mailer: 1 pieces/);
});

test('bad input fails without writing', async () => {
  const job = await run({}, { type: 'report.weekly', agent: 'manager', input: { period_start: 'last week' } });
  assert.equal(job.status, 'failed');
});
