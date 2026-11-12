import type { ItemSummary } from '@localvault/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { getVaultCoreHandle } from '../../native/VaultCore';
import { useToastStore } from '../../state/toastStore';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';
import {
  buildSections,
  copiedMessage,
  flattenSections,
  HIGHLIGHT_MS,
  noticeMessage,
  type SortMode,
} from './model';
import { loadSortMode, saveSortMode } from './prefs';

export function useItemList() {
  const { core, engine } = useSession();
  const push = useToastStore((s) => s.push);
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState<SortMode>('recent');
  const [refreshing, setRefreshing] = useState(false);
  const [highlight, setHighlight] = useState<{ id: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await core.listItems());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [core]);

  useEffect(() => {
    void load();
    void loadSortMode().then(setSortState);
    const handle = getVaultCoreHandle();
    const offChanged = handle.on('onVaultChanged', () => void load());
    const offNotice = handle.on('onNotice', ({ notice }) => push('info', noticeMessage(notice)));
    // Notices queued while the list was not mounted (e.g. a sync during unlock).
    void core
      .drainNotices()
      .then((ns) => {
        for (const n of ns) push('info', noticeMessage(n));
      })
      .catch(() => undefined);
    return () => {
      offChanged();
      offNotice();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [core, load, push]);

  const setSort = useCallback((s: SortMode) => {
    setSortState(s);
    void saveSortMode(s);
  }, []);

  const rows = useMemo(
    () => flattenSections(buildSections(items ?? [], { query, sort })),
    [items, query, sort],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await engine.requestSync('manual');
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [engine, load]);

  const copy = useCallback(
    async (id: string, field: 'username' | 'password') => {
      try {
        const r = await core.copy(id, field);
        haptics.success();
        push('success', copiedMessage(r.clearsAt, Date.now()));
        if (field === 'username') {
          // FR-34: draw the eye to the password button for 10 s.
          setHighlight({ id, until: Date.now() + HIGHLIGHT_MS });
          setNow(Date.now());
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setNow(Date.now()), HIGHLIGHT_MS + 50);
        } else {
          setHighlight(null);
        }
      } catch (e) {
        haptics.error();
        push('error', describeError(e) || t('items.copyFailed'));
      }
    },
    [core, push],
  );

  const toggleFavorite = useCallback(
    async (id: string) => {
      try {
        const d = await core.getItem(id);
        await core.saveItem({
          id,
          title: d.title,
          username: d.username,
          urls: d.urls,
          notes: d.notes,
          favorite: !d.favorite,
        });
        haptics.tap();
      } catch (e) {
        push('error', describeError(e));
      }
    },
    [core, push],
  );

  const trash = useCallback(
    async (id: string) => {
      try {
        await core.trashItem(id);
        haptics.success();
        push('success', t('items.movedToTrash'));
      } catch (e) {
        push('error', describeError(e));
      }
    },
    [core, push],
  );

  return {
    loading: items === null && !failed,
    failed,
    hasAny: (items ?? []).some((i) => i.trashedAt === null),
    rows,
    query,
    setQuery,
    sort,
    setSort,
    refreshing,
    refresh,
    reload: load,
    copy,
    toggleFavorite,
    trash,
    highlight,
    now,
  };
}
