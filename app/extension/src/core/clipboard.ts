// Clipboard clearing (5.10): the popup copies, then asks the service worker to schedule a clear;
// an Offscreen Document (reason CLIPBOARD) writes the empty string when the alarm fires.
import { KEY, store } from './storage';
import type { Env } from './types';

export const CLIPBOARD_ALARM = 'lv-clipboard-clear';

export interface AlarmsApi {
  create(name: string, info: { when: number }): Promise<void> | void;
  clear(name: string): Promise<unknown> | unknown;
}

/** Schedules (or re-schedules: a newer copy resets the timer) a clear. Returns the due time. */
export async function scheduleClipboardClear(env: Env, alarms: AlarmsApi): Promise<number | null> {
  const { clipboardClearSec } = await store.config(env);
  if (clipboardClearSec === null) {
    await alarms.clear(CLIPBOARD_ALARM);
    await env.local.remove(KEY.clipboard);
    return null;
  }
  const when = env.clock.now() + clipboardClearSec * 1000;
  await env.local.set({ [KEY.clipboard]: { clearAt: when } });
  await alarms.create(CLIPBOARD_ALARM, { when });
  return when;
}

/** Called when the alarm fires and on every service-worker start (a missed alarm is made up). */
export async function runDueClipboardClear(env: Env, clear: () => Promise<void>): Promise<boolean> {
  const due = await store.clipboardAt(env);
  if (due === null || env.clock.now() < due.clearAt) return false;
  await env.local.remove(KEY.clipboard);
  await clear();
  return true;
}
