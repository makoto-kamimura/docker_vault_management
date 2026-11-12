import { ApiError, type ErrorCode } from '@localvault/protocol';

export { ApiError };

export function fail(code: ErrorCode, message?: string, details?: Record<string, unknown>): never {
  throw new ApiError(code, message, details);
}

/** Error body for failures that have no protocol code (unexpected server errors). */
export const INTERNAL_ERROR_BODY = {
  error: { code: 'E_INTERNAL', message: 'internal error' },
} as const;

/** Postgres unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}
