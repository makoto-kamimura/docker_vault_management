// Limits, field lengths, TTLs and rate limits (spec §3 NFR-12, §6.1, §8, §13, v0.4 G12).

export const KB = 1024;
export const MB = 1024 * 1024;

/** NFR-12 */
export const MAX_RECORDS_PER_ACCOUNT = 10_000;
/** NFR-12: ciphertext bytes per record (decoded). */
export const MAX_CIPHERTEXT_BYTES = 64 * KB;

/** Body limits (v0.4 G12). */
export const BODY_LIMIT_DEFAULT_BYTES = 1 * MB;
export const BODY_LIMIT_BULK_BYTES = 12 * MB;
export const MAX_RECORDS_PER_BATCH = 100;
export const MAX_RECORDS_PER_ROTATION_CHUNK = 100;
export const MAX_PULL_LIMIT = 500;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_AUDIT_LIMIT = 50;
export const DEFAULT_AUDIT_LIMIT = 50;

/** Field limits of §6.1 (counts are UTF-16 code units as measured by JS `string.length`). */
export const FIELD = {
  titleMin: 1,
  titleMax: 100,
  usernameMax: 256,
  passwordMax: 1024,
  urlsMax: 20,
  urlMax: 2048,
  androidAppsMax: 20,
  androidCertsMax: 10,
  androidLabelMax: 100,
  notesMax: 10_000,
  deviceNameMin: 1,
  deviceNameMax: 64,
  passwordHistoryMax: 5,
  accountNameMin: 3,
  accountNameMax: 32,
  masterPasswordMin: 10,
  exportPasswordMin: 10,
  pushTokenMax: 4096,
  inviteCodeMax: 128,
} as const;

/** Sizes in bytes of binary fields. */
export const BYTES = {
  uuid: 16,
  nonce: 12,
  gcmTag: 16,
  vk: 32,
  authKey: 32,
  verifier: 32,
  challenge: 32,
  kdfSalt: 16,
  signPub: 65,
  ephPub: 65,
  sig: 64,
  requestNonce: 16,
  adminNonce: 16,
  pollToken: 32,
  claimToken: 32,
  rcId: 16,
  rc: 32,
  authRC: 32,
  wrappedVkCt: 48,
  fingerprint: 32,
} as const;

export const KDF_MIN_ITERATIONS = 600_000;
export const KDF_MAX_ITERATIONS = 10_000_000;

/** TTLs, in seconds unless the name says otherwise. */
export const TTL_SEC = {
  pairing: 5 * 60,
  unlockRequest: 120,
  authChallenge: 60,
  accessToken: 15 * 60,
  adminTsWindow: 5 * 60,
  adminNonceRetention: 10 * 60,
  unlockRequestRowRetention: 24 * 3600,
  unlockIssuedAtWindow: 5 * 60,
  unlockNonceMemory: 24 * 3600,
  recoveryClaimExpiry: 7 * 86400,
  tombstone: 180 * 86400,
  deletedDeviceTombstone: 90 * 86400,
  auditLog: 90 * 86400,
  ipLog: 30 * 86400,
  rotation: 15 * 60,
  trash: 30 * 86400,
  clockSkewWindow: 5 * 60,
} as const;

export const RC_WAIT_SEC = [86_400, 172_800, 259_200] as const;
export const RC_WAIT_DEFAULT_SEC = 172_800;
export const PC_SESSION_MAX_SEC = [0, 900, 3600, 28_800] as const;
export const PC_SESSION_DEFAULT_SEC = 3600;
export const UNLOCK_CODE_MIN = 10;
export const UNLOCK_CODE_MAX = 99;
export const UNLOCK_CODE_MAX_ATTEMPTS = 3;

export type RateLimitKey = 'ip' | 'accountName' | 'account' | 'device' | 'claim' | 'token';

export type RateLimit = {
  /** Route name in `routes`, or 'global'. */
  route: string;
  by: RateLimitKey;
  max: number;
  windowSec: number;
};

/** §13.8. Single instance, in-memory counters are sufficient. */
export const RATE_LIMITS: readonly RateLimit[] = [
  { route: 'prelogin', by: 'ip', max: 20, windowSec: 60 },
  { route: 'prelogin', by: 'accountName', max: 10, windowSec: 60 },
  { route: 'authRecover', by: 'account', max: 5, windowSec: 15 * 60 },
  { route: 'authRecover', by: 'ip', max: 20, windowSec: 3600 },
  { route: 'authChallenge', by: 'device', max: 30, windowSec: 60 },
  { route: 'createPairing', by: 'ip', max: 10, windowSec: 3600 },
  { route: 'createUnlockRequest', by: 'device', max: 5, windowSec: 10 * 60 },
  { route: 'createRecoveryClaim', by: 'account', max: 5, windowSec: 86_400 },
  { route: 'createRecoveryClaim', by: 'ip', max: 10, windowSec: 3600 },
  { route: 'completeRecoveryClaim', by: 'claim', max: 10, windowSec: 3600 },
  { route: 'createAccount', by: 'ip', max: 5, windowSec: 3600 },
  { route: 'global', by: 'token', max: 300, windowSec: 60 },
];
