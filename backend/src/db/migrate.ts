#!/usr/bin/env tsx
/**
 * Migration runner.
 *
 * Applies every .sql file in database/migrations in lexical order exactly once,
 * inside a transaction, recording a checksum so an already-applied file that
 * later changes is reported rather than silently ignored.
 *
 *   npm run migrate          # apply pending
 *   npm run migrate:status   # list state
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, queryRows } from './pool.js';
import { sha256 } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../../database/migrations');

interface MigrationRow {
  name: string;
  checksum: string;
  applied_at: Date;
}

async function ensureTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER
    )
  `);
}

function listFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function applied(): Promise<Map<string, MigrationRow>> {
  const rows = await queryRows<MigrationRow>(
    'SELECT name, checksum, applied_at FROM schema_migrations',
  );
  return new Map(rows.map((r) => [r.name, r]));
}

async function up(): Promise<void> {
  await ensureTable();
  const done = await applied();
  const files = listFiles();
  let count = 0;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = sha256(sql);
    const prior = done.get(file);

    if (prior) {
      if (prior.checksum !== checksum) {
        logger.warn(
          { file },
          'Migration file changed after being applied. Existing databases will NOT be updated — add a new migration instead.',
        );
      }
      continue;
    }

    const started = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
        [file, checksum, Date.now() - started],
      );
      await client.query('COMMIT');
      logger.info({ file, ms: Date.now() - started }, 'Applied migration');
      count += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ err, file }, 'Migration failed — rolled back');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info({ applied: count, total: files.length }, count ? 'Migrations complete' : 'Already up to date');
}

async function status(): Promise<void> {
  await ensureTable();
  const done = await applied();
  const files = listFiles();
  for (const file of files) {
    const row = done.get(file);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const drift = row && row.checksum !== sha256(sql) ? '  [CHANGED SINCE APPLIED]' : '';
    // eslint-disable-next-line no-console
    console.log(
      `${row ? 'applied ' : 'PENDING '} ${file}${row ? `  ${row.applied_at.toISOString()}` : ''}${drift}`,
    );
  }
}

const cmd = process.argv[2] ?? 'up';
try {
  if (cmd === 'up') await up();
  else if (cmd === 'status') await status();
  else {
    // eslint-disable-next-line no-console
    console.error(`Unknown command "${cmd}". Use: up | status`);
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
