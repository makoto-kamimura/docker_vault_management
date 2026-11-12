// Token handling shared by the virtual phone and PC: device login with a signed challenge,
// automatic re-login when the access token expired (tests move the server clock by days).
import type { ServerRequest } from '@localvault/core';
import { HttpError, type Transport } from './transport';

export type Signer = (challenge: string) => Promise<{ deviceId: string; sig: string }>;

export class DeviceSession {
  token: string | null = null;
  /** Called with every error code before it is thrown (revocation handling lives here). */
  onError: ((e: HttpError) => Promise<void>) | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly sign: Signer | null,
    private readonly getDeviceId: () => Promise<string>,
  ) {}

  async login(): Promise<void> {
    if (!this.sign) throw new Error('no signer');
    const c = await this.raw({
      method: 'POST',
      path: '/v1/auth/challenge',
      body: { deviceId: await this.getDeviceId() },
    });
    const { deviceId, sig } = await this.sign(c.challenge);
    const t = await this.raw({
      method: 'POST',
      path: '/v1/auth/token',
      body: { deviceId, challenge: c.challenge, sig },
    });
    this.token = t.accessToken;
  }

  /** One request without any retry logic. */
  // biome-ignore lint/suspicious/noExplicitAny: JSON
  async raw(req: ServerRequest, extra: Record<string, string> = {}): Promise<any> {
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const res = await this.transport.send({
      method: req.method,
      path: req.path,
      body,
      headers: { ...req.headers, ...extra },
    });
    if (res.status >= 400) {
      const err = res.body?.error ?? {};
      const e = new HttpError(res.status, err.code ?? 'E_UNKNOWN', err.details);
      await this.onError?.(e);
      throw e;
    }
    return res.body;
  }

  /** Authenticated request (Bearer), re-logging in once if the token is gone. */
  // biome-ignore lint/suspicious/noExplicitAny: JSON
  async call(req: ServerRequest, opts: { auth?: boolean } = {}): Promise<any> {
    if (opts.auth === false || req.headers?.Authorization) return this.raw(req);
    if (!this.token) await this.login();
    try {
      return await this.raw(req, { Authorization: `Bearer ${this.token}` });
    } catch (e) {
      if (!(e instanceof HttpError) || e.code !== 'E_UNAUTHORIZED') throw e;
      await this.login();
      return this.raw(req, { Authorization: `Bearer ${this.token}` });
    }
  }
}
