import type { PushPayload } from '@localvault/protocol';
import type { Logger } from 'pino';
import type { Clock } from '../clock';
import type { Config } from '../config';
import type { Database } from '../db/client';
import { ApnsSender } from './apns';
import { FcmSender } from './fcm';
import type { PushOptions, PushOutcome, PushSender, PushTarget } from './types';

export type { PushOptions, PushOutcome, PushSender, PushTarget } from './types';

/** Used when neither APNs nor FCM is configured. */
export const noopPushSender: PushSender = {
  send: async () => 'skipped',
};

export function createPushSender(
  config: Config,
  clock: Clock,
  log: Logger,
): PushSender & { close(): void } {
  const apns = config.apns ? new ApnsSender(config.apns, clock) : null;
  const fcm = config.fcm ? new FcmSender(config.fcm, clock) : null;
  if (!apns && !fcm) log.info('push: no APNs/FCM configured, notifications are disabled');
  return {
    async send(target: PushTarget, payload: PushPayload, opts: PushOptions): Promise<PushOutcome> {
      const sender = target.platform === 'apns' ? apns : fcm;
      if (!sender) return 'skipped';
      return await sender.send(target, payload, opts);
    },
    close() {
      apns?.close();
    },
  };
}

/** Background task tracking so shutdown (and tests) can wait for in-flight work. */
export class Tasks {
  private readonly pending = new Set<Promise<unknown>>();

  run(p: Promise<unknown>): void {
    const tracked = p.catch(() => {}).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}

/**
 * Send `payload` to every non-revoked approver (mobile) device that has a push token. Failures are
 * logged by name only and never propagate; tokens the service reports as dead are removed.
 */
export async function notifyApprovers(
  db: Database,
  sender: PushSender,
  log: Logger,
  accountId: string,
  payload: PushPayload,
  opts: PushOptions,
): Promise<void> {
  try {
    const rows = await db
      .selectFrom('devices')
      .select(['id', 'push_platform', 'push_token'])
      .where('account_id', '=', accountId)
      .where('kind', '=', 'mobile')
      .where('revoked_at', 'is', null)
      .where('push_token', 'is not', null)
      .where('push_platform', 'is not', null)
      .execute();
    await Promise.all(
      rows.map(async (row) => {
        const target: PushTarget = {
          deviceId: row.id,
          platform: row.push_platform as 'apns' | 'fcm',
          token: row.push_token as string,
        };
        try {
          const outcome = await sender.send(target, payload, opts);
          if (outcome === 'invalid_token') {
            await db
              .updateTable('devices')
              .set({ push_token: null, push_platform: null })
              .where('id', '=', row.id)
              .where('push_token', '=', target.token)
              .execute();
          } else if (outcome === 'failed') {
            log.warn({ platform: target.platform, t: payload.t }, 'push delivery failed');
          }
        } catch (err) {
          log.warn({ platform: target.platform, errName: (err as Error).name }, 'push send error');
        }
      }),
    );
  } catch (err) {
    log.warn({ errName: (err as Error).name }, 'push fan-out error');
  }
}
