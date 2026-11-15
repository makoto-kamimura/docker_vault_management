// Devices: list, PC pairing (§8.3), revocation with chunked key rotation (§8.8, G12).
import {
  type DeviceInfo,
  type PairingInfo,
  type ServerRequest,
  type VaultCore,
  VaultCoreError,
} from '@localvault/core';
import type { ApiClient } from '../../api';
import { FLAGS, type FlagStore } from '../../lib/flagStore';

export type DeviceRow = DeviceInfo & { lastSeenAt: string | null };

export type DeviceLists = { active: DeviceRow[]; revoked: DeviceRow[]; serverReachable: boolean };

/** Local trust list (names) merged with the server's last-seen times. Offline is tolerated. */
export async function loadDevices(core: VaultCore, api: ApiClient): Promise<DeviceLists> {
  const [local, server] = await Promise.all([
    core.listDevices(),
    api
      .call('listDevices')
      .then((r) => r.devices)
      .catch(() => null),
  ]);
  const seen = new Map(server?.map((d) => [d.deviceId, d.lastSeenAt]) ?? []);
  const rows: DeviceRow[] = local.map((d) => ({
    ...d,
    lastSeenAt: seen.get(d.deviceId) ?? null,
  }));
  const byRecent = (a: DeviceRow, b: DeviceRow) => Date.parse(b.addedAt) - Date.parse(a.addedAt);
  return {
    active: rows
      .filter((d) => d.revokedAt === null)
      .sort((a, b) =>
        a.isThisDevice === b.isThisDevice ? byRecent(a, b) : a.isThisDevice ? -1 : 1,
      ),
    revoked: rows.filter((d) => d.revokedAt !== null).sort(byRecent),
    serverReachable: server !== null,
  };
}

/** True when no other approver phone could still unlock a PC (sign-out warning, FR-111). */
export function isLastApprover(devices: DeviceInfo[]): boolean {
  return !devices.some((d) => d.type === 'mobile' && d.revokedAt === null && !d.isThisDevice);
}

// ---------------------------------------------------------------- pairing

const BROWSER_LABEL: Record<string, string> = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' };

/** The PC's OS is not part of the pairing record (decision: no protocol change), so the default is "Chrome（PC）"; the user can edit it. */
export function defaultDeviceName(platform: string): string {
  return `${BROWSER_LABEL[platform] ?? platform}（PC）`;
}

export function normalizeOrigin(s: string): string {
  return s.trim().replace(/\/+$/, '').toLowerCase();
}

export type PairPreview = { pairing: PairingInfo; fingerprint: string; defaultName: string };

/** QR -> origin check -> server lookup. The fingerprint itself is verified inside VaultCore. */
export async function preparePairing(
  core: VaultCore,
  api: ApiClient,
  qr: string,
): Promise<PairPreview> {
  const parsed = await core.parsePairingQr(qr);
  const account = await core.getAccountInfo();
  if (normalizeOrigin(parsed.serverOrigin) !== normalizeOrigin(account.serverUrl)) {
    throw new VaultCoreError('E_SERVER_MISMATCH');
  }
  const p = await api.call('getPairing', { params: { id: parsed.pairingId } });
  return {
    pairing: {
      pairingId: p.pairingId,
      deviceId: p.deviceId,
      platform: p.platform,
      signPub: p.signPub,
      ephPub: p.ephPub,
    },
    fingerprint: parsed.fingerprint,
    defaultName: defaultDeviceName(p.platform),
  };
}

export function validDeviceName(name: string): boolean {
  const n = name.trim();
  return n.length >= 1 && n.length <= 64;
}

export async function confirmPairing(
  deps: { core: VaultCore; api: ApiClient; syncAfter?: () => Promise<void> },
  preview: PairPreview,
  name: string,
): Promise<void> {
  const request = await deps.core.approvePairing({
    pairing: preview.pairing,
    fingerprint: preview.fingerprint,
    name: name.trim(),
  });
  await deps.api.sendServerRequest(request);
  await deps.syncAfter?.().catch(() => undefined);
}

// ---------------------------------------------------------------- revocation + rotation

export type RotationProgress =
  | { phase: 'revoke' }
  | { phase: 'start' }
  | { phase: 'staging'; done: number; total: number }
  | { phase: 'commit'; done: number; total: number }
  | { phase: 'finish' };

export type RevokeDeps = {
  core: VaultCore;
  api: ApiClient;
  store: FlagStore;
  syncAfter?: () => Promise<void>;
  onProgress?: (p: RotationProgress) => void;
};

/** `revoked`: the device is already revoked on the server when the rotation part failed. */
export class RevokeFlowError extends Error {
  override readonly name = 'RevokeFlowError';
  constructor(
    readonly stage: 'revoke' | 'rotation',
    readonly revoked: boolean,
    override readonly cause: unknown,
  ) {
    super(stage);
  }
}

const NIL_ID = '00000000-0000-4000-8000-000000000000';
const isRotationsPost = (r: ServerRequest) => r.method === 'POST' && r.path === '/v1/rotations';
const isCommit = (r: ServerRequest) => r.method === 'POST' && /\/commit$/.test(r.path);

