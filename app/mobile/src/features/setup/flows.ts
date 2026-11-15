// Setup flows as plain async functions over VaultCore + API (testable without React).
import type { VaultCore } from '@localvault/core';
import { defaultProvider, parseRecoveryKey } from '@localvault/core';
import {
  ApiError,
  type Keyset,
  normalizeAccountName,
  parseKitQr,
  parseRcQr,
  QrParseError,
} from '@localvault/protocol';
import type { ApiClient } from '../../api';
import { checkServerUrl } from '../../api';
import { allowInsecureLocalhost } from '../../env';

export type MakeApi = (origin: string) => ApiClient;

export class FlowInputError extends Error {
  override readonly name = 'FlowInputError';
  constructor(readonly field: 'accountName' | 'serverUrl' | 'qr') {
    super(field);
  }
}

export type CreateProgress = 'keys' | 'register';

export async function createAccountFlow(deps: {
  core: VaultCore;
  makeApi: MakeApi;
  serverUrl: string;
  accountName: string;
  masterPassword: string;
  inviteCode: string;
  onProgress?: (step: CreateProgress) => void;
}): Promise<{ recoveryKey: string }> {
  const name = normalizeAccountName(deps.accountName);
  if (!name.ok) throw new FlowInputError('accountName');
  deps.onProgress?.('keys');
  const { request, recoveryKey } = await deps.core.createAccount({
    serverUrl: deps.serverUrl,
    accountName: name.name,
    masterPassword: deps.masterPassword,
    inviteCode: deps.inviteCode.trim(),
  });
  deps.onProgress?.('register');
  try {
    await deps.makeApi(deps.serverUrl).sendServerRequest(request);
  } catch (e) {
    await deps.core.discardPendingAccount();
    throw e;
  }
  await deps.core.commitAccount();
  return { recoveryKey };
}

export type RestoreProgress = 'verify' | 'keys' | 'sync';

export async function restoreAccountFlow(deps: {
  core: VaultCore;
  makeApi: MakeApi;
  serverUrl: string;
  accountName: string;
  masterPassword: string;
  recoveryKey: string;
  onProgress?: (step: RestoreProgress) => void;
}): Promise<void> {
  const name = normalizeAccountName(deps.accountName);
  if (!name.ok) throw new FlowInputError('accountName');
  // Check characters first: a typo must not cost a server round trip (§5.5).
  await parseRecoveryKey(defaultProvider(), deps.recoveryKey);

  const api = deps.makeApi(deps.serverUrl);
  deps.onProgress?.('verify');
  // prelogin takes the lower-cased name (W2 interpretation).
  const pre = await api.call('prelogin', { query: { account: name.name } });
  deps.onProgress?.('keys');
  const authKey = await deps.core.deriveAuthKey({
    accountId: pre.accountId,
    kdf: pre.kdf,
    masterPassword: deps.masterPassword,
    recoveryKey: deps.recoveryKey,
  });
  const request = await deps.core.buildRecoverRequest({ accountName: name.name, authKey });
  const res = (await api.sendServerRequest(request)) as { keyset: Keyset };
  await deps.core.restoreAccount({
    serverUrl: deps.serverUrl,
    accountName: name.name,
    accountId: pre.accountId,
    keyset: res.keyset,
    masterPassword: deps.masterPassword,
    recoveryKey: deps.recoveryKey,
  });
  deps.onProgress?.('sync');
}

/** Parses an emergency-kit QR (`lvkit:v1?…`). */
export function parseKitScan(data: string) {
  try {
    return parseKitQr(data, { allowInsecureLocalhost });
  } catch (e) {
    if (e instanceof QrParseError) throw new FlowInputError('qr');
    throw e;
  }
}

export type ClaimStart = { claimId: string; availableAt: string; accountName: string };

