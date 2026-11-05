import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, agentDb, config, HH, run } from './helpers.ts';
import { RetryableError } from '../src/ai.ts';
import { handlers } from '../src/registry.ts';
import { claimJobs, enqueue, reapStale } from '../src/queue.ts';
import { runScheduler } from '../src/scheduler.ts';

test('unknown job type fails with a clear error', async () => {
  const job = await run({}, { type: 'nope.nothing', agent: 'scrub', input: {} });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /unknown job type/);
});

test('a retryable error requeues the job with a delay, then fails after max attempts', async () => {
  handlers['test.flaky'] = async () => {
    throw new RetryableError('provider busy', 60);
  };
  try {
    const first = await run({}, { type: 'test.flaky', agent: 'scrub', input: {} });
    assert.equal(first.status, 'queued');
    assert.ok(new Date(first.run_after).getTime() > Date.now() + 30_000, 'retry is delayed');
    assert.equal(first.locked_by, null);
    // Burn the remaining attempts.
    await admin.query(`update public.agent_jobs set attempts = 3, run_after = now() - interval '1 hour' where id = $1`, [first.id]);
    await admin.query(`update public.agent_jobs set status = 'cancelled' where status = 'queued' and id <> $1`, [first.id]);
    const cfg = config();
    const [claimed] = await claimJobs(agentDb, cfg.workerId, cfg.agents, 1);
    assert.equal(claimed!.id, first.id);
    const { runJob } = await import('../src/worker.ts');
    await runJob({ db: agentDb, config: cfg, llm: null, search: null, tracerfy: null }, claimed!);
    const last = (await admin.query('select status, error from public.agent_jobs where id = $1', [first.id])).rows[0];
    assert.equal(last.status, 'failed');
  } finally {
    delete handlers['test.flaky'];
  }
});

test('jobs stuck in running are requeued, or failed after max attempts', async () => {
  const biz = await HH();
  const { rows } = await admin.query(
    `insert into public.agent_jobs (business_id, agent, job_type, idempotency_key, status, locked_at, locked_by, attempts)
     values ($1, 'scrub', 'x', 'stuck-a', 'running', now() - interval '2 hours', 'dead', 1),
            ($1, 'scrub', 'x', 'stuck-b', 'running', now() - interval '2 hours', 'dead', 3),
            ($1, 'scrub', 'x', 'busy-c', 'running', now() - interval '1 minute', 'alive', 1)
     returning idempotency_key, id`,
    [biz],
  );
  const res = await reapStale(agentDb, 30, 3);
  assert.deepEqual(res, { requeued: 1, failed: 1 });
  const st = Object.fromEntries(
    (await admin.query(`select idempotency_key, status from public.agent_jobs where id = any($1)`, [rows.map((r) => r.id)])).rows.map(
      (r) => [r.idempotency_key, r.status],
    ),
  );
  assert.deepEqual(st, { 'stuck-a': 'queued', 'stuck-b': 'failed', 'busy-c': 'running' });
  await admin.query(`update public.agent_jobs set status = 'cancelled' where id = any($1)`, [rows.map((r) => r.id)]);
});

test('a job reaped and re-claimed elsewhere is not overwritten by the old worker', async () => {
  handlers['test.slow'] = async ({ db, job }) => {
    // Another worker takes the job over mid-run.
    await db.query(`select 1`);
    await admin.query(`update public.agent_jobs set locked_by = 'other-worker' where id = $1`, [job.id]);
    return {
      status: 'done',
      result: {},
      write: async (tx) => {
        await tx.query(
          `insert into public.agent_reports (business_id, period_start, period_end, title, body) values ($1, '2001-01-01', '2001-01-07', 'lost', 'x')`,
          [job.business_id],
        );
      },
    };
  };
  try {
    const job = await run({}, { type: 'test.slow', agent: 'manager', input: {} });
    assert.equal(job.status, 'running', 'still owned by the other worker');
    const n = await admin.query(`select count(*)::int as n from public.agent_reports where title = 'lost'`);
    assert.equal(n.rows[0].n, 0, 'findings rolled back');
    await admin.query(`update public.agent_jobs set status = 'cancelled' where id = $1`, [job.id]);
  } finally {
    delete handlers['test.slow'];
  }
});

test('the worker can queue its own jobs, once per key', async () => {
  const biz = await HH();
  const a = await enqueue(agentDb, { businessId: biz, agent: 'manager', jobType: 'x', input: {}, key: 'own-1' });
  const b = await enqueue(agentDb, { businessId: biz, agent: 'manager', jobType: 'x', input: {}, key: 'own-1' });
  assert.deepEqual([a, b], [true, false]);
  await admin.query(`update public.agent_jobs set status = 'cancelled' where idempotency_key = 'own-1'`);
});

test('the scheduler queues the weekly report and hourly draft planner once, and facebook only when search is on', async () => {
  const biz = await HH();
  const off = config({ searchProvider: '' });
  await runScheduler(agentDb, off, true);
  await runScheduler(agentDb, off, true);
  const rows = (
    await admin.query(`select job_type, count(*)::int as n from public.agent_jobs where business_id = $1 and job_type in ('report.weekly','plan.drafts','plan.facebook') group by 1`, [biz])
  ).rows;
  const by = Object.fromEntries(rows.map((r) => [r.job_type, r.n]));
  assert.equal(by['plan.drafts'], 1);
  assert.ok((by['report.weekly'] ?? 0) <= 1);
  assert.equal(by['plan.facebook'], undefined);
  const wk = (await admin.query(`select input from public.agent_jobs where job_type = 'report.weekly' and business_id = $1`, [biz])).rows[0];
  if (wk) {
    const days = (Date.parse(wk.input.period_end) - Date.parse(wk.input.period_start)) / 86_400_000;
    assert.equal(days, 6, 'report covers Monday to Sunday');
  }
  await admin.query(`update public.agent_jobs set status = 'cancelled' where status = 'queued'`);
});

test('a database duplicate guard firing counts as already done, not a failure', async () => {
  const biz = await HH();
  await admin.query(`insert into public.agent_reports (business_id, period_start, period_end, title, body) values ($1, '2001-02-05', '2001-02-11', 'first', 'x')`, [biz]);
  handlers['test.dup'] = async ({ job }) => ({
    status: 'done',
    result: {},
    write: async (tx) => {
      await tx.query(`insert into public.agent_reports (business_id, period_start, period_end, title, body) values ($1, '2001-02-05', '2001-02-11', 'second', 'x')`, [job.business_id]);
    },
  });
  try {
    const job = await run({}, { type: 'test.dup', agent: 'manager', input: {} });
    assert.equal(job.status, 'done');
    assert.match(job.result.skipped, /duplicate guard/);
    const n = await admin.query(`select count(*)::int as n from public.agent_reports where period_start = '2001-02-05'`);
    assert.equal(n.rows[0].n, 1);
  } finally {
    delete handlers['test.dup'];
  }
});
