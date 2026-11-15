// Exact builders for every signed string, AAD and HKDF info of the spec.
// All return JS strings; callers encode them with `utf8Encode`. Newlines are "\n" (no trailing one).

export const AUTH_SIGN_TAG = 'lv-auth-v2';
export const UNLOCK_SIGN_TAG = 'lv-unlock-v2';
export const ADMIN_SIGN_TAG = 'lv-admin-v2';

// ---- HKDF info strings (§5.4, §8.5, §8.11.1) ----
export const HKDF_INFO = {
  kek: 'localvault/v2/kek',
  auth: 'localvault/v2/auth',
  rcId: 'localvault/v2/rc-id',
  rcKek: 'localvault/v2/rc-kek',
  rcAuth: 'localvault/v2/rc-auth',
} as const;

/** `localvault/v2/seal|<ctx>` (§8.5 step 3). */
export function sealHkdfInfo(ctx: string): string {
  return `localvault/v2/seal|${ctx}`;
}

// ---- Seal contexts ----
export function sealContextPair(pairingId: string): string {
  return `pair|${pairingId}`;
}
export function sealContextUnlock(requestId: string): string {
  return `unlock|${requestId}`;
}

// ---- AAD strings ----
/** wrappedVK AAD (§5.4). */
export function vkAad(accountId: string, keysetVersion: number): string {
  return `lv|v2|vk|${accountId}|${keysetVersion}`;
}
/** record AAD (§6.2). */
export function recordAad(accountId: string, recordId: string, vkVersion: number): string {
  return `lv|v2|rec|${accountId}|${recordId}|${vkVersion}`;
}
/** Seal AAD (§8.5 step 4). */
export function sealAad(ctx: string): string {
  return `lv|v2|seal|${ctx}`;
}
/** recovery-code wrappedVK AAD (§8.11.1). `rcId` is base64url. */
export function rcAad(accountId: string, rcId: string, vkVersion: number): string {
  return `lv|v2|rc|${accountId}|${rcId}|${vkVersion}`;
}
export const EXPORT_AAD_KEY = 'lv-export|1|key';
export const EXPORT_AAD_PAYLOAD = 'lv-export|1|payload';

// ---- signed strings ----
/** Device login (§13.3): signed over UTF-8 of this string. `challenge` is base64url. */
export function authSignString(deviceId: string, challenge: string): string {
  return `${AUTH_SIGN_TAG}\n${deviceId}\n${challenge}`;
}

export type UnlockSignFields = {
  accountId: string;
  deviceId: string;
  /** base64url, 16 bytes */
  requestNonce: string;
  /** base64url, 65 bytes */
  ephPub: string;
  /** two digits, "10".."99" */
  code: string;
  /** UTC, second precision, e.g. 2026-11-11T09:00:00Z */
  issuedAt: string;
};

/** Unlock request (§8.4). */
export function unlockSignString(f: UnlockSignFields): string {
  return [
    UNLOCK_SIGN_TAG,
    f.accountId,
    f.deviceId,
    f.requestNonce,
    f.ephPub,
    f.code,
    f.issuedAt,
  ].join('\n');
}

export type AdminSignFields = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Request path exactly as sent, including the query string if any. */
  path: string;
  /** base64url(SHA-256(raw request body bytes)); the hash of the empty string when there is no body. */
  bodyHash: string;
  /** UNIX seconds */
  ts: number;
  /** base64url, 16 bytes */
  nonce: string;
};

/** Admin signature (§8.7). */
export function adminSignString(f: AdminSignFields): string {
  return [ADMIN_SIGN_TAG, f.method, f.path, f.bodyHash, String(f.ts), f.nonce].join('\n');
}
