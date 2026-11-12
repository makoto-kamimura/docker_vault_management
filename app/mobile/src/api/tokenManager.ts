// Device token handling: challenge -> VaultCore.signAuthChallenge -> token (spec §13.3 / §15).
import type { VaultCore } from '@localvault/core';
import type { ApiClient, TokenSource } from './client';

export type TokenManager = TokenSource & { clear(): void };

export function createTokenManager(deps: {
  api: Pick<ApiClient, 'call'>;
  core: Pick<VaultCore, 'signAuthChallenge' | 'getAccountInfo'>;
  now?: () => number;
  /** Refresh this long before expiry. */
  skewMs?: number;
}): TokenManager {
  const now = deps.now ?? Date.now;
  const skewMs = deps.skewMs ?? 30_000;
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const { deviceId } = await deps.core.getAccountInfo();
    const { challenge } = await deps.api.call('authChallenge', { body: { deviceId } });
    const signed = await deps.core.signAuthChallenge(challenge);
    const res = await deps.api.call('authToken', {
      body: { deviceId: signed.deviceId, challenge, sig: signed.sig },
    });
    cached = { token: res.accessToken, expiresAtMs: Date.parse(res.expiresAt) };
    return res.accessToken;
  }

  return {
    async getToken() {
      if (cached && cached.expiresAtMs - skewMs > now()) return cached.token;
      // Single flight: concurrent callers share one challenge round trip.
      inflight ??= fetchToken().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      cached = null;
    },
    clear() {
      cached = null;
    },
  };
}
