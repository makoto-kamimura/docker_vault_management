import type { ErrorCode } from '@localvault/protocol';

/** Errors the UI can show. Messages never contain secrets. */
export type PcErrorCode =
  | 'E_NOT_PAIRED'
  | 'E_LOCKED'
  | 'E_NO_PENDING'
  | 'E_NETWORK'
  | 'E_BAD_RESPONSE'
  | 'E_BAD_SERVER_URL'
  | 'E_FINGERPRINT'
  | 'E_BAD_VK'
  | 'E_NOT_FOUND'
  | 'E_FORBIDDEN_ORIGIN'
  | 'E_INSECURE_PAGE'
  | 'E_SYNC_HALTED'
  | 'E_BAD_MESSAGE'
  | 'E_BAD_SENDER'
  | 'E_REVOKED'
  | 'E_ACCOUNT_DELETED'
  | 'E_INTERNAL'
  | ErrorCode;

export class PcError extends Error {
  override readonly name = 'PcError';
  readonly code: PcErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: PcErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.code = code;
    this.details = details;
  }
}
