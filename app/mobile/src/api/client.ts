// Typed API client over the protocol `routes` table: request/response validation, ApiError mapping,
// timeouts, one retry after a 401, and `sendServerRequest` for requests VaultCore built.
import type { ServerRequest } from '@localvault/core';
import {
  ApiError,
  buildPath,
  type RouteBodyInput,
  type RouteDef,
  type RouteName,
  type RouteResponse,
  routeList,
  routes,
} from '@localvault/protocol';
import { InvalidRequestError, InvalidResponseError, NetworkError } from './errors';

export type TokenSource = {
  getToken(): Promise<string>;
  invalidate(): void;
};

export type CallArgs<N extends RouteName> = {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: RouteBodyInput<N>;
  /** Overrides the Authorization header (`Pairing …`, `Claim …`). */
  authorization?: string;
  /** Extra headers (e.g. X-LV-Admin built by VaultCore). */
  headers?: Record<string, string>;
};

export type ApiClientOptions = {
  baseUrl: () => string | Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  tokens?: TokenSource;
};

export type ApiClient = {
  call<N extends RouteName>(name: N, args?: CallArgs<N>): Promise<RouteResponse<N>>;
  /** Sends a request VaultCore built, validating it against the matching route. */
  sendServerRequest(req: ServerRequest): Promise<unknown>;
};

export const DEFAULT_TIMEOUT_MS = 15_000;

function needsBearer(auth: RouteDef['auth']): boolean {
  return auth === 'device' || auth === 'extension' || auth.startsWith('approver');
}

type Matcher = { def: RouteDef; re: RegExp };
let matchers: Matcher[] | undefined;

function routeMatchers(): Matcher[] {
  matchers ??= routeList.map((def) => ({
    def,
    re: new RegExp(`^${def.path.replace(/\{\w+\}/g, '[^/?#]+')}$`),
  }));
  return matchers;
}

/** Finds the route for a method + path (query string ignored). `devices/self/...` beats `{id}`. */
export function matchRoute(method: string, path: string): RouteDef | undefined {
  const bare = path.split('?')[0] ?? path;
  const hits = routeMatchers().filter((m) => m.def.method === method && m.re.test(bare));
  // Prefer the route with the fewest placeholders (literal segments are more specific).
  hits.sort(
    (a, b) => (a.def.path.match(/\{/g)?.length ?? 0) - (b.def.path.match(/\{/g)?.length ?? 0),
  );
  return hits[0]?.def;
}

function validateBody(def: RouteDef, body: unknown): void {
  const schema = def.request.body;
  if (schema === undefined) return;
  const r = schema.safeParse(body);
  if (!r.success) {
    // Field paths only: issue messages can echo input values.
    throw new InvalidRequestError(
      def.name,
      r.error.issues.map((i) => i.path.join('.') || '(root)'),
    );
  }
}

function validateQuery(def: RouteDef, query: Record<string, string | number | undefined>): void {
  const schema = def.request.query;
  if (schema === undefined) return;
  const strings: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined) strings[k] = String(v);
  const r = schema.safeParse(strings);
  if (!r.success) {
    throw new InvalidRequestError(
      def.name,
      r.error.issues.map((i) => i.path.join('.') || '(root)'),
    );
  }
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send(
    def: RouteDef,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    authorization: string | undefined,
  ): Promise<unknown> {
    const base = await opts.baseUrl();
    const hdrs: Record<string, string> = { Accept: 'application/json', ...headers };
    if (body !== undefined) hdrs['Content-Type'] = 'application/json';
    if (authorization !== undefined) hdrs.Authorization = authorization;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, {
        method: def.method,
        headers: hdrs,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch {
      throw new NetworkError(controller.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (res.status < 200 || res.status >= 300) {
      const apiErr = ApiError.fromBody(json);
      if (apiErr) throw apiErr;
      if (res.status >= 500) throw new ApiError('E_INTERNAL');
      throw new InvalidResponseError(def.name, res.status);
    }
    if (def.status === 204) return undefined;
    const parsed = def.response.safeParse(json);
    if (!parsed.success) throw new InvalidResponseError(def.name, res.status);
    return parsed.data;
  }

  async function execute(
    def: RouteDef,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    authorization: string | undefined,
  ): Promise<unknown> {
    const useBearer =
      authorization === undefined && opts.tokens !== undefined && needsBearer(def.auth);
    for (let attempt = 0; ; attempt++) {
      const auth = useBearer
        ? `Bearer ${await (opts.tokens as TokenSource).getToken()}`
        : authorization;
      try {
        return await send(def, path, body, headers, auth);
      } catch (e) {
        if (useBearer && attempt === 0 && e instanceof ApiError && e.code === 'E_UNAUTHORIZED') {
          (opts.tokens as TokenSource).invalidate();
          continue;
        }
        throw e;
      }
    }
  }

  return {
    async call<N extends RouteName>(name: N, args: CallArgs<N> = {}): Promise<RouteResponse<N>> {
      const def = routes[name] as RouteDef;
      validateBody(def, args.body);
      if (args.query) validateQuery(def, args.query);
      const path = buildPath(def.path, args.params, args.query);
      const out = await execute(def, path, args.body, args.headers ?? {}, args.authorization);
      return out as RouteResponse<N>;
    },

    async sendServerRequest(req) {
      const def = matchRoute(req.method, req.path);
      if (!def) throw new InvalidRequestError('unknown', ['path']);
      validateBody(def, req.body);
      const headers = { ...(req.headers ?? {}) };
      let authorization: string | undefined;
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'authorization') {
          authorization = headers[k];
          delete headers[k];
        }
      }
      return execute(def, req.path, req.body, headers, authorization);
    },
  };
}
