import {
  type CryptoProvider,
  createNobleProvider,
  createWebCryptoProvider,
  type VaultCore,
} from '@localvault/core';
import type { EncryptedRecord, Keyset, PushResult, RecordChange } from '@localvault/protocol';
import { createVaultEngine, type EngineExtras } from '../src';
import { createMemoryDeps, ManualClock, type MemoryDeps } from '../src/memory';

export const webcrypto = createWebCryptoProvider();
export const noble = createNobleProvider();

export type Engine = VaultCore & EngineExtras;
export const PW = 'correct horse battery';

/** Minimal stand-in for the sync part of the server (rev numbering, tombstones, keyset delivery). */
export class FakeServer {
  records = new Map<string, EncryptedRecord>();
  recordRev = 0;
  keysetRev = 0;
  minValid = 0;
  keyset!: Keyset;
  accountId = '';
  accountName = '';
  /** Applied to each pull response (tests use it to play a malicious server). */
  tamperPull: ((res: PullResponse) => PullResponse) | null = null;

  push(changes: RecordChange[]): PushResult[] {
    const out: PushResult[] = [];
    for (const c of changes) {
      if (c.vkVersion !== this.keyset.vkVersion) throw new Error('E_STALE_KEY');
      const cur = this.records.get(c.id);
      if (cur && cur.rev !== c.baseRev) {
        out.push({ id: c.id, status: 'conflict', current: cur });
        continue;
      }
      const rev = ++this.recordRev;
      const rec: EncryptedRecord = c.deleted
        ? { id: c.id, rev, vkVersion: c.vkVersion, deleted: true, nonce: null, ct: null }
        : { id: c.id, rev, vkVersion: c.vkVersion, deleted: false, nonce: c.nonce, ct: c.ct };
      this.records.set(c.id, rec);
      out.push({ id: c.id, status: 'ok', rev });
    }
    return out;
  }

  pull(since: number, limit = 500): PullResponse {
    const rows = [...this.records.values()]
      .filter((r) => r.rev > since)
      .sort((a, b) => a.rev - b.rev);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const res: PullResponse = {
      records: page,
      cursor: hasMore ? (page[page.length - 1] as EncryptedRecord).rev : this.recordRev,
      hasMore,
      fullResync: since > 0 && since < this.minValid,
    };
    if (since === 0 || since < this.keysetRev) res.keyset = this.keyset;
    return this.tamperPull ? this.tamperPull(res) : res;
  }

  setKeyset(ks: Keyset): void {
    this.keyset = ks;
    this.keysetRev = ++this.recordRev;
  }

  rotate(
    records: { id: string; deleted: boolean; nonce: string | null; ct: string | null }[],
    ks: Keyset,
  ): number {
    const base = this.recordRev;
    const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
    sorted.forEach((r, i) => {
      this.records.set(
        r.id,
        r.deleted
          ? {
              id: r.id,
              rev: base + i + 1,
              vkVersion: ks.vkVersion,
              deleted: true,
              nonce: null,
              ct: null,
            }
          : {
              id: r.id,
              rev: base + i + 1,
              vkVersion: ks.vkVersion,
              deleted: false,
              nonce: r.nonce as string,
              ct: r.ct as string,
            },
      );
    });
    this.recordRev = base + sorted.length;
    this.keysetRev = this.recordRev;
    this.minValid = base + 1;
    this.keyset = ks;
    return this.recordRev;
  }
}

export type PullResponse = {
  records: EncryptedRecord[];
  cursor: number;
  hasMore: boolean;
  fullResync: boolean;
  keyset?: Keyset;
};

/** The sync loop of spec §15 plus the W2 fullResync restart rule. */
export async function syncOnce(
  e: Engine,
  s: FakeServer,
): Promise<{ needsMasterPassword: boolean }> {
  for (;;) {
    const changes = await e.getPendingChanges(100);
    if (changes.length === 0) break;
    await e.applyPushResults(s.push(changes));
  }
  let needs = false;
  let { cursor } = await e.getSyncState();
  let restarting = false;
  for (;;) {
    let res = s.pull(cursor);
    if (res.fullResync && !restarting) {
      restarting = true;
      cursor = 0;
      continue;
    }
    if (restarting) res = { ...res, fullResync: true };
    const r = await e.applyPulled(res);
    if (r.needsMasterPassword) needs = true;
    cursor = res.cursor;
    if (!res.hasMore) break;
  }
  return { needsMasterPassword: needs };
}

export type Phone = { e: Engine; deps: MemoryDeps; clock: ManualClock };

export function newPhone(
  opts: { crypto?: CryptoProvider; clock?: ManualClock; platform?: 'ios' | 'android' } = {},
): Phone {
  const clock = opts.clock ?? new ManualClock();
  const deps = createMemoryDeps(opts.crypto ?? webcrypto, {
    clock,
    platform: opts.platform ?? 'ios',
  });
  return { e: createVaultEngine(deps), deps, clock };
}

/** Same storage / keystore, fresh engine: "the app was restarted". */
export function restart(p: Phone): Phone {
  return { ...p, e: createVaultEngine(p.deps) };
}

export async function setup(
  server: FakeServer,
  p: Phone,
  name = 'alice',
): Promise<{ recoveryKey: string }> {
  const { request, recoveryKey } = await p.e.createAccount({
    serverUrl: 'https://vault.test',
    accountName: name,
    masterPassword: PW,
    inviteCode: 'x',
  });
  const body = request.body as { accountId: string; keyset: Keyset; accountName: string };
  server.accountId = body.accountId;
  server.accountName = body.accountName;
  server.keyset = body.keyset;
  await p.e.commitAccount();
  await syncOnce(p.e, server);
  return { recoveryKey };
}

export async function restoreOn(
  server: FakeServer,
  p: Phone,
  recoveryKey: string,
  password = PW,
): Promise<void> {
  const authKey = await p.e.deriveAuthKey({
    accountId: server.accountId,
    kdf: server.keyset.kdf,
    masterPassword: password,
    recoveryKey,
  });
  await p.e.buildRecoverRequest({ accountName: server.accountName, authKey });
  await p.e.restoreAccount({
    serverUrl: 'https://vault.test',
    accountName: server.accountName,
    accountId: server.accountId,
    keyset: server.keyset,
    masterPassword: password,
    recoveryKey,
  });
  await syncOnce(p.e, server);
}

export const item = (title: string, extra: Partial<Parameters<VaultCore['saveItem']>[0]> = {}) => ({
  title,
  username: `${title}-user`,
  password: `${title}-pass`,
  urls: [{ url: `https://${title.toLowerCase()}.example.com/login`, match: 'domain' as const }],
  notes: '',
  favorite: false,
  ...extra,
});
