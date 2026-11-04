import pg from 'pg';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, type Config } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import type { Llm, LlmRequest } from '../src/ai.ts';
import type { SearchHit, SearchProvider } from '../src/search.ts';
import { claimJobs } from '../src/queue.ts';
import { runJob, type Deps } from '../src/worker.ts';
import type { Job } from '../src/types.ts';

// admin = postgres superuser, only for fixtures and assertions.
// agentDb = the worker's real login (agents_worker in agent_service).
export const admin = new pg.Pool({ connectionString: process.env.ADMIN_URL });
export const agentDb = createPool(process.env.DATABASE_URL!);
after(async () => {
  await admin.end();
  await agentDb.end();
});

export const HH = async (): Promise<string> =>
  (await admin.query(`select id from public.businesses where slug = 'helping-hands'`)).rows[0].id;

export function config(over: Partial<Config> = {}): Config {
  return { ...loadConfig(), workerId: 'test-worker', ...over };
}

export function fakeLlm(reply: (req: LlmRequest) => string = () => 'ok'): Llm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    model: 'claude-sonnet-5-5',
    calls,
    async complete(req) {
      calls.push(req);
      return { text: reply(req), model: 'claude-sonnet-5-5', inputTokens: 1500, outputTokens: 300 };
    },
  };
}

export function fakeSearch(byQuery: (q: string) => SearchHit[]): SearchProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    name: 'logged out search (test)',
    queries,
    async search(q) {
      queries.push(q);
      return byQuery(q);
    },
  };
}

let seq = 0;
// Queues one job (as the CRM or Manager would), claims it with the worker's
// login, and runs it. Returns the final job row.
export async function run(
  deps: Partial<Deps> & { config?: Config },
  job: { type: string; agent: Job['agent']; input: Record<string, unknown>; key?: string },
) {
  const biz = await HH();
  // Park anything else queued so the claim picks up exactly this job.
  await admin.query(`update public.agent_jobs set status = 'cancelled' where status = 'queued'`);
  const key = job.key ?? `test:${job.type}:${Date.now()}:${seq++}`;
  const ins = await admin.query(
    `insert into public.agent_jobs (business_id, agent, job_type, input, idempotency_key, run_after)
     values ($1, $2, $3, $4::jsonb, $5, now() - interval '1 hour') returning id`,
    [biz, job.agent, job.type, JSON.stringify(job.input), key],
  );
  const cfg = deps.config ?? config();
  const claimed = await claimJobs(agentDb, cfg.workerId, cfg.agents, 1);
  assert.equal(claimed.length, 1, 'worker claimed the job');
  assert.equal(claimed[0]!.id, ins.rows[0].id);
  await runJob({ db: agentDb, config: cfg, llm: deps.llm ?? null, search: deps.search ?? null }, claimed[0]!);
  return (await admin.query(`select * from public.agent_jobs where id = $1`, [ins.rows[0].id])).rows[0];
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await admin.query(`select count(*)::int as n from (${sql}) x`, params)).rows[0].n);
}
