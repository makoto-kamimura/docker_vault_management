import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import {
  type AdminHeader,
  adminSignString,
  apiErrorBodySchema,
  authSignString,
  base64urlEncode,
  buildPath,
  formatAdminHeader,
  type Keyset,
  type RouteBodyInput,
  type RouteName,
  routes,
  unlockSignString,
} from '@localvault/protocol';
import { expect } from 'vitest';
import type { TestEnv } from './env';

const b64 = (b: Uint8Array) => base64urlEncode(b);

export class KeyPair {
  readonly priv: KeyObject;
  readonly pub: string;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.priv = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.pub = b64(
      Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x as string, 'base64url'),
        Buffer.from(jwk.y as string, 'base64url'),
      ]),
    );
  }
  sign(message: string): string {
    return b64(sign('sha256', Buffer.from(message), { key: this.priv, dsaEncoding: 'ieee-p1363' }));
  }
}

export class TestDevice {
  readonly id = randomUUID();
  readonly signKey = new KeyPair();
  readonly adminKey: KeyPair | null;
  token: string | null = null;
  constructor(
    readonly type: 'mobile' | 'extension',
    readonly platform: 'ios' | 'android' | 'chrome' | 'edge' | 'brave' = type === 'mobile'
      ? 'ios'
      : 'chrome',
  ) {
    this.adminKey = type === 'mobile' ? new KeyPair() : null;
  }
  registration() {
    return {
      deviceId: this.id,
      type: this.type,
      platform: this.platform,
      signPub: this.signKey.pub,
      adminPub: this.adminKey?.pub ?? null,
    };
  }
}

export type Admin =
  | { kind: 'sig'; tsOffsetSec?: number; nonce?: string; badSig?: boolean; as?: TestDevice }
  | { kind: 'authKey'; authKey: string }
  | { kind: 'both'; authKey: string };

export type CallOpts<N extends RouteName> = {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: RouteBodyInput<N> | unknown;
  rawBody?: string;
  device?: TestDevice;
  authorization?: string;
  admin?: Admin;
  authKeyHeader?: string;
  headers?: Record<string, string>;
  ip?: string;
};

// biome-ignore lint/suspicious/noExplicitAny: test helper; response bodies are checked with the protocol schemas
export type Result = { status: number; body: any; headers: Headers };

// Each call comes from a fresh address unless a test pins one (IP rate limits would otherwise trip).
let ipCounter = 1;

export class Api {
  constructor(readonly env: TestEnv) {}

  async call<N extends RouteName>(name: N, o: CallOpts<N> = {}): Promise<Result> {
    const def = routes[name];
    const path = buildPath(def.path, o.params, o.query);
    const raw = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const headers: Record<string, string> = {
      'x-forwarded-for':
        o.ip ?? `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`,
      ...o.headers,
    };
    if (raw !== undefined) headers['content-type'] = 'application/json';
    if (o.authorization) headers.authorization = o.authorization;
    else if (o.device?.token) headers.authorization = `Bearer ${o.device.token}`;
    if (o.authKeyHeader) headers['x-lv-authkey'] = o.authKeyHeader;
    const a = o.admin;
    if (a && (a.kind === 'sig' || a.kind === 'both')) {
      const so = a.kind === 'sig' ? a : ({} as Extract<Admin, { kind: 'sig' }>);
      const signer = so.as ?? (o.device as TestDevice);
      const ts = Math.floor(this.env.clock.now().getTime() / 1000) + (so.tsOffsetSec ?? 0);
      const nonce = so.nonce ?? b64(randomBytes(16));
      const bodyHash = b64(
        createHash('sha256')
          .update(raw ?? '')
          .digest(),
      );
      const str = adminSignString({ method: def.method, path, bodyHash, ts, nonce });
      let sig = (signer.adminKey as KeyPair).sign(str);
      if (so.badSig) sig = b64(randomBytes(64));
      const h: AdminHeader = { deviceId: signer.id, ts, nonce, sig };
      headers['x-lv-admin'] = formatAdminHeader(h);
    }
    if (a && (a.kind === 'authKey' || a.kind === 'both')) headers['x-lv-authkey'] = a.authKey;
    const res = await this.env.app.request(path, { method: def.method, headers, body: raw });
    const text = await res.text();
    const body = text ? JSON.parse(text) : undefined;
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    if (res.status === def.status) {
      if (def.status === 204) expect(text).toBe('');
      else def.response.parse(body);
    } else {
      expect(apiErrorBodySchema.safeParse(body).success, `non-success body: ${text}`).toBe(true);
    }
    return { status: res.status, body, headers: res.headers };
  }

