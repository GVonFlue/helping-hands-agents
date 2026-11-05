import { anthropicLlm } from './ai.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { log } from './log.ts';
import { braveSearch, rateLimited, serperSearch } from './search.ts';
import { tracerfyClient } from './tracerfy.ts';
import { loop } from './worker.ts';

// Startup problems get one clear log line (never the connection string), then a
// pause before exiting so Railway doesn't restart in a tight loop.
async function fail(msg: string, fields: Record<string, unknown> = {}): Promise<never> {
  log('error', `startup failed: ${msg}`, { node: process.version, ...fields });
  await new Promise((r) => setTimeout(r, 30_000));
  process.exit(1);
}

let configError = '';
const maybeConfig = (() => {
  try {
    return loadConfig();
  } catch (e) {
    configError = (e as Error).message;
    return null;
  }
})();
if (!maybeConfig) await fail(configError);
const config = maybeConfig!;
const url = config.databaseUrl;
const host = (() => { try { return new URL(url).hostname; } catch { return '(unparseable URL: check for unencoded @ : / # % in the password)'; } })();
const user = (() => { try { return decodeURIComponent(new URL(url).username); } catch { return '?'; } })();
const port = (() => { try { return new URL(url).port; } catch { return '?'; } })();
if (/^db\..*\.supabase\.co$/.test(host)) {
  await fail('DATABASE_URL is the direct connection (IPv6 only, unreachable from Railway). Use the Session pooler string (host ends in pooler.supabase.com).', { host });
}
if (port === '6543') await fail('DATABASE_URL uses port 6543 (transaction pooler). Use the Session pooler on port 5432.', { host });
if (host.endsWith('pooler.supabase.com') && !user.includes('.')) {
  await fail('pooler user must be agents_worker.<project-ref> (with the dot and project id).', { user });
}
const db = createPool(url, config.databasePassword || undefined);

// Refuse to run as anything but the locked-down agent role.
const who = await db
  .query(
    `select current_user as name, pg_has_role(current_user, 'agent_service', 'member') as agent,
            (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) as too_powerful`,
  )
  .catch(async (e: { code?: string; message?: string }) => {
    const m = e.message ?? String(e);
    const hint =
      e.code === '28P01' || /password authentication/i.test(m) ? 'wrong password for agents_worker (paste it as-is into DATABASE_PASSWORD)'
      : /tenant or user not found/i.test(m) ? 'pooler does not recognise the user: it must be agents_worker.ylrfaqlxuxujyubjnqnz'
      : e.code === 'ENOTFOUND' ? 'host not found: copy the host from Supabase > Connect > Session pooler'
      : e.code === 'ENETUNREACH' ? 'network unreachable: probably the IPv6 direct host; use the Session pooler'
      : /certificate/i.test(m) ? 'TLS certificate check failed: remove ?sslmode=... from the URL'
      : 'could not connect to the database';
    return fail(hint, { host, user, code: e.code, error: m.slice(0, 200) });
  });
if (!who.rows[0].agent || who.rows[0].too_powerful) {
  log('error', 'refusing to start: DATABASE_URL must log in as a member of agent_service, not a privileged role', {
    user: who.rows[0].name,
  });
  process.exit(1);
}

log('info', 'database ok', { user: who.rows[0].name });
const llm = config.anthropicApiKey ? anthropicLlm(config.anthropicApiKey, config.model) : null;
const provider =
  config.searchProvider === 'serper' && config.serperApiKey
    ? serperSearch(config.serperApiKey)
    : config.searchProvider === 'brave' && config.braveApiKey
      ? braveSearch(config.braveApiKey)
      : null;
const search = provider ? rateLimited(provider, config.searchMinIntervalMs) : null;
const tracerfy = config.tracerfyApiKey ? tracerfyClient(config.tracerfyApiKey, config.tracerfyBase) : null;

const stop = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('info', `got ${sig}, finishing the current job`);
    stop.abort();
  });
}

await loop({ db, config, llm, search, tracerfy }, stop.signal);
await db.end();
