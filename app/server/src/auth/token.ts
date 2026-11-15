import { TTL_SEC, uuidSchema } from '@localvault/protocol';
import { jwtVerify, SignJWT } from 'jose';
import type { Clock } from '../clock';
import { fail } from '../errors';

export type AccessClaims = { deviceId: string; accountId: string; kind: 'mobile' | 'extension' };

const key = (secret: string) => new TextEncoder().encode(secret);

/** HS256 access token (spec §13.3): sub = deviceId, acc = accountId, kind = device kind. */
export async function issueAccessToken(
  secret: string,
  clock: Clock,
  claims: AccessClaims,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const now = clock.now();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + TTL_SEC.accessToken;
  const accessToken = await new SignJWT({ acc: claims.accountId, kind: claims.kind })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.deviceId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key(secret));
  return { accessToken, expiresAt: new Date(exp * 1000) };
}

/** Signature and expiry only; the caller still checks the device row. Any failure is E_UNAUTHORIZED. */
export async function verifyAccessToken(
  secret: string,
  clock: Clock,
  token: string,
): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'],
      currentDate: clock.now(),
      requiredClaims: ['sub', 'acc', 'kind', 'exp'],
    });
    const deviceId = payload.sub;
    const accountId = payload.acc;
    const kind = payload.kind;
    if (
      typeof deviceId === 'string' &&
      typeof accountId === 'string' &&
      uuidSchema.safeParse(deviceId).success &&
      uuidSchema.safeParse(accountId).success &&
      (kind === 'mobile' || kind === 'extension')
    ) {
      return { deviceId, accountId, kind };
    }
  } catch {
    // fall through
  }
  return fail('E_UNAUTHORIZED', 'invalid or expired token');
}
