// W4b additions to FakeVaultCore (devices, approvals, rotation, recovery code, backup, account).
// Installed onto the prototype from FakeVaultCore.ts; state lives in a WeakMap so the class stays
// untouched. Still NOT secure: it does no cryptography.
import {
  type DeviceInfo,
  type PendingUnlockRequest,
  type ServerRequest,
  type TrustedBrowser,
  type VaultCore,
  VaultCoreError,
} from '@localvault/core';
import { fakeB64, fakeId, fakeKeyset } from './FakeVaultCore';

export type W4bState = {
  devices: DeviceInfo[];
  /** Verdict `verifyUnlockRequest` returns. */
  verdict: Awaited<ReturnType<VaultCore['verifyUnlockRequest']>>;
  /** Remaining code attempts; `typedCode !== request.payload.code` decrements. */
  attemptsLeft: number;
  rotationPending: boolean;
  /** Number of staging uploads `continueRotation` returns before the commit. */
  stagingChunks: number;
  rotationId: string | null;
  confirmedCursor: number | null;
  aborted: string[];
  revokeCalls: { deviceId: string; rotateKey: boolean; masterPassword?: string }[];
  browsers: TrustedBrowser[];
  lastExportAt: string | null;
  exportDeleted: string[];
  csv: { format: 'chrome'; itemCount: number; duplicateCount: number; skippedCount: number };
  signedOut: number;
};

const states = new WeakMap<object, W4bState>();

export function w4b(core: object): W4bState {
  let s = states.get(core);
  if (!s) {
    s = {
      devices: [],
      verdict: { ok: true, deviceName: 'Chrome（PC）' },
      attemptsLeft: 3,
      rotationPending: false,
      stagingChunks: 2,
      rotationId: null,
      confirmedCursor: null,
      aborted: [],
      revokeCalls: [],
      browsers: [{ packageName: 'com.android.chrome', label: 'Chrome', builtIn: true }],
      lastExportAt: null,
      exportDeleted: [],
      csv: { format: 'chrome', itemCount: 10, duplicateCount: 2, skippedCount: 1 },
      signedOut: 0,
    };
    states.set(core, s);
  }
  return s;
}

const req = (method: ServerRequest['method'], path: string, body?: unknown): ServerRequest => ({
  method,
  path,
  ...(body === undefined ? {} : { body }),
  headers: { 'X-LV-Admin': 'fake' },
});

type Core = VaultCore & object;

