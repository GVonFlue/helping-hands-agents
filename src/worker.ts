import { RetryableError } from './ai.ts';
import type { Config } from './config.ts';
import { lockKey, withTx, type Db } from './db.ts';
import { log } from './log.ts';
import { claimJobs, finishJob, reapStale, requeueJob } from './queue.ts';
import { handlers } from './registry.ts';
import { runScheduler } from './scheduler.ts';
import type { Llm } from './ai.ts';
import type { SearchProvider } from './search.ts';
import { emptySpend } from './spend.ts';
import type { Ctx, Job } from './types.ts';

export type Deps = { db: Db; config: Config; llm: Llm | null; search: SearchProvider | null };

// Runs one claimed job to a final state. Never throws.
export async function runJob(deps: Deps, job: Job): Promise<string> {
  const { db, config } = deps;
  const ctx: Ctx = { ...deps, job, spend: emptySpend() };
  const spendResult = () => (ctx.spend.ai_cents || ctx.spend.searches ? { spend: ctx.spend } : {});
  const handler = handlers[job.job_type];
  try {
    if (!handler) {
      await finishJob(db, config.workerId, job.id, { status: 'failed', error: `unknown job type "${job.job_type}"` });
      return 'failed';
    }
    const out = await handler(ctx);
    if (out.status === 'done') {
      const stillOurs = await withTx(db, async (tx) => {
        if (out.lockKey) await lockKey(tx, out.lockKey);
        const extra = out.write ? await out.write(tx) : undefined;
        const ok = await finishJob(tx, config.workerId, job.id, {
          status: 'done',
          result: { ...out.result, ...(extra ?? {}), ...spendResult() },
          costCents: out.costCents ?? 0,
        });
        // Lost the job (reaped and re-claimed): roll back so nothing is written twice.
        if (!ok) throw new LostJob();
        return ok;
      }).catch((e) => {
        if (e instanceof LostJob) return false;
        throw e;
      });
      if (!stillOurs) log('warn', 'job was no longer ours; findings rolled back', { job: job.id });
      return stillOurs ? 'done' : 'lost';
    }
    await finishJob(db, config.workerId, job.id, {
      status: out.status,
      error: out.error,
      result: { ...(out.status === 'blocked' ? out.result ?? {} : {}), ...spendResult() },
    });
    return out.status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof RetryableError || isTransient(err);
    if (retryable && job.attempts < config.maxAttempts) {
      const delay = err instanceof RetryableError ? err.delaySec : 600 * job.attempts;
      await requeueJob(db, config.workerId, job.id, delay, message).catch(() => {});
      log('warn', 'job will retry', { job: job.id, type: job.job_type, attempt: job.attempts, error: message });
      return 'retry';
    }
    await finishJob(db, config.workerId, job.id, { status: 'failed', error: message.slice(0, 500), result: spendResult() }).catch(
      () => {},
    );
    log('error', 'job failed', { job: job.id, type: job.job_type, error: message });
    return 'failed';
  }
}

class LostJob extends Error {}

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', '57P01', '40001', '40P01'].includes(code) ||
    (err instanceof Error && err.name === 'TimeoutError');
}

// One pass: recover stuck jobs, schedule Manager work, claim and run a batch.
export async function tick(deps: Deps): Promise<number> {
  const { db, config } = deps;
  const reaped = await reapStale(db, config.staleLockMinutes, config.maxAttempts);
  if (reaped.requeued || reaped.failed) log('warn', 'recovered stuck jobs', reaped);
  await runScheduler(db, config);
  const jobs = await claimJobs(db, config.workerId, config.agents, config.claimBatch);
  for (const job of jobs) {
    const started = Date.now();
    const status = await runJob(deps, job);
    log('info', 'job finished', { job: job.id, type: job.job_type, status, ms: Date.now() - started });
  }
  return jobs.length;
}

export async function loop(deps: Deps, signal: AbortSignal): Promise<void> {
  log('info', 'worker started', { worker: deps.config.workerId, ai: !!deps.llm, search: deps.search?.name ?? 'off' });
  let idleTicks = 0;
  while (!signal.aborted) {
    let claimed = 0;
    try {
      claimed = await tick(deps);
    } catch (err) {
      log('error', 'tick failed', { error: err instanceof Error ? err.message : String(err) });
    }
    if (claimed > 0) {
      idleTicks = 0;
      continue; // more may be waiting
    }
    idleTicks += 1;
    // Poll every 15s at first, then back off to every 60s while the queue stays empty.
    await sleep(idleTicks > 4 ? deps.config.idlePollMs : deps.config.pollMs, signal);
  }
  log('info', 'worker stopped');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}
