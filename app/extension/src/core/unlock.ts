// PC unlock request (8.4).
import { open, wipe } from '@localvault/core';
import {
  base64urlDecode,
  base64urlEncode,
  sealContextUnlock,
  unlockSignString,
  utf8Encode,
} from '@localvault/protocol';
import { PcError } from './errors';
import type { ApiFactory } from './pairing';
import { randomIntInclusive } from './random';
import { openSession } from './session';
import { type Pending, store } from './storage';
import { pullRecords } from './sync';
import { isoSeconds } from './time';
import type { Env } from './types';
import { buildIndex, verifyVaultKey } from './vault-index';

export type UnlockPoll =
  | { state: 'unlocked' }
  | { state: 'idle' }
  | { state: 'waiting'; code: string; expiresAt: number }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'failed'; reason: 'bad_vk' | 'bad_response' | 'stale' };

type UnlockPending = Extract<Pending, { kind: 'unlock' }>;
const LOCAL_EXPIRY_GRACE_MS = 5_000;

export async function startUnlock(
  env: Env,
  makeApi: ApiFactory,
): Promise<{ code: string; expiresAt: number; requestId: string }> {
  const account = await store.account(env);
  if (account === null) throw new PcError('E_NOT_PAIRED', 'not paired');

  // Resume an unexpired request (worker restart, second UI): the server limits creation rate.
  const existing = await store.pending(env);
  if (existing?.kind === 'unlock' && env.clock.now() < existing.expiresAt) {
    return { code: existing.code, expiresAt: existing.expiresAt, requestId: existing.requestId };
  }

  const eph = await env.crypto.generateKeyPair();
  const requestNonce = base64urlEncode(await env.crypto.randomBytes(16));
  const ephPub = base64urlEncode(eph.publicKey);
  const code = String(await randomIntInclusive(env.crypto, 10, 99));
  const issuedAt = isoSeconds(env.clock.now());
  const text = unlockSignString({
    accountId: account.accountId,
    deviceId: account.deviceId,
    requestNonce,
    ephPub,
    code,
    issuedAt,
  });
  const sig = base64urlEncode(await env.deviceKey.sign(utf8Encode(text)));
  const res = await makeApi(account.serverUrl).authed('createUnlockRequest', account.deviceId, {
    body: { requestNonce, ephPub, code, issuedAt, sig },
  });
  const expiresAt = Date.parse(res.expiresAt);
  await store.setPending(env, {
    kind: 'unlock',
    requestId: res.requestId,
    ephPriv: base64urlEncode(eph.privateKey),
    code,
    expiresAt,
  });
  wipe(eph.privateKey);
  return { code, expiresAt, requestId: res.requestId };
}

export async function cancelUnlock(env: Env): Promise<void> {
  const p = await store.pending(env);
  if (p?.kind === 'unlock') await store.clearPending(env);
}

export async function pollUnlock(env: Env, makeApi: ApiFactory): Promise<UnlockPoll> {
  const account = await store.account(env);
  if (account === null) throw new PcError('E_NOT_PAIRED', 'not paired');
  const p = await store.pending(env);
  if (p?.kind !== 'unlock') {
    return (await store.session(env)) !== null ? { state: 'unlocked' } : { state: 'idle' };
  }
  if (env.clock.now() > p.expiresAt + LOCAL_EXPIRY_GRACE_MS) {
    await store.clearPending(env);
    return { state: 'expired' };
  }
  const api = makeApi(account.serverUrl);
  const res = await api.authed('getUnlockRequest', account.deviceId, {
    params: { id: p.requestId },
  });
  if (res.status === 'pending') {
    return { state: 'waiting', code: p.code, expiresAt: p.expiresAt };
  }
  if (res.status === 'denied' || res.status === 'expired') {
    await store.clearPending(env);
    return { state: res.status };
  }
  return approve(env, makeApi, p, res.response);
}

async function approve(
  env: Env,
  makeApi: ApiFactory,
  p: UnlockPending,
  response: Parameters<typeof open>[3],
): Promise<UnlockPoll> {
  const account = await store.account(env);
  if (account === null) throw new PcError('E_NOT_PAIRED', 'not paired');
  const ephPriv = base64urlDecode(p.ephPriv);
  let vk: Uint8Array | undefined;
  try {
    const m = await open(env.crypto, ephPriv, sealContextUnlock(p.requestId), response);
    vk = base64urlDecode(m.vk);
    // Sync first (7.8); an unreachable server is fine if the cache already holds the meta record.
    try {
      await pullRecords(env, makeApi(account.serverUrl), account);
    } catch (e) {
      if (!(e instanceof PcError) || e.code !== 'E_NETWORK') throw e;
    }
    const sync = await store.sync(env);
    if (m.vkVersion < sync.vkVersion) {
      await store.clearPending(env);
      return { state: 'failed', reason: 'stale' };
    }
    const records = await store.records(env);
    // A forged approval carries a VK that cannot decrypt the meta record: reject it.
    await verifyVaultKey(env, account.accountId, vk, m.vkVersion, records);
    const index = await buildIndex(env, account.accountId, vk, m.vkVersion, records);
    await openSession(env, { vk, vkVersion: m.vkVersion, sessionMaxSec: m.sessionMaxSec });
    await store.setIndex(env, index);
    await store.clearPending(env);
    return { state: 'unlocked' };
  } catch (e) {
    if (e instanceof PcError && e.code === 'E_BAD_VK') {
      await store.clearPending(env);
      return { state: 'failed', reason: 'bad_vk' };
    }
    if (e instanceof Error && (e.name === 'ApiError' || (e as PcError).code === 'E_NETWORK')) {
      throw e; // keep the pending request; the next poll retries
    }
    await store.clearPending(env);
    return { state: 'failed', reason: 'bad_response' };
  } finally {
    wipe(ephPriv);
    if (vk !== undefined) wipe(vk);
  }
}