const methods = {
  async listDevices(this: Core) {
    return w4b(this).devices;
  },
  async renameDevice(this: Core, deviceId: string, name: string) {
    const d = w4b(this).devices.find((x) => x.deviceId === deviceId);
    if (!d) throw new VaultCoreError('E_NOT_FOUND');
    d.name = name;
  },
  async parsePairingQr(this: Core, qr: string) {
    const m = /^lvpair:v1\?s=([^&]+)&p=([^&]+)&f=([^&]+)$/.exec(qr);
    if (!m) throw new VaultCoreError('E_INVALID_INPUT');
    return {
      pairingId: m[2] as string,
      serverOrigin: decodeURIComponent(m[1] as string),
      fingerprint: m[3] as string,
    };
  },
  async approvePairing(
    this: Core,
    p: { pairing: { pairingId: string }; fingerprint: string; name: string },
  ) {
    if (p.fingerprint === 'bad') throw new VaultCoreError('E_FINGERPRINT_MISMATCH');
    return req('POST', `/v1/pairings/${p.pairing.pairingId}/approve`, {
      response: { epk: fakeB64(65), nonce: fakeB64(12), ct: fakeB64(48) },
    });
  },
  async verifyUnlockRequest(this: Core) {
    return w4b(this).verdict;
  },
  async approveUnlock(this: Core, p: { request: PendingUnlockRequest; typedCode: string }) {
    const s = w4b(this);
    if (p.typedCode !== p.request.payload.code) {
      s.attemptsLeft -= 1;
      throw new VaultCoreError('E_CODE_MISMATCH', 'mismatch', { attemptsLeft: s.attemptsLeft });
    }
    return req('POST', `/v1/unlock-requests/${p.request.requestId}/approve`, {
      response: { epk: fakeB64(65), nonce: fakeB64(12), ct: fakeB64(48) },
    });
  },
  async revokeDevice(
    this: Core,
    p: { deviceId: string; rotateKey: boolean; masterPassword?: string },
  ) {
    const s = w4b(this);
    s.revokeCalls.push(p);
    if (p.rotateKey && !p.masterPassword) throw new VaultCoreError('E_NEEDS_MASTER_PASSWORD');
    const out = [req('DELETE', `/v1/devices/${p.deviceId}`)];
    if (p.rotateKey) {
      s.rotationPending = true;
      out.push(req('POST', '/v1/rotations', { expectedRev: 1, newVkVersion: 2 }));
    }
    return out;
  },
  async continueRotation(this: Core, rotationId: string) {
    const s = w4b(this);
    s.rotationId = rotationId;
    const steps: ServerRequest[] = [];
    for (let i = 0; i < s.stagingChunks; i++) {
      steps.push({
        method: 'PUT',
        path: `/v1/rotations/${rotationId}/records`,
        body: { records: [{ id: fakeId(), deleted: true, nonce: null, ct: null }] },
      });
    }
    steps.push(
      req('POST', `/v1/rotations/${rotationId}/commit`, {
        keyset: { ...fakeKeyset(), keysetVersion: 2, vkVersion: 2 },
        verifier: fakeB64(32),
        recordCount: s.stagingChunks,
      }),
    );
    return steps;
  },
  async confirmRotation(this: Core, r: { cursor: number }) {
    const s = w4b(this);
    s.confirmedCursor = r.cursor;
    s.rotationPending = false;
  },
  async abortRotation(this: Core, rotationId: string) {
    const s = w4b(this);
    s.aborted.push(rotationId);
    s.rotationPending = false;
    return { method: 'DELETE' as const, path: `/v1/rotations/${rotationId}` };
  },
  async isRotationPending(this: Core) {
    return w4b(this).rotationPending;
  },
  async issueRecoveryCode(this: Core, p: { waitSec: number }) {
    return {
      request: req('PUT', '/v1/recovery-code', {
        rcId: fakeB64(16),
        verifier: fakeB64(32),
        wrappedVK: { nonce: fakeB64(12), ct: fakeB64(48) },
        vkVersion: 1,
        waitSec: p.waitSec,
      }),
      sheet: {
        qr: 'lvrc:v1?s=fake&a=fake&c=fake',
        text: 'LVRC-ABCDEF-GHJKMN-PQRSTV-WXYZ01-234567-89ABCD-EFGHJK-MNPQRS-TVWXYZ',
      },
    };
  },
  async buildSetRecoveryWait(this: Core, waitSec: number) {
    return req('PUT', '/v1/recovery-code/wait-period', { waitSec });
  },
  async buildRevokeRecoveryCode(this: Core) {
    return req('DELETE', '/v1/recovery-code');
  },
  async buildCancelRecoveryClaim(this: Core, id: string) {
    return req('POST', `/v1/recovery-claims/${id}/cancel`, {});
  },
  async buildApproveRecoveryClaimNow(this: Core, id: string) {
    return req('POST', `/v1/recovery-claims/${id}/approve-now`, {});
  },
  async changeMasterPassword(this: Core, current: string) {
    if (current !== 'correct horse battery') throw new VaultCoreError('E_WRONG_PASSWORD');
    return req('PUT', '/v1/keyset', {
      keyset: { ...fakeKeyset(), keysetVersion: 2 },
      verifier: fakeB64(32),
    });
  },
  async resetMasterPassword(this: Core) {
    return req('PUT', '/v1/keyset', {
      keyset: { ...fakeKeyset(), keysetVersion: 2 },
      verifier: fakeB64(32),
    });
  },
  async buildDeleteAccount(this: Core) {
    return req('DELETE', '/v1/account');
  },
  async buildSignOutDevice(this: Core) {
    w4b(this).signedOut += 1;
    const info = await this.getAccountInfo();
    return [req('DELETE', `/v1/devices/${info.deviceId}`)];
  },
  async getRecoveryKey(this: Core) {
    return 'LV2-7J4K-9PQ2-X8MD-T3VW-R5NB-H6CY-0ZEA';
  },
  async changeServerUrl(this: Core) {},
  async exportVault(this: Core) {
    w4b(this).lastExportAt = new Date().toISOString();
    return { fileUri: 'file:///tmp/fake.lvbackup' };
  },
  async deleteExportFile(this: Core, uri: string) {
    w4b(this).exportDeleted.push(uri);
  },
  async inspectImport(this: Core, _uri: string, password: string) {
    if (password !== 'export-password') throw new VaultCoreError('E_IMPORT_FORMAT');
    return { itemCount: 12, conflictCount: 3 };
  },
  async importVault(this: Core) {
    return { added: 9, updated: 3 };
  },
  async inspectCsvImport(this: Core) {
    return w4b(this).csv;
  },
  async importCsv(this: Core, _uri: string, o: { skipDuplicates: boolean }) {
    const c = w4b(this).csv;
    return {
      added: o.skipDuplicates ? c.itemCount - c.duplicateCount : c.itemCount,
      skipped: c.skippedCount,
    };
  },
  async getBackupInfo(this: Core) {
    return { lastExportAt: w4b(this).lastExportAt };
  },
  async listTrustedBrowsers(this: Core) {
    return w4b(this).browsers;
  },
  async addTrustedBrowser(this: Core, packageName: string) {
    w4b(this).browsers.push({ packageName, label: packageName, builtIn: false });
  },
  async removeTrustedBrowser(this: Core, packageName: string) {
    const s = w4b(this);
    const b = s.browsers.find((x) => x.packageName === packageName);
    if (b?.builtIn) throw new VaultCoreError('E_INVALID_INPUT');
    s.browsers = s.browsers.filter((x) => x.packageName !== packageName);
  },
};

/** Called once from FakeVaultCore.ts (after the class exists). */
export function installW4bFake(cls: { prototype: object }): void {
  Object.assign(cls.prototype, methods);
}
