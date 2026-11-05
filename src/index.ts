import { anthropicLlm } from './ai.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { log } from './log.ts';
import { braveSearch, rateLimited, serperSearch } from './search.ts';
import { loop } from './worker.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);

// Refuse to run as anything but the locked-down agent role.
const who = await db.query(
  `select current_user as name, pg_has_role(current_user, 'agent_service', 'member') as agent,
          (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) as too_powerful`,
);
if (!who.rows[0].agent || who.rows[0].too_powerful) {
  log('error', 'refusing to start: DATABASE_URL must log in as a member of agent_service, not a privileged role', {
    user: who.rows[0].name,
  });
  process.exit(1);
}

const llm = config.anthropicApiKey ? anthropicLlm(config.anthropicApiKey, config.model) : null;
const provider =
  config.searchProvider === 'serper' && config.serperApiKey
    ? serperSearch(config.serperApiKey)
    : config.searchProvider === 'brave' && config.braveApiKey
      ? braveSearch(config.braveApiKey)
      : null;
const search = provider ? rateLimited(provider, config.searchMinIntervalMs) : null;

const stop = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('info', `got ${sig}, finishing the current job`);
    stop.abort();
  });
}

await loop({ db, config, llm, search }, stop.signal);
await db.end();
