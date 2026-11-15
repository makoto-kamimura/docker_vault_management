import type { VaultCore } from '@localvault/core';
import { type ApiClient, type ApiClientOptions, createApiClient } from './client';
import { createTokenManager, type TokenManager } from './tokenManager';

export * from './client';
export * from './errors';
export * from './serverUrl';
export * from './tokenManager';

export type AuthedApi = { api: ApiClient; tokens: TokenManager };

/** API client for the signed-in account: token acquisition goes through an unauthenticated client. */
export function createAuthedApi(
  core: Pick<VaultCore, 'signAuthChallenge' | 'getAccountInfo'>,
  opts: Omit<ApiClientOptions, 'tokens'>,
  now?: () => number,
): AuthedApi {
  const plain = createApiClient(opts);
  const tokens = createTokenManager({ api: plain, core, now });
  const api = createApiClient({ ...opts, tokens });
  return { api, tokens };
}
