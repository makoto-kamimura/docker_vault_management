// Error types shared by every core module. Messages never contain secrets or plaintext.

/**
 * Error codes of the VaultCore interface (spec §15 table, v0.4 additions) plus two
 * core-internal codes: `E_INVALID_INPUT` (a caller-supplied value is malformed) and
 * `E_TOO_LARGE` (a record does not fit the 64 KB ciphertext limit).
 */
export type VaultCoreErrorCode =
  | 'E_LOCKED'
  | 'E_AUTH_CANCELED'
  | 'E_AUTH_FAILED'
  | 'E_BIOMETRY_INVALIDATED'
  | 'E_BIOMETRY_UNAVAILABLE'
  | 'E_WRONG_PASSWORD'
  | 'E_WRONG_CREDENTIALS'
  | 'E_INVALID_RECOVERY_KEY'
  | 'E_THROTTLED'
  | 'E_CORRUPTED'
  | 'E_UNSUPPORTED_VERSION'
  | 'E_IO'
  | 'E_NOT_FOUND'
  | 'E_IMPORT_FORMAT'
  | 'E_ROLLBACK_DETECTED'
  | 'E_NEEDS_MASTER_PASSWORD'
  | 'E_FINGERPRINT_MISMATCH'
  | 'E_SERVER_MISMATCH'
  | 'E_CODE_MISMATCH'
  | 'E_UNTRUSTED_DEVICE'
  | 'E_INVALID_RECOVERY_CODE'
  | 'E_CLAIM_WAITING'
  | 'E_RC_FROZEN'
  | 'E_CLAIM_CLOSED'
  | 'E_DEVICE_REVOKED'
  | 'E_ACCOUNT_DELETED'
  | 'E_CLOCK_SKEW'
  | 'E_STALE_KEY'
  | 'E_VERSION_CONFLICT'
  | 'E_INVALID_INPUT'
  | 'E_TOO_LARGE';

/** Documented `details` payloads of some codes. */
export type VaultCoreErrorDetails = {
  /** `E_THROTTLED` */
  retryAfterSec?: number;
  /** `E_CODE_MISMATCH` */
  attemptsLeft?: number;
  /** `E_CLAIM_WAITING` (ISO 8601) */
  availableAt?: string;
};

export class VaultCoreError extends Error {
  override readonly name = 'VaultCoreError';
  readonly code: VaultCoreErrorCode;
  readonly details: VaultCoreErrorDetails | undefined;

  constructor(code: VaultCoreErrorCode, message?: string, details?: VaultCoreErrorDetails) {
    super(message ?? code);
    this.code = code;
    this.details = details;
  }
}

/**
 * Failure inside a crypto primitive. `E_DECRYPT` is the only AEAD failure signal: it carries no
 * detail on purpose (wrong key, wrong AAD, tampered ciphertext and malformed input all look alike).
 */
export type CryptoErrorCode = 'E_DECRYPT' | 'E_CRYPTO_INPUT';

export class CryptoError extends Error {
  override readonly name = 'CryptoError';
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}
