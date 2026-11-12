import { base64urlDecode, base64urlEncode, sealContextUnlock } from '@localvault/protocol';
import { describe, expect, test } from 'vitest';
import {
  CryptoError,
  createExportFile,
  createKeyset,
  decryptRecord,
  deriveMasterKeys,
  encryptRecord,
  generateRecoveryKeyBytes,
  open,
  openExportFile,
  paddedLength,
  rewrapKeyset,
  seal,
  unwrapVaultKey,
  VaultCoreError,
  wrapVaultKey,
} from '../src';
import { ACCOUNT, loginRecord, providers, REC, REC2 } from './helpers';

describe.each(providers)('crypto %s', (_n, p) => {
  const pw = 'correct horse battery';
  test('keyset round trip, wrong password, rewrap', async () => {
    const sk = await generateRecoveryKeyBytes(p);
    const b = await createKeyset(p, { masterPassword: pw, recoveryKey: sk, accountId: ACCOUNT });
    const ok = await deriveMasterKeys(p, {
      masterPassword: pw,
      kdf: b.keyset.kdf,
      recoveryKey: sk,
      accountId: ACCOUNT,
    });
    expect(await unwrapVaultKey(p, ok.kek, b.keyset.wrappedVK, ACCOUNT, 1)).toEqual(b.vk);
    const bad = await deriveMasterKeys(p, {
      masterPassword: `${pw} `,
      kdf: b.keyset.kdf,
      recoveryKey: sk,
      accountId: ACCOUNT,
    });
    await expect(unwrapVaultKey(p, bad.kek, b.keyset.wrappedVK, ACCOUNT, 1)).rejects.toBeInstanceOf(
      CryptoError,
    );
    await expect(unwrapVaultKey(p, ok.kek, b.keyset.wrappedVK, ACCOUNT, 2)).rejects.toBeInstanceOf(
      CryptoError,
    );
    const r = await rewrapKeyset(p, {
      masterPassword: 'new password 1',
      recoveryKey: sk,
      accountId: ACCOUNT,
      vk: b.vk,
      previous: b.keyset,
      iterations: 600000,
    });
    expect(r.keyset.keysetVersion).toBe(2);
    expect(r.keyset.kdf.salt).not.toBe(b.keyset.kdf.salt);
    expect(r.vk).toEqual(b.vk);
  }, 60000);

  test('NFKC: full-width password equals half-width', async () => {
    const sk = new Uint8Array(16).fill(7);
    const kdf = {
      alg: 'PBKDF2-HMAC-SHA256' as const,
      iterations: 600000,
      salt: base64urlEncode(new Uint8Array(16)),
    };
    const a = await deriveMasterKeys(p, {
      masterPassword: 'ＡＢＣ１２３４５６７８９',
      kdf,
      recoveryKey: sk,
      accountId: ACCOUNT,
    });
    const b = await deriveMasterKeys(p, {
      masterPassword: 'ABC123456789',
      kdf,
      recoveryKey: sk,
      accountId: ACCOUNT,
    });
    expect(a.kek).toEqual(b.kek);
  }, 60000);

  test('records: round trip, padding, nonce freshness, tamper, swapped id', async () => {
    const vk = await p.randomBytes(32);
    const loc = { accountId: ACCOUNT, recordId: REC, vkVersion: 1 };
    const rec = loginRecord();
    const e1 = await encryptRecord(p, vk, loc, rec);
    const e2 = await encryptRecord(p, vk, loc, rec);
    expect(e1.nonce).not.toBe(e2.nonce);
    expect((base64urlDecode(e1.ct).length - 16) % 256).toBe(0);
    expect(await decryptRecord(p, vk, loc, e1)).toEqual(rec);
    // absent history -> []
    const noHist = loginRecord();
    delete (noHist.data as { passwordHistory?: unknown }).passwordHistory;
    const e3 = await encryptRecord(p, vk, loc, noHist);
    expect((await decryptRecord(p, vk, loc, e3)).kind === 'login').toBe(true);
    // swapped ids / vkVersion / account
    await expect(decryptRecord(p, vk, { ...loc, recordId: REC2 }, e1)).rejects.toBeInstanceOf(
      CryptoError,
    );
    await expect(decryptRecord(p, vk, { ...loc, vkVersion: 2 }, e1)).rejects.toBeInstanceOf(
      CryptoError,
    );
    // 1-byte tamper in ct body, tag, nonce
    const ct = base64urlDecode(e1.ct);
    for (const pos of [0, ct.length - 1]) {
      const t = new Uint8Array(ct);
      t[pos] = (t[pos] as number) ^ 1;
      await expect(
        decryptRecord(p, vk, loc, { nonce: e1.nonce, ct: base64urlEncode(t) }),
      ).rejects.toBeInstanceOf(CryptoError);
    }
    const nn = base64urlDecode(e1.nonce);
    nn[0] = (nn[0] as number) ^ 1;
    await expect(
      decryptRecord(p, vk, loc, { nonce: base64urlEncode(nn), ct: e1.ct }),
    ).rejects.toBeInstanceOf(CryptoError);
    // meta id/kind mismatch
    await expect(
      encryptRecord(p, vk, { ...loc, recordId: '00000000-0000-4000-8000-000000000001' }, rec),
    ).rejects.toBeInstanceOf(VaultCoreError);
  });

  test('padding lengths', () => {
    expect(paddedLength(1)).toBe(256);
    expect(paddedLength(256)).toBe(256);
    expect(paddedLength(257)).toBe(512);
  });

  test('wrapVaultKey nonces differ', async () => {
    const kek = await p.randomBytes(32);
    const vk = await p.randomBytes(32);
    const a = await wrapVaultKey(p, kek, vk, ACCOUNT, 1);
    const b = await wrapVaultKey(p, kek, vk, ACCOUNT, 1);
    expect(a.nonce).not.toBe(b.nonce);
  });

  test('seal / open', async () => {
    const r = await p.generateKeyPair();
    const m = {
      vk: base64urlEncode(new Uint8Array(32).fill(1)),
      vkVersion: 1,
      sessionMaxSec: 3600 as const,
      issuedAt: '2026-11-11T09:00:00Z',
    };
    const ctx = sealContextUnlock(REC);
    const env = await seal(p, r.publicKey, ctx, m);
    expect(await open(p, r.privateKey, ctx, env)).toEqual(m);
    await expect(open(p, r.privateKey, sealContextUnlock(REC2), env)).rejects.toBeInstanceOf(
      CryptoError,
    );
    const other = await p.generateKeyPair();
    await expect(open(p, other.privateKey, ctx, env)).rejects.toBeInstanceOf(CryptoError);
    const ct = base64urlDecode(env.ct);
    ct[ct.length - 1] = (ct[ct.length - 1] as number) ^ 1;
    await expect(
      open(p, r.privateKey, ctx, { ...env, ct: base64urlEncode(ct) }),
    ).rejects.toBeInstanceOf(CryptoError);
  });

  test('ecdsa: verify rejects bad inputs, accepts high-S', async () => {
    const kp = await p.generateKeyPair();
    const msg = new Uint8Array([1, 2, 3]);
    const sig = await p.ecdsaSign(kp.privateKey, msg);
    expect(sig.length).toBe(64);
    expect(await p.ecdsaVerify(kp.publicKey, msg, sig)).toBe(true);
    expect(await p.ecdsaVerify(kp.publicKey, new Uint8Array([1, 2, 4]), sig)).toBe(false);
    expect(await p.ecdsaVerify(kp.publicKey, msg, sig.slice(0, 63))).toBe(false);
    const offCurve = new Uint8Array(kp.publicKey);
    offCurve[64] = (offCurve[64] as number) ^ 1;
    expect(await p.ecdsaVerify(offCurve, msg, sig)).toBe(false);
    // high-S: s' = n - s
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const s = BigInt(
      `0x${Array.from(sig.slice(32), (x) => x.toString(16).padStart(2, '0')).join('')}`,
    );
    const hs = (n - s).toString(16).padStart(64, '0');
    const high = new Uint8Array(64);
    high.set(sig.slice(0, 32));
    high.set(
      Uint8Array.from(hs.match(/../g) as string[], (h) => Number.parseInt(h, 16)),
      32,
    );
    expect(await p.ecdsaVerify(kp.publicKey, msg, high)).toBe(true);
  });

  test('export file', async () => {
    const payload = {
      items: [{ id: REC, data: loginRecord().data, updatedAt: '2026-11-11T09:00:00.000Z' }],
    };
    const f = await createExportFile(p, {
      exportPassword: 'export-password-1',
      payload,
      exportedAt: '2026-11-11T09:00:00.000Z',
    });
    expect((await openExportFile(p, 'export-password-1', f)).payload).toEqual(payload);
    await expect(openExportFile(p, 'wrong-password-12', f)).rejects.toMatchObject({
      code: 'E_WRONG_PASSWORD',
    });
    await expect(openExportFile(p, 'x', { format: 'nope' })).rejects.toMatchObject({
      code: 'E_IMPORT_FORMAT',
    });
    await expect(openExportFile(p, 'x', { ...f, version: 2 })).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_VERSION',
    });
    await expect(
      createExportFile(p, { exportPassword: 'short', payload, exportedAt: f.exportedAt }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  }, 60000);
});
