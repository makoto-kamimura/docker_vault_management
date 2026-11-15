import { describe, expect, it } from 'vitest';
import { type GuardInput, resolveGuard } from '../src/features/navigation/guard';

const g = (o: Partial<GuardInput>) =>
  resolveGuard({
    lockState: 'unlocked',
    standing: 'ok',
    segments: ['(app)'],
    setupInProgress: false,
    ...o,
  });

describe('route guard', () => {
  it('waits while the lock state is unknown', () => {
    expect(g({ lockState: 'unknown', segments: ['(app)'] })).toBeNull();
  });
  it('sends uninitialised users to /setup', () => {
    expect(g({ lockState: 'uninitialized', segments: ['(app)'] })).toBe('/setup');
    expect(g({ lockState: 'uninitialized', segments: ['(locked)', 'unlock'] })).toBe('/setup');
    expect(g({ lockState: 'uninitialized', segments: ['(setup)', 'setup', 'server'] })).toBeNull();
  });
  it('sends locked users to /unlock but lets /approve through', () => {
    expect(g({ lockState: 'locked', segments: ['(app)'] })).toBe('/unlock');
    expect(g({ lockState: 'locked', segments: ['(app)', 'item', '[id]'] })).toBe('/unlock');
    expect(g({ lockState: 'locked', segments: ['(locked)', 'unlock'] })).toBeNull();
    expect(g({ lockState: 'locked', segments: ['(app)', 'approve', '[requestId]'] })).toBeNull();
    expect(g({ lockState: 'locked', segments: ['(setup)', 'setup'] })).toBe('/unlock');
  });
  it('keeps unlocked users out of /unlock and out of setup unless a flow is running', () => {
    expect(g({ segments: ['(locked)', 'unlock'] })).toBe('/');
    expect(g({ segments: ['(setup)', 'setup', 'server'] })).toBe('/');
    expect(g({ segments: ['(setup)', 'setup', 'biometrics'], setupInProgress: true })).toBeNull();
    expect(g({ segments: ['(app)'] })).toBeNull();
  });
  it('shows /revoked for revoked or deleted devices in any lock state', () => {
    for (const lockState of ['locked', 'unlocked', 'uninitialized'] as const) {
      expect(g({ lockState, standing: 'revoked', segments: ['(app)'] })).toBe('/revoked');
      expect(
        g({ lockState, standing: 'accountDeleted', segments: ['(locked)', 'revoked'] }),
      ).toBeNull();
    }
  });
  it('does not leave /revoked-only state reachable when standing is ok', () => {
    expect(g({ lockState: 'locked', segments: ['(locked)', 'revoked'] })).toBe('/unlock');
    expect(g({ lockState: 'uninitialized', segments: ['(locked)', 'revoked'] })).toBe('/setup');
  });
});
