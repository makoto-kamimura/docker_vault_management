import type { PushPayload } from '@localvault/protocol';
import { importPKCS8, SignJWT } from 'jose';
import type { Clock } from '../clock';
import type { FcmConfig } from '../config';
import type { PushOptions, PushOutcome, PushTarget } from './types';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;

export class FcmSender {
  private access: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: FcmConfig,
    private readonly clock: Clock,
  ) {}

  /** OAuth2 access token via the service-account JWT bearer grant (RS256). */
  private async accessToken(): Promise<string> {
    const nowMs = this.clock.now().getTime();
    if (this.access && this.access.expiresAt - 60_000 > nowMs) return this.access.token;
    const key = await importPKCS8(this.cfg.privateKey, 'RS256');
    const nowSec = Math.floor(nowMs / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.cfg.clientEmail)
      .setSubject(this.cfg.clientEmail)
      .setAudience(this.cfg.tokenUri)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(key);
    const res = await fetch(this.cfg.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`fcm oauth failed (${res.status})`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('fcm oauth returned no token');
    this.access = { token: json.access_token, expiresAt: nowMs + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  async send(target: PushTarget, payload: PushPayload, opts: PushOptions): Promise<PushOutcome> {
    const accessToken = await this.accessToken();
    const data: Record<string, string> = { t: payload.t };
    if ('r' in payload) data.r = payload.r;
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.cfg.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: target.token,
            data,
            android: { priority: 'HIGH', ttl: `${opts.ttlSec}s` },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (res.ok) return 'sent';
    if (res.status === 404 || res.status === 400) {
      const text = await res.text().catch(() => '');
      if (text.includes('UNREGISTERED')) return 'invalid_token';
    }
    return 'failed';
  }
}