  /** Like `call` but asserts the HTTP status and returns the body. */
  // biome-ignore lint/suspicious/noExplicitAny: test helper; bodies are schema-validated in `call`
  async ok<N extends RouteName>(name: N, o: CallOpts<N> = {}): Promise<any> {
    const r = await this.call(name, o);
    expect(r.status, JSON.stringify(r.body)).toBe(routes[name].status);
    return r.body;
  }

  async err<N extends RouteName>(name: N, code: string, o: CallOpts<N> = {}): Promise<Result> {
    const r = await this.call(name, o);
    expect(r.body?.error?.code, JSON.stringify(r.body)).toBe(code);
    return r;
  }

  async login(d: TestDevice): Promise<void> {
    const c = await this.ok('authChallenge', { body: { deviceId: d.id } });
    const t = await this.ok('authToken', {
      body: {
        deviceId: d.id,
        challenge: c.challenge,
        sig: d.signKey.sign(authSignString(d.id, c.challenge)),
      },
    });
    d.token = t.accessToken;
  }
}

export const fakeKeyset = (keysetVersion = 1, vkVersion = 1): Keyset => ({
  keysetVersion,
  vkVersion,
  kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64(randomBytes(16)) },
  wrappedVK: { nonce: b64(randomBytes(12)), ct: b64(randomBytes(48)) },
});

export type TestAccount = {
  accountId: string;
  name: string;
  authKey: string;
  verifier: string;
  device: TestDevice;
};

export async function createAccount(
  api: Api,
  opts: { name?: string; inviteCode?: string; device?: TestDevice } = {},
): Promise<TestAccount> {
  const device = opts.device ?? new TestDevice('mobile');
  const authKey = b64(randomBytes(32));
  const verifier = b64(createHash('sha256').update(Buffer.from(authKey, 'base64url')).digest());
  const accountId = randomUUID();
  const name = opts.name ?? `user${randomBytes(4).toString('hex')}`;
  await api.ok('createAccount', {
    body: {
      inviteCode: opts.inviteCode ?? 'x',
      accountId,
      accountName: name,
      keyset: fakeKeyset(),
      verifier,
      device: device.registration(),
    },
  });
  await api.login(device);
  return { accountId, name, authKey, verifier, device };
}

/** Register a PC through the real pairing endpoints and log it in. */
export async function addExtension(api: Api, acct: TestAccount): Promise<TestDevice> {
  const ext = new TestDevice('extension');
  const eph = new KeyPair();
  const p = await api.ok('createPairing', {
    body: { deviceId: ext.id, signPub: ext.signKey.pub, ephPub: eph.pub, platform: 'chrome' },
  });
  await api.ok('approvePairing', {
    device: acct.device,
    admin: { kind: 'sig' },
    params: { id: p.pairingId },
    body: { response: { epk: eph.pub, nonce: b64(randomBytes(12)), ct: b64(randomBytes(64)) } },
  });
  await api.login(ext);
  return ext;
}

export function change(id: string, baseRev: number, vkVersion = 1) {
  return {
    id,
    baseRev,
    deleted: false as const,
    vkVersion,
    nonce: b64(randomBytes(12)),
    ct: b64(randomBytes(40)),
  };
}

export function unlockPayload(
  d: TestDevice,
  accountId: string,
  o: { code?: string; issuedAt?: string; nonce?: string } = {},
) {
  const eph = new KeyPair();
  const requestNonce = o.nonce ?? b64(randomBytes(16));
  const code = o.code ?? '47';
  const issuedAt = o.issuedAt;
  return (now: Date) => {
    const at = issuedAt ?? now.toISOString().replace(/\.\d+Z$/, 'Z');
    const sig = d.signKey.sign(
      unlockSignString({
        accountId,
        deviceId: d.id,
        requestNonce,
        ephPub: eph.pub,
        code,
        issuedAt: at,
      }),
    );
    return { requestNonce, ephPub: eph.pub, code, issuedAt: at, sig };
  };
}
