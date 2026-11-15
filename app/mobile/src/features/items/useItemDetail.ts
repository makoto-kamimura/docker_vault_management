import type { ItemDetail } from '@localvault/core';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { getVaultCoreHandle } from '../../native/VaultCore';
import { useToastStore } from '../../state/toastStore';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';
import { copiedMessage, toOpenableUrl } from './model';

export type HistoryEntry = { index: number; changedAt: string; revealed: string | null };

export function useItemDetail(id: string) {
  const { core } = useSession();
  const push = useToastStore((s) => s.push);
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [original, setOriginal] = useState<ItemDetail | null>(null);
  const [missing, setMissing] = useState(false);
  // Plaintext lives in state only after an explicit reveal and is dropped on blur (spec §4.4).
  const [password, setPassword] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await core.getItem(id);
      if (!alive.current) return;
      setItem(d);
      setMissing(false);
      setHistory((await core.getPasswordHistory(id)).map((h) => ({ ...h, revealed: null })));
      if (d.conflictOf) {
        setOriginal(await core.getItem(d.conflictOf).catch(() => null));
      } else setOriginal(null);
    } catch {
      if (alive.current) setMissing(true);
    }
  }, [core, id]);

  useEffect(() => {
    alive.current = true;
    void load();
    const off = getVaultCoreHandle().on('onVaultChanged', () => void load());
    return () => {
      alive.current = false;
      off();
    };
  }, [load]);

  const hide = useCallback(() => {
    setPassword(null);
    setHistory((h) => h.map((e) => ({ ...e, revealed: null })));
  }, []);

  // Clear on blur / unmount and when the app goes to the background.
  useFocusEffect(
    useCallback(() => {
      const sub = AppState.addEventListener('change', (s) => {
        if (s !== 'active') hide();
      });
      return () => {
        sub.remove();
        hide();
      };
    }, [hide]),
  );

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        haptics.error();
        push('error', describeError(e));
      }
    },
    [push],
  );

  const toggleReveal = () =>
    run(async () => {
      if (password !== null) return hide();
      setPassword(await core.revealPassword(id));
    });

  const copy = (field: 'username' | 'password') =>
    run(async () => {
      const r = await core.copy(id, field);
      haptics.success();
      push('success', copiedMessage(r.clearsAt, Date.now()));
    });

  const openUrl = (raw: string) =>
    run(async () => {
      const u = toOpenableUrl(raw);
      if (u === null) throw new Error('url');
      await Linking.openURL(u).catch(() => {
        push('error', t('detail.openFailed'));
      });
    });

  const toggleHistory = (index: number) =>
    run(async () => {
      const cur = history.find((h) => h.index === index);
      if (!cur) return;
      const revealed = cur.revealed === null ? await core.revealHistoricPassword(id, index) : null;
      setHistory((hs) => hs.map((h) => (h.index === index ? { ...h, revealed } : h)));
    });

  const copyHistory = (index: number) =>
    run(async () => {
      const r = await core.copyHistoricPassword(id, index);
      haptics.success();
      push('success', copiedMessage(r.clearsAt, Date.now()));
    });

  const clearHistory = () =>
    run(async () => {
      await core.clearPasswordHistory(id);
      setHistory([]);
      push('success', t('detail.historyCleared'));
    });

  const unlinkApp = (packageName: string) =>
    run(async () => {
      await core.unlinkAndroidApp(id, packageName);
      push('success', t('detail.unlinked'));
      await load();
    });

  const moveToTrash = () =>
    run(async () => {
      await core.trashItem(id);
      haptics.success();
      push('success', t('items.movedToTrash'));
      nav.back();
    });

  const keepCopy = () =>
    run(async () => {
      await core.resolveConflict(id, 'copy');
      push('success', t('detail.conflictResolved'));
      await load();
    });

  const deleteCopy = () =>
    run(async () => {
      await core.resolveConflict(id, 'original');
      push('success', t('detail.conflictResolved'));
      nav.back();
    });

  return {
    item,
    original,
    missing,
    password,
    history,
    toggleReveal,
    copy,
    openUrl,
    toggleHistory,
    copyHistory,
    clearHistory,
    unlinkApp,
    moveToTrash,
    keepCopy,
    deleteCopy,
  };
}
