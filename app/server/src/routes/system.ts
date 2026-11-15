import { normalizeAccountName } from '@localvault/protocol';
import { sql } from 'kysely';
import { fakePrelogin } from '../prelogin';
import { SERVER_VERSION } from '../version';
import type { Registrar } from './define';

export function registerSystemRoutes(r: Registrar): void {
  r.handle('health', async ({ deps }) => {
    await sql`select 1`.execute(deps.db);
    return { version: SERVER_VERSION, registrationMode: deps.config.registrationMode };
  });

  r.handle('prelogin', async ({ deps, query }) => {
    // The schema already requires the canonical form; normalising again is a no-op safety net.
    const norm = normalizeAccountName(query.account);
    const name = norm.ok ? norm.name : query.account;
    // Always compute the fake answer so both branches do comparable work.
    const fake = fakePrelogin(deps.config.preloginSecret, name);
    const row = await deps.db
      .selectFrom('accounts')
      .select(['id', 'kdf'])
      .where('name', '=', name)
      .executeTakeFirst();
    return row ? { accountId: row.id, kdf: row.kdf } : fake;
  });
}
