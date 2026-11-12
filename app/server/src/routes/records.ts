import {
  DEFAULT_PULL_LIMIT,
  MAX_RECORDS_PER_ACCOUNT,
  type PushResult,
  type RouteResponse,
} from '@localvault/protocol';
import { fromB64 } from '../crypto';
import { fail } from '../errors';
import { keysetOf, lockAccount, recordToWire } from './common';
import type { Registrar } from './define';

export function registerRecordRoutes(r: Registrar): void {
  // §7.2
  r.handle('getRecords', async ({ deps, auth, query }) => {
    const limit = query.limit ?? DEFAULT_PULL_LIMIT;
    const acc = await deps.db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', auth.device.accountId)
      .executeTakeFirstOrThrow();
    // Only revs up to the account counter we just read: every one of them is already committed,
    // because rev allocation holds the account row lock until the writer commits.
    const rows = await deps.db
      .selectFrom('records')
      .selectAll()
      .where('account_id', '=', acc.id)
      .where('rev', '>', query.since)
      .where('rev', '<=', acc.record_rev)
      .orderBy('rev')
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const out: RouteResponse<'getRecords'> = {
      records: page.map(recordToWire),
      cursor: hasMore ? (page[page.length - 1] as { rev: number }).rev : acc.record_rev,
      hasMore,
      // `fullResync` is only meaningful for an incremental pull; since=0 already is a full one.
      fullResync: query.since > 0 && query.since < acc.min_valid_cursor,
    };
    // The protocol query has no keysetVersion, so "behind" is decided by cursor: keyset changes
    // burn a rev (keyset_rev), and a client whose cursor is older has not seen it.
    if (query.since === 0 || query.since < acc.keyset_rev) out.keyset = keysetOf(acc);
    return out;
  });

  // §7.3
  r.handle('postRecordsBatch', async ({ deps, now, auth, body }) => {
    const accountId = auth.device.accountId;
    const results = await deps.db.transaction().execute(async (trx) => {
      // Serialise all writers of this account for the whole batch.
      const acc = await lockAccount(trx, accountId);
      if (body.changes.some((c) => c.vkVersion !== acc.vk_version)) {
        fail('E_STALE_KEY', 'vkVersion is not the current one');
      }
      let live: number | null = null; // lazily counted
      const out: PushResult[] = [];
      for (const ch of body.changes) {
        const cur = await trx
          .selectFrom('records')
          .selectAll()
          .where('account_id', '=', accountId)
          .where('id', '=', ch.id)
          .executeTakeFirst();
        // A record that no longer exists (tombstone purged) cannot be compared; it is re-created.
        if (cur && cur.rev !== ch.baseRev) {
          out.push({ id: ch.id, status: 'conflict', current: recordToWire(cur) });
          continue;
        }
        const wasLive = cur !== undefined && !cur.deleted;
        if (!ch.deleted && !wasLive) {
          if (live === null) {
            const c = await trx
              .selectFrom('records')
              .select((eb) => eb.fn.countAll<number>().as('n'))
              .where('account_id', '=', accountId)
              .where('deleted', '=', false)
              .executeTakeFirstOrThrow();
            live = Number(c.n);
          }
          if (live >= MAX_RECORDS_PER_ACCOUNT) fail('E_TOO_LARGE', 'record limit reached');
          live++;
        } else if (ch.deleted && wasLive && live !== null) {
          live--;
        }
        const alloc = await trx
          .updateTable('accounts')
          .set((eb) => ({ record_rev: eb('record_rev', '+', 1) }))
          .where('id', '=', accountId)
          .returning('record_rev')
          .executeTakeFirstOrThrow();
        const values = {
          rev: alloc.record_rev,
          deleted: ch.deleted,
          vk_version: ch.vkVersion,
          nonce: ch.deleted ? null : fromB64(ch.nonce),
          ct: ch.deleted ? null : fromB64(ch.ct),
          updated_at: now,
        };
        if (cur) {
          await trx
            .updateTable('records')
            .set(values)
            .where('account_id', '=', accountId)
            .where('id', '=', ch.id)
            .execute();
        } else {
          await trx
            .insertInto('records')
            .values({ account_id: accountId, id: ch.id, ...values })
            .execute();
        }
        out.push({ id: ch.id, status: 'ok', rev: alloc.record_rev });
      }
      return out;
    });
    return { results };
  });
}
