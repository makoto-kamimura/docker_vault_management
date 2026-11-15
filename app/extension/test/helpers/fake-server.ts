// An in-memory LocalVault server + "phone" for tests. It speaks the real protocol shapes
// (responses are validated by the extension against the same zod schemas).
import {
  createWebCryptoProvider,
  encryptRecord,
  seal,
  uuidV4FromRandom,
  verifyAuthChallenge,
} from '@localvault/core';
import {
  type ApiError as _ApiError,
  base64urlDecode,
  base64urlEncode,
  type EncryptedRecord,
  META_RECORD_ID,
  type RecordPlain,
  sealContextPair,
  sealContextUnlock,
} from '@localvault/protocol';

const p = createWebCryptoProvider();
void (null as unknown as _ApiError);

export type FakeLogin = {
  title: string;
  username: string;
  password: string;
  urls: { url: string; match: 'domain' | 'host' }[];
  trashed?: boolean;
};

const b64 = (n: number) => base64urlEncode(crypto.getRandomValues(new Uint8Array(n)));

export class FakeServer {
  readonly origin = 'https://vault.test';
  accountId = uuidV4FromRandom(crypto.getRandomValues(new Uint8Array(16)));
  vk = crypto.getRandomValues(new Uint8Array(32));
  vkVersion = 1;
  keysetVersion = 1;
  keysetRev = 0;
  rev = 0;
  minValidCursor = 0;
  records = new Map<string, EncryptedRecord>();
  devices = new Map<string, string>(); // deviceId -> signPub
  revoked = new Set<string>();
  deleted = new Set<string>();
  tokens = new Map<string, string>(); // token -> deviceId
  challenges = new Map<string, string>(); // deviceId -> challenge
  pairings = new Map<
    string,
    { deviceId: string; signPub: string; ephPub: string; pollToken: string; response?: unknown }
  >();
  unlocks = new Map<
    string,
    {
      deviceId: string;
      ephPub: string;
      code: string;
      status: 'pending' | 'denied' | 'approved';
      response?: unknown;
    }
  >();
  sessionMaxSec = 3600;
  requests: { method: string; path: string }[] = [];
  /** Test hook: force a response for the next matching path. */
  failNext: { path: RegExp; status: number; body: unknown }[] = [];
  offline = false;
  lastUnlockBody: unknown;

  async putLogin(id: string, login: FakeLogin): Promise<void> {
    const now = new Date().toISOString();
    const plain: RecordPlain = {
      kind: 'login',
      updatedAt: now,
      updatedBy: this.accountId,
      data: {
        title: login.title,
        username: login.username,
        password: login.password,
        urls: login.urls,
        androidApps: [],
        notes: '',
        favorite: false,
        createdAt: now,
        trashedAt: login.trashed ? now : null,
        conflictOf: null,
      },
    };
    await this.put(id, plain);
  }

  async putMeta(): Promise<void> {
    const now = new Date().toISOString();
    await this.put(META_RECORD_ID, {
      kind: 'meta',
      updatedAt: now,
      updatedBy: this.accountId,
      data: {
        recoveryKey: 'LV2-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA',
        pcSessionMaxSec: 3600,
        createdAt: now,
      },
    });
  }

  async put(id: string, plain: RecordPlain, vk = this.vk): Promise<void> {
    const enc = await encryptRecord(
      p,
      vk,
      { accountId: this.accountId, recordId: id, vkVersion: this.vkVersion },
      plain,
    );
    this.rev += 1;
    this.records.set(id, {
      id,
      rev: this.rev,
      vkVersion: this.vkVersion,
      deleted: false,
      nonce: enc.nonce,
      ct: enc.ct,
    });
  }

  tombstone(id: string): void {
    this.rev += 1;
    this.records.set(id, {
      id,
      rev: this.rev,
      vkVersion: this.vkVersion,
      deleted: true,
      nonce: null,
      ct: null,
    });
  }

