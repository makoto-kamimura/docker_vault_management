// Security log (F3, FR-95): paged audit events with device names resolved locally.
import type { DeviceInfo, VaultCore } from '@localvault/core';
import type { AuditEvent, AuditEventKind } from '@localvault/protocol';
import type { ApiClient } from '../../api';
import type { MessageKey } from '../../i18n';

export const PAGE_SIZE = 50;

export const KIND_LABEL: Record<AuditEventKind, MessageKey> = {
  account_created: 'slog.account_created',
  device_added: 'slog.device_added',
  device_revoked: 'slog.device_revoked',
  device_signed_out: 'slog.device_signed_out',
  keyset_changed: 'slog.keyset_changed',
  rotated: 'slog.rotated',
  unlock_approved: 'slog.unlock_approved',
  unlock_denied: 'slog.unlock_denied',
  rc_issued: 'slog.rc_issued',
  rc_claimed: 'slog.rc_claimed',
  rc_canceled: 'slog.rc_canceled',
  rc_approved_now: 'slog.rc_approved_now',
  rc_used: 'slog.rc_used',
  rc_frozen: 'slog.rc_frozen',
  rc_revoked: 'slog.rc_revoked',
};

export type Severity = 'normal' | 'warning' | 'danger';
export function severity(kind: AuditEventKind): Severity {
  switch (kind) {
    case 'device_revoked':
    case 'rc_frozen':
    case 'rc_claimed':
    case 'rc_used':
      return 'warning';
    case 'unlock_denied':
    case 'rc_canceled':
      return 'danger';
    default:
      return 'normal';
  }
}

export type LogPage = { events: AuditEvent[]; hasMore: boolean; nextBefore: number | null };

export async function loadAuditPage(api: ApiClient, before?: number): Promise<LogPage> {
  const r = await api.call('listAuditEvents', { query: { before, limit: PAGE_SIZE } });
  const last = r.events[r.events.length - 1];
  return { events: r.events, hasMore: r.hasMore, nextBefore: last ? last.id : null };
}

export async function deviceNameMap(core: VaultCore): Promise<Map<string, string>> {
  const list: DeviceInfo[] = await core.listDevices().catch(() => []);
  return new Map(list.map((d) => [d.deviceId, d.name]));
}
