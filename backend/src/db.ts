import { Pool, PoolClient, QueryResultRow } from 'pg';

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://mapgraph:mapgraph@localhost:2345/mapgraph';

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000
});

pool.on('error', (err) => {
  // Never let an idle-client error take the process down.
  console.error('[pg] idle client error', err);
});

export function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
) {
  return pool.query<T>(sql, params as never[]);
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function waitForDatabase(attempts = 40, delayMs = 1500) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await query('SELECT 1');
      console.log('[pg] connected');
      return;
    } catch (err) {
      console.log(`[pg] not ready (${i}/${attempts})`);
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
