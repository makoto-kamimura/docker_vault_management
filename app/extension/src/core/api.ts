// Typed API client built from the protocol route table. Every response is validated against the
// route's schema; nothing the server sends is used unvalidated.
import {
  ApiError,
  authSignString,
  base64urlEncode,
  buildPath,
  formatAuthorization,
  type RouteBodyInput,
  type RouteName,
  type RouteResponse,
  routes,
  utf8Encode,
} from '@localvault/protocol';
import { PcError } from './errors';
import { KEY, store } from './storage';
import type { Env } from './types';

export type CallOptions<N extends RouteName> = {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: RouteBodyInput<N>;
  /** Explicit Authorization header value (pairing poll). Otherwise the device Bearer token. */
  authorization?: string;
};

/** Refresh the access token this long before it expires. */
const TOKEN_SKEW_MS = 30_000;

export class ApiClient {
  constructor(
    private readonly env: Env,
    private readonly origin: string,
    /** Called with the error before it is rethrown; used to wipe on revoke / account deletion. */
    private readonly onApiError?: (e: ApiError) => Promise<void>,
  ) {}

  /** Device login (13.3): challenge -> sign with the non-extractable key -> 15 minute token. */
  async login(deviceId: string): Promise<string> {
    const cached = await store.token(this.env);
    if (cached !== null && cached.expiresAt - TOKEN_SKEW_MS > this.env.clock.now()) {
      return cached.accessToken;
    }
    const ch = await this.call('authChallenge', { body: { deviceId }, authorization: '' });
    const sig = await this.env.deviceKey.sign(utf8Encode(authSignString(deviceId, ch.challenge)));
    const tok = await this.call('authToken', {
      body: { deviceId, challenge: ch.challenge, sig: base64urlEncode(sig) },
      authorization: '',
    });
    await store.setToken(this.env, {
      accessToken: tok.accessToken,
      expiresAt: Date.parse(tok.expiresAt),
    });
    return tok.accessToken;
  }

  /** Authenticated call as this (already paired) device. */
  async authed<N extends RouteName>(
    name: N,
    deviceId: string,
    opts: CallOptions<N> = {},
  ): Promise<RouteResponse<N>> {
    const token = await this.login(deviceId);
    try {
      return await this.call(name, {
        ...opts,
        authorization: formatAuthorization({ scheme: 'Bearer', token }),
      });
    } catch (e) {
      // A 401 for an expired token: forget it so the next call logs in again.
      if (e instanceof ApiError && e.code === 'E_UNAUTHORIZED') {
        await this.env.session.remove(KEY.token);
      }
      throw e;
    }
  }

  async call<N extends RouteName>(name: N, opts: CallOptions<N> = {}): Promise<RouteResponse<N>> {
    const route = routes[name];
    const path = buildPath(route.path, opts.params, opts.query);
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (opts.authorization !== undefined && opts.authorization !== '') {
      headers.Authorization = opts.authorization;
    }
    let res: Response;
    try {
      res = await this.env.fetch(`${this.origin}${path}`, {
        method: route.method,
        headers,
        body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new PcError('E_NETWORK', 'server unreachable');
    }

    if (!res.ok) {
      let parsed: ApiError | null = null;
      try {
        parsed = ApiError.fromBody(await res.json());
      } catch {
        parsed = null;
      }
      if (parsed === null) throw new PcError('E_BAD_RESPONSE', `unexpected status ${res.status}`);
      if (this.onApiError) await this.onApiError(parsed);
      throw parsed;
    }
    if (res.status !== route.status) throw new PcError('E_BAD_RESPONSE', 'unexpected status');
    if (res.status === 204) return undefined as RouteResponse<N>;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PcError('E_BAD_RESPONSE', 'response is not JSON');
    }
    const parsed = route.response.safeParse(json);
    if (!parsed.success) throw new PcError('E_BAD_RESPONSE', `response does not match ${name}`);
    return parsed.data as RouteResponse<N>;
  }
}
