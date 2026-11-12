// Session lifecycle (12.3 / 12.5). VK and the decrypted index live ONLY in `storage.session`.
import { base64urlDecode, base64urlEncode } from '@localvault/protocol';
import { KEY, type SessionData, store } from './storage';
import type { Env } from './types';

/** Safety cap for single-use sessions (sessionMaxSec 0): lock after one fill/copy or 5 minutes. */
export const SINGLE_USE_CAP_MS = 5 * 60 * 1000;

export type LockReason =
  | 'manual'
  | 'expired'
  | 'idle'
  | 'screen_locked'
  | 'single_use'
  | 'revoked'
  | 'vk_changed'
  | 'unpaired';

export async function openSession(
  env: Env,
  input: { vk: Uint8Array; vkVersion: number; sessionMaxSec: number },
): Promise<SessionData> {
  const now = env.clock.now();
  const singleUse = input.sessionMaxSec === 0;
  const data: SessionData = {
    vk: base64urlEncode(input.vk),
    vkVersion: input.vkVersion,
    sessionMaxSec: input.sessionMaxSec,
    expiresAt: now + (singleUse ? SINGLE_USE_CAP_MS : input.sessionMaxSec * 1000),
    singleUse,
    unlockedAt: now,
  };
  await store.setSession(env, data);
  return data;
}

/** Removes VK, index and an in-flight unlock request (12.5). A pairing in progress is kept. */
export async function lock(env: Env, _reason: LockReason): Promise<void> {
  await env.session.remove([KEY.session, KEY.index]);
  const pending = await store.pending(env);
  if (pending?.kind === 'unlock') await store.clearPending(env);
}

/** The live session, or null. An expired session is locked as a side effect (checked per call). */
export async function getSession(env: Env): Promise<SessionData | null> {
  const s = await store.session(env);
  if (s === null) return null;
  if (env.clock.now() >= s.expiresAt) {
    await lock(env, 'expired');
    return null;
  }
  return s;
}

export async function getVk(env: Env): Promise<{ vk: Uint8Array; session: SessionData } | null> {
  const session = await getSession(env);
  if (session === null) return null;
  return { vk: base64urlDecode(session.vk), session };
}

/** sessionMaxSec 0: lock right after one fill / copy. */
export async function afterUse(env: Env): Promise<void> {
  const s = await store.session(env);
  if (s?.singleUse === true) await lock(env, 'single_use');
}
