import { base64urlDecode } from '@localvault/protocol';
import { describe, expect, test } from 'vitest';
import {
  createRecoveryCodeRegistration,
  deriveRecoveryCodeKeys,
  formatRecoveryCode,
  formatRecoveryKey,
  parseRecoveryCode,
  parseRecoveryKey,
  recoveryCodeConfirmationTail,
  unwrapVaultKeyWithRecoveryCode,
} from '../src';
import { ACCOUNT, providers } from './helpers';

describe.each(providers)('recovery %s', (_n, p) => {
  test('recovery key: format, check chars, lenient parse', async () => {
    const sk = Uint8Array.from({ length: 16 }, (_, i) => i * 13 + 1);
    const text = await formatRecoveryKey(p, sk);
    expect(text).toMatch(/^LV2(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(await parseRecoveryKey(p, text)).toEqual(sk);
    expect(await parseRecoveryKey(p, text.toLowerCase())).toEqual(sk);
    expect(await parseRecoveryKey(p, text.replaceAll('-', ' '))).toEqual(sk);
    expect(await parseRecoveryKey(p, text.slice(4))).toEqual(sk); // prefix optional
    // I/L -> 1 and O -> 0 reading
    const alt = text.replaceAll('1', 'l').replaceAll('0', 'O');
    expect(await parseRecoveryKey(p, alt.replace('LV2', 'lv2'))).toEqual(sk);
    // wrong check chars / typo / bad length / illegal char
    const body = text.slice(4).replaceAll('-', '');
    const swap = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    for (const bad of [
      swap(body, 27),
      swap(body, 3),
      body.slice(1),
      `${body}0`,
      `U${body.slice(1)}`,
      '',
    ]) {
      await expect(parseRecoveryKey(p, bad)).rejects.toMatchObject({
        code: 'E_INVALID_RECOVERY_KEY',
      });
    }
    // non-zero padding bits in the 26th char are rejected
    await expect(
      parseRecoveryKey(p, `${body.slice(0, 25)}Z${body.slice(26)}`),
    ).rejects.toMatchObject({ code: 'E_INVALID_RECOVERY_KEY' });
  });

  test('recovery code: text format and derivations', async () => {
    const rc = Uint8Array.from({ length: 32 }, (_, i) => 255 - i * 7);
    const text = await formatRecoveryCode(p, rc);
    expect(text).toMatch(/^LVRC(-[0-9A-HJKMNP-TV-Z]{6}){9}$/);
    expect(text.replaceAll('-', '').length).toBe(4 + 54);
    expect(await parseRecoveryCode(p, text.toLowerCase().replaceAll('-', ' '))).toEqual(rc);
    expect(recoveryCodeConfirmationTail(text)).toBe(text.slice(-6));
    const bad = text.slice(0, -1) + (text.endsWith('A') ? 'B' : 'A');
    await expect(parseRecoveryCode(p, bad)).rejects.toMatchObject({
      code: 'E_INVALID_RECOVERY_CODE',
    });
    await expect(parseRecoveryCode(p, 'LVRC-AAAA')).rejects.toMatchObject({
      code: 'E_INVALID_RECOVERY_CODE',
    });

    const keys = await deriveRecoveryCodeKeys(p, rc, ACCOUNT);
    expect([keys.rcId.length, keys.kekRC.length, keys.authRC.length]).toEqual([16, 32, 32]);
    const vk = await p.randomBytes(32);
    const reg = await createRecoveryCodeRegistration(p, rc, ACCOUNT, vk, 3);
    expect(base64urlDecode(reg.rcId)).toEqual(keys.rcId);
    expect(base64urlDecode(reg.verifier)).toEqual(await p.sha256(keys.authRC));
    expect(await unwrapVaultKeyWithRecoveryCode(p, rc, ACCOUNT, reg.wrappedVK, 3)).toEqual(vk);
    await expect(
      unwrapVaultKeyWithRecoveryCode(p, rc, ACCOUNT, reg.wrappedVK, 4),
    ).rejects.toMatchObject({ code: 'E_DECRYPT' });
  });
});
