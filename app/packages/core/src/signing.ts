// Signing and verification helpers built on the protocol string builders (never re-declared here).
import {
  type AdminHeader,
  type AdminSignFields,
  adminSignString,
  authSignString,
  BYTES,
  b64Bytes,
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  type DeviceData,
  equalBytes,
  formatAdminHeader,
  HeaderParseError,
  isoSecondsSchema,
  parseAdminHeader,
  signPubSchema,
  sigSchema,
  TTL_SEC,
  UNLOCK_CODE_MAX_ATTEMPTS,
  type UnlockSignFields,
  unlockSignString,
  utf8Encode,
  uuidSchema,
} from '@localvault/protocol';
import type { CryptoProvider } from './crypto/provider';
import { VaultCoreError } from './errors';

// ---------------------------------------------------------------- device auth challenge (§13.3)

export async function signAuthChallenge(
  p: CryptoProvider,
  signPrivateKey: Uint8Array,
  deviceId: string,
  challenge: string,
): Promise<string> {
  if (!b64Bytes(BYTES.challenge).safeParse(challenge).success) {
    throw new VaultCoreError('E_INVALID_INPUT', 'challenge must be 32 bytes of base64url');
  }
  const sig = await p.ecdsaSign(signPrivateKey, utf8Encode(authSignString(deviceId, challenge)));
  return base64urlEncode(sig);
}

export async function verifyAuthChallenge(
  p: CryptoProvider,
  signPublicKey: string,
  deviceId: string,
  challenge: string,
  sig: string,
): Promise<boolean> {
  return verifyText(p, signPublicKey, authSignString(deviceId, challenge), sig);
}

// ---------------------------------------------------------------- unlock request (§8.4)

export async function signUnlockRequest(
  p: CryptoProvider,
  signPrivateKey: Uint8Array,
  fields: UnlockSignFields,
): Promise<string> {
  const sig = await p.ecdsaSign(signPrivateKey, utf8Encode(unlockSignString(fields)));
  return base64urlEncode(sig);
}

export type UnlockRequestToVerify = {
  deviceId: string;
  requestNonce: string;
  ephPub: string;
  code: string;
  issuedAt: string;
  sig: string;
};

export type VerifyUnlockInput = {
  accountId: string;
  request: UnlockRequestToVerify;
  /** Trust list (device records) from the synced vault — never keys supplied by the server. */
  trust: readonly DeviceData[];
  /** Current time, as a Date or epoch milliseconds. */
  now: Date | number;
  /** True if this requestNonce was already seen in the last 24 hours. */
  isNonceSeen: (requestNonce: string) => boolean;
};

export type VerifyUnlockResult =
  | { ok: true; deviceName: string }
  | { ok: false; reason: 'unknown_device' | 'revoked' | 'bad_signature' | 'stale' | 'replayed' };

const CODE_RE = /^[1-9][0-9]$/;

/**
 * Checks 2-5 of §8.4 (check 1, syncing first, and check 6, the typed code, belong to the caller;
 * see `evaluateCodeAttempt`). Order: trust list, signature, freshness, replay. A request whose
 * fields are malformed cannot be a genuine one and is reported as `bad_signature`.
 */
export async function verifyUnlockRequest(
  p: CryptoProvider,
  input: VerifyUnlockInput,
): Promise<VerifyUnlockResult> {
  const { request: r } = input;

  const entries = input.trust.filter((d) => d.deviceId === r.deviceId);
  const entry = entries.find((d) => d.revokedAt !== null) ?? entries[0];
  if (entry === undefined || entry.type !== 'extension')
    return { ok: false, reason: 'unknown_device' };
  if (entry.revokedAt !== null) return { ok: false, reason: 'revoked' };

  const wellFormed =
    uuidSchema.safeParse(input.accountId).success &&
    uuidSchema.safeParse(r.deviceId).success &&
    b64Bytes(BYTES.requestNonce).safeParse(r.requestNonce).success &&
    signPubSchema.safeParse(r.ephPub).success &&
    CODE_RE.test(r.code) &&
    isoSecondsSchema.safeParse(r.issuedAt).success &&
    sigSchema.safeParse(r.sig).success;
  if (!wellFormed) return { ok: false, reason: 'bad_signature' };

  const text = unlockSignString({
    accountId: input.accountId,
    deviceId: r.deviceId,
    requestNonce: r.requestNonce,
    ephPub: r.ephPub,
    code: r.code,
    issuedAt: r.issuedAt,
  });
  // Verified against the key in OUR trust list.
  if (!(await verifyText(p, entry.signPub, text, r.sig)))
    return { ok: false, reason: 'bad_signature' };

  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now;
  const issuedMs = Date.parse(r.issuedAt);
  if (Math.abs(nowMs - issuedMs) > TTL_SEC.unlockIssuedAtWindow * 1000) {
    return { ok: false, reason: 'stale' };
  }
  if (input.isNonceSeen(r.requestNonce)) return { ok: false, reason: 'replayed' };
  return { ok: true, deviceName: entry.name };
}

