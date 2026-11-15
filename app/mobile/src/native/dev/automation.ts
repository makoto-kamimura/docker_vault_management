// DEVELOPMENT ONLY automation. There is no GUI test driver on the build machine, so the dev core
// can be steered from the shell: write `dev-control.json` into the app's document directory
// (xcrun simctl get_app_container booted <bundle> data) and this module runs its steps against the
// core and the router, then writes `dev-result.json`. Active only inside createDevVaultCore, which
// itself exists only in dev builds with EXPO_PUBLIC_LV_DEV_CORE=1.
import type { VaultCore } from '@localvault/core';
import { File, Paths } from 'expo-file-system';
import { createApiClient } from '../../api';
import { createAccountFlow, restoreAccountFlow } from '../../features/setup/flows';
import { nav } from '../../lib/nav';
import { useToastStore } from '../../state/toastStore';
import type { DevBiometric } from './biometric';

export type DevStep =
  | { op: 'create'; server: string; name: string; password: string }
  | { op: 'restore'; server: string; name: string; password: string; recoveryKey: string }
  | { op: 'seed' }
  | { op: 'route'; path: string }
  | { op: 'back' }
  | { op: 'lock' }
  | { op: 'unlock'; password: string }
  | { op: 'biometric'; answer: 'success' | 'cancel' | 'fail' | 'invalidated' | null }
  | { op: 'editGitHub' }
  | { op: 'sleep'; ms: number };

type Result = {
  at: string;
  ok: boolean;
  steps: string[];
  recoveryKey?: string;
  ids: Record<string, string>;
  error?: string;
  items?: string[];
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const makeApiFor = (origin: string) => createApiClient({ baseUrl: () => origin });

async function seed(core: VaultCore, ids: Record<string, string>) {
  const gen = await core.generatePassword({
    length: 24,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: true,
  });
  const gh = await core.saveItem({
    title: 'GitHub',
    username: 'alice@example.com',
    password: gen,
    urls: [{ url: 'https://github.com/login', match: 'domain' }],
    notes: '個人アカウント。\n2 段階認証は別の場所に保管。',
    favorite: true,
  });
  ids.GitHub = gh.id;
  const bank = await core.saveItem({
    title: 'みずほダイレクト',
    username: '1234567890',
    password: 'Tr0ub4dor&3-horse-staple',
    urls: [{ url: 'https://web.ib.mizuho-bk.co.jp', match: 'host' }],
    notes: '',
    favorite: false,
  });
  ids.Bank = bank.id;
  const nf = await core.saveItem({
    title: 'Netflix',
    username: 'family@example.com',
    password: 'popcorn-Friday-night-42',
    urls: [{ url: 'https://www.netflix.com', match: 'domain' }],
    notes: '家族共用',
    favorite: false,
  });
  ids.Netflix = nf.id;
  const old = await core.saveItem({
    title: '古いフォーラム',
    username: 'alice_old',
    password: 'old-forum-password-1',
    urls: [],
    notes: '',
    favorite: false,
  });
  ids.Old = old.id;
  await core.trashItem(old.id);
  const tmp = await core.saveItem({
    title: '一時メモ',
    username: 'tmp',
    password: 'tmp-pass-for-restore',
    urls: [],
    notes: '',
    favorite: false,
  });
  ids.Tmp = tmp.id;
  await core.trashItem(tmp.id);
  await core.restoreItem(tmp.id);
  await core.copy(gh.id, 'username');
  await core.copy(gh.id, 'password');
}

async function runStep(
  step: DevStep,
  core: VaultCore,
  biometric: DevBiometric,
  result: Result,
): Promise<void> {
  const sub = (p: string) => p.replace(/\{(\w+)\}/g, (_w, k: string) => result.ids[k] ?? k);
  switch (step.op) {
    case 'create': {
      const r = await createAccountFlow({
        core,
        makeApi: makeApiFor,
        serverUrl: step.server,
        accountName: step.name,
        masterPassword: step.password,
        inviteCode: 'open',
      });
      result.recoveryKey = r.recoveryKey;
      return;
    }
    case 'restore':
      await restoreAccountFlow({
        core,
        makeApi: makeApiFor,
        serverUrl: step.server,
        accountName: step.name,
        masterPassword: step.password,
        recoveryKey: step.recoveryKey,
      });
      return;
    case 'seed':
      return seed(core, result.ids);
    case 'editGitHub': {
      const id = result.ids.GitHub;
      if (!id) throw new Error('seed first');
      const d = await core.getItem(id);
      await core.saveItem({
        id,
        title: d.title,
        username: d.username,
        password: 'github-second-password-77',
        urls: d.urls,
        notes: d.notes,
        favorite: d.favorite,
      });
      return;
    }
    case 'route':
      if (step.path === '/') nav.replace('/');
      else nav.push(sub(step.path));
      return;
    case 'back':
      nav.back();
      return;
    case 'lock':
      return core.lock();
    case 'unlock':
      return core.unlockWithPassword(step.password);
    case 'biometric':
      biometric.override = step.answer;
      return;
    case 'sleep':
      return sleep(step.ms);
  }
}

export function startDevAutomation(core: VaultCore, biometric: DevBiometric): void {
  if (process.env.EXPO_PUBLIC_LV_DEV_AUTOMATION !== '1') return;
  const control = new File(Paths.document, 'dev-control.json');
  const resultFile = new File(Paths.document, 'dev-result.json');
  const result: Result = { at: '', ok: true, steps: [], ids: {} };
  let busy = false;

  const flush = async () => {
    result.at = new Date().toISOString();
    if (!resultFile.exists) resultFile.create({ overwrite: true });
    await resultFile.write(JSON.stringify(result, null, 2));
  };

  const tick = async () => {
    if (busy || !control.exists) return;
    busy = true;
    try {
      const steps = JSON.parse(await control.text()) as DevStep[];
      control.delete();
      result.ok = true;
      result.error = undefined;
      for (const step of steps) {
        result.steps.push(`${step.op}@${new Date().toISOString()}`);
        await flush();
        try {
          await runStep(step, core, biometric, result);
        } catch (e) {
          result.ok = false;
          result.error = `${step.op}: ${e instanceof Error ? `${e.name} ${e.message}` : 'error'}`;
          break;
        }
        await flush();
      }
      try {
        result.items = (await core.listItems({ includeTrashed: true })).map(
          (i) => `${i.title}${i.trashedAt ? ' (trash)' : ''}`,
        );
      } catch {
        result.items = undefined;
      }
      useToastStore.getState().dismiss(-1);
      await flush();
    } catch (e) {
      result.ok = false;
      result.error = e instanceof Error ? e.message : 'error';
      await flush().catch(() => undefined);
    } finally {
      busy = false;
    }
  };
  setInterval(() => void tick(), 700);
}
