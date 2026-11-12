// Service worker wiring. NO module-level state (12.4): the Env is rebuilt on every event and all
// persistent facts are re-read from storage. Listeners are registered synchronously at top level.
import { type CryptoProvider, createWebCryptoProvider } from '@localvault/core';
import { defaultPsl } from '@localvault/core/psl-data';
import { CLIPBOARD_ALARM, runDueClipboardClear } from '../core/clipboard';
import { createDeviceKeyStore, createIdbBackend } from '../core/device-key';
import { createPcClient } from '../core/pc-client';
import { detectPlatform } from '../core/platform';
import type { Env, StorageArea } from '../core/types';
import { createRouter } from './router';
import { classifySender } from './sender';

const SESSION_ALARM = 'lv-session-check';
const SYNC_ALARM = 'lv-sync';
const IDLE_SEC = 15 * 60;

function areaOf(area: chrome.storage.StorageArea): StorageArea {
  return {
    get: (keys) => area.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
    clear: () => area.clear(),
  };
}

export function buildEnv(): Env {
  const nav = navigator as Navigator & { brave?: unknown };
  const crypto: CryptoProvider = createWebCryptoProvider();
  return {
    local: areaOf(chrome.storage.local),
    session: areaOf(chrome.storage.session),
    fetch: (input, init) => fetch(input, init),
    crypto,
    clock: { now: () => Date.now() },
    deviceKey: createDeviceKeyStore(createIdbBackend()),
    psl: defaultPsl(),
    platform: detectPlatform(nav.userAgent, nav.brave !== undefined),
    allowInsecureLocalhost: __LV_DEV_ALLOW_HTTP__,
  };
}

async function clearClipboardViaOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: 'Clear the clipboard after copying a credential',
    });
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'clear-clipboard' });
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

async function ensureAlarms(): Promise<void> {
  if ((await chrome.alarms.get(SESSION_ALARM)) === undefined) {
    chrome.alarms.create(SESSION_ALARM, { periodInMinutes: 1 });
  }
  if ((await chrome.alarms.get(SYNC_ALARM)) === undefined) {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
  }
}

export function startBackground(): void {
  const wiring = () => {
    const env = buildEnv();
    return { env, client: createPcClient(env) };
  };

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const { env, client } = wiring();
    const router = createRouter({ env, client, alarms: chrome.alarms });
    const info = classifySender(sender, chrome.runtime.id, chrome.runtime.getURL(''));
    void router.handle(message, info).then(sendResponse);
    return true; // async response
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    const { env, client } = wiring();
    void (async () => {
      if (alarm.name === SESSION_ALARM) await client.checkSession();
      else if (alarm.name === SYNC_ALARM) {
        // Pull-only; allowed while locked (ciphertext only). Failures are retried at the next tick.
        await client.sync().catch(() => undefined);
      } else if (alarm.name === CLIPBOARD_ALARM) {
        await runDueClipboardClear(env, clearClipboardViaOffscreen).catch(() => undefined);
      }
    })();
  });

  // Idle (15 min without input) and screen lock both lock the session (12.5).
  chrome.idle.setDetectionInterval(IDLE_SEC);
  chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'idle' || state === 'locked') {
      void wiring().client.lock(state === 'locked' ? 'screen_locked' : 'idle');
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => void wiring().client.forgetTab(tabId));
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'loading') void wiring().client.forgetTab(tabId);
  });

  chrome.runtime.onInstalled.addListener(() => void ensureAlarms());
  chrome.runtime.onStartup.addListener(() => void ensureAlarms());

  // Every worker start: make sure the alarms exist and a missed clipboard clear is made up.
  void ensureAlarms();
  const { env } = wiring();
  void runDueClipboardClear(env, clearClipboardViaOffscreen).catch(() => undefined);
}
