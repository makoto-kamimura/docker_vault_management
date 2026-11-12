// Recovery code (§8.11.3, FR-105..110). The RC lives only in the returned sheet; JS drops it after use.
import type { RecoverySheet, RecoveryWaitSec, VaultCore } from '@localvault/core';
import type { ApiClient } from '../../api';
import { constantTimeEqual } from '../../lib/constantTime';
import { FLAGS, type FlagStore } from '../../lib/flagStore';
import { normalizeTailInput } from '../../lib/recoveryKeyInput';

type Deps = { core: VaultCore; api: ApiClient };

export type RcStatus =
  | { enabled: false }
  | { enabled: true; createdAt: string; waitSec: RecoveryWaitSec; frozen: boolean };

export async function getRcStatus(api: ApiClient): Promise<RcStatus> {
  const r = await api.call('getRecoveryCode');
  return r.enabled
    ? {
        enabled: true,
        createdAt: r.createdAt,
        waitSec: r.waitSec as RecoveryWaitSec,
        frozen: r.frozen,
      }
    : { enabled: false };
}

/** Biometric inside VaultCore. The sheet is only returned once the server accepted the code. */
export async function issueRecoveryCodeFlow(
  { core, api }: Deps,
  store: FlagStore,
  waitSec: RecoveryWaitSec,
): Promise<RecoverySheet> {
  const { request, sheet } = await core.issueRecoveryCode({ waitSec });
  await api.sendServerRequest(request);
  // Banner on the list until the sheet is confirmed (FR-106). Only a flag is stored, never the RC.
  await store.set(FLAGS.rcSheetUnconfirmed, true);
  return sheet;
}

export async function setWaitFlow({ core, api }: Deps, waitSec: RecoveryWaitSec): Promise<void> {
  await api.sendServerRequest(await core.buildSetRecoveryWait(waitSec));
}

export async function disableRecoveryCodeFlow(
  { core, api }: Deps,
  store: FlagStore,
): Promise<void> {
  await api.sendServerRequest(await core.buildRevokeRecoveryCode());
  await store.remove(FLAGS.rcSheetUnconfirmed);
}

/** Last 6 data characters of `LVRC-XXXXXX-…` (FR-106). */
export function sheetTail(text: string): string {
  return normalizeTailInput(text.replace(/^LVRC/i, '')).slice(-6);
}

export function tailMatches(sheetText: string, typed: string): boolean {
  const t = normalizeTailInput(typed);
  return t.length === 6 && constantTimeEqual(t, sheetTail(sheetText));
}

export async function confirmSheetFlow(store: FlagStore): Promise<void> {
  await store.remove(FLAGS.rcSheetUnconfirmed);
}
