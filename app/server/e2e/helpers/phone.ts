// VirtualPhone: a vault-engine instance plus an HTTP driver that sends the engine's
// `ServerRequest`s and runs the sync loop of spec §15 (with the W2 `fullResync` restart rule).

import type { VaultCore } from '@localvault/core';
import {
  createWebCryptoProvider,
  type PendingUnlockRequest,
  type ServerRequest,
  VaultCoreError,
} from '@localvault/core';
import type { Keyset, PushResult } from '@localvault/protocol';
import { createVaultEngine, type EngineExtras } from '@localvault/vault-engine';
import { createMemoryDeps, type MemoryDeps } from '@localvault/vault-engine/memory';
import { DeviceSession } from './session';
import { HttpError, type Transport } from './transport';

export const SERVER_URL = 'https://vault.test';
export const MASTER_PW = 'correct horse battery staple';
export const provider = createWebCryptoProvider();

export type Engine = VaultCore & EngineExtras;

export class VirtualPhone {
  readonly deps: MemoryDeps;
  readonly engine: Engine;
  readonly session: DeviceSession;
  /** What the app would show: set when sync stopped for a reason the user must see. */
  stopped: string | null = null;

  constructor(
    readonly transport: Transport,
    clock: { now(): Date },
    opts: { platform?: 'ios' | 'android'; name?: string } = {},
  ) {
    this.deps = createMemoryDeps(provider, {
      clock,
      platform: opts.platform ?? 'ios',
      ...(opts.name ? { deviceName: opts.name } : {}),
    });
    this.engine = createVaultEngine(this.deps);
    this.session = new DeviceSession(
      transport,
      (c) => this.engine.signAuthChallenge(c),
      async () => (await this.engine.getAccountInfo()).deviceId,
    );
    this.session.onError = async (e) => {
      if (e.code === 'E_DEVICE_REVOKED') {
        this.stopped = 'E_DEVICE_REVOKED';
        await this.engine.markRevoked();
      } else if (e.code === 'E_ACCOUNT_DELETED') {
        this.stopped = 'E_ACCOUNT_DELETED';
      }
    };
  }

  /** Sends a request built by the engine; feeds batch results back into the engine. */
  // biome-ignore lint/suspicious/noExplicitAny: JSON
  async send(req: ServerRequest, opts: { auth?: boolean } = {}): Promise<any> {
    try {
      const body = await this.session.call(req, opts);
      if (req.method === 'POST' && req.path === '/v1/records/batch') {
        await this.engine.applyPushResults(body.results as PushResult[]);
      }
      return body;
    } catch (e) {
      if (e instanceof HttpError && ['E_DEVICE_REVOKED', 'E_ACCOUNT_DELETED'].includes(e.code)) {
        throw new VaultCoreError(e.code as 'E_DEVICE_REVOKED' | 'E_ACCOUNT_DELETED');
      }
      throw e;
    }
  }

  async sendAll(reqs: ServerRequest[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const r of reqs) out.push(await this.send(r));
    return out;
  }

  async createAccount(p: {
    name: string;
    password?: string;
    invite?: string;
  }): Promise<{ recoveryKey: string; accountId: string }> {
    const { request, recoveryKey } = await this.engine.createAccount({
      serverUrl: SERVER_URL,
      accountName: p.name,
      masterPassword: p.password ?? MASTER_PW,
      inviteCode: p.invite ?? 'x',
    });
    try {
      await this.session.call(request, { auth: false });
    } catch (e) {
      await this.engine.discardPendingAccount();
      throw e;
    }
    await this.engine.commitAccount();
    await this.session.login();
    await this.syncOnce();
    return { recoveryKey, accountId: (await this.engine.getAccountInfo()).accountId };
  }

  /** §8.6: prelogin -> authKey -> recover -> unwrap -> pull. Returns the unwrapped sync outcome. */
  async restore(p: { name: string; password?: string; recoveryKey: string }): Promise<void> {
    const name = p.name.normalize('NFKC').toLowerCase();
    const pre = await this.session.call(
      { method: 'GET', path: `/v1/prelogin?account=${encodeURIComponent(name)}` },
      { auth: false },
    );
    const password = p.password ?? MASTER_PW;
    const authKey = await this.engine.deriveAuthKey({
      accountId: pre.accountId,
      kdf: pre.kdf,
      masterPassword: password,
      recoveryKey: p.recoveryKey,
    });
    const req = await this.engine.buildRecoverRequest({ accountName: name, authKey });
    const rec = await this.session.call(req, { auth: false });
    await this.engine.restoreAccount({
      serverUrl: SERVER_URL,
      accountName: name,
      accountId: pre.accountId,
      keyset: rec.keyset as Keyset,
      masterPassword: password,
      recoveryKey: p.recoveryKey,
    });
    await this.session.login();
    await this.syncOnce();
  }

