import { timingSafeEqual } from 'node:crypto';
import {
  ADMIN_HEADER,
  AUTHKEY_HEADER,
  type AuthKind,
  HeaderParseError,
  parseAuthorization,
} from '@localvault/protocol';
import type { Clock } from '../clock';
import { fromB64, sha256 } from '../crypto';
import type { Database } from '../db/client';
import { fail } from '../errors';
import { verifyAdminSignature } from './admin';
import { verifyAuthKeyHeader } from './authkey';
import { verifyAccessToken } from './token';
import type { AnyAuthContext, AuthRequest, ClaimAuth, DeviceCtx, PairingAuth } from './types';

export type AuthDeps = { db: Database; clock: Clock; tokenSecret: string };

function authorization(req: AuthRequest, scheme: 'Bearer' | 'Pairing' | 'Claim'): string {
  const raw = req.header('authorization');
  if (raw === undefined) return fail('E_UNAUTHORIZED', 'authorization required');
  try {
    const a = parseAuthorization(raw);
    if (a.scheme !== scheme) return fail('E_UNAUTHORIZED', `${scheme} token required`);
    return a.token;
  } catch (err) {
    if (err instanceof HeaderParseError) return fail('E_UNAUTHORIZED', 'malformed authorization');
    throw err;
  }
}

/**
 * Bearer token -> device row. Re-checked in the database on every request so a revoked device
 * stops working immediately (spec §13.3); a device that belonged to a deleted account gets
 * E_ACCOUNT_DELETED (G3).
 */
export async function authenticateBearer(deps: AuthDeps, req: AuthRequest): Promise<DeviceCtx> {
  const token = authorization(req, 'Bearer');
  const claims = await verifyAccessToken(deps.tokenSecret, deps.clock, token);
  const row = await deps.db
    .selectFrom('devices')
    .select([
      'id',
      'account_id',
      'kind',
      'platform',
      'sign_pub',
      'admin_pub',
      'revoked_at',
      'last_seen_at',
    ])
    .where('id', '=', claims.deviceId)
    .executeTakeFirst();
  if (!row) {
    const gone = await deps.db
      .selectFrom('deleted_devices')
      .select('device_id')
      .where('device_id', '=', claims.deviceId)
      .executeTakeFirst();
    return fail(
      gone ? 'E_ACCOUNT_DELETED' : 'E_UNAUTHORIZED',
      gone ? 'account deleted' : 'unknown device',
    );
  }
  if (row.account_id !== claims.accountId) fail('E_UNAUTHORIZED', 'token does not match device');
  if (row.revoked_at !== null) fail('E_DEVICE_REVOKED', 'device revoked');

  const now = deps.clock.now();
  if (row.last_seen_at === null || now.getTime() - row.last_seen_at.getTime() >= 60_000) {
    await deps.db
      .updateTable('devices')
      .set({ last_seen_at: now })
      .where('id', '=', row.id)
      .execute();
  }
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    platform: row.platform,
    signPub: row.sign_pub,
    adminPub: row.admin_pub,
  };
}

/** Tokens are stored as SHA-256 of the raw 32 bytes (the protocol already checked the length). */
function secretHashMatches(presentedB64: string, stored: Uint8Array): boolean {
  const h = sha256(fromB64(presentedB64));
  return h.length === stored.length && timingSafeEqual(h, stored);
}

async function authenticatePairing(deps: AuthDeps, req: AuthRequest): Promise<PairingAuth> {
  const token = authorization(req, 'Pairing');
  const row = req.idParam
    ? await deps.db
        .selectFrom('pairings')
        .selectAll()
        .where('id', '=', req.idParam)
        .executeTakeFirst()
    : undefined;
  if (!row || !secretHashMatches(token, row.poll_token_hash))
    fail('E_UNAUTHORIZED', 'bad pairing token');
  return {
    id: row.id,
    deviceId: row.device_id,
    platform: row.platform,
    signPub: row.sign_pub,
    ephPub: row.eph_pub,
    status: row.status,
    accountId: row.account_id,
    response: row.response,
    expiresAt: row.expires_at,
  };
}

async function authenticateClaim(deps: AuthDeps, req: AuthRequest): Promise<ClaimAuth> {
  const token = authorization(req, 'Claim');
  const row = req.idParam
    ? await deps.db
        .selectFrom('recovery_claims')
        .selectAll()
        .where('id', '=', req.idParam)
        .executeTakeFirst()
    : undefined;
  if (!row || !secretHashMatches(token, row.claim_token_hash))
    fail('E_UNAUTHORIZED', 'bad claim token');
  return {
    id: row.id,
    accountId: row.account_id,
    rcId: row.rc_id,
    device: row.device,
    status: row.status,
    availableAt: row.available_at,
    createdAt: row.created_at,
  };
}

/** Admin proof: signature if the header is present (no silent fallback), else the authKey. */
async function requireAdminProof(
  deps: AuthDeps,
  device: DeviceCtx,
  req: AuthRequest,
): Promise<void> {
  const admin = req.header(ADMIN_HEADER);
  if (admin !== undefined) {
    await verifyAdminSignature(deps.db, deps.clock, device, req, admin);
    return;
  }
  await verifyAuthKeyHeader(deps.db, device.accountId, req.header(AUTHKEY_HEADER));
}

/** True for kinds checked from headers before the body is parsed. */
export function usesHeaderAuth(kind: AuthKind): boolean {
  return !(kind === 'none' || kind === 'invite' || kind === 'authKey' || kind === 'authRC');
}

/**
 * One entry point for every `auth` kind of the protocol route table. Body-credential kinds
 * (`invite`, `authKey`, `authRC`) are verified inside their handlers because the credential
 * lives in the body together with the account lookup; they return an empty context here.
 */
export async function authenticate(
  kind: AuthKind,
  deps: AuthDeps,
  req: AuthRequest,
): Promise<AnyAuthContext> {
  switch (kind) {
    case 'none':
    case 'invite':
    case 'authKey':
    case 'authRC':
      return {};
    case 'pairing':
      return { pairing: await authenticatePairing(deps, req) };
    case 'claim':
      return { claim: await authenticateClaim(deps, req) };
    case 'device':
      return { device: await authenticateBearer(deps, req) };
    case 'approver':
    case 'approver+admin':
    case 'approver+authKey':
    case 'approver+admin+authKey':
    case 'extension': {
      const device = await authenticateBearer(deps, req);
      const wantKind = kind === 'extension' ? 'extension' : 'mobile';
      if (device.kind !== wantKind) {
        fail(
          'E_FORBIDDEN',
          kind === 'extension' ? 'extension devices only' : 'approver devices only',
        );
      }
      if (kind === 'approver+admin') await requireAdminProof(deps, device, req);
      if (kind === 'approver+authKey') {
        await verifyAuthKeyHeader(deps.db, device.accountId, req.header(AUTHKEY_HEADER));
      }
      if (kind === 'approver+admin+authKey') {
        // Account deletion: BOTH proofs are mandatory.
        const admin = req.header(ADMIN_HEADER);
        if (admin === undefined) fail('E_UNAUTHORIZED', `${ADMIN_HEADER} required`);
        await verifyAdminSignature(deps.db, deps.clock, device, req, admin);
        await verifyAuthKeyHeader(deps.db, device.accountId, req.header(AUTHKEY_HEADER));
      }
      return { device };
    }
  }
}
