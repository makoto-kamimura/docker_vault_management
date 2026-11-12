import {
  ApiError,
  type AuthKind,
  BODY_LIMIT_BULK_BYTES,
  BODY_LIMIT_DEFAULT_BYTES,
  MAX_CIPHERTEXT_BYTES,
  type RateLimitKey,
  type RouteBody,
  type RouteDef,
  type RouteName,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
  type Routes,
  routes,
} from '@localvault/protocol';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authenticate, usesHeaderAuth } from '../auth';
import type { AnyAuthContext, AuthContextOf, AuthRequest } from '../auth/types';
import type { Deps } from '../deps';
import { fail } from '../errors';
import { clientIp } from '../ip';
import { limitsFor } from '../ratelimit';

export type AppEnv = { Variables: { routePattern: string } };

export type HandlerArgs<N extends RouteName> = {
  deps: Deps;
  now: Date;
  auth: AuthContextOf<Routes[N]['auth']>;
  params: RouteParams<N>;
  query: RouteQuery<N>;
  body: RouteBody<N>;
};
export type Handler<N extends RouteName> = (a: HandlerArgs<N>) => Promise<RouteResponse<N>>;

/** Routes whose body carries ciphertext arrays: field holding the array. */
const CIPHERTEXT_ARRAYS: Partial<Record<RouteName, string>> = {
  postRecordsBatch: 'changes',
  stageRotationRecords: 'records',
};
const BULK_ROUTES = new Set<RouteName>(['postRecordsBatch', 'stageRotationRecords']);
/** Unpadded base64url length of the largest allowed ciphertext. */
const MAX_CT_CHARS = Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3);

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`)
    .join('; ');
}

function parseJson(raw: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return fail('E_INVALID', 'body is not valid JSON');
  }
}

/** NFR-12: an oversized ciphertext is E_TOO_LARGE rather than a generic validation error. */
function assertCiphertextSize(name: RouteName, json: unknown): void {
  const field = CIPHERTEXT_ARRAYS[name];
  if (field === undefined || typeof json !== 'object' || json === null) return;
  const list = (json as Record<string, unknown>)[field];
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const ct = (item as { ct?: unknown } | null)?.ct;
    if (typeof ct === 'string' && ct.length > MAX_CT_CHARS)
      fail('E_TOO_LARGE', 'ciphertext too large');
  }
}

type Parsed = { params: unknown; query: unknown; body: unknown };

function parseRequest(def: RouteDef, c: Context, raw: Uint8Array): Parsed {
  const out: Parsed = { params: undefined, query: undefined, body: undefined };
  if (def.request.params) {
    const r = def.request.params.safeParse(c.req.param());
    if (!r.success) fail('E_INVALID', describeIssues(r.error.issues));
    out.params = r.data;
  }
  if (def.request.query) {
    const obj: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams) {
      if (k in obj) fail('E_INVALID', `duplicate query parameter ${k}`);
      obj[k] = v;
    }
    const r = def.request.query.safeParse(obj);
    if (!r.success) fail('E_INVALID', describeIssues(r.error.issues));
    out.query = r.data;
  }
  if (def.request.body) {
    if (raw.length === 0) fail('E_INVALID', 'body required');
    const json = parseJson(raw);
    assertCiphertextSize(def.name as RouteName, json);
    const r = def.request.body.safeParse(json);
    if (!r.success) fail('E_INVALID', describeIssues(r.error.issues));
    out.body = r.data;
  }
  return out;
}

type Subjects = Partial<Record<RateLimitKey, string>>;

function applyLimits(
  deps: Deps,
  routeName: string,
  subjects: Subjects,
  applied: Set<object>,
  now: Date,
): void {
  for (const limit of limitsFor(routeName)) {
    const subject = subjects[limit.by];
    if (subject === undefined || applied.has(limit)) continue;
    applied.add(limit);
    const r = deps.limiter.hit(
      `${limit.route}|${limit.by}|${subject}`,
      limit.max,
      limit.windowSec,
      now.getTime(),
    );
    if (!r.ok) {
      fail('E_RATE_LIMITED', 'too many requests', { retryAfterSec: r.retryAfterSec });
    }
  }
}

export type RegisteredRoute = { name: RouteName; method: string; path: string; auth: AuthKind };

/** Registers protocol routes on the Hono app and runs the common pipeline for each. */
export class Registrar {
  readonly registered = new Map<RouteName, RegisteredRoute>();

  constructor(
    private readonly app: Hono<AppEnv>,
    private readonly deps: Deps,
  ) {}

  handle<N extends RouteName>(name: N, handler: Handler<N>): void {
    const def = routes[name] as RouteDef;
    if (this.registered.has(name)) throw new Error(`route ${name} registered twice`);
    this.registered.set(name, { name, method: def.method, path: def.path, auth: def.auth });
    const honoPath = def.path.replace(/\{(\w+)\}/g, ':$1');
    const maxSize = BULK_ROUTES.has(name) ? BODY_LIMIT_BULK_BYTES : BODY_LIMIT_DEFAULT_BYTES;
    const deps = this.deps;

    this.app.on(
      def.method,
      honoPath,
      bodyLimit({
        maxSize,
        onError: (c) => c.json(new ApiError('E_TOO_LARGE', 'request body too large').toBody(), 413),
      }),
      async (c) => {
        c.set('routePattern', def.path);
        const now = deps.clock.now();
        const rawBody = new Uint8Array(await c.req.arrayBuffer());
        if (rawBody.length > maxSize) fail('E_TOO_LARGE', 'request body too large');
        const url = new URL(c.req.url);
        const req: AuthRequest = {
          header: (n) => c.req.header(n),
          method: def.method,
          pathWithQuery: url.pathname + url.search,
          rawBody,
          idParam: c.req.param('id'),
        };
        const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
          ?.incoming?.socket?.remoteAddress;
        const ip = clientIp(c.req.header('x-forwarded-for'), socket, deps.config.trustProxy);

        // 1. limits that need nothing but the request line
        const applied = new Set<object>();
        const subjects: Subjects = { ip };
        if (def.auth === 'claim' && req.idParam) subjects.claim = req.idParam;
        applyLimits(deps, def.name, subjects, applied, now);

        // 2. header-based authentication, before the body is looked at
        const auth: AnyAuthContext = usesHeaderAuth(def.auth)
          ? await authenticate(
              def.auth,
              { db: deps.db, clock: deps.clock, tokenSecret: deps.config.tokenSecret },
              req,
            )
          : {};

        // 3. validation
        const parsed = parseRequest(def, c, rawBody);

        // 4. limits keyed by validated input or by the authenticated device
        const q = parsed.query as { account?: string } | undefined;
        const b = parsed.body as { accountId?: string; deviceId?: string } | undefined;
        if (q?.account !== undefined) subjects.accountName = q.account;
        if (b?.accountId !== undefined) subjects.account = b.accountId;
        const deviceSubject = auth.device?.id ?? b?.deviceId;
        if (deviceSubject !== undefined) subjects.device = deviceSubject;
        if (auth.device) subjects.token = auth.device.id;
        applyLimits(deps, def.name, subjects, applied, now);

        // 5. the handler
        const result = await (handler as Handler<RouteName>)({
          deps,
          now,
          auth: auth as never,
          params: parsed.params as never,
          query: parsed.query as never,
          body: parsed.body as never,
        });

        if (def.status === 204) return c.body(null, 204);
        if (deps.validateResponses) def.response.parse(result);
        return c.json(result as object, def.status);
      },
    );
  }

  assertComplete(): void {
    const missing = Object.keys(routes).filter((n) => !this.registered.has(n as RouteName));
    if (missing.length > 0) throw new Error(`routes not registered: ${missing.join(', ')}`);
  }
}
