import type { PushPayload } from '@localvault/protocol';

export type PushTarget = {
  deviceId: string;
  platform: 'apns' | 'fcm';
  token: string;
};

export type PushOptions = {
  /** Lifetime of the notification at the push service. */
  ttlSec: number;
  /** APNs collapse id (the request id). */
  collapseId?: string;
};

/** `invalid_token`: APNs 410 / FCM UNREGISTERED. The caller deletes the token. */
export type PushOutcome = 'sent' | 'invalid_token' | 'failed' | 'skipped';

export interface PushSender {
  send(target: PushTarget, payload: PushPayload, opts: PushOptions): Promise<PushOutcome>;
}
