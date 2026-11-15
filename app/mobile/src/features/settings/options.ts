import type {
  AutoLockSec,
  ClipboardClearSec,
  PcSessionMaxSec,
  RecoveryWaitSec,
} from '@localvault/core';
import type { MessageKey } from '../../i18n';

export type Option<V> = { value: V; label: MessageKey };

export const AUTO_LOCK_OPTIONS: readonly Option<AutoLockSec>[] = [
  { value: 0, label: 'set.autoLock.0' },
  { value: 30, label: 'set.autoLock.30' },
  { value: 60, label: 'set.autoLock.60' },
  { value: 300, label: 'set.autoLock.300' },
];

export const CLIPBOARD_OPTIONS: readonly Option<ClipboardClearSec>[] = [
  { value: 30, label: 'set.clip.30' },
  { value: 60, label: 'set.clip.60' },
  { value: 120, label: 'set.clip.120' },
  { value: null, label: 'set.clip.never' },
];

export const PC_SESSION_OPTIONS: readonly Option<PcSessionMaxSec>[] = [
  { value: 0, label: 'set.pcSession.0' },
  { value: 900, label: 'set.pcSession.900' },
  { value: 3600, label: 'set.pcSession.3600' },
  { value: 28800, label: 'set.pcSession.28800' },
];

export const RC_WAIT_OPTIONS: readonly Option<RecoveryWaitSec>[] = [
  { value: 86400, label: 'rc.wait.24' },
  { value: 172800, label: 'rc.wait.48' },
  { value: 259200, label: 'rc.wait.72' },
];

export function labelFor<V>(options: readonly Option<V>[], value: V): MessageKey | undefined {
  return options.find((o) => o.value === value)?.label;
}
