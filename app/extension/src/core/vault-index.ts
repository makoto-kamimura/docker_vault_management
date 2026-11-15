// Decrypted index (12.3: id, title, username, match targets — never passwords) and per-item decrypt.
import {
  decryptRecord,
  type MatchEntry,
  matchesQuery,
  matchItems,
  type PublicSuffixList,
} from '@localvault/core';
import {
  type EncryptedRecord,
  type LoginData,
  META_RECORD_ID,
  type MetaData,
} from '@localvault/protocol';
import { PcError } from './errors';
import { type IndexData, type IndexEntry, store } from './storage';
import type { Env } from './types';

const CHUNK = 64;

/** Decrypts the meta record. Throws `PcError('E_BAD_VK')` when it does not authenticate. */
export async function verifyVaultKey(
  env: Env,
  accountId: string,
  vk: Uint8Array,
  vkVersion: number,
  records: Record<string, EncryptedRecord>,
): Promise<MetaData> {
  const rec = records[META_RECORD_ID];
  if (rec === undefined || rec.deleted || rec.vkVersion !== vkVersion) {
    throw new PcError('E_BAD_VK', 'vault key could not be verified');
  }
  try {
    const plain = await decryptRecord(
      env.crypto,
      vk,
      { accountId, recordId: rec.id, vkVersion: rec.vkVersion },
      { nonce: rec.nonce, ct: rec.ct },
    );
    if (plain.kind !== 'meta') throw new Error('not a meta record');
    return plain.data;
  } catch {
    throw new PcError('E_BAD_VK', 'vault key could not be verified');
  }
}

export async function buildIndex(
  env: Env,
  accountId: string,
  vk: Uint8Array,
  vkVersion: number,
  records: Record<string, EncryptedRecord>,
): Promise<IndexData> {
  const live = Object.values(records).filter(
    (r): r is Extract<EncryptedRecord, { deleted: false }> => !r.deleted && r.id !== META_RECORD_ID,
  );
  const entries: IndexEntry[] = [];
  let skipped = 0;
  for (let i = 0; i < live.length; i += CHUNK) {
    const results = await Promise.all(
      live.slice(i, i + CHUNK).map(async (r) => {
        if (r.vkVersion !== vkVersion) return 'skip' as const;
        try {
          const plain = await decryptRecord(
            env.crypto,
            vk,
            { accountId, recordId: r.id, vkVersion: r.vkVersion },
            { nonce: r.nonce, ct: r.ct },
          );
          if (plain.kind !== 'login') return null;
          if (plain.data.trashedAt !== null) return null; // trash never appears (9.1-7)
          return {
            id: r.id,
            title: plain.data.title,
            username: plain.data.username,
            urls: plain.data.urls,
          } satisfies IndexEntry;
        } catch {
          return 'skip' as const;
        }
      }),
    );
    for (const x of results) {
      if (x === 'skip') skipped++;
      else if (x !== null) entries.push(x);
    }
  }
  entries.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  return { entries, skipped };
}

/** Decrypts exactly ONE login (fill / copy). The plaintext is returned and not retained. */
export async function decryptLogin(
  env: Env,
  accountId: string,
  vk: Uint8Array,
  id: string,
): Promise<LoginData> {
  const rec = (await store.records(env))[id];
  if (rec === undefined || rec.deleted) throw new PcError('E_NOT_FOUND', 'no such item');
  try {
    const plain = await decryptRecord(
      env.crypto,
      vk,
      { accountId, recordId: id, vkVersion: rec.vkVersion },
      { nonce: rec.nonce, ct: rec.ct },
    );
    if (plain.kind !== 'login' || plain.data.trashedAt !== null) {
      throw new PcError('E_NOT_FOUND', 'no such item');
    }
    return plain.data;
  } catch (e) {
    if (e instanceof PcError) throw e;
    throw new PcError('E_NOT_FOUND', 'item could not be decrypted');
  }
}

export type ItemSummary = { id: string; title: string; username: string };

export function summaryOf(e: IndexEntry): ItemSummary {
  return { id: e.id, title: e.title, username: e.username };
}

export function toMatchEntries(entries: readonly IndexEntry[]): MatchEntry[] {
  return entries.map((e) => ({ id: e.id, urls: e.urls }));
}

export type RequestOrigin = { scheme: string; host: string };

/** Parses `MessageSender.origin` ("https://host[:port]"). Opaque / odd origins return null. */
export function parseSenderOrigin(origin: string | undefined): RequestOrigin | null {
  if (origin === undefined || origin === 'null') return null;
  const m = /^(https?):\/\/([^/:?#@]+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?$/.exec(origin);
  if (m === null) return null;
  return { scheme: (m[1] as string).toLowerCase(), host: m[2] as string };
}

/** Ids of the items that match the origin (9.1 / 9.4), best first. */
export function matchOrigin(
  psl: PublicSuffixList,
  origin: RequestOrigin,
  entries: readonly IndexEntry[],
): { id: string; rank: 'host' | 'domain' }[] {
  return matchItems(psl, origin, toMatchEntries(entries)).map((c) => ({ id: c.id, rank: c.rank }));
}

export function searchEntries(entries: readonly IndexEntry[], query: string): IndexEntry[] {
  const q = query.trim();
  if (q === '') return [...entries];
  return entries.filter((e) => matchesQuery(q, [e.title, e.username, ...e.urls.map((u) => u.url)]));
}