export async function recoveryCodeEnabled(api: ApiClient): Promise<boolean> {
  try {
    return (await api.call('getRecoveryCode')).enabled;
  } catch {
    return false;
  }
}

export async function revokeDeviceFlow(
  deps: RevokeDeps,
  p: { deviceId: string; rotateKey: boolean; masterPassword?: string },
): Promise<{ rotated: boolean; rcWasEnabled: boolean }> {
  const rcWasEnabled = await recoveryCodeEnabled(deps.api);
  deps.onProgress?.({ phase: 'revoke' });
  let requests: ServerRequest[];
  try {
    requests = await deps.core.revokeDevice(p);
  } catch (e) {
    throw new RevokeFlowError('revoke', false, e);
  }

  if (!p.rotateKey) {
    try {
      for (const r of requests) await deps.api.sendServerRequest(r);
    } catch (e) {
      throw new RevokeFlowError('revoke', false, e);
    }
    await deps.syncAfter?.().catch(() => undefined);
    return { rotated: false, rcWasEnabled };
  }

  const last = requests[requests.length - 1];
  if (!last || !isRotationsPost(last)) {
    throw new RevokeFlowError('revoke', false, new VaultCoreError('E_INVALID_INPUT'));
  }
  let rotationId: string;
  try {
    for (const r of requests.slice(0, -1)) await deps.api.sendServerRequest(r);
  } catch (e) {
    throw new RevokeFlowError('revoke', false, e);
  }
  try {
    deps.onProgress?.({ phase: 'start' });
    const created = (await deps.api.sendServerRequest(last)) as { rotationId: string };
    rotationId = created.rotationId;
  } catch (e) {
    // The device is revoked, the key was not rotated; VaultCore still holds the pending rotation.
    await safeAbort(deps, NIL_ID);
    throw new RevokeFlowError('rotation', true, e);
  }
  await deps.store.set(FLAGS.rotationId, rotationId);
  try {
    await runRotation(deps, rotationId);
  } catch (e) {
    throw new RevokeFlowError('rotation', true, e);
  }
  await deps.syncAfter?.().catch(() => undefined);
  return { rotated: true, rcWasEnabled };
}

/** Steps 2 and 3 of a rotation; any failure before the commit succeeded aborts it. */
async function runRotation(deps: RevokeDeps, rotationId: string): Promise<void> {
  let committed = false;
  let uncertain = false;
  try {
    const steps = await deps.core.continueRotation(rotationId);
    const total = steps.length;
    let cursor: number | null = null;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as ServerRequest;
      deps.onProgress?.({ phase: isCommit(step) ? 'commit' : 'staging', done: i, total });
      try {
        const res = await deps.api.sendServerRequest(step);
        if (isCommit(step)) {
          committed = true;
          cursor = (res as { cursor: number }).cursor;
        }
      } catch (e) {
        // A lost commit response may still have been applied: keep the rotation resumable.
        if (isCommit(step) && isNetworkLoss(e)) uncertain = true;
        throw e;
      }
      deps.onProgress?.({ phase: isCommit(step) ? 'commit' : 'staging', done: i + 1, total });
    }
    if (cursor === null) throw new VaultCoreError('E_INVALID_INPUT');
    deps.onProgress?.({ phase: 'finish' });
    await deps.core.confirmRotation({ cursor });
    await deps.store.remove(FLAGS.rotationId);
  } catch (e) {
    if (!committed && !uncertain) await safeAbort(deps, rotationId);
    throw e;
  }
}

function isNetworkLoss(e: unknown): boolean {
  return e instanceof Error && e.name === 'NetworkError';
}

async function safeAbort(deps: Pick<RevokeDeps, 'core' | 'api' | 'store'>, id: string) {
  try {
    const req = await deps.core.abortRotation(id);
    await deps.api.sendServerRequest(req).catch(() => undefined);
  } catch {
    // best effort: the server drops stale rotations after 15 minutes anyway
  }
  await deps.store.remove(FLAGS.rotationId).catch(() => undefined);
}

// ---------------------------------------------------------------- resume at app start

export async function pendingRotation(
  core: VaultCore,
  store: FlagStore,
): Promise<{ rotationId: string | null } | null> {
  if (!(await core.isRotationPending())) return null;
  return { rotationId: await store.get<string>(FLAGS.rotationId) };
}

export async function resumeRotationFlow(deps: RevokeDeps, rotationId: string): Promise<void> {
  deps.onProgress?.({ phase: 'start' });
  await runRotation(deps, rotationId);
  await deps.syncAfter?.().catch(() => undefined);
}

export async function abortRotationFlow(
  deps: Pick<RevokeDeps, 'core' | 'api' | 'store'>,
  rotationId: string | null,
): Promise<void> {
  await safeAbort(deps, rotationId ?? NIL_ID);
}

export function rotationPercent(p: RotationProgress | null): number {
  if (!p) return 0;
  switch (p.phase) {
    case 'revoke':
      return 0.03;
    case 'start':
      return 0.06;
    case 'staging':
    case 'commit':
      return 0.06 + 0.9 * (p.total === 0 ? 1 : p.done / p.total);
    case 'finish':
      return 0.98;
  }
}
