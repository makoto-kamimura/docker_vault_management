import { type ClientHttp2Session, connect, constants } from 'node:http2';
import { PUSH_TEXT, type PushPayload } from '@localvault/protocol';
import { importPKCS8, SignJWT } from 'jose';
import type { Clock } from '../clock';
import type { ApnsConfig } from '../config';
import type { PushOptions, PushOutcome, PushTarget } from './types';

const TOKEN_LIFETIME_MS = 50 * 60 * 1000; // APNs wants a refresh between 20 and 60 minutes
const REQUEST_TIMEOUT_MS = 10_000;

export class ApnsSender {
  private session: ClientHttp2Session | null = null;
  private jwt: { value: string; issuedAt: number } | null = null;
  private readonly origin: string;

  constructor(
    private readonly cfg: ApnsConfig,
    private readonly clock: Clock,
  ) {
    this.origin = cfg.production
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
  }

  private async authToken(): Promise<string> {
    const nowMs = this.clock.now().getTime();
    if (this.jwt && nowMs - this.jwt.issuedAt < TOKEN_LIFETIME_MS) return this.jwt.value;
    const key = await importPKCS8(this.cfg.keyP8, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.cfg.keyId })
      .setIssuer(this.cfg.teamId)
      .setIssuedAt(Math.floor(nowMs / 1000))
      .sign(key);
    this.jwt = { value, issuedAt: nowMs };
    return value;
  }

  private getSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const s = connect(this.origin);
    s.on('error', () => {
      if (this.session === s) this.session = null;
    });
    s.on('close', () => {
      if (this.session === s) this.session = null;
    });
    s.unref();
    this.session = s;
    return s;
  }

  async send(target: PushTarget, payload: PushPayload, opts: PushOptions): Promise<PushOutcome> {
    const text = PUSH_TEXT[payload.t];
    const body = JSON.stringify({
      aps: { alert: { title: text.title, body: text.body }, sound: 'default' },
      ...payload,
    });
    const expiration = Math.floor(this.clock.now().getTime() / 1000) + opts.ttlSec;
    const token = await this.authToken();
    const session = this.getSession();
    return await new Promise<PushOutcome>((resolve) => {
      const headers: Record<string, string | number> = {
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${target.token}`,
        authorization: `bearer ${token}`,
        'apns-topic': this.cfg.topic,
        'apns-push-type': 'alert',
        'apns-priority': 10,
        'apns-expiration': expiration,
        'content-type': 'application/json',
      };
      if (opts.collapseId) headers['apns-collapse-id'] = opts.collapseId;
      let status = 0;
      const req = session.request(headers);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close());
      req.on('response', (h) => {
        status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      req.on('error', () => resolve('failed'));
      req.on('close', () => {
        if (status === 200) resolve('sent');
        else if (status === 410) resolve('invalid_token');
        else resolve('failed');
      });
      req.resume();
      req.end(body);
    });
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}
