// Maps any thrown error to a Japanese user message (spec §14 error table). Never includes the
// error's own message: it could carry data we must not display or log.
import { VaultCoreError } from '@localvault/core';
import { ApiError } from '@localvault/protocol';
import { InvalidRequestError, InvalidResponseError, NetworkError } from '../../api/errors';
import { type MessageKey, t } from '../../i18n';

export function errorMessageKey(e: unknown): MessageKey {
  if (e instanceof NetworkError) return e.kind === 'timeout' ? 'error.timeout' : 'error.network';
  if (e instanceof InvalidResponseError || e instanceof InvalidRequestError)
    return 'error.invalidResponse';
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'E_CLOCK_SKEW':
        return 'error.clockSkew';
      case 'E_INTERNAL':
        return 'error.internal';
      case 'E_RATE_LIMITED':
        return 'error.rateLimited';
      case 'E_REGISTRATION_CLOSED':
        return 'error.registrationClosed';
      case 'E_ACCOUNT_EXISTS':
        return 'error.accountExists';
      case 'E_RC_FROZEN':
        return 'error.rcFrozen';
      case 'E_CLAIM_CLOSED':
        return 'error.claimClosed';
      case 'E_NOT_FOUND':
        return 'error.notFound';
      case 'E_FORBIDDEN':
      case 'E_UNAUTHORIZED':
        return 'error.inviteInvalid';
      default:
        return 'error.unknown';
    }
  }
  if (e instanceof VaultCoreError) {
    switch (e.code) {
      case 'E_WRONG_CREDENTIALS':
        return 'error.wrongCredentials';
      case 'E_INVALID_RECOVERY_KEY':
        return 'error.invalidRecoveryKey';
      case 'E_INVALID_RECOVERY_CODE':
        return 'error.invalidRecoveryCode';
      case 'E_RC_FROZEN':
        return 'error.rcFrozen';
      case 'E_CLAIM_CLOSED':
        return 'error.claimClosed';
      case 'E_CLOCK_SKEW':
        return 'error.clockSkew';
      case 'E_LOCKED':
        return 'error.locked';
      case 'E_IO':
        return 'error.io';
      case 'E_CORRUPTED':
        return 'error.corrupted';
      case 'E_UNSUPPORTED_VERSION':
        return 'error.unsupportedVersion';
      default:
        return 'error.unknown';
    }
  }
  return 'error.unknown';
}

export function describeError(e: unknown): string {
  return t(errorMessageKey(e));
}

/** Restore and recovery-claim servers answer a wrong authKey with a plain 401. */
export function describeRestoreError(e: unknown): string {
  if (e instanceof ApiError && e.code === 'E_UNAUTHORIZED') return t('error.wrongCredentials');
  return describeError(e);
}

export function describeClaimError(e: unknown): string {
  if (e instanceof ApiError && e.code === 'E_UNAUTHORIZED') return t('error.invalidRecoveryCode');
  return describeError(e);
}
