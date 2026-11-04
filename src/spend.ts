import type { Db } from './db.ts';

// Two kinds of money, kept apart on purpose:
//
// 1. Client money (Francis's paid lookup cap): agent_jobs.cost_cents, checked with
//    agent_budget_left() before every call billed to him (skip trace, later).
// 2. House money (ProyTech's flat $249): AI tokens and search queries. Recorded in
//    agent_jobs.result -> 'spend' and checked against the worker's own monthly
//    ceilings, so it never eats Francis's cap. If it grows, it's billed to him.

// Standard API prices, cents per million tokens (platform.claude.com pricing, Nov 2026).
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5-5': { in: 200, out: 1000 },
  'claude-haiku-5-5': { in: 10, out: 50 },
};

export function aiCents(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? PRICES['claude-sonnet-5-5']!; // unknown model: assume the dearer price
  return round4((inputTokens * p.in + outputTokens * p.out) / 1_000_000);
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export type Spend = {
  ai_cents: number;
  search_cents: number;
  searches: number;
  ai_calls: { model: string; input_tokens: number; output_tokens: number; cents: number }[];
};

export function emptySpend(): Spend {
  return { ai_cents: 0, search_cents: 0, searches: 0, ai_calls: [] };
}

export function addAi(s: Spend, model: string, input: number, output: number): void {
  const cents = aiCents(model, input, output);
  s.ai_calls.push({ model, input_tokens: input, output_tokens: output, cents });
  s.ai_cents = round4(s.ai_cents + cents);
}

export function addSearch(s: Spend, centsPerQuery: number): void {
  s.searches += 1;
  s.search_cents = round4(s.search_cents + centsPerQuery);
}

// House spend this calendar month across the whole suite (one client, one $249).
export async function houseSpendThisMonth(db: Db): Promise<{ ai_cents: number; search_cents: number }> {
  const { rows } = await db.query(
    `select coalesce(sum((result -> 'spend' ->> 'ai_cents')::numeric), 0) as ai_cents,
            coalesce(sum((result -> 'spend' ->> 'search_cents')::numeric), 0) as search_cents
       from public.agent_jobs
      where finished_at >= date_trunc('month', now())
        and result ? 'spend'`,
  );
  return { ai_cents: Number(rows[0].ai_cents), search_cents: Number(rows[0].search_cents) };
}

// Francis's paid lookup budget for an agent, in cents (0 means paid calls are off).
export async function clientBudgetLeft(db: Db, businessId: string, agent: string): Promise<number> {
  const { rows } = await db.query('select public.agent_budget_left($1, $2) as left', [businessId, agent]);
  return Number(rows[0].left);
}
