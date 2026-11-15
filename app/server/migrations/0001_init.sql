-- LocalVault server schema (spec §13.6 + v0.4). Binary values are stored as bytea.
-- Applied only by `node dist/cli.js migrate`; the runner wraps each file in a transaction.

create table accounts (
  id               uuid primary key,
  name             text not null unique,
  verifier         bytea not null,                  -- SHA-256(authKey)
  kdf              jsonb not null,                  -- {alg, iterations, salt}
  wrapped_vk       jsonb not null,                  -- {nonce, ct}
  keyset_version   int not null,
  vk_version       int not null,
  record_rev       bigint not null default 0,       -- last rev handed out
  min_valid_cursor bigint not null default 0,       -- older cursors must resync from scratch
  keyset_rev       bigint not null default 0,       -- record_rev at the last keyset change (pull returns keyset when since < this)
  created_at       timestamptz not null
);

create table records (
  account_id  uuid not null references accounts(id) on delete cascade,
  id          uuid not null,
  rev         bigint not null,
  deleted     boolean not null default false,
  vk_version  int not null,
  nonce       bytea,
  ct          bytea,
  updated_at  timestamptz not null,
  primary key (account_id, id)
);
create index records_by_rev on records (account_id, rev);
create index records_tombstones on records (updated_at) where deleted;

create table devices (
  id            uuid primary key,
  account_id    uuid not null references accounts(id) on delete cascade,
  kind          text not null check (kind in ('mobile', 'extension')),
  platform      text not null,
  sign_pub      bytea not null,
  admin_pub     bytea,
  push_platform text check (push_platform in ('apns', 'fcm')),
  push_token    text,
  created_at    timestamptz not null,
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
create index devices_by_account on devices (account_id, created_at);

create table pairings (
  id              uuid primary key,
  poll_token_hash bytea not null,
  device_id       uuid not null,
  platform        text not null,
  sign_pub        bytea not null,
  eph_pub         bytea not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'expired')),
  account_id      uuid references accounts(id) on delete cascade,
  response        jsonb,
  expires_at      timestamptz not null
);
create index pairings_by_expiry on pairings (expires_at);

create table unlock_requests (
  id            uuid primary key,
  account_id    uuid not null references accounts(id) on delete cascade,
  device_id     uuid not null references devices(id) on delete cascade,
  request_nonce bytea not null,
  payload       jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired')),
  response      jsonb,
  created_at    timestamptz not null,
  expires_at    timestamptz not null,
  unique (device_id, request_nonce)
);
create index unlock_requests_by_account on unlock_requests (account_id, status, expires_at);
create index unlock_requests_by_created on unlock_requests (created_at);

create table auth_challenges (
  device_id  uuid not null,
  challenge  bytea not null,
  expires_at timestamptz not null,
  primary key (device_id, challenge)
);
create index auth_challenges_by_expiry on auth_challenges (expires_at);

create table admin_nonces (
  device_id  uuid not null,
  nonce      bytea not null,
  expires_at timestamptz not null,
  primary key (device_id, nonce)
);
create index admin_nonces_by_expiry on admin_nonces (expires_at);

create table invites (
  id         uuid not null unique,
  code_hash  bytea primary key,
  created_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  used_at    timestamptz,
  account_id uuid
);

create table audit_events (
  id         bigserial primary key,
  account_id uuid not null,
  device_id  uuid,
  kind       text not null,
  created_at timestamptz not null
);
create index audit_events_by_account on audit_events (account_id, id desc);
create index audit_events_by_created on audit_events (created_at);

create table recovery_codes (
  account_id  uuid primary key references accounts(id) on delete cascade,
  rc_id       bytea not null,
  verifier    bytea not null,                       -- SHA-256(authRC)
  wrapped_vk  jsonb not null,
  vk_version  int not null,
  wait_sec    int not null check (wait_sec in (86400, 172800, 259200)),
  frozen_at   timestamptz,
  created_at  timestamptz not null
);

create table recovery_claims (
  id               uuid primary key,
  account_id       uuid not null references accounts(id) on delete cascade,
  rc_id            bytea not null,
  claim_token_hash bytea not null,
  device           jsonb not null,                  -- {deviceId, platform, signPub, adminPub}
  status           text not null default 'waiting'
                   check (status in ('waiting', 'completed', 'canceled', 'disputed', 'expired')),
  available_at     timestamptz not null,
  created_at       timestamptz not null
);
create index recovery_claims_by_account on recovery_claims (account_id, status);

create table deleted_devices (
  device_id  uuid primary key,
  deleted_at timestamptz not null
);

create table rotations (
  id             uuid primary key,
  account_id     uuid not null unique references accounts(id) on delete cascade,
  device_id      uuid not null references devices(id) on delete cascade,
  expected_rev   bigint not null,
  new_vk_version int not null,
  created_at     timestamptz not null,
  expires_at     timestamptz not null
);

create table rotation_records (
  rotation_id uuid not null references rotations(id) on delete cascade,
  id          uuid not null,
  deleted     boolean not null,
  nonce       bytea,
  ct          bytea,
  primary key (rotation_id, id)
);
