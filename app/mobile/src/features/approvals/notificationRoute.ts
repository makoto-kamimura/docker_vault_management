// Pure: turns notification data (iOS custom keys / Android data message) into a route.
import { type PushPayload, pushPayloadSchema, pushTargetRoute } from '@localvault/protocol';

/** Accepts either the payload itself or objects that nest it (`data`, `payload`, `body`). */
export function extractPushPayload(raw: unknown, depth = 0): PushPayload | null {
  if (!raw || typeof raw !== 'object' || depth > 3) return null;
  const direct = pushPayloadSchema.safeParse(pickPush(raw as Record<string, unknown>));
  if (direct.success) return direct.data;
  for (const k of ['data', 'payload', 'body', 'dataString', 'content', 'trigger']) {
    let v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        continue;
      }
    }
    const nested = extractPushPayload(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function pickPush(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof o.t === 'string') out.t = o.t;
  if (typeof o.r === 'string') out.r = o.r;
  return out;
}

export function routeForNotification(raw: unknown): string | null {
  const p = extractPushPayload(raw);
  return p ? pushTargetRoute(p) : null;
}
