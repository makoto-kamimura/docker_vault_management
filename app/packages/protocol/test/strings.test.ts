import { describe, expect, it } from 'vitest';
import {
  adminSignString,
  authSignString,
  EXPORT_AAD_KEY,
  EXPORT_AAD_PAYLOAD,
  HKDF_INFO,
  rcAad,
  recordAad,
  sealAad,
  sealContextPair,
  sealContextUnlock,
  sealHkdfInfo,
  unlockSignString,
  vkAad,
} from '../src/index';

const A = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';

describe('signed strings (spec §8.4, §8.7, §13.3)', () => {
  it('auth', () => {
    expect(authSignString(D, 'Q0hBTExFTkdF')).toBe(`lv-auth-v2\n${D}\nQ0hBTExFTkdF`);
  });
  it('unlock', () => {
    expect(
      unlockSignString({
        accountId: A,
        deviceId: D,
        requestNonce: 'NONCE',
        ephPub: 'EPH',
        code: '47',
        issuedAt: '2026-11-11T09:00:00Z',
      }),
    ).toBe(`lv-unlock-v2\n${A}\n${D}\nNONCE\nEPH\n47\n2026-11-11T09:00:00Z`);
  });
  it('admin', () => {
    expect(
      adminSignString({
        method: 'DELETE',
        path: `/v1/devices/${D}`,
        bodyHash: 'HASH',
        ts: 1789117200,
        nonce: 'N',
      }),
    ).toBe(`lv-admin-v2\nDELETE\n/v1/devices/${D}\nHASH\n1789117200\nN`);
  });
});

describe('AAD and HKDF info (spec §5.4, §6.2, §8.5, §8.11.1, §6.5)', () => {
  it('AADs', () => {
    expect(vkAad(A, 3)).toBe(`lv|v2|vk|${A}|3`);
    expect(recordAad(A, D, 1)).toBe(`lv|v2|rec|${A}|${D}|1`);
    expect(sealAad('pair|P')).toBe('lv|v2|seal|pair|P');
    expect(rcAad(A, 'RCID', 2)).toBe(`lv|v2|rc|${A}|RCID|2`);
    expect(EXPORT_AAD_KEY).toBe('lv-export|1|key');
    expect(EXPORT_AAD_PAYLOAD).toBe('lv-export|1|payload');
  });
  it('HKDF infos', () => {
    expect(HKDF_INFO).toEqual({
      kek: 'localvault/v2/kek',
      auth: 'localvault/v2/auth',
      rcId: 'localvault/v2/rc-id',
      rcKek: 'localvault/v2/rc-kek',
      rcAuth: 'localvault/v2/rc-auth',
    });
    expect(sealHkdfInfo(sealContextPair('P1'))).toBe('localvault/v2/seal|pair|P1');
    expect(sealHkdfInfo(sealContextUnlock('R1'))).toBe('localvault/v2/seal|unlock|R1');
  });
});
