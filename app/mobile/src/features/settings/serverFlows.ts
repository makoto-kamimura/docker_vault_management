// G14: change the server URL after proving the new server is the same account and accepts this device.
import type { VaultCore } from '@localvault/core';
import { type ApiClient, checkServerUrl, createAuthedApi } from '../../api';

export class ServerChangeError extends Error {
  override readonly name = 'ServerChangeError';
  constructor(readonly reason: 'url' | 'sameUrl' | 'otherAccount') {
    super(reason);
  }
}

export async function changeServerFlow(deps: {
  core: VaultCore;
  makeApi: (origin: string) => ApiClient;
  fetchImpl?: typeof fetch;
  input: string;
}): Promise<string> {
  const check = checkServerUrl(deps.input);
  if (!check.ok) throw new ServerChangeError('url');
  const origin = check.origin;
  const info = await deps.core.getAccountInfo();
  if (origin === info.serverUrl) throw new ServerChangeError('sameUrl');
  const pre = await deps.makeApi(origin).call('prelogin', { query: { account: info.accountName } });
  if (pre.accountId !== info.accountId) throw new ServerChangeError('otherAccount');
  // Device login against the new server (challenge -> signature -> token).
  const probe = createAuthedApi(deps.core, { baseUrl: () => origin, fetch: deps.fetchImpl });
  await probe.tokens.getToken();
  await deps.core.changeServerUrl(origin);
  return origin;
}
