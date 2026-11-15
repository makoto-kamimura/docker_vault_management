import { createWebCryptoProvider } from '@localvault/core';
import { defaultPsl } from '@localvault/core/psl-data';
import { createRouter } from '../../src/background/router';
import type { AlarmsApi } from '../../src/core/clipboard';
import { createDeviceKeyStore, createMemoryBackend } from '../../src/core/device-key';
import { createPcClient } from '../../src/core/pc-client';
import { createMemoryStorage } from '../../src/core/storage';
import type { Env, StorageArea } from '../../src/core/types';
import { FakeServer } from './fake-server';

export type Harness = ReturnType<typeof createHarness>;

export function createHarness(opts: { server?: FakeServer } = {}) {
  const server = opts.server ?? new FakeServer();
  const local = createMemoryStorage();
  const session = createMemoryStorage();
  const keyBackend = createMemoryBackend();
  const time = { now: Date.now() };
  const alarmLog: { name: string; when: number }[] = [];
  const alarms: AlarmsApi = {
    create: (name, info) => {
      alarmLog.push({ name, when: info.when });
    },
    clear: (name) => {
      for (let i = alarmLog.length - 1; i >= 0; i--)
        if (alarmLog[i]?.name === name) alarmLog.splice(i, 1);
    },
  };

  /** A new Env over the SAME storage: exactly what a restarted service worker does. */
  function makeEnv(): Env {
    return {
      local: local as StorageArea,
      session: session as StorageArea,
      fetch: server.fetch as typeof fetch,
      crypto: createWebCryptoProvider(),
      clock: { now: () => time.now },
      deviceKey: createDeviceKeyStore(keyBackend),
      psl: defaultPsl(),
      platform: { browser: 'chrome', os: 'Windows' },
      allowInsecureLocalhost: false,
    };
  }
  function boot() {
    const env = makeEnv();
    const client = createPcClient(env);
    const router = createRouter({ env, client, alarms });
    return { env, client, router };
  }
  return { server, local, session, keyBackend, time, alarmLog, alarms, makeEnv, boot };
}

export const content = (origin: string | undefined, frameId = 0, tabId = 1) =>
  ({ kind: 'content', origin, frameId, tabId }) as const;
export const page = { kind: 'extension' } as const;

/** Pairs the harness' client with the fake server and returns once unlocked. */
export async function pairAndUnlock(h: Harness) {
  const { client } = h.boot();
  await h.server.putMeta();
  const start = await client.startPairing(h.server.origin);
  await h.server.approvePairing(start.pairingId);
  const res = await h.boot().client.pollPairing();
  if (res.state !== 'paired') throw new Error(`pairing failed: ${JSON.stringify(res)}`);
  return h.boot();
}
