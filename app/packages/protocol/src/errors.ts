import { z } from 'zod';

/** Every API error code with its HTTP status (spec §13.4 + v0.4). */
export const ERROR_STATUS = {
  E_INVALID: 400,
  E_CLOCK_SKEW: 400,
  E_UNAUTHORIZED: 401,
  E_DEVICE_REVOKED: 401,
  E_FORBIDDEN: 403,
  E_REGISTRATION_CLOSED: 403,
  E_NOT_FOUND: 404,
  E_ALREADY_HANDLED: 409,
  E_ACCOUNT_EXISTS: 409,
  E_CLAIM_WAITING: 409,
  E_VERSION_CONFLICT: 409,
  E_STALE_KEY: 409,
  E_EXPIRED: 410,
  E_CLAIM_CLOSED: 410,
  E_ACCOUNT_DELETED: 410,
  E_TOO_LARGE: 413,
  E_RATE_LIMITED: 429,
  E_RC_FROZEN: 423,
  /** Unexpected server failure. Carries no detail; clients treat it as retryable. */
  E_INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export const errorCodeSchema = z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]);

/** Documented `details` payloads. */
export type ErrorDetails = {
  E_CLOCK_SKEW: { serverTime: string };
  E_CLAIM_WAITING: { availableAt: string };
  E_RATE_LIMITED: { retryAfterSec: number };
};

export const apiErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().max(500),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }

  static fromBody(body: unknown): ApiError | null {
    const r = apiErrorBodySchema.safeParse(body);
    if (!r.success) return null;
    return new ApiError(r.data.error.code, r.data.error.message, r.data.error.details);
  }
}
