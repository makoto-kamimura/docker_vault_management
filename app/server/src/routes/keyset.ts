import { writeAudit } from '../audit';
import { fromB64 } from '../crypto';
import { fail } from '../errors';
import { keysetOf, lockAccount } from './common';
import type { Registrar } from './define';

export function registerKeysetRoutes(r: Registrar): void {
  r.handle('getKeyset', async ({ deps, auth }) => {
    const acc = await deps.db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', auth.device.accountId)
      .executeTakeFirstOrThrow();
    return { keyset: keysetOf(acc) };
  });

  r.handle('putKeyset', async ({ deps, now, auth, body }) => {
    await deps.db.transaction().execute(async (trx) => {
      const acc = await lockAccount(trx, auth.device.accountId);
      // G4: exactly the next keysetVersion, same vkVersion.
      if (
        body.keyset.keysetVersion !== acc.keyset_version + 1 ||
        body.keyset.vkVersion !== acc.vk_version
      ) {
        fail('E_VERSION_CONFLICT', 'keyset version mismatch');
      }
      // Burn one rev so that pulls with an older cursor learn about the new keyset.
      const rev = acc.record_rev + 1;
      await trx
        .updateTable('accounts')
        .set({
          kdf: body.keyset.kdf,
          wrapped_vk: body.keyset.wrappedVK,
          keyset_version: body.keyset.keysetVersion,
          verifier: fromB64(body.verifier),
          record_rev: rev,
          keyset_rev: rev,
        })
        .where('id', '=', acc.id)
        .execute();
      await writeAudit(trx, acc.id, auth.device.id, 'keyset_changed', now);
    });
    return undefined;
  });
}
