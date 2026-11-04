import type { Config } from './config.ts';
import type { Db, Tx } from './db.ts';
import type { Llm } from './ai.ts';
import type { SearchProvider } from './search.ts';
import type { Spend } from './spend.ts';

export type Job = {
  id: string;
  business_id: string;
  agent: 'manager' | 'scrub' | 'contact';
  job_type: string;
  input: Record<string, unknown>;
  idempotency_key: string;
  status: string;
  attempts: number;
};

export type Ctx = {
  db: Db;
  job: Job;
  config: Config;
  llm: Llm | null; // null when no API key is configured
  search: SearchProvider | null; // null until a provider is signed off
  spend: Spend; // house spend for this job; saved into result.spend
};

// What a handler hands back. `write` runs in the same transaction that marks the
// job done, behind `lockKey`, so findings and "done" land together or not at all.
export type Outcome =
  | {
      status: 'done';
      result: Record<string, unknown>;
      costCents?: number; // client money only (Francis's cap)
      lockKey?: string;
      write?: (tx: Tx) => Promise<Record<string, unknown> | void>;
    }
  | { status: 'blocked'; error: string; result?: Record<string, unknown> }
  | { status: 'failed'; error: string };

export type Handler = (ctx: Ctx) => Promise<Outcome>;

// Any well-formed UUID (Postgres accepts all versions; zod's .uuid() is stricter).
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
