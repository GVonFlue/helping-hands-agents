import pg from 'pg';

// Postgres numeric and bigint come back as strings by default; the worker only
// uses them for counts and money, so parse them to numbers.
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));
// Keep `date` columns as plain YYYY-MM-DD strings.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string): Db {
  // Supabase's session pooler presents a certificate signed by Supabase's own CA.
  // Encryption stays on; set DATABASE_CA to the CA bundle to verify it too.
  const local = /@(localhost|127\.0\.0\.1)|host=\//.test(url) || url.includes('%2F');
  const ssl = local
    ? undefined
    : process.env.DATABASE_CA
      ? { ca: process.env.DATABASE_CA }
      : { rejectUnauthorized: false };
  // A ?sslmode=require copied from Supabase would override `ssl` and turn on
  // strict certificate checks pg can't satisfy without the CA; drop it.
  const cleaned = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return new pg.Pool({ connectionString: cleaned, max: 5, ssl, application_name: 'helping-hands-agents' });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    const out = await fn(tx);
    await tx.query('commit');
    return out;
  } catch (err) {
    await tx.query('rollback').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// Serialises work on one subject (an owner, a person, a report period) across
// workers and re-runs, for the length of the transaction.
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}
