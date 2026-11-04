import type { Db, Tx } from './db.ts';
import type { Job } from './types.ts';

const JOB_COLS = 'id, business_id, agent, job_type, input, idempotency_key, status, attempts';

export async function claimJobs(db: Db, workerId: string, agents: readonly string[], limit: number): Promise<Job[]> {
  const { rows } = await db.query(`select ${JOB_COLS} from public.claim_agent_jobs($1, $2::text[], $3)`, [
    workerId,
    agents,
    limit,
  ]);
  return rows as Job[];
}

type Final = {
  status: 'done' | 'failed' | 'blocked';
  result?: Record<string, unknown> | null;
  error?: string | null;
  costCents?: number;
  houseCents?: number; // ProyTech's AI + search spend (migration 14 column)
};

// Only touches a job this worker still holds, so a job reaped and re-claimed
// elsewhere is never overwritten. Returns false if the job wasn't ours any more.
export async function finishJob(q: Db | Tx, workerId: string, jobId: string, f: Final): Promise<boolean> {
  const { rowCount } = await q.query(
    `update public.agent_jobs
        set status = $3, result = $4::jsonb, error = $5, cost_cents = $6, house_cost_cents = $7, finished_at = now()
      where id = $1 and status = 'running' and locked_by = $2`,
    [jobId, workerId, f.status, f.result ? JSON.stringify(f.result) : null, f.error ?? null, Math.round(f.costCents ?? 0),
     Math.round((f.houseCents ?? 0) * 10_000) / 10_000],
  );
  return rowCount === 1;
}

export async function requeueJob(db: Db, workerId: string, jobId: string, delaySec: number, error: string): Promise<void> {
  await db.query(
    `update public.agent_jobs
        set status = 'queued', run_after = now() + make_interval(secs => $3), locked_at = null, locked_by = null, error = $4
      where id = $1 and status = 'running' and locked_by = $2`,
    [jobId, workerId, delaySec, error],
  );
}

// claim_agent_jobs has no recovery for a worker that died mid-job. Jobs stuck in
// 'running' past the stale window go back in the queue, or fail after max attempts.
export async function reapStale(db: Db, staleMinutes: number, maxAttempts: number): Promise<{ requeued: number; failed: number }> {
  const failed = await db.query(
    `update public.agent_jobs
        set status = 'failed', error = 'worker stopped mid-job ' || attempts || ' times', finished_at = now()
      where status = 'running' and locked_at < now() - make_interval(mins => $1) and attempts >= $2`,
    [staleMinutes, maxAttempts],
  );
  const requeued = await db.query(
    `update public.agent_jobs
        set status = 'queued', run_after = now() + interval '5 minutes', locked_at = null, locked_by = null,
            error = 'requeued after the worker stopped mid-job'
      where status = 'running' and locked_at < now() - make_interval(mins => $1) and attempts < $2`,
    [staleMinutes, maxAttempts],
  );
  return { requeued: requeued.rowCount ?? 0, failed: failed.rowCount ?? 0 };
}

// The worker's own jobs (Manager scheduling, planners). Idempotent by key.
export async function enqueue(
  q: Db | Tx,
  job: { businessId: string; agent: Job['agent']; jobType: string; input: Record<string, unknown>; key: string; runAfterSec?: number },
): Promise<boolean> {
  const { rowCount } = await q.query(
    `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, status, run_after)
     values ($1, $2, $3, $4::jsonb, $5, 'queued', now() + make_interval(secs => $6))
     on conflict (idempotency_key) do nothing`,
    [job.businessId, job.agent, job.jobType, JSON.stringify(job.input), job.key, job.runAfterSec ?? 0],
  );
  return rowCount === 1;
}