  keyset() {
    return {
      keysetVersion: this.keysetVersion,
      vkVersion: this.vkVersion,
      kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations: 600000, salt: b64(16) },
      wrappedVK: { nonce: b64(12), ct: b64(48) },
    };
  }

  // ---- phone side
  async approvePairing(pairingId: string, opts: { vk?: Uint8Array; vkVersion?: number } = {}) {
    const pr = this.pairings.get(pairingId);
    if (!pr) throw new Error('no pairing');
    this.devices.set(pr.deviceId, pr.signPub);
    pr.response = await seal(p, base64urlDecode(pr.ephPub), sealContextPair(pairingId), {
      vk: base64urlEncode(opts.vk ?? this.vk),
      vkVersion: opts.vkVersion ?? this.vkVersion,
      sessionMaxSec: this.sessionMaxSec as 3600,
      issuedAt: new Date().toISOString(),
    });
  }

  async approveUnlock(requestId: string, opts: { vk?: Uint8Array; vkVersion?: number } = {}) {
    const r = this.unlocks.get(requestId);
    if (!r) throw new Error('no unlock');
    r.response = await seal(p, base64urlDecode(r.ephPub), sealContextUnlock(requestId), {
      vk: base64urlEncode(opts.vk ?? this.vk),
      vkVersion: opts.vkVersion ?? this.vkVersion,
      sessionMaxSec: this.sessionMaxSec as 3600,
      issuedAt: new Date().toISOString(),
    });
    r.status = 'approved';
  }

  // ---- HTTP
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError('offline');
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = init?.method ?? 'GET';
    this.requests.push({ method, path });
    const forced = this.failNext.findIndex((f) => f.path.test(path));
    if (forced >= 0) {
      const f = this.failNext.splice(forced, 1)[0];
      return json(f?.status ?? 500, f?.body);
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;

    const err = (status: number, code: string, details?: unknown) =>
      json(status, { error: { code, message: code, ...(details ? { details } : {}) } });

    if (method === 'POST' && path === '/v1/auth/challenge') {
      if (this.deleted.has(body.deviceId)) return err(410, 'E_ACCOUNT_DELETED');
      if (this.revoked.has(body.deviceId)) return err(401, 'E_DEVICE_REVOKED');
      if (!this.devices.has(body.deviceId)) return err(401, 'E_UNAUTHORIZED');
      const challenge = b64(32);
      this.challenges.set(body.deviceId, challenge);
      return json(200, { challenge, expiresAt: new Date(Date.now() + 60000).toISOString() });
    }
    if (method === 'POST' && path === '/v1/auth/token') {
      const ch = this.challenges.get(body.deviceId);
      const pub = this.devices.get(body.deviceId);
      if (!ch || ch !== body.challenge || !pub) return err(401, 'E_UNAUTHORIZED');
      const ok = await verifyAuthChallenge(p, pub, body.deviceId, body.challenge, body.sig);
      if (!ok) return err(401, 'E_UNAUTHORIZED');
      this.challenges.delete(body.deviceId);
      const token = `${b64(8)}.${b64(8)}.${b64(8)}`;
      this.tokens.set(token, body.deviceId);
      return json(200, {
        accessToken: token,
        expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      });
    }
    if (method === 'POST' && path === '/v1/pairings') {
      const pairingId = uuidV4FromRandom(crypto.getRandomValues(new Uint8Array(16)));
      const pollToken = b64(32);
      this.pairings.set(pairingId, { ...body, pollToken });
      return json(201, {
        pairingId,
        pollToken,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      });
    }
    const ps = /^\/v1\/pairings\/([^/]+)\/status$/.exec(path);
    if (method === 'GET' && ps) {
      const pr = this.pairings.get(ps[1] as string);
      if (!pr || auth !== `Pairing ${pr.pollToken}`) return err(401, 'E_UNAUTHORIZED');
      if (!pr.response) return json(200, { status: 'pending' });
      return json(200, { status: 'approved', accountId: this.accountId, response: pr.response });
    }

    // ---- Bearer-authenticated
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const deviceId = token ? this.tokens.get(token) : undefined;
    if (!deviceId) return err(401, 'E_UNAUTHORIZED');
    if (this.deleted.has(deviceId)) return err(410, 'E_ACCOUNT_DELETED');
    if (this.revoked.has(deviceId)) return err(401, 'E_DEVICE_REVOKED');

    if (method === 'GET' && path.startsWith('/v1/records')) {
      const since = Number(new URL(url).searchParams.get('since'));
      const limit = Number(url.searchParams.get('limit') ?? 500);
      const all = [...this.records.values()]
        .filter((r) => r.rev > since)
        .sort((a, b) => a.rev - b.rev);
      const page = all.slice(0, limit);
      const hasMore = all.length > page.length;
      const out: Record<string, unknown> = {
        records: page,
        cursor: hasMore ? (page[page.length - 1] as EncryptedRecord).rev : this.rev,
        hasMore,
        fullResync: since > 0 && since < this.minValidCursor,
      };
      if (since === 0 || since < this.keysetRev) out.keyset = this.keyset();
      return json(200, out);
    }
    if (method === 'POST' && path === '/v1/unlock-requests') {
      const requestId = uuidV4FromRandom(crypto.getRandomValues(new Uint8Array(16)));
      this.lastUnlockBody = body;
      this.unlocks.set(requestId, {
        deviceId,
        ephPub: body.ephPub,
        code: body.code,
        status: 'pending',
      });
      return json(201, { requestId, expiresAt: new Date(Date.now() + 120000).toISOString() });
    }
    const um = /^\/v1\/unlock-requests\/([^/]+)$/.exec(path);
    if (method === 'GET' && um) {
      const r = this.unlocks.get(um[1] as string);
      if (!r || r.deviceId !== deviceId) return err(404, 'E_NOT_FOUND');
      if (r.status === 'pending')
        return json(200, {
          status: 'pending',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
      if (r.status === 'denied') return json(200, { status: 'denied' });
      return json(200, { status: 'approved', response: r.response });
    }
    return err(404, 'E_NOT_FOUND');
  };
}

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
