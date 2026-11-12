import type { AuthKind } from '@localvault/protocol';
import type { ClaimStatus } from '../db/schema';

export type DeviceCtx = {
  id: string;
  accountId: string;
  kind: 'mobile' | 'extension';
  platform: string;
  signPub: Buffer;
  adminPub: Buffer | null;
};

export type PairingAuth = {
  id: string;
  deviceId: string;
  platform: string;
  signPub: Buffer;
  ephPub: Buffer;
  status: 'pending' | 'approved' | 'expired';
  accountId: string | null;
  response: unknown;
  expiresAt: Date;
};

export type ClaimAuth = {
  id: string;
  accountId: string;
  rcId: Buffer;
  device: { deviceId: string; platform: string; signPub: string; adminPub: string | null };
  status: ClaimStatus;
  availableAt: Date;
  createdAt: Date;
};

/** What the middleware hands to a handler, by the route's `auth` kind. */
export type AuthContextOf<K extends AuthKind> = K extends 'pairing'
  ? { pairing: PairingAuth }
  : K extends 'claim'
    ? { claim: ClaimAuth }
    : K extends 'none' | 'invite' | 'authKey' | 'authRC'
      ? Record<string, never>
      : { device: DeviceCtx };

export type AnyAuthContext = {
  device?: DeviceCtx;
  pairing?: PairingAuth;
  claim?: ClaimAuth;
};

/** Everything the authenticators need to know about the HTTP request. */
export type AuthRequest = {
  header(name: string): string | undefined;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path exactly as sent, including the query string (the admin signature covers it). */
  pathWithQuery: string;
  rawBody: Uint8Array;
  /** The `{id}` path parameter, if the route has one. */
  idParam: string | undefined;
};
