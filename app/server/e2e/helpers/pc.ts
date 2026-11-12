// VirtualPc: a minimal extension-side client written with core primitives only (no vault-engine).
// `PcClient` is the seam: the real extension core can be substituted behind it later.
import {
  decryptRecord,
  open,
  pairingFingerprint,
  signAuthChallenge,
  signUnlockRequest,
} from '@localvault/core';
import {
  base64urlEncode as b64,
  type EncryptedRecord,
  formatPairQr,
  META_RECORD_ID,
  type RecordPlain,
  sealContextPair,
  sealContextUnlock,
  base64urlDecode as unb64,
} from '@localvault/protocol';
import { provider, SERVER_URL } from './phone';
import { DeviceSession } from './session';
import type { HttpError, Transport } from './transport';

export type PcState = 'unpaired' | 'pairing' | 'locked' | 'unlocked' | 'wiped';
export type PcItem = { title: string; username: string; password: string };

export interface PcClient {
  readonly state: PcState;
  beginPairing(): Promise<{ qr: string; pairingId: string }>;
  completePairing(): Promise<void>;
  requestUnlock(): Promise<{ requestId: string; code: string }>;
  awaitUnlock(requestId: string): Promise<'unlocked' | 'denied' | 'expired' | 'pending'>;
  /** Pull ciphertext; decrypt when unlocked. A revoked device wipes itself here. */
  sync(): Promise<void>;
  items(): PcItem[];
  lock(): void;
  /** Number of ciphertext records held (survives lock; gone after a wipe). */
  cachedCount(): number;
}

export class PcCheckError extends Error {
  override readonly name = 'PcCheckError';
}

export class VirtualPc implements PcClient {
  state: PcState = 'unpaired';
  #id!: string;
  #sign!: { privateKey: Uint8Array; publicKey: Uint8Array };
  #eph!: { privateKey: Uint8Array; publicKey: Uint8Array };
  #accountId = '';
  #pairing: { id: string; pollToken: string } | null = null;
  #vk: Uint8Array | null = null;
  #vkVersion = 1;
  #cache = new Map<string, EncryptedRecord>();
  #cursor = 0;
  #plain = new Map<string, RecordPlain>();
  sessionMaxSec = 0;
  readonly session: DeviceSession;

  constructor(
    readonly transport: Transport,
    private readonly clock: { now(): Date },
  ) {
    this.session = new DeviceSession(
      transport,
      async (challenge) => ({
        deviceId: this.#id,
        sig: await signAuthChallenge(provider, this.#sign.privateKey, this.#id, challenge),
      }),
      async () => this.#id,
    );
    this.session.onError = async (e: HttpError) => {
      if (e.code === 'E_DEVICE_REVOKED') this.#wipe();
    };
  }

  /** The device id the server knows (available after `beginPairing`). */
  get id(): string {
    return this.#id;
  }

  #wipe(): void {
    this.#vk?.fill(0);
    this.#vk = null;
    this.#cache.clear();
    this.#plain.clear();
    this.#cursor = 0;
    this.session.token = null;
    this.#sign = undefined as never;
    this.#eph = undefined as never;
    this.state = 'wiped';
  }

