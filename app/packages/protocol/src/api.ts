import { z } from 'zod';
import { validateAccountName } from './account-name';
import {
  BYTES,
  FIELD,
  MAX_AUDIT_LIMIT,
  MAX_PULL_LIMIT,
  MAX_RECORDS_PER_BATCH,
  MAX_RECORDS_PER_ROTATION_CHUNK,
  UNLOCK_CODE_MAX,
  UNLOCK_CODE_MIN,
} from './limits';
import {
  b64Bytes,
  devicePlatformSchema,
  deviceRegistrationSchema,
  deviceTypeSchema,
  encryptedRecordSchema,
  isoDateTimeSchema,
  isoSecondsSchema,
  kdfSchema,
  keysetSchema,
  pushResultSchema,
  rcWaitSecSchema,
  recordChangeSchema,
  rotationRecordSchema,
  sealEnvelopeSchema,
  signPubSchema,
  sigSchema,
  uuidSchema,
  wrappedVkSchema,
} from './records';

// ================================================================ shared building blocks

export type AuthKind =
  | 'none'
  | 'invite'
  | 'device'
  | 'approver'
  | 'approver+admin'
  | 'approver+authKey'
  | 'approver+admin+authKey'
  | 'extension'
  | 'pairing'
  | 'claim'
  | 'authKey'
  | 'authRC';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** `{}` body (strict). */
export const emptyObject = z.strictObject({});
/** Marker for "no response body" (HTTP 204). */
export const noBody = z.undefined();

const verifierSchema = b64Bytes(BYTES.verifier);
const authKeySchema = b64Bytes(BYTES.authKey);
const nonNeg = z.int().min(0);
const pos = z.int().min(1);

/** Query-string integer: arrives as a decimal string, parsed to number. */
const queryInt = (min: number, max: number) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,15})$/)
    .transform(Number)
    .pipe(z.int().min(min).max(max));

const accountNameSchema = z
  .string()
  .refine((s) => validateAccountName(s).ok, { message: 'invalid account name' });

const idParams = z.strictObject({ id: uuidSchema });

const mobileRegistrationSchema = deviceRegistrationSchema.refine((d) => d.type === 'mobile', {
  message: 'must be a mobile device',
  path: ['type'],
});

export const registrationModeSchema = z.enum(['invite', 'closed', 'open']);

// ---------------------------------------------------------------- audit (F3, FR-95)

/** §13.6 comment + v0.4. */
export const AUDIT_EVENT_KINDS = [
  'account_created',
  'device_added',
  'device_revoked',
  'device_signed_out',
  'keyset_changed',
  'rotated',
  'unlock_approved',
  'unlock_denied',
  'rc_issued',
  'rc_claimed',
  'rc_canceled',
  'rc_approved_now',
  'rc_used',
  'rc_frozen',
  'rc_revoked',
] as const;
export const auditEventKindSchema = z.enum(AUDIT_EVENT_KINDS);
export type AuditEventKind = z.infer<typeof auditEventKindSchema>;