export async function startClaimFlow(deps: {
  core: VaultCore;
  makeApi: MakeApi;
  source:
    | { kind: 'qr'; data: string }
    | { kind: 'manual'; serverUrl: string; accountName: string; text: string };
}): Promise<ClaimStart> {
  let origin: string;
  let started: Awaited<ReturnType<VaultCore['startRecoveryClaim']>>;
  if (deps.source.kind === 'qr') {
    let parsed: ReturnType<typeof parseRcQr>;
    try {
      parsed = parseRcQr(deps.source.data, { allowInsecureLocalhost });
    } catch (e) {
      if (e instanceof QrParseError) throw new FlowInputError('qr');
      throw e;
    }
    origin = parsed.serverUrl;
    started = await deps.core.startRecoveryClaim({ qr: deps.source.data });
  } else {
    const url = checkServerUrl(deps.source.serverUrl);
    if (!url.ok) throw new FlowInputError('serverUrl');
    const name = normalizeAccountName(deps.source.accountName);
    if (!name.ok) throw new FlowInputError('accountName');
    origin = url.origin;
    const pre = await deps.makeApi(origin).call('prelogin', { query: { account: name.name } });
    started = await deps.core.startRecoveryClaim({
      serverUrl: origin,
      accountId: pre.accountId,
      text: deps.source.text.trim(),
    });
  }
  const res = (await deps.makeApi(origin).sendServerRequest(started.request)) as {
    claimId: string;
    claimToken: string;
    availableAt: string;
    accountName: string;
  };
  await deps.core.rememberRecoveryClaim({
    claimId: res.claimId,
    claimToken: res.claimToken,
    availableAt: res.availableAt,
  });
  return { claimId: res.claimId, availableAt: res.availableAt, accountName: res.accountName };
}

export type ClaimPoll = { status: 'waiting'; availableAt: string | null } | { status: 'completed' };

/** Tries to complete the pending recovery claim (§8.11.4). Waiting is a normal outcome. */
export async function pollClaimFlow(deps: {
  core: VaultCore;
  makeApi: MakeApi;
}): Promise<ClaimPoll> {
  const pending = await deps.core.getPendingRecoveryClaim();
  if (!pending) throw new FlowInputError('qr');
  try {
    const request = await deps.core.buildCompleteRecoveryClaim();
    const res = await deps.makeApi(pending.serverUrl).sendServerRequest(request);
    await deps.core.completeRecoveryClaim(res as Parameters<VaultCore['completeRecoveryClaim']>[0]);
    return { status: 'completed' };
  } catch (e) {
    const waitingAt = claimWaitingAt(e);
    if (waitingAt !== undefined) return { status: 'waiting', availableAt: waitingAt };
    throw e;
  }
}

function claimWaitingAt(e: unknown): string | null | undefined {
  if (e instanceof ApiError && e.code === 'E_CLAIM_WAITING') {
    const v = e.details?.availableAt;
    return typeof v === 'string' ? v : null;
  }
  if (
    e &&
    typeof e === 'object' &&
    'code' in e &&
    (e as { code: unknown }).code === 'E_CLAIM_WAITING'
  ) {
    const v = (e as { details?: { availableAt?: string } }).details?.availableAt;
    return v ?? null;
  }
  return undefined;
}

export async function setNewPasswordAfterRecoveryFlow(deps: {
  core: VaultCore;
  makeApi: MakeApi;
  serverUrl: string;
  newPassword: string;
}): Promise<{ recoveryKey: string }> {
  const api = deps.makeApi(deps.serverUrl);
  const setReq = await deps.core.setMasterPasswordAfterCodeRecovery(deps.newPassword);
  await api.sendServerRequest(setReq);
  await deps.core.confirmKeysetAccepted();
  // The old recovery key is unknown to this user: issue a fresh one for the new emergency kit.
  const regen = await deps.core.regenerateRecoveryKey(deps.newPassword);
  await api.sendServerRequest(regen.request);
  await deps.core.confirmKeysetAccepted();
  return { recoveryKey: regen.recoveryKey };
}
