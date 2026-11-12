import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATION_FILE = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;
const LOCK_KEY = 7_204_1971; // arbitrary constant for pg_advisory_lock

export class SchemaBehindError extends Error {
  override readonly name = 'SchemaBehindError';
}

/** `MIGRATIONS_DIR`, else `migrations/` next to the package (works from src/db and from dist). */
export function defaultMigrationsDir(override?: string): string {
  if (override) return resolve(override);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../migrations', '../../migrations']) {
    const dir = resolve(here, rel);
    if (existsSync(dir)) return dir;
  }
  throw new Error('migrations directory not found (set MIGRATIONS_DIR)');
}

export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();
}

async function appliedNames(pool: pg.Pool): Promise<Set<string> | null> {
  const exists = await pool.query<{ t: string | null }>(
    "select to_regclass('public.schema_migrations') as t",
  );
  if (exists.rows[0]?.t == null) return null;
  const r = await pool.query<{ name: string }>('select name from schema_migrations');
  return new Set(r.rows.map((x) => x.name));
}

/** Apply pending migrations, each file in its own transaction. Returns the applied names. */
export async function runMigrations(pool: pg.Pool, dir: string): Promise<string[]> {
  const files = listMigrationFiles(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}

/** Throws SchemaBehindError (with an operator-facing hint) unless every migration is applied. */
export async function assertSchemaUpToDate(pool: pg.Pool, dir: string): Promise<void> {
  const files = listMigrationFiles(dir);
  const done = await appliedNames(pool);
  const missing = files.filter((f) => !done?.has(f));
  if (missing.length > 0) {
    throw new SchemaBehindError(
      `database schema is behind (${missing.length} pending migration(s): ${missing.join(', ')}). ` +
        'Run `node dist/cli.js migrate` first.',
    );
  }
}
