import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool, types } = pg;

/**
 * NUMERIC comes back from node-postgres as a string by default to avoid
 * precision loss. For market data we want numbers; every NUMERIC column in
 * this schema is comfortably inside IEEE-754 safe range at the precision we
 * store (4 dp on prices, 2 dp on money). Money aggregates are still summed in
 * SQL with NUMERIC arithmetic, so the rounding stays server-side.
 */
types.setTypeParser(types.builtins.NUMERIC, (v: string) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.INT8, (v: string) => (v === null ? null : Number(v)));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'bharat-terminal',
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle postgres client error');
});

export type QueryParam = string | number | boolean | Date | null | undefined | unknown[] | object;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<pg.QueryResult<T>> {
  const started = Date.now();
  try {
    const res = await pool.query<T>(text, params as unknown[]);
    const ms = Date.now() - started;
    if (ms > 500) {
      logger.warn({ ms, sql: text.slice(0, 160), rows: res.rowCount }, 'Slow query');
    }
    return res;
  } catch (err) {
    logger.error({ err, sql: text.slice(0, 300) }, 'Query failed');
    throw err;
  }
}

export async function queryRows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<T[]> {
  return (await query<T>(text, params)).rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(text, params);
  return rows[0] ?? null;
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function hasTimescale(): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS exists`,
  );
  return Boolean(row?.exists);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
