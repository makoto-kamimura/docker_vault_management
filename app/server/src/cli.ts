import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { deleteAccountCascade } from './accounts';
import { systemClock } from './clock';
import { loadDatabaseConfig } from './config';
import { b64, sha256 } from './crypto';
import { createDb, type Database } from './db/client';
import { defaultMigrationsDir, runMigrations } from './db/migrate';

const USAGE = `usage: cli.js <command>
  migrate
  invite create [--expires-in 7d] | invite list | invite revoke <id>
  account list | account delete <name> --yes
  stats`;

export function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error('invalid duration (examples: 30m, 12h, 7d)');
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's'];
  return Number(m[1]) * unit;
}

export async function createInvite(db: Database, expiresInMs: number, now = new Date()) {
  const code = b64(randomBytes(18));
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + expiresInMs);
  await db
    .insertInto('invites')
    .values({
      id,
      code_hash: sha256(Buffer.from(code, 'utf8')),
      created_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      used_at: null,
      account_id: null,
    })
    .execute();
  return { id, code, expiresAt };
}

async function run(argv: string[], out: (s: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { 'expires-in': { type: 'string' }, yes: { type: 'boolean' } },
  });
  const [cmd, sub, arg] = positionals;
  if (!cmd) {
    out(USAGE);
    return 2;
  }
  const cfg = loadDatabaseConfig();
  const { db, pool } = createDb(cfg.databaseUrl, { max: 2 });
  try {
    if (cmd === 'migrate') {
      const applied = await runMigrations(pool, defaultMigrationsDir(cfg.migrationsDir));
      out(applied.length ? `applied: ${applied.join(', ')}` : 'schema is up to date');
    } else if (cmd === 'invite' && sub === 'create') {
      const inv = await createInvite(db, parseDuration(values['expires-in'] ?? '7d'));
      out(
        `id:      ${inv.id}\ncode:    ${inv.code}\nexpires: ${inv.expiresAt.toISOString()}\n(the code is shown only once)`,
      );
    } else if (cmd === 'invite' && sub === 'list') {
      const rows = await db
        .selectFrom('invites')
        .select(['id', 'created_at', 'expires_at', 'revoked_at', 'used_at'])
        .orderBy('created_at')
        .execute();
      for (const r of rows) {
        const state = r.used_at
          ? 'used'
          : r.revoked_at
            ? 'revoked'
            : r.expires_at && r.expires_at < new Date()
              ? 'expired'
              : 'active';
        out(`${r.id}  ${state}  expires ${r.expires_at?.toISOString() ?? '-'}`);
      }
    } else if (cmd === 'invite' && sub === 'revoke' && arg) {
      const r = await db
        .updateTable('invites')
        .set({ revoked_at: new Date() })
        .where('id', '=', arg)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) {
        out('no such active invite');
        return 1;
      }
      out('revoked');
    } else if (cmd === 'account' && sub === 'list') {
      const rows = await db
        .selectFrom('accounts')
        .select(['id', 'name', 'created_at'])
        .orderBy('created_at')
        .execute();
      for (const r of rows) out(`${r.id}  ${r.name}  ${r.created_at.toISOString()}`);
    } else if (cmd === 'account' && sub === 'delete' && arg) {
      if (!values.yes) {
        out('refusing without --yes');
        return 2;
      }
      const acc = await db
        .selectFrom('accounts')
        .select('id')
        .where('name', '=', arg.normalize('NFKC').toLowerCase())
        .executeTakeFirst();
      if (!acc) {
        out('no such account');
        return 1;
      }
      await deleteAccountCascade(db, acc.id, systemClock.now());
      out('deleted');
    } else if (cmd === 'stats') {
      const count = async (t: 'accounts' | 'devices' | 'records' | 'invites') =>
        Number(
          (
            await db
              .selectFrom(t)
              .select((eb) => eb.fn.countAll<number>().as('n'))
              .executeTakeFirstOrThrow()
          ).n,
        );
      out(
        `accounts: ${await count('accounts')}\ndevices: ${await count('devices')}\nrecords: ${await count('records')}\ninvites: ${await count('invites')}`,
      );
    } else {
      out(USAGE);
      return 2;
    }
    return 0;
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1])) {
  run(process.argv.slice(2), (s) => process.stdout.write(`${s}\n`)).then(
    (code) => process.exit(code),
    (err: Error) => {
      process.stderr.write(`localvault-cli: ${err.message}\n`);
      process.exit(1);
    },
  );
}
