import { KEY, store } from './storage';
import type { Env } from './types';

/**
 * Back to the initial state (8.8-4, 12.5): session, cache, token and device key are deleted. The
 * server URL and clipboard preference survive so the user can pair again. `notice` explains why.
 */
export async function wipeAll(
  env: Env,
  notice: 'revoked' | 'account_deleted' | 'unpaired' | null,
): Promise<void> {
  await env.session.clear();
  await env.local.remove([KEY.account, KEY.sync, KEY.records, KEY.clipboard]);
  await env.deviceKey.delete();
  await store.setNotice(env, notice === null ? null : { kind: notice, at: env.clock.now() });
}
