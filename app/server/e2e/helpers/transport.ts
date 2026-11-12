// HTTP transport between the virtual devices and the in-process server app, plus the tampering
// wrapper that plays a malicious server (spec §17.3).
import type { TestEnv } from '../../test/helpers/env';

export type HttpReq = {
  method: string;
  path: string;
  /** Raw JSON text exactly as sent (admin signatures cover these bytes). */
  body?: string;
  headers: Record<string, string>;
};
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the callers
export type HttpRes = { status: number; body: any };

export interface Transport {
  send(req: HttpReq): Promise<HttpRes>;
}

export class HttpError extends Error {
  override readonly name = 'HttpError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${status} ${code}`);
  }
}

let ipCounter = 1;
const nextIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

export class InProcessTransport implements Transport {
  readonly log: { method: string; path: string; status: number }[] = [];
  constructor(private readonly env: TestEnv) {}
  async send(req: HttpReq): Promise<HttpRes> {
    const headers: Record<string, string> = { 'x-forwarded-for': nextIp(), ...req.headers };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.env.app.request(req.path, {
      method: req.method,
      headers,
      body: req.body,
    });
    const text = await res.text();
    this.log.push({ method: req.method, path: req.path, status: res.status });
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }
}

export type Rule = {
  match: (req: HttpReq) => boolean;
  apply: (res: HttpRes, req: HttpReq) => HttpRes;
  /** Remove the rule after its first use. */
  once?: boolean;
};

export class TamperingTransport implements Transport {
  rules: Rule[] = [];
  /** Every response that passed through, for replay attacks. */
  readonly seen: { req: HttpReq; res: HttpRes }[] = [];
  constructor(private readonly inner: Transport) {}

  rewrite(rule: Rule): void {
    this.rules.push(rule);
  }
  clear(): void {
    this.rules = [];
  }

  async send(req: HttpReq): Promise<HttpRes> {
    let res = await this.inner.send(req);
    this.seen.push({ req, res: structuredClone(res) });
    for (const rule of [...this.rules]) {
      if (!rule.match(req)) continue;
      res = rule.apply(structuredClone(res), req);
      if (rule.once) this.rules = this.rules.filter((r) => r !== rule);
    }
    return res;
  }
}
