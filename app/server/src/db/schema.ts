import type { ColumnType, Generated } from 'kysely';

type Ts = Date;
type Bytes = Buffer;

export type KdfJson = { alg: 'PBKDF2-HMAC-SHA256'; iterations: number; salt: string };
export type WrappedVkJson = { nonce: string; ct: string };

export interface AccountsTable {
  id: string;
  name: string;
  verifier: Bytes;
  kdf: KdfJson;
  wrapped_vk: WrappedVkJson;
  keyset_version: number;
  vk_version: number;
  record_rev: number;
  min_valid_cursor: number;
  keyset_rev: number;
  created_at: Ts;
}

export interface RecordsTable {
  account_id: string;
  id: string;
  rev: number;
  deleted: boolean;
  vk_version: number;
  nonce: Bytes | null;
  ct: Bytes | null;
  updated_at: Ts;
}

export interface DevicesTable {
  id: string;
  account_id: string;
  kind: 'mobile' | 'extension';
  platform: string;
  sign_pub: Bytes;
  admin_pub: Bytes | null;
  push_platform: 'apns' | 'fcm' | null;
  push_token: string | null;
  created_at: Ts;
  last_seen_at: Ts | null;
  revoked_at: Ts | null;
}

export interface PairingsTable {
  id: string;
  poll_token_hash: Bytes;
  device_id: string;
  platform: string;
  sign_pub: Bytes;
  eph_pub: Bytes;
  status: 'pending' | 'approved' | 'expired';
  account_id: string | null;
  response: ColumnType<unknown | null, string | null, string | null>;
  expires_at: Ts;
}

export interface UnlockRequestsTable {
  id: string;
  account_id: string;
  device_id: string;
  request_nonce: Bytes;
  payload: ColumnType<unknown, string, string>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  response: ColumnType<unknown | null, string | null, string | null>;
  created_at: Ts;
  expires_at: Ts;
}

export interface AuthChallengesTable {
  device_id: string;
  challenge: Bytes;
  expires_at: Ts;
}

export interface AdminNoncesTable {
  device_id: string;
  nonce: Bytes;
  expires_at: Ts;
}

export interface InvitesTable {
  id: string;
  code_hash: Bytes;
  created_at: Ts;
  expires_at: Ts | null;
  revoked_at: Ts | null;
  used_at: Ts | null;
  account_id: string | null;
}

export interface AuditEventsTable {
  id: Generated<number>;
  account_id: string;
  device_id: string | null;
  kind: string;
  created_at: Ts;
}

export interface RecoveryCodesTable {
  account_id: string;
  rc_id: Bytes;
  verifier: Bytes;
  wrapped_vk: WrappedVkJson;
  vk_version: number;
  wait_sec: number;
  frozen_at: Ts | null;
  created_at: Ts;
}

export type ClaimStatus = 'waiting' | 'completed' | 'canceled' | 'disputed' | 'expired';

export interface RecoveryClaimsTable {
  id: string;
  account_id: string;
  rc_id: Bytes;
  claim_token_hash: Bytes;
  device: ColumnType<
    { deviceId: string; platform: string; signPub: string; adminPub: string | null },
    string,
    string
  >;
  status: ClaimStatus;
  available_at: Ts;
  created_at: Ts;
}

export interface DeletedDevicesTable {
  device_id: string;
  deleted_at: Ts;
}

export interface RotationsTable {
  id: string;
  account_id: string;
  device_id: string;
  expected_rev: number;
  new_vk_version: number;
  created_at: Ts;
  expires_at: Ts;
}

export interface RotationRecordsTable {
  rotation_id: string;
  id: string;
  deleted: boolean;
  nonce: Bytes | null;
  ct: Bytes | null;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: Ts;
}

export interface DB {
  accounts: AccountsTable;
  records: RecordsTable;
  devices: DevicesTable;
  pairings: PairingsTable;
  unlock_requests: UnlockRequestsTable;
  auth_challenges: AuthChallengesTable;
  admin_nonces: AdminNoncesTable;
  invites: InvitesTable;
  audit_events: AuditEventsTable;
  recovery_codes: RecoveryCodesTable;
  recovery_claims: RecoveryClaimsTable;
  deleted_devices: DeletedDevicesTable;
  rotations: RotationsTable;
  rotation_records: RotationRecordsTable;
  schema_migrations: SchemaMigrationsTable;
}