export type CodeAttemptResult = { ok: true } | { ok: false; attemptsLeft: number; reject: boolean };

/**
 * Check 6 of §8.4: the typed number must equal the signed `code`; three wrong attempts reject the
 * request. `failedAttempts` is the number of wrong attempts BEFORE this one.
 */
export function evaluateCodeAttempt(input: {
  typedCode: string;
  signedCode: string;
  failedAttempts: number;
}): CodeAttemptResult {
  const equal = equalBytes(utf8Encode(input.typedCode), utf8Encode(input.signedCode));
  if (equal) return { ok: true };
  const attemptsLeft = Math.max(0, UNLOCK_CODE_MAX_ATTEMPTS - (input.failedAttempts + 1));
  return { ok: false, attemptsLeft, reject: attemptsLeft === 0 };
}

// ---------------------------------------------------------------- admin header (§8.7)

export type AdminRequest = {
  method: AdminSignFields['method'];
  /** Path exactly as sent, including the query string. */
  path: string;
  /** Raw request body bytes, or undefined / empty when there is none. */
  body?: Uint8Array | undefined;
};

export async function adminBodyHash(
  p: CryptoProvider,
  body: Uint8Array | undefined,
): Promise<string> {
  return base64urlEncode(await p.sha256(body ?? new Uint8Array(0)));
}

/** Value of the `X-LV-Admin` header. `nowSec` is UNIX seconds. */
export async function buildAdminHeader(
  p: CryptoProvider,
  adminPrivateKey: Uint8Array,
  input: AdminRequest & { deviceId: string; nowSec: number },
): Promise<string> {
  const nonce = base64urlEncode(await p.randomBytes(BYTES.adminNonce));
  const fields: AdminSignFields = {
    method: input.method,
    path: input.path,
    bodyHash: await adminBodyHash(p, input.body),
    ts: input.nowSec,
    nonce,
  };
  const sig = base64urlEncode(
    await p.ecdsaSign(adminPrivateKey, utf8Encode(adminSignString(fields))),
  );
  return formatAdminHeader({ deviceId: input.deviceId, ts: input.nowSec, nonce, sig });
}

export type VerifyAdminResult =
  | { ok: true; header: AdminHeader }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'clock_skew' };

/**
 * Verifies the signature of an `X-LV-Admin` header against the device's admin public key. If
 * `nowSec` is given the ±5 minute window is enforced too. Nonce reuse is the caller's concern.
 */
export async function verifyAdminHeader(
  p: CryptoProvider,
  adminPublicKey: string,
  request: AdminRequest,
  headerValue: string,
  nowSec?: number,
): Promise<VerifyAdminResult> {
  let header: AdminHeader;
  try {
    header = parseAdminHeader(headerValue);
  } catch (e) {
    if (e instanceof HeaderParseError) return { ok: false, reason: 'malformed' };
    throw e;
  }
  const text = adminSignString({
    method: request.method,
    path: request.path,
    bodyHash: await adminBodyHash(p, request.body),
    ts: header.ts,
    nonce: header.nonce,
  });
  if (!(await verifyText(p, adminPublicKey, text, header.sig)))
    return { ok: false, reason: 'bad_signature' };
  if (nowSec !== undefined && Math.abs(nowSec - header.ts) > TTL_SEC.adminTsWindow) {
    return { ok: false, reason: 'clock_skew' };
  }
  return { ok: true, header };
}

// ---------------------------------------------------------------- pairing fingerprint (§8.3)

/** base64url(SHA-256(signPub || ephPub)); both public keys are 65-byte base64url strings. */
export async function pairingFingerprint(
  p: CryptoProvider,
  signPub: string,
  ephPub: string,
): Promise<string> {
  const a = base64urlDecode(signPub);
  const b = base64urlDecode(ephPub);
  if (a.length !== BYTES.signPub || b.length !== BYTES.ephPub) {
    throw new VaultCoreError('E_INVALID_INPUT', 'public keys must be 65 bytes');
  }
  return base64urlEncode(await p.sha256(concatBytes(a, b)));
}

/** Constant-time comparison of the QR fingerprint with the one recomputed from the server's keys. */
export async function verifyPairingFingerprint(
  p: CryptoProvider,
  signPub: string,
  ephPub: string,
  expected: string,
): Promise<boolean> {
  let expectedBytes: Uint8Array;
  try {
    expectedBytes = base64urlDecode(expected);
  } catch {
    return false; // not even base64url: cannot match
  }
  const actual = base64urlDecode(await pairingFingerprint(p, signPub, ephPub));
  return equalBytes(actual, expectedBytes);
}

// ---------------------------------------------------------------- shared

async function verifyText(
  p: CryptoProvider,
  publicKey: string,
  text: string,
  sig: string,
): Promise<boolean> {
  let pub: Uint8Array;
  let signature: Uint8Array;
  try {
    pub = base64urlDecode(publicKey);
    signature = base64urlDecode(sig);
  } catch {
    return false; // malformed encodings can never verify
  }
  return p.ecdsaVerify(pub, utf8Encode(text), signature);
}
