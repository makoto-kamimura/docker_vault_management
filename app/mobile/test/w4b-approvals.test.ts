import { type PendingUnlockRequest, VaultCoreError } from '@localvault/core';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api';
import { approveClaimNow, cancelClaim, loadClaim } from '../src/features/approvals/claimFlows';
import {
  approveUnlockRequest,
  countPending,
  loadUnlockRequest,
} from '../src/features/approvals/flows';
import { routeForNotification } from '../src/features/approvals/notificationRoute';
import { resolveGuard } from '../src/features/navigation/guard';
import { FakeVaultCore, fakeB64, fakeId } from '../src/native/fake/FakeVaultCore';
import { w4b } from '../src/native/fake/w4bFake';
import { apiError, json, makeFetch } from './helpers';

const iso = (ms: number) => new Date(ms).toISOString();
const sig = fakeB64(64);
function pending(code = '42', expiresInMs = 60_000): PendingUnlockRequest {
  return {
    requestId: fakeId(),
    deviceId: fakeId(),
    expiresAt: iso(Date.now() + expiresInMs),
    payload: {
      requestNonce: fakeB64(16),
      ephPub: fakeB64(65),
      code,
      issuedAt: '2026-11-11T09:00:00Z',
      sig,
    },
  };
}
const setup = (...handlers: Parameters<typeof makeFetch>) => {
  const f = makeFetch(...handlers);
  const api = createApiClient({ baseUrl: () => 'https://v.example.com', fetch: f.fetch });
  const core = new FakeVaultCore({ lockState: 'unlocked' });
  return { ...f, api, core };
};

describe('loadUnlockRequest', () => {
  it('syncs first, then verifies', async () => {
    const r = pending();
    const order: string[] = [];
    const { api, core } = setup((c) => {
      order.push('http');
      return c.url.endsWith('/unlock-requests/pending') ? json(200, { requests: [r] }) : undefined;
    });
    const out = await loadUnlockRequest(
      { core, api, syncFirst: async () => void order.push('sync') },
      r.requestId,
    );
    expect(order).toEqual(['sync', 'http']);
    expect(out).toMatchObject({ status: 'ready', deviceName: 'Chrome（PC）' });
  });
  it('reports gone, expired and invalid', async () => {
    const expired = pending('42', -1000);
    const ok = pending();
    const { api, core } = setup(() => json(200, { requests: [expired, ok] }));
    expect((await loadUnlockRequest({ core, api }, fakeId())).status).toBe('gone');
    expect((await loadUnlockRequest({ core, api }, expired.requestId)).status).toBe('expired');
    w4b(core).verdict = { ok: false, reason: 'unknown_device' };
    expect(await loadUnlockRequest({ core, api }, ok.requestId)).toEqual({
      status: 'invalid',
      reason: 'unknown_device',
    });
  });
});

describe('approveUnlockRequest', () => {
  it('sends the built approval on the right code', async () => {
    const r = pending('42');
    const { api, core, calls } = setup(() => json(204, undefined));
    expect(await approveUnlockRequest({ core, api }, r, '42')).toEqual({ status: 'approved' });
    expect(calls[0]?.url).toContain(`/v1/unlock-requests/${r.requestId}/approve`);
  });
  it('counts down attempts and denies at zero', async () => {
    const r = pending('42');
    const { api, core, calls } = setup(() => json(204, undefined));
    expect(await approveUnlockRequest({ core, api }, r, '11')).toEqual({
      status: 'mismatch',
      attemptsLeft: 2,
    });
    expect(await approveUnlockRequest({ core, api }, r, '12')).toEqual({
      status: 'mismatch',
      attemptsLeft: 1,
    });
    expect(await approveUnlockRequest({ core, api }, r, '13')).toEqual({
      status: 'denied-after-mismatch',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/deny');
  });
  it('propagates canceled biometrics', async () => {
    const r = pending();
    const { api, core } = setup(() => json(204, undefined));
    core.approveUnlock = async () => {
      throw new VaultCoreError('E_AUTH_CANCELED');
    };
    await expect(approveUnlockRequest({ core, api }, r, '42')).rejects.toMatchObject({
      code: 'E_AUTH_CANCELED',
    });
  });
});

describe('pending count and claims', () => {
  it('counts unlock requests and waiting claims only', async () => {
    const r = pending();
    const claimId = fakeId();
    const { api } = setup((c) =>
      c.url.includes('unlock-requests/pending')
        ? json(200, { requests: [r] })
        : json(200, {
            claims: [
              { claimId, createdAt: iso(0), availableAt: iso(1), status: 'waiting' },
              { claimId: fakeId(), createdAt: iso(0), availableAt: iso(1), status: 'canceled' },
            ],
          }),
    );
    expect(await countPending(api)).toEqual({
      unlock: 1,
      claims: 1,
      firstRoute: `/approve/${r.requestId}`,
    });
  });
  it('loads a claim and builds cancel / approve-now requests', async () => {
    const id = fakeId();
    const { api, core, calls } = setup((c) =>
      c.method === 'GET'
        ? json(200, {
            claims: [{ claimId: id, createdAt: iso(0), availableAt: iso(5000), status: 'waiting' }],
          })
        : json(204, undefined),
    );
    expect((await loadClaim(api, id)).status).toBe('open');
    expect(await loadClaim(api, fakeId())).toEqual({ status: 'closed', reason: 'missing' });
    await cancelClaim(core, api, id);
    await approveClaimNow(core, api, id);
    expect(calls.map((c) => c.url.split('/').pop())).toEqual([
      'pending',
      'pending',
      'cancel',
      'approve-now',
    ]);
  });
  it('maps a server error without leaking', async () => {
    const { api } = setup(() => apiError(500, 'E_INTERNAL'));
    await expect(loadClaim(api, fakeId())).rejects.toMatchObject({ code: 'E_INTERNAL' });
  });
});

describe('notification routing and guards', () => {
  const id = fakeId();
  it('routes the three push kinds, nested or flat', () => {
    expect(routeForNotification({ t: 'unlock', r: id })).toBe(`/approve/${id}`);
    expect(routeForNotification({ content: { data: { t: 'rc_claim', r: id } } })).toBe(
      `/recovery-claim/${id}`,
    );
    expect(routeForNotification({ trigger: { payload: { t: 'rc_frozen' } } })).toBe(
      '/settings/recovery-code',
    );
    expect(routeForNotification({ content: { data: { t: 'nope' } } })).toBeNull();
    expect(routeForNotification(null)).toBeNull();
  });
  it('lets /approve through while locked but not my other routes', () => {
    const g = (segments: string[]) =>
      resolveGuard({ lockState: 'locked', standing: 'ok', segments, setupInProgress: false });
    expect(g(['(app)', 'approve', '[requestId]'])).toBeNull();
    for (const leaf of [
      ['recovery-claim', '[id]'],
      ['devices'],
      ['settings'],
      ['settings', 'account'],
    ]) {
      expect(g(['(app)', ...leaf])).toBe('/unlock');
    }
  });
});