  /** §15 syncOnce. Rollback errors propagate as `VaultCoreError('E_ROLLBACK_DETECTED')` and stop the loop. */
  async syncOnce(): Promise<{ needsMasterPassword: boolean }> {
    if (this.stopped) throw new VaultCoreError(this.stopped as 'E_DEVICE_REVOKED');
    for (;;) {
      const changes = await this.engine.getPendingChanges(100);
      if (changes.length === 0) break;
      await this.send({ method: 'POST', path: '/v1/records/batch', body: { changes } });
    }
    let needs = false;
    let { cursor } = await this.engine.getSyncState();
    let restarting = false;
    for (;;) {
      const res = await this.session.call({
        method: 'GET',
        path: `/v1/records?since=${cursor}&limit=500`,
      });
      if (res.fullResync && !restarting) {
        // W2 rule: restart from since=0 and ignore fullResync on the later pages of the restart.
        restarting = true;
        cursor = 0;
        continue;
      }
      const r = await this.engine.applyPulled({ ...res, fullResync: restarting });
      if (r.needsMasterPassword) needs = true;
      cursor = res.cursor;
      if (!res.hasMore) break;
    }
    return { needsMasterPassword: needs };
  }

  /** FR-05: register a push token so the server can notify this phone. */
  async registerPush(token = `apns-${Math.random().toString(36).slice(2)}`): Promise<void> {
    await this.send({
      method: 'PUT',
      path: '/v1/devices/self/push-token',
      body: { pushPlatform: 'apns', token },
    });
  }

  // ---- flows used by several scenarios ----

  async approvePairing(qr: string, name = 'Chrome (Windows)'): Promise<void> {
    await this.syncOnce();
    const q = await this.engine.parsePairingQr(qr);
    const p = await this.session.call({ method: 'GET', path: `/v1/pairings/${q.pairingId}` });
    const req = await this.engine.approvePairing({
      pairing: {
        pairingId: p.pairingId,
        deviceId: p.deviceId,
        platform: p.platform,
        signPub: p.signPub,
        ephPub: p.ephPub,
      },
      fingerprint: q.fingerprint,
      name,
    });
    await this.send(req);
    await this.syncOnce();
  }

  async pendingUnlocks(): Promise<PendingUnlockRequest[]> {
    await this.syncOnce();
    const r = await this.session.call({ method: 'GET', path: '/v1/unlock-requests/pending' });
    return r.requests as PendingUnlockRequest[];
  }

  async approveUnlock(req: PendingUnlockRequest, typedCode: string): Promise<void> {
    await this.send(await this.engine.approveUnlock({ request: req, typedCode }));
  }

  async denyUnlock(req: PendingUnlockRequest): Promise<void> {
    await this.engine.rememberUnlockNonce(req.payload.requestNonce);
    await this.send({
      method: 'POST',
      path: `/v1/unlock-requests/${req.requestId}/deny`,
      body: {},
    });
  }

  /** Revocation, with the chunked key rotation of G12 when requested. */
  async revokeDevice(deviceId: string, o: { rotate?: boolean } = {}): Promise<void> {
    await this.syncOnce();
    const reqs = await this.engine.revokeDevice({
      deviceId,
      rotateKey: o.rotate === true,
      masterPassword: MASTER_PW,
    });
    for (const r of reqs) {
      const out = await this.send(r);
      if (r.path === '/v1/rotations') {
        const more = await this.engine.continueRotation(out.rotationId);
        try {
          let cursor = 0;
          for (const m of more) {
            const x = await this.send(m);
            if (m.path.endsWith('/commit')) cursor = x.cursor;
          }
          await this.engine.confirmRotation({ cursor });
        } catch (e) {
          await this.send(await this.engine.abortRotation(out.rotationId)).catch(() => undefined);
          throw e;
        }
      }
    }
    await this.syncOnce();
  }

  async changeMasterPassword(current: string, next: string): Promise<void> {
    const req = await this.engine.changeMasterPassword(current, next);
    await this.send(req);
    await this.engine.confirmKeysetAccepted();
    await this.syncOnce();
  }

  async regenerateRecoveryKey(password = MASTER_PW): Promise<string> {
    const { request, recoveryKey } = await this.engine.regenerateRecoveryKey(password);
    await this.send(request);
    await this.engine.confirmKeysetAccepted();
    await this.syncOnce();
    return recoveryKey;
  }
}
