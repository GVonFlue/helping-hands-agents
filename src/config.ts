// Every setting comes from environment variables (Railway → Variables).
// Secrets are never written to files; see .env.example for the names.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (agents_worker login, Supabase session pooler).');
  return {
    databaseUrl,
    // Optional: the password on its own, pasted as-is (no URL encoding needed).
    // When set, it's used instead of any password inside DATABASE_URL.
    databasePassword: process.env.DATABASE_PASSWORD || '',
    workerId: process.env.WORKER_ID || 'railway-worker-1',
    agents: ['scrub', 'contact', 'manager'] as const,
    claimBatch: num('CLAIM_BATCH', 5),
    pollMs: num('POLL_MS', 15_000),
    idlePollMs: num('IDLE_POLL_MS', 60_000),
    maxAttempts: num('MAX_ATTEMPTS', 3),
    staleLockMinutes: num('STALE_LOCK_MINUTES', 30),

    // ProyTech's own spend, out of the flat $249 a month. Not Francis's lookup cap.
    aiMonthlyCeilingCents: num('AI_MONTHLY_CEILING_CENTS', 4000),
    searchMonthlyCeilingCents: num('SEARCH_MONTHLY_CEILING_CENTS', 2500),

    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',

    // Facebook search. Off until a provider is signed off and its key is set.
    searchProvider: (process.env.SEARCH_PROVIDER || '') as '' | 'serper' | 'brave',
    serperApiKey: process.env.SERPER_API_KEY || '',
    braveApiKey: process.env.BRAVE_API_KEY || '', // not signed off: Brave's terms forbid storing results
    searchCentsPerQuery: num('SEARCH_CENTS_PER_QUERY', 0.1), // Serper: $50 per 50k queries
    searchMinIntervalMs: num('SEARCH_MIN_INTERVAL_MS', 1100),
    facebookDailyLimit: num('FACEBOOK_DAILY_LIMIT', 100),
    facebookMinConfidence: num('FACEBOOK_MIN_CONFIDENCE', 0.6),

    entityCacheDays: 90,

    // Skip trace (Tracerfy). Billed to Francis's Scrub cap (agent_budget_left).
    tracerfyApiKey: process.env.TRACERFY_API_KEY || '',
    tracerfyBase: process.env.TRACERFY_BASE || 'https://tracerfy.com', // https://mock.tracerfy.com = free test data
    skiptraceDailyLimit: num('SKIPTRACE_DAILY_LIMIT', 20),
    // Owners from CRM button clicks (list-wide LLC / paid lookup buttons) sent per day, so one click
    // can't spend the month's budget at once. The rest go out on the following days.
    skiptraceAskedDailyLimit: num('SKIPTRACE_ASKED_DAILY_LIMIT', 50),
    skiptraceDnc: (process.env.SKIPTRACE_DNC ?? 'true') !== 'false',
    // Rank band Francis wants done first (just past his mail cutoff).
    skiptraceFirstBand: (process.env.SKIPTRACE_FIRST_BAND || '2501-10000').split('-').map(Number) as [number, number],
    skipBigCompanyDoors: num('SKIP_BIG_COMPANY_DOORS', 20),
  };
}
