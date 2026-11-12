import { useEffect, useState } from 'react';
import { Banner } from '../../components';
import { t } from '../../i18n';
import { FLAGS, getFlagStore } from '../../lib/flagStore';
import { nav } from '../../lib/nav';
import { useApprovalsStore } from '../../state/approvalsStore';
import { useSession } from '../session/SessionProvider';
import { usePendingTarget } from './pendingRoute';

const BACKUP_NUDGE_DAYS = 90;

/**
 * Banners for the list screen (spec §14 "バナー"): pending approvals, recovery sheet not yet
 * confirmed (FR-106), export overdue (FR-53). The list screen (W4a) mounts `<HomeBanners />`.
 */
export function HomeBanners() {
  const { core } = useSession();
  const pending = useApprovalsStore((s) => s.pendingCount);
  const target = usePendingTarget((s) => s.route);
  const [sheetUnconfirmed, setSheetUnconfirmed] = useState(false);
  const [exportOverdue, setExportOverdue] = useState(false);

  useEffect(() => {
    let alive = true;
    getFlagStore()
      .get<boolean>(FLAGS.rcSheetUnconfirmed)
      .then((v) => alive && setSheetUnconfirmed(v === true))
      .catch(() => undefined);
    core
      .getBackupInfo()
      .then((b) => {
        if (!alive) return;
        const last = b.lastExportAt === null ? null : Date.parse(b.lastExportAt);
        setExportOverdue(last === null || Date.now() - last > BACKUP_NUDGE_DAYS * 86_400_000);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [core]);

  return (
    <>
      {pending > 0 && (
        <Banner
          kind="warning"
          message={t('banner.pending', { n: pending })}
          actionLabel={t('banner.pendingAction')}
          onAction={() => nav.push(target ?? '/devices')}
        />
      )}
      {sheetUnconfirmed && (
        <Banner
          kind="warning"
          message={t('banner.rcSheet')}
          actionLabel={t('banner.rcSheetAction')}
          onAction={() => nav.push('/settings/recovery-code')}
        />
      )}
      {exportOverdue && (
        <Banner
          kind="info"
          message={t('banner.export')}
          actionLabel={t('banner.exportAction')}
          onAction={() => nav.push('/settings/backup')}
        />
      )}
    </>
  );
}
