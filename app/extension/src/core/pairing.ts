// PC pairing (8.3). Approval and the first unlock happen together.
import { open, pairingFingerprint, uuidV4FromRandom, wipe } from '@localvault/core';
import {
  base64urlDecode,
  base64urlEncode,
  formatPairQr,
  parseServerUrl,
  sealContextPair,
} from '@localvault/protocol';
import { wipeAll } from './account';
import type { ApiClient } from './api';
import { PcError } from './errors';
import { defaultDeviceName } from './platform';
import { openSession } from './session';
import { store } from './storage';
import { pullRecords } from './sync';
import type { Env } from './types';
import { buildIndex, verifyVaultKey } from './vault-index';

export type PairStart = { qr: string; pairingId: string; expiresAt: number; fingerprint: string };

export type PairPoll =
  | { state: 'pending'; expiresAt: number }
  | { state: 'expired' }
  | { state: 'paired' }
  | { state: 'failed'; reason: 'bad_vk' | 'bad_response' | 'network' };

/** Grace for clock differences before we call a still-pending pairing expired locally. */
const LOCAL_EXPIRY_GRACE_MS = 5_000;

export type ApiFactory = (origin: string) => ApiClient;

export async function startPairing(
  env: Env,
  makeApi: ApiFactory,
  serverUrlInput: string,
): Promise<PairStart> {
  if ((await store.account(env)) !== null) {
    throw new PcError('E_FORBIDDEN_ORIGIN', 'already paired; unpair first');
  }
  const parsed = parseServerUrl(serverUrlInput.trim(), {
    allowInsecureLocalhost: env.allowInsecureLocalhost,
  });
  if (!parsed.ok) throw new PcError('E_BAD_SERVER_URL', parsed.reason);
  const origin = parsed.origin;

  const signPub = base64urlEncode(await env.deviceKey.create());
  const eph = await env.crypto.generateKeyPair();
  const ephPub = base64urlEncode(eph.publicKey);
  const deviceId = uuidV4FromRandom(await env.crypto.randomBytes(16));

  const res = await makeApi(origin).call('createPairing', {
    body: { deviceId, signPub, ephPub, platform: env.platform.browser },
  });
  const fingerprint = await pairingFingerprint(env.crypto, signPub, ephPub);
  const qr = formatPairQr(
    { serverOrigin: origin, pairingId: res.pairingId, fingerprint },
    { allowInsecureLocalhost: env.allowInsecureLocalhost },
  );
  const expiresAt = Date.parse(res.expiresAt);
  await store.setPending(env, {
    kind: 'pair',
    pairingId: res.pairingId,
    pollToken: res.pollToken,
    deviceId,
    serverUrl: origin,
    ephPriv: base64urlEncode(eph.privateKey),
    ephPub,
    signPub,
    expiresAt,
    deviceName: defaultDeviceName(env.platform),
  });
  wipe(eph.privateKey);
  const cfg = await store.config(env);
  await store.setConfig(env, { ...cfg, serverUrl: origin });
  return { qr, pairingId: res.pairingId, expiresAt, fingerprint };
}

export async function cancelPairing(env: Env): Promise<void> {
  const p = await store.pending(env);
  if (p?.kind !== 'pair') return;
  await store.clearPending(env);
  if ((await store.account(env)) === null) await env.deviceKey.delete();
}

export async function pollPairing(env: Env, makeApi: ApiFactory): Promise<PairPoll> {
  const p = await store.pending(env);
  if (p?.kind !== 'pair') {
    if ((await store.account(env)) !== null) return { state: 'paired' };
    throw new PcError('E_NO_PENDING', 'no pairing in progress');
  }
  if (env.clock.now() > p.expiresAt + LOCAL_EXPIRY_GRACE_MS) {
    await cancelPairing(env);
    return { state: 'expired' };
  }
  const api = makeApi(p.serverUrl);
  const status = await api.call('pairingStatus', {
    params: { id: p.pairingId },
    authorization: `Pairing ${p.pollToken}`,
  });
  if (status.status === 'pending') return { state: 'pending', expiresAt: p.expiresAt };
  if (status.status === 'expired') {
    await cancelPairing(env);
    return { state: 'expired' };
  }

  // approved: open the Seal with OUR ephemeral key, then prove the VK before trusting it.
  const ephPriv = base64urlDecode(p.ephPriv);
  let vk: Uint8Array | undefined;
  try {
    const m = await open(env.crypto, ephPriv, sealContextPair(p.pairingId), status.response);
    vk = base64urlDecode(m.vk);
    await store.setAccount(env, {
      accountId: status.accountId,
      deviceId: p.deviceId,
      serverUrl: p.serverUrl,
      deviceName: p.deviceName,
      pairedAt: new Date(env.clock.now()).toISOString(),
    });
    const account = (await store.account(env)) as NonNullable<
      Awaited<ReturnType<typeof store.account>>
    >;
    await pullRecords(env, makeApi(p.serverUrl), account);
    const records = await store.records(env);
    await verifyVaultKey(env, account.accountId, vk, m.vkVersion, records);
    const index = await buildIndex(env, account.accountId, vk, m.vkVersion, records);
    await openSession(env, { vk, vkVersion: m.vkVersion, sessionMaxSec: m.sessionMaxSec });
    await store.setIndex(env, index);
    await store.clearPending(env);
    await store.setNotice(env, null);
    return { state: 'paired' };
  } catch (e) {
    // Anything wrong with an approval: undo completely, stay unpaired.
    await store.clearPending(env);
    if (e instanceof PcError && e.code === 'E_NETWORK') {
      await wipeAll(env, null);
      return { state: 'failed', reason: 'network' };
    }
    if (e instanceof PcError && e.code === 'E_BAD_VK') {
      await wipeAll(env, null);
      return { state: 'failed', reason: 'bad_vk' };
    }
    if (isApiError(e)) throw e;
    await wipeAll(env, null);
    return { state: 'failed', reason: 'bad_response' };
  } finally {
    wipe(ephPriv);
    if (vk !== undefined) wipe(vk);
  }
}

function isApiError(e: unknown): boolean {
  return e instanceof Error && e.name === 'ApiError';
}
