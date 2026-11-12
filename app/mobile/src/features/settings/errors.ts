// Error text for the W4b screens. Never shows the error's own message (it could echo data).
import { VaultCoreError } from '@localvault/core';
import { ApiError } from '@localvault/protocol';
import { NetworkError } from '../../api/errors';
import { formatDuration, t } from '../../i18n';
import { describeError } from '../errors/messages';

/** null = the user canceled (biometric sheet): show nothing. */
export function describeActionError(e: unknown): string | null {
  if (e instanceof VaultCoreError) {
    switch (e.code) {
      case 'E_AUTH_CANCELED':
        return null;
      case 'E_AUTH_FAILED':
        return t('w.err.authFailed');
      case 'E_BIOMETRY_INVALIDATED':
        return t('w.err.bioInvalidated');
      case 'E_BIOMETRY_UNAVAILABLE':
        return t('w.err.bioUnavailable');
      case 'E_WRONG_PASSWORD':
        return t('w.err.wrongPassword');
      case 'E_THROTTLED':
        return t('w.err.throttled', { time: formatDuration(e.details?.retryAfterSec ?? 30) });
      case 'E_NEEDS_MASTER_PASSWORD':
        return t('w.err.needsPassword');
      case 'E_FINGERPRINT_MISMATCH':
      case 'E_SERVER_MISMATCH':
        return t('w.err.pairMismatch');
      case 'E_STALE_KEY':
      case 'E_VERSION_CONFLICT':
        return t('w.err.conflict');
      case 'E_IMPORT_FORMAT':
        return t('w.err.importFormat');
      case 'E_TOO_LARGE':
        return t('w.err.tooLarge');
      case 'E_DEVICE_REVOKED':
        return t('w.err.deviceRevoked');
      case 'E_UNTRUSTED_DEVICE':
        return t('w.err.untrusted');
      case 'E_INVALID_INPUT':
        return t('w.err.invalidInput');
      default:
        return describeError(e);
    }
  }
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'E_ALREADY_HANDLED':
        return t('w.err.alreadyHandled');
      case 'E_EXPIRED':
        return t('w.err.expired');
      case 'E_STALE_KEY':
      case 'E_VERSION_CONFLICT':
        return t('w.err.conflict');
      case 'E_DEVICE_REVOKED':
        return t('w.err.deviceRevoked');
      case 'E_TOO_LARGE':
        return t('w.err.tooLarge');
      default:
        return describeError(e);
    }
  }
  return describeError(e);
}

/** Network trouble, rate limits and E_INTERNAL are worth a "retry" button. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  return e instanceof ApiError && (e.code === 'E_INTERNAL' || e.code === 'E_RATE_LIMITED');
}

/** E_CLOCK_SKEW gets its own banner (fix the device clock). */
export function isClockSkew(e: unknown): boolean {
  return (
    (e instanceof ApiError && e.code === 'E_CLOCK_SKEW') ||
    (e instanceof VaultCoreError && e.code === 'E_CLOCK_SKEW')
  );
}
