import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './schema';

export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Either the pool-backed database or a transaction. */
export type Queryable = Kysely<DB>;

const INT8_OID = 20;
const NUMERIC_OID = 1700;

export type DbHandle = { db: Database; pool: pg.Pool };

/** bigint columns (rev, cursors) stay far below 2^53, so they are returned as numbers. */
export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 10,
    types: {
      getTypeParser: (oid: number, format?: 'text' | 'binary') => {
        if (oid === INT8_OID || oid === NUMERIC_OID) return (v: string) => Number(v);
        return pg.types.getTypeParser(oid, format as 'text');
      },
    } as pg.CustomTypesConfig,
  });
  // An idle client error must not crash the process; the next query reports the problem.
  pool.on('error', () => {});
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