export const auditEventSchema = z.strictObject({
  id: pos,
  kind: auditEventKindSchema,
  deviceId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

// ---------------------------------------------------------------- request payloads (shared)

export const unlockRequestPayloadSchema = z.strictObject({
  requestNonce: b64Bytes(BYTES.requestNonce),
  ephPub: b64Bytes(BYTES.ephPub),
  code: z
    .string()
    .regex(/^[0-9]{2}$/)
    .refine((c) => Number(c) >= UNLOCK_CODE_MIN && Number(c) <= UNLOCK_CODE_MAX, {
      message: 'code must be 10..99',
    }),
  issuedAt: isoSecondsSchema,
  sig: sigSchema,
});
export type UnlockRequestPayload = z.infer<typeof unlockRequestPayloadSchema>;

export const adminAuthDeviceSchema = deviceRegistrationSchema;

export const deviceListItemSchema = z.strictObject({
  deviceId: uuidSchema,
  type: deviceTypeSchema,
  platform: devicePlatformSchema,
  createdAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
});
export type DeviceListItem = z.infer<typeof deviceListItemSchema>;

export const claimStatusSchema = z.enum([
  'waiting',
  'completed',
  'canceled',
  'disputed',
  'expired',
]);

export const tokenResponseSchema = z.strictObject({
  accessToken: z.string().min(1).max(2048),
  expiresAt: isoDateTimeSchema,
});

// ================================================================ route table

type Schema = z.ZodType;

export type RouteDef = {
  name: string;
  method: HttpMethod;
  /** Path template; `{id}` placeholders correspond to `request.params`. */
  path: string;
  auth: AuthKind;
  /** HTTP status of the success response. */
  status: 200 | 201 | 204;
  request: { params?: Schema; query?: Schema; body?: Schema };
  /** Schema of the JSON body; `noBody` for 204. */
  response: Schema;
};

function route<const R extends RouteDef>(r: R): R {
  return r;
}

export const routes = {
  health: route({
    name: 'health',
    method: 'GET',
    path: '/v1/health',
    auth: 'none',
    status: 200,
    request: {},
    response: z.strictObject({
      version: z.string().min(1).max(64),
      registrationMode: registrationModeSchema,
    }),
  }),
  prelogin: route({
    name: 'prelogin',
    method: 'GET',
    path: '/v1/prelogin',
    auth: 'none',
    status: 200,
    request: { query: z.strictObject({ account: accountNameSchema }) },
    response: z.strictObject({ accountId: uuidSchema, kdf: kdfSchema }),
  }),
  createAccount: route({
    name: 'createAccount',
    method: 'POST',
    path: '/v1/accounts',
    auth: 'invite',
    status: 201,
    request: {
      body: z.strictObject({
        inviteCode: z.string().min(1).max(FIELD.inviteCodeMax),
        accountId: uuidSchema,
        accountName: accountNameSchema,
        keyset: keysetSchema.refine((k) => k.keysetVersion === 1 && k.vkVersion === 1, {
          message: 'initial keyset must have keysetVersion 1 and vkVersion 1',
        }),
        verifier: verifierSchema,
        device: mobileRegistrationSchema,
      }),
    },
    response: emptyObject,
  }),
  authChallenge: route({
    name: 'authChallenge',
    method: 'POST',
    path: '/v1/auth/challenge',
    auth: 'none',
    status: 200,
    request: { body: z.strictObject({ deviceId: uuidSchema }) },
    response: z.strictObject({
      challenge: b64Bytes(BYTES.challenge),
      expiresAt: isoDateTimeSchema,
    }),
  }),
  authToken: route({
    name: 'authToken',
    method: 'POST',
    path: '/v1/auth/token',
    auth: 'none',
    status: 200,
    request: {
      body: z.strictObject({
        deviceId: uuidSchema,
        challenge: b64Bytes(BYTES.challenge),
        sig: sigSchema,
      }),
    },
    response: tokenResponseSchema,
  }),
  authRecover: route({
    name: 'authRecover',
    method: 'POST',
    path: '/v1/auth/recover',
    auth: 'authKey',
    status: 200,
    request: {
      body: z.strictObject({
        accountId: uuidSchema,
        authKey: authKeySchema,
        device: mobileRegistrationSchema,
      }),
    },
    response: tokenResponseSchema.extend({ keyset: keysetSchema }),
  }),
  getKeyset: route({
    name: 'getKeyset',
    method: 'GET',
    path: '/v1/keyset',
    auth: 'device',
    status: 200,
    request: {},
    response: z.strictObject({ keyset: keysetSchema }),
  }),
  putKeyset: route({
    name: 'putKeyset',
    method: 'PUT',
    path: '/v1/keyset',
    auth: 'approver+admin',
    status: 204,
    // G4: server requires keyset.keysetVersion == current + 1 and keyset.vkVersion == current,
    // otherwise E_VERSION_CONFLICT.
    request: { body: z.strictObject({ keyset: keysetSchema, verifier: verifierSchema }) },
    response: noBody,
  }),
  getRecords: route({
    name: 'getRecords',
    method: 'GET',
    path: '/v1/records',
    auth: 'device',
    status: 200,
    request: {
      query: z.strictObject({
        since: queryInt(0, Number.MAX_SAFE_INTEGER),
        limit: queryInt(1, MAX_PULL_LIMIT).optional(),
      }),
    },
    response: z.strictObject({
      records: z.array(encryptedRecordSchema).max(MAX_PULL_LIMIT),
      cursor: nonNeg,
      hasMore: z.boolean(),
      keyset: keysetSchema.optional(),
      fullResync: z.boolean(),
    }),
  }),
  postRecordsBatch: route({
    name: 'postRecordsBatch',
    method: 'POST',
    path: '/v1/records/batch',
    auth: 'approver',
    status: 200,
    // G4: whole request fails with E_STALE_KEY if any change.vkVersion != account's current one.
    request: {
      body: z.strictObject({
        changes: z.array(recordChangeSchema).min(1).max(MAX_RECORDS_PER_BATCH),
      }),
    },
    response: z.strictObject({ results: z.array(pushResultSchema).max(MAX_RECORDS_PER_BATCH) }),
  }),
  // ---- G12 chunked rotation ----
  createRotation: route({
    name: 'createRotation',
    method: 'POST',
    path: '/v1/rotations',
    auth: 'approver+admin',
    status: 201,
    request: { body: z.strictObject({ expectedRev: nonNeg, newVkVersion: pos }) },
    response: z.strictObject({ rotationId: uuidSchema, expiresAt: isoDateTimeSchema }),
  }),
  stageRotationRecords: route({
    name: 'stageRotationRecords',
    method: 'PUT',
    path: '/v1/rotations/{id}/records',
    auth: 'approver',
    status: 204,
    request: {
      params: idParams,
      body: z.strictObject({
        records: z.array(rotationRecordSchema).min(1).max(MAX_RECORDS_PER_ROTATION_CHUNK),
      }),
    },
    response: noBody,
  }),
  commitRotation: route({
    name: 'commitRotation',
    method: 'POST',
    path: '/v1/rotations/{id}/commit',
    auth: 'approver+admin',
    status: 200,
    request: {
      params: idParams,
      body: z.strictObject({ keyset: keysetSchema, verifier: verifierSchema, recordCount: nonNeg }),
    },
    response: z.strictObject({ cursor: nonNeg }),
  }),
  abortRotation: route({
    name: 'abortRotation',
    method: 'DELETE',
    path: '/v1/rotations/{id}',
    auth: 'approver',
    status: 204,
    request: { params: idParams },
    response: noBody,
  }),
  // ---- devices ----
  listDevices: route({
    name: 'listDevices',
    method: 'GET',
    path: '/v1/devices',
    auth: 'approver',
    status: 200,
    request: {},
    response: z.strictObject({ devices: z.array(deviceListItemSchema) }),
  }),
  deleteDevice: route({
    name: 'deleteDevice',
    method: 'DELETE',
    path: '/v1/devices/{id}',
    auth: 'approver+admin',
    status: 204,
    // G2: `id` may be the caller's own deviceId (sign out of this device).
    request: { params: idParams },
    response: noBody,
  }),
  putPushToken: route({
    name: 'putPushToken',
    method: 'PUT',
    path: '/v1/devices/self/push-token',
    auth: 'approver',
    status: 204,
    request: {
      body: z.strictObject({
        pushPlatform: z.enum(['apns', 'fcm']),
        token: z.string().min(1).max(FIELD.pushTokenMax),
      }),
    },
    response: noBody,
  }),
  putAdminKey: route({
    name: 'putAdminKey',
    method: 'PUT',
    path: '/v1/devices/self/admin-key',
    auth: 'approver+authKey',
    status: 204,
    request: { body: z.strictObject({ adminPub: signPubSchema }) },
    response: noBody,
  }),
  // ---- pairing ----
  createPairing: route({
    name: 'createPairing',
    method: 'POST',
    path: '/v1/pairings',
    auth: 'none',
    status: 201,
    request: {
      body: z.strictObject({
        deviceId: uuidSchema,
        signPub: signPubSchema,
        ephPub: b64Bytes(BYTES.ephPub),
        platform: z.enum(['chrome', 'edge', 'brave']),
      }),
    },
    response: z.strictObject({
      pairingId: uuidSchema,
      pollToken: b64Bytes(BYTES.pollToken),
      expiresAt: isoDateTimeSchema,
    }),
  }),
  getPairing: route({
    name: 'getPairing',
    method: 'GET',
    path: '/v1/pairings/{id}',
    auth: 'approver',
    status: 200,
    request: { params: idParams },
    response: z.strictObject({
      pairingId: uuidSchema,
      deviceId: uuidSchema,
      platform: z.enum(['chrome', 'edge', 'brave']),
      signPub: signPubSchema,
      ephPub: b64Bytes(BYTES.ephPub),
      expiresAt: isoDateTimeSchema,
    }),
  }),
  approvePairing: route({
    name: 'approvePairing',
    method: 'POST',
    path: '/v1/pairings/{id}/approve',
    auth: 'approver+admin',
    status: 204,
    request: { params: idParams, body: z.strictObject({ response: sealEnvelopeSchema }) },
    response: noBody,
  }),
  pairingStatus: route({
    name: 'pairingStatus',
    method: 'GET',
    path: '/v1/pairings/{id}/status',
    auth: 'pairing',
    status: 200,
    request: { params: idParams },
    response: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('pending') }),
      z.strictObject({ status: z.literal('expired') }),
      z.strictObject({
        status: z.literal('approved'),
        accountId: uuidSchema,
        response: sealEnvelopeSchema,
      }),
    ]),
  }),
  // ---- unlock ----
  createUnlockRequest: route({
    name: 'createUnlockRequest',
    method: 'POST',
    path: '/v1/unlock-requests',
    auth: 'extension',
    status: 201,
    request: { body: unlockRequestPayloadSchema },
    response: z.strictObject({ requestId: uuidSchema, expiresAt: isoDateTimeSchema }),
  }),
  pendingUnlockRequests: route({
    name: 'pendingUnlockRequests',
    method: 'GET',
    path: '/v1/unlock-requests/pending',
    auth: 'approver',
    status: 200,
    request: {},
    response: z.strictObject({
      requests: z.array(
        z.strictObject({
          requestId: uuidSchema,
          deviceId: uuidSchema,
          expiresAt: isoDateTimeSchema,
          payload: unlockRequestPayloadSchema,
        }),
      ),
    }),
  }),
  getUnlockRequest: route({
    name: 'getUnlockRequest',
    method: 'GET',
    path: '/v1/unlock-requests/{id}',
    auth: 'extension',
    status: 200,
    request: { params: idParams },
    response: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('pending'), expiresAt: isoDateTimeSchema }),
      z.strictObject({ status: z.literal('denied') }),
      z.strictObject({ status: z.literal('expired') }),
      z.strictObject({ status: z.literal('approved'), response: sealEnvelopeSchema }),
    ]),
  }),
  approveUnlockRequest: route({
    name: 'approveUnlockRequest',
    method: 'POST',
    path: '/v1/unlock-requests/{id}/approve',
    auth: 'approver',
    status: 204,
    request: { params: idParams, body: z.strictObject({ response: sealEnvelopeSchema }) },
    response: noBody,
  }),
  denyUnlockRequest: route({
    name: 'denyUnlockRequest',
    method: 'POST',
    path: '/v1/unlock-requests/{id}/deny',
    auth: 'approver',
    status: 204,
    request: { params: idParams, body: emptyObject },
    response: noBody,
  }),
  // ---- recovery code ----
  getRecoveryCode: route({
    name: 'getRecoveryCode',
    method: 'GET',
    path: '/v1/recovery-code',
    auth: 'approver',
    status: 200,
    request: {},
    response: z.discriminatedUnion('enabled', [
      z.strictObject({ enabled: z.literal(false) }),
      z.strictObject({
        enabled: z.literal(true),
        createdAt: isoDateTimeSchema,
        waitSec: rcWaitSecSchema,
        frozen: z.boolean(),
      }),
    ]),
  }),
  putRecoveryCode: route({
    name: 'putRecoveryCode',
    method: 'PUT',
    path: '/v1/recovery-code',
    auth: 'approver+admin',
    status: 204,
    // vkVersion must equal the account's current one, else E_STALE_KEY.
    request: {
      body: z.strictObject({
        rcId: b64Bytes(BYTES.rcId),
        verifier: verifierSchema,
        wrappedVK: wrappedVkSchema,
        vkVersion: pos,
        waitSec: rcWaitSecSchema,
      }),
    },
    response: noBody,
  }),
  putRecoveryWaitPeriod: route({
    name: 'putRecoveryWaitPeriod',
    method: 'PUT',
    path: '/v1/recovery-code/wait-period',
    auth: 'approver+admin',
    status: 204,
    request: { body: z.strictObject({ waitSec: rcWaitSecSchema }) },
    response: noBody,
  }),
  deleteRecoveryCode: route({
    name: 'deleteRecoveryCode',
    method: 'DELETE',
    path: '/v1/recovery-code',
    auth: 'approver+admin',
    status: 204,
    request: {},
    response: noBody,
  }),
  createRecoveryClaim: route({
    name: 'createRecoveryClaim',
    method: 'POST',
    path: '/v1/recovery-claims',
    auth: 'authRC',
    status: 201,
    request: {
      body: z.strictObject({
        accountId: uuidSchema,
        rcId: b64Bytes(BYTES.rcId),
        authRC: b64Bytes(BYTES.authRC),
        device: mobileRegistrationSchema,
      }),
    },
    response: z.strictObject({
      claimId: uuidSchema,
      claimToken: b64Bytes(BYTES.claimToken),
      availableAt: isoDateTimeSchema,
      accountName: accountNameSchema,
    }),
  }),
  pendingRecoveryClaims: route({
    name: 'pendingRecoveryClaims',
    method: 'GET',
    path: '/v1/recovery-claims/pending',
    auth: 'approver',
    status: 200,
    request: {},
    response: z.strictObject({
      claims: z.array(
        z.strictObject({
          claimId: uuidSchema,
          createdAt: isoDateTimeSchema,
          availableAt: isoDateTimeSchema,
          status: claimStatusSchema,
        }),
      ),
    }),
  }),
  getRecoveryClaim: route({
    name: 'getRecoveryClaim',
    method: 'GET',
    path: '/v1/recovery-claims/{id}',
    auth: 'claim',
    status: 200,
    request: { params: idParams },
    response: z.strictObject({ status: claimStatusSchema, availableAt: isoDateTimeSchema }),
  }),
  completeRecoveryClaim: route({
    name: 'completeRecoveryClaim',
    method: 'POST',
    path: '/v1/recovery-claims/{id}/complete',
    auth: 'claim',
    status: 200,
    request: { params: idParams, body: emptyObject },
    response: z.strictObject({
      accessToken: z.string().min(1).max(2048),
      accountName: accountNameSchema,
      keyset: keysetSchema,
      wrappedVK: wrappedVkSchema,
      vkVersion: pos,
    }),
  }),
  cancelRecoveryClaim: route({
    name: 'cancelRecoveryClaim',
    method: 'POST',
    path: '/v1/recovery-claims/{id}/cancel',
    auth: 'approver+admin',
    status: 204,
    request: { params: idParams, body: emptyObject },
    response: noBody,
  }),
  approveRecoveryClaimNow: route({
    name: 'approveRecoveryClaimNow',
    method: 'POST',
    path: '/v1/recovery-claims/{id}/approve-now',
    auth: 'approver+admin',
    status: 204,
    request: { params: idParams, body: emptyObject },
    response: noBody,
  }),
  deleteAccount: route({
    name: 'deleteAccount',
    method: 'DELETE',
    path: '/v1/account',
    auth: 'approver+admin+authKey',
    status: 204,
    request: {},
    response: noBody,
  }),
  // ---- F3 ----
  listAuditEvents: route({
    name: 'listAuditEvents',
    method: 'GET',
    path: '/v1/audit-events',
    auth: 'approver',
    status: 200,
    request: {
      query: z.strictObject({
        before: queryInt(1, Number.MAX_SAFE_INTEGER).optional(),
        limit: queryInt(1, MAX_AUDIT_LIMIT).optional(),
      }),
    },
    response: z.strictObject({
      events: z.array(auditEventSchema).max(MAX_AUDIT_LIMIT),
      hasMore: z.boolean(),
    }),
  }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;
export const routeList: readonly RouteDef[] = Object.values(routes);
export const ROUTE_NAMES = Object.keys(routes) as RouteName[];

type Out<S> = S extends Schema ? z.output<S> : undefined;
type In<S> = S extends Schema ? z.input<S> : undefined;

/** Parsed (server side) request types for a route. */
export type RouteParams<N extends RouteName> = Out<
  Routes[N]['request'] extends { params: infer S } ? S : undefined
>;
export type RouteQuery<N extends RouteName> = Out<
  Routes[N]['request'] extends { query: infer S } ? S : undefined
>;
export type RouteBody<N extends RouteName> = Out<
  Routes[N]['request'] extends { body: infer S } ? S : undefined
>;
/** Body a client sends (input type of the schema). */
export type RouteBodyInput<N extends RouteName> = In<
  Routes[N]['request'] extends { body: infer S } ? S : undefined
>;
export type RouteResponse<N extends RouteName> = Out<Routes[N]['response']>;

/**
 * Expand `{id}` placeholders and append a query string. Values are percent-encoded. This is the
 * exact string to use as the `path` in the `X-LV-Admin` signature.
 */
export function buildPath(
  path: string,
  params?: Record<string, string>,
  query?: Record<string, string | number | undefined>,
): string {
  let p = path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params?.[k];
    if (v === undefined) throw new Error(`missing path param ${k}`);
    return encodeURIComponent(v);
  });
  if (query) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (parts.length > 0) p += `?${parts.join('&')}`;
  }
  return p;
}

// ================================================================ push payloads (§13.7, G10)

export const pushPayloadSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('unlock'), r: uuidSchema }),
  z.strictObject({ t: z.literal('rc_claim'), r: uuidSchema }),
  z.strictObject({ t: z.literal('rc_frozen') }),
]);
export type PushPayload = z.infer<typeof pushPayloadSchema>;

/** Fixed notification texts (the server does not know device names). */
export const PUSH_TEXT = {
  unlock: { title: 'うちカギ', body: 'PC から解錠のリクエストがあります' },
  rc_claim: {
    title: 'うちカギ',
    body: '復旧コードによる復元が始まりました。心当たりがなければ取り消してください',
  },
  rc_frozen: { title: 'うちカギ', body: '復旧コードが凍結されました。アプリで確認してください' },
} as const;

/** Deep-link a tapped notification opens (§13.7, §14). */
export function pushTargetRoute(p: PushPayload): string {
  switch (p.t) {
    case 'unlock':
      return `/approve/${p.r}`;
    case 'rc_claim':
      return `/recovery-claim/${p.r}`;
    case 'rc_frozen':
      return '/settings/recovery-code';
  }
}
