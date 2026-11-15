import { describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_ALARM,
  runDueClipboardClear,
  scheduleClipboardClear,
} from '../src/core/clipboard';
import { createHarness } from './helpers/harness';

describe('clipboard clear scheduling (5.10)', () => {
  it('schedules the configured delay and a newer copy resets it', async () => {
    const h = createHarness();
    const { env, client } = h.boot();
    await client.setClipboardClear(30);
    const t0 = h.time.now;
    expect(await scheduleClipboardClear(env, h.alarms)).toBe(t0 + 30_000);
    h.time.now += 10_000;
    await scheduleClipboardClear(env, h.alarms);
    expect(h.alarmLog).toEqual([
      { name: CLIPBOARD_ALARM, when: t0 + 30_000 },
      { name: CLIPBOARD_ALARM, when: t0 + 40_000 },
    ]);
  });

  it('"never" schedules nothing and cancels a pending clear', async () => {
    const h = createHarness();
    const { env, client } = h.boot();
    await scheduleClipboardClear(env, h.alarms);
    await client.setClipboardClear(null);
    expect(await scheduleClipboardClear(env, h.alarms)).toBeNull();
    expect(h.alarmLog).toEqual([]);
  });

  it('clears only once the time has come, and only once', async () => {
    const h = createHarness();
    const { env } = h.boot();
    await scheduleClipboardClear(env, h.alarms); // default 60 s
    const clear = vi.fn(async () => undefined);
    expect(await runDueClipboardClear(env, clear)).toBe(false);
    h.time.now += 61_000;
    expect(await runDueClipboardClear(env, clear)).toBe(true);
    expect(await runDueClipboardClear(env, clear)).toBe(false);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('the page-message route validates the allowed delays', async () => {
    const h = createHarness();
    const { router } = h.boot();
    const page = { kind: 'extension' } as const;
    expect(await router.handle({ type: 'set-clipboard-clear', sec: 45 }, page)).toMatchObject({
      ok: false,
    });
    expect(await router.handle({ type: 'set-clipboard-clear', sec: 120 }, page)).toMatchObject({
      ok: true,
    });
    expect(await router.handle({ type: 'schedule-clipboard-clear' }, page)).toMatchObject({
      ok: true,
    });
    expect(h.alarmLog).toHaveLength(1);
  });
});
