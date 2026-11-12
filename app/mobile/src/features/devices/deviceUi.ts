import { Globe, Monitor, Smartphone } from 'lucide-react-native';
import type { MessageKey } from '../../i18n';
import { t } from '../../i18n';
import { formatDate, formatDateTime } from '../../lib/format';
import type { DeviceRow } from './flows';

export const deviceIcon = (d: Pick<DeviceRow, 'type' | 'platform'>) =>
  d.type === 'mobile' ? Smartphone : d.platform === 'chrome' ? Globe : Monitor;

const VIA: Record<string, MessageKey> = {
  'recovery-key': 'dev.via.recoveryKey',
  'recovery-code': 'dev.via.recoveryCode',
  pairing: 'dev.via.pairing',
  setup: 'dev.via.setup',
};

export function deviceSubtitle(d: DeviceRow): string {
  const parts = [d.type === 'mobile' ? t('dev.type.mobile') : t('dev.type.extension')];
  parts.push(t('dev.addedOn', { date: formatDate(d.addedAt) }));
  if (d.revokedAt === null) {
    parts.push(
      d.lastSeenAt ? t('dev.lastSeen', { date: formatDateTime(d.lastSeenAt) }) : t('dev.neverSeen'),
    );
  } else {
    parts.push(t('dev.revokedOn', { date: formatDate(d.revokedAt) }));
  }
  const via = d.addedVia ? VIA[d.addedVia] : undefined;
  if (via) parts.push(t(via));
  return parts.join(' ・ ');
}
