import type { ItemSummary } from '@localvault/core';
import { useCallback, useEffect, useState } from 'react';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { getVaultCoreHandle } from '../../native/VaultCore';
import { useToastStore } from '../../state/toastStore';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';
import { trashedOnly } from './model';

export function useTrash() {
  const { core } = useSession();
  const push = useToastStore((s) => s.push);
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(trashedOnly(await core.listItems({ includeTrashed: true })));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [core]);

  useEffect(() => {
    void load();
    return getVaultCoreHandle().on('onVaultChanged', () => void load());
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<void>, ok: string) => {
      try {
        await fn();
        haptics.success();
        push('success', ok);
        await load();
      } catch (e) {
        haptics.error();
        push('error', describeError(e));
      }
    },
    [load, push],
  );

  return {
    items,
    failed,
    reload: load,
    restore: (id: string) => act(() => core.restoreItem(id), t('trash.restored')),
    purge: (id: string) => act(() => core.purgeItem(id), t('trash.deleted')),
    emptyAll: () =>
      act(async () => {
        for (const i of items ?? []) await core.purgeItem(i.id);
      }, t('trash.emptied')),
  };
}
