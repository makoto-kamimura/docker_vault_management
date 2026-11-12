// Every message the service worker accepts, validated strictly (zod). Unknown keys are rejected.
import { uuidSchema } from '@localvault/protocol';
import { z } from 'zod';

const none = {} as const;
const idField = { id: uuidSchema };

/** Messages a content script may send. */
export const contentMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), ...none }),
  z.strictObject({ type: z.literal('status'), ...none }),
  z.strictObject({ type: z.literal('candidates'), ...none }),
  z.strictObject({
    type: z.literal('fill'),
    ...idField,
    fields: z.enum(['both', 'username', 'password']),
    insecureConfirmed: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('unlock-start'), ...none }),
  z.strictObject({ type: z.literal('unlock-poll'), ...none }),
  z.strictObject({ type: z.literal('unlock-cancel'), ...none }),
  z.strictObject({ type: z.literal('search-insecure'), query: z.string().max(200) }),
]);
export type ContentMessage = z.infer<typeof contentMessageSchema>;

/** Messages only extension pages (popup, options) may send. */
export const pageMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('status'), ...none }),
  z.strictObject({ type: z.literal('unlock-start'), ...none }),
  z.strictObject({ type: z.literal('unlock-poll'), ...none }),
  z.strictObject({ type: z.literal('unlock-cancel'), ...none }),
  z.strictObject({ type: z.literal('lock'), ...none }),
  z.strictObject({
    type: z.literal('list'),
    query: z.string().max(200),
    tabId: z.int().min(0).optional(),
  }),
  z.strictObject({
    type: z.literal('copy'),
    ...idField,
    field: z.enum(['username', 'password']),
  }),
  z.strictObject({ type: z.literal('schedule-clipboard-clear'), ...none }),
  z.strictObject({ type: z.literal('sync'), ...none }),
  z.strictObject({ type: z.literal('accept-server-state'), ...none }),
  z.strictObject({ type: z.literal('check-server-url'), url: z.string().max(2048) }),
  z.strictObject({ type: z.literal('pair-start'), url: z.string().max(2048) }),
  z.strictObject({ type: z.literal('pair-poll'), ...none }),
  z.strictObject({ type: z.literal('pair-cancel'), ...none }),
  z.strictObject({ type: z.literal('unpair'), ...none }),
  z.strictObject({
    type: z.literal('set-clipboard-clear'),
    sec: z.union([z.literal(30), z.literal(60), z.literal(120), z.null()]),
  }),
]);
export type PageMessage = z.infer<typeof pageMessageSchema>;

export type ErrorInfo = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};
export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: ErrorInfo };