  async beginPairing(): Promise<{ qr: string; pairingId: string }> {
    this.#id = crypto.randomUUID();
    this.#sign = await provider.generateKeyPair();
    this.#eph = await provider.generateKeyPair();
    const signPub = b64(this.#sign.publicKey);
    const ephPub = b64(this.#eph.publicKey);
    const r = await this.session.raw(
      {
        method: 'POST',
        path: '/v1/pairings',
        body: { deviceId: this.#id, signPub, ephPub, platform: 'chrome' },
      },
      {},
    );
    this.#pairing = { id: r.pairingId, pollToken: r.pollToken };
    this.state = 'pairing';
    return {
      pairingId: r.pairingId,
      qr: formatPairQr(
        {
          serverOrigin: SERVER_URL,
          pairingId: r.pairingId,
          fingerprint: await pairingFingerprint(provider, signPub, ephPub),
        },
        { allowInsecureLocalhost: true },
      ),
    };
  }

  async completePairing(): Promise<void> {
    if (!this.#pairing) throw new PcCheckError('not pairing');
    const st = await this.session.raw(
      { method: 'GET', path: `/v1/pairings/${this.#pairing.id}/status` },
      { Authorization: `Pairing ${this.#pairing.pollToken}` },
    );
    if (st.status !== 'approved') throw new PcCheckError(`pairing is ${st.status}`);
    this.#accountId = st.accountId;
    const m = await open(
      provider,
      this.#eph.privateKey,
      sealContextPair(this.#pairing.id),
      st.response,
    );
    await this.#adoptVk(unb64(m.vk), m.vkVersion, m.sessionMaxSec);
    this.#pairing = null;
  }

  /** §8.5: only after the meta record decrypts with the received VK does the PC trust it. */
  async #adoptVk(vk: Uint8Array, vkVersion: number, sessionMaxSec: number): Promise<void> {
    await this.#pull();
    const meta = this.#cache.get(META_RECORD_ID);
    if (!meta || meta.deleted) throw new PcCheckError('meta record missing');
    try {
      await decryptRecord(
        provider,
        vk,
        { accountId: this.#accountId, recordId: META_RECORD_ID, vkVersion: meta.vkVersion },
        { nonce: meta.nonce, ct: meta.ct },
      );
    } catch {
      throw new PcCheckError('received key does not open the vault');
    }
    this.#vk = vk;
    this.#vkVersion = vkVersion;
    this.sessionMaxSec = sessionMaxSec;
    this.state = 'unlocked';
    await this.#decryptAll();
  }

  async #pull(): Promise<void> {
    if (!this.session.token) await this.session.login();
    for (;;) {
      const res = await this.session.call({
        method: 'GET',
        path: `/v1/records?since=${this.#cursor}&limit=500`,
      });
      for (const r of res.records as EncryptedRecord[]) this.#cache.set(r.id, r);
      this.#cursor = res.cursor;
      if (!res.hasMore) break;
    }
  }

  async #decryptAll(): Promise<void> {
    this.#plain.clear();
    for (const r of this.#cache.values()) {
      if (r.deleted) continue;
      this.#plain.set(
        r.id,
        await decryptRecord(
          provider,
          this.#vk as Uint8Array,
          { accountId: this.#accountId, recordId: r.id, vkVersion: r.vkVersion },
          { nonce: r.nonce, ct: r.ct },
        ),
      );
    }
  }

  async requestUnlock(): Promise<{ requestId: string; code: string }> {
    if (this.state !== 'locked') throw new PcCheckError('not locked');
    this.#eph = await provider.generateKeyPair();
    const requestNonce = b64(await provider.randomBytes(16));
    const code = String(10 + (((await provider.randomBytes(1))[0] as number) % 90));
    const issuedAt = this.clock
      .now()
      .toISOString()
      .replace(/\.\d+Z$/, 'Z');
    const ephPub = b64(this.#eph.publicKey);
    const sig = await signUnlockRequest(provider, this.#sign.privateKey, {
      accountId: this.#accountId,
      deviceId: this.#id,
      requestNonce,
      ephPub,
      code,
      issuedAt,
    });
    const r = await this.session.call({
      method: 'POST',
      path: '/v1/unlock-requests',
      body: { requestNonce, ephPub, code, issuedAt, sig },
    });
    this.#lastUnlock = r.requestId;
    return { requestId: r.requestId, code };
  }
  #lastUnlock = '';

  async awaitUnlock(requestId: string) {
    const r = await this.session.call({ method: 'GET', path: `/v1/unlock-requests/${requestId}` });
    if (r.status !== 'approved') return r.status as 'denied' | 'expired' | 'pending';
    const m = await open(provider, this.#eph.privateKey, sealContextUnlock(requestId), r.response);
    await this.#adoptVk(unb64(m.vk), m.vkVersion, m.sessionMaxSec);
    return 'unlocked' as const;
  }

  async sync(): Promise<void> {
    if (this.state === 'wiped' || this.state === 'unpaired') return;
    await this.#pull();
    if (this.state === 'unlocked') await this.#decryptAll();
  }

  items(): PcItem[] {
    if (this.state !== 'unlocked') return [];
    const out: PcItem[] = [];
    for (const p of this.#plain.values()) {
      if (p.kind === 'login' && p.data.trashedAt === null)
        out.push({ title: p.data.title, username: p.data.username, password: p.data.password });
    }
    return out;
  }

  lock(): void {
    this.#vk?.fill(0);
    this.#vk = null;
    this.#plain.clear();
    if (this.state === 'unlocked') this.state = 'locked';
  }

  cachedCount(): number {
    return this.#cache.size;
  }

  get hasKeyMaterial(): boolean {
    return this.#sign !== undefined && this.#vk !== null;
  }
  get lastUnlockRequestId(): string {
    return this.#lastUnlock;
  }
  get vkVersion(): number {
    return this.#vkVersion;
  }
  get hasDeviceKey(): boolean {
    return this.#sign !== undefined;
  }
}
