// Every vector must be reproduced by BOTH providers through the public core API.

import {
  type CryptoProvider,
  createExportFile,
  createNobleProvider,
  createRecoveryCodeRegistration,
  createWebCryptoProvider,
  decryptRecord,
  deriveMasterKeys,
  deriveRecoveryCodeKeys,
  encryptRecord,
  formatRecoveryCode,
  formatRecoveryKey,
  open,
  openExportFile,
  pairingFingerprint,
  parseRecoveryCode,
  parseRecoveryKey,
  passwordBytes,
  seal,
  unwrapVaultKey,
  unwrapVaultKeyWithRecoveryCode,
  verifierOf,
  verifyAdminHeader,
  wrapVaultKey,
} from '@localvault/core';
import { createDeterministicProvider } from '@localvault/core/testing';
import {
  adminSignString,
  authSignString,
  base64urlDecode,
  base64urlEncode,
  unlockSignString,
  utf8Encode,
} from '@localvault/protocol';
import { describe, expect, test } from 'vitest';
import { hexOf, load, unhex } from './load';

const providers: [string, CryptoProvider][] = [
  ['webcrypto', createWebCryptoProvider()],
  ['noble', createNobleProvider()],
];
const E_DECRYPT = { code: 'E_DECRYPT' };

describe.each(providers)('vectors on %s', (_n, base) => {
  test('primitives', async () => {
    const v = load('primitives.json');
    for (const c of v.sha256)
      expect(hexOf(await base.sha256(utf8Encode(c.messageUtf8)))).toBe(c.sha256);
    for (const c of v.hmacSha256)
      expect(hexOf(await base.hmacSha256(unhex(c.keyHex), utf8Encode(c.messageUtf8)))).toBe(c.mac);
    for (const c of v.hkdfSha256)
      expect(
        hexOf(
          await base.hkdfSha256(
            unhex(c.ikmHex),
            unhex(c.saltHex),
            utf8Encode(c.infoUtf8),
            c.length,
          ),
        ),
      ).toBe(c.okmHex);
    for (const c of v.pbkdf2Sha256)
      expect(
        hexOf(
          await base.pbkdf2Sha256(
            utf8Encode(c.passwordUtf8),
            unhex(c.saltHex),
            c.iterations,
            c.length,
          ),
        ),
      ).toBe(c.dkHex);
    for (const c of v.aesGcm) {
      const ct = await base.aesGcmEncrypt(
        unhex(c.keyHex),
        unhex(c.nonceHex),
        unhex(c.plaintextHex),
        unhex(c.aadHex),
      );
      expect(hexOf(ct)).toBe(c.ciphertextAndTagHex);
      expect(
        hexOf(await base.aesGcmDecrypt(unhex(c.keyHex), unhex(c.nonceHex), ct, unhex(c.aadHex))),
      ).toBe(c.plaintextHex);
    }
    for (const c of v.ecdh) {
      expect(hexOf(await base.publicKeyOf(unhex(c.privateKeyAHex)))).toBe(c.publicKeyAHex);
      expect(hexOf(await base.ecdh(unhex(c.privateKeyAHex), unhex(c.publicKeyBHex)))).toBe(
        c.sharedXHex,
      );
      expect(hexOf(await base.ecdh(unhex(c.privateKeyBHex), unhex(c.publicKeyAHex)))).toBe(
        c.sharedXHex,
      );
    }
    const e = v.ecdsaVerify;
    const msg = unhex(e.messageHex);
    for (const s of e.valid)
      expect(
        await base.ecdsaVerify(unhex(e.publicKeyHex), msg, unhex(s.signatureHex)),
        s.name,
      ).toBe(true);
    for (const s of e.invalid)
      expect(
        await base.ecdsaVerify(unhex(e.publicKeyHex), msg, unhex(s.signatureHex)),
        s.name,
      ).toBe(false);
    const goodSig = unhex(e.valid[0].signatureHex);
    for (const k of e.invalidPublicKeys)
      expect(await base.ecdsaVerify(unhex(k.publicKeyHex), msg, goodSig), k.name).toBe(false);
  });

  test('kdf + wrapped VK', { timeout: 300_000 }, async () => {
    const kdf = load('kdf.json');
    for (const c of kdf.cases) {
      const sk = unhex(c.recoveryKeyHex);
      expect(
        hexOf(
          await base.pbkdf2Sha256(
            passwordBytes(c.masterPasswordUtf8),
            base64urlDecode(c.kdf.salt),
            c.kdf.iterations,
            32,
          ),
        ),
      ).toBe(c.expected.pbkdf2Hex);
      const { kek, authKey } = await deriveMasterKeys(base, {
        masterPassword: c.masterPasswordUtf8,
        kdf: c.kdf,
        recoveryKey: sk,
        accountId: c.accountId,
      });
      expect(hexOf(kek)).toBe(c.expected.kekHex);
      expect(hexOf(authKey)).toBe(c.expected.authKeyHex);
      expect(base64urlEncode(await verifierOf(base, authKey))).toBe(c.expected.verifier);
      expect(await formatRecoveryKey(base, sk)).toBe(c.recoveryKeyText);
    }
    const w = load('wrapped-vk.json');
    const det = createDeterministicProvider(base);
    det.enqueueRandom(unhex(w.nonceHex));
    expect(
      await wrapVaultKey(det, unhex(w.kekHex), unhex(w.vkHex), w.accountId, w.keysetVersion),
    ).toEqual(w.wrappedVK);
    det.assertDrained();
    expect(
      hexOf(await unwrapVaultKey(base, unhex(w.kekHex), w.wrappedVK, w.accountId, w.keysetVersion)),
    ).toBe(w.vkHex);
    for (const n of w.negative)
      await expect(
        unwrapVaultKey(base, unhex(w.kekHex), n.wrappedVK, n.accountId, n.keysetVersion),
        n.name,
      ).rejects.toMatchObject(E_DECRYPT);
  });

  test('records and padding', async () => {
    const v = load('records.json');
    const vk = unhex(v.vkHex);
    for (const c of v.cases) {
      const det = createDeterministicProvider(base);
      det.enqueueRandom(unhex(c.nonceHex));
      const enc = await encryptRecord(
        det,
        vk,
        { accountId: v.accountId, recordId: c.recordId, vkVersion: c.vkVersion },
        c.plain,
      );
      expect(enc, c.name).toEqual(c.encrypted);
      det.assertDrained();
      expect(c.paddedByteLength % 256).toBe(0);
      const dec = await decryptRecord(
        base,
        vk,
        { accountId: v.accountId, recordId: c.recordId, vkVersion: c.vkVersion },
        c.encrypted,
      );
      expect(dec.kind).toBe(c.plain.kind);
    }
    for (const n of v.negative)
      await expect(
        decryptRecord(
          base,
          vk,
          { accountId: n.accountId, recordId: n.recordId, vkVersion: n.vkVersion },
          n.encrypted,
        ),
        n.name,
      ).rejects.toMatchObject(E_DECRYPT);

    const pad = load('record-padding.json');
    for (const c of pad.cases) {
      const det = createDeterministicProvider(base);
      det.enqueueRandom(unhex(pad.nonceHex));
      const rec = v.cases[0].plain;
      const plain = { ...rec, data: { ...rec.data, notes: 'x'.repeat(c.notesLength) } };
      const enc = await encryptRecord(
        det,
        unhex(pad.vkHex),
        { accountId: pad.accountId, recordId: pad.recordId, vkVersion: 1 },
        plain,
      );
      expect(base64urlDecode(enc.ct).length).toBe(c.ciphertextBytes);
      expect(c.ciphertextBytes).toBe(c.paddedByteLength + 16);
      expect(new TextEncoder().encode(JSON.stringify(plain)).length).toBe(c.jsonByteLength);
    }
  });

  test('seal', async () => {
    const v = load('seal.json');
    for (const c of v.cases) {
      const det = createDeterministicProvider(base);
      det.enqueueKeyPair({
        privateKey: unhex(c.senderPrivateKeyHex),
        publicKey: unhex(c.senderPublicKeyHex),
      });
      det.enqueueRandom(unhex(c.nonceHex));
      expect(await seal(det, unhex(v.recipientPublicKeyHex), c.ctx, c.plaintext)).toEqual(
        c.envelope,
      );
      det.assertDrained();
      expect(await open(base, unhex(v.recipientPrivateKeyHex), c.ctx, c.envelope)).toEqual(
        c.plaintext,
      );
    }
    for (const n of v.negative) {
      const priv = unhex(n.recipientPrivateKeyHex ?? v.recipientPrivateKeyHex);
      await expect(open(base, priv, n.ctx, n.envelope), n.name).rejects.toMatchObject(E_DECRYPT);
    }
  });

  test('signed strings', async () => {
    const v = load('signed-strings.json');
    const pub = base64urlDecode(v.signerPublicKey);
    const [auth, unlock, admin, adminNoBody] = v.items;
    expect(authSignString(auth.input.deviceId, auth.input.challenge)).toBe(auth.text);
    expect(unlockSignString(unlock.input)).toBe(unlock.text);
    expect(adminSignString(admin.input)).toBe(admin.text);
    expect(adminSignString(adminNoBody.input)).toBe(adminNoBody.text);
    for (const i of v.items) {
      const text = utf8Encode(i.text);
      expect(await base.ecdsaVerify(pub, text, base64urlDecode(i.signature)), i.name).toBe(true);
      expect(
        await base.ecdsaVerify(pub, text, base64urlDecode(i.signatureHighS)),
        `${i.name} high-S`,
      ).toBe(true);
      expect(
        await base.ecdsaVerify(pub, text, base64urlDecode(i.tamperedSignature)),
        `${i.name} tampered`,
      ).toBe(false);
      expect(
        await base.ecdsaVerify(pub, utf8Encode(`${i.text}\n`), base64urlDecode(i.signature)),
      ).toBe(false);
    }
    const h = v.adminHeader;
    const r = await verifyAdminHeader(
      base,
      v.signerPublicKey,
      { method: h.request.method, path: h.request.path, body: utf8Encode(h.request.bodyUtf8) },
      h.value,
    );
    expect(r.ok).toBe(true);

    const f = load('pairing-fingerprint.json');
    for (const c of f.cases)
      expect(await pairingFingerprint(base, c.signPub, c.ephPub)).toBe(c.fingerprint);
    for (const c of f.negative)
      expect(await pairingFingerprint(base, c.signPub, c.ephPub)).not.toBe(c.fingerprint);
  });

  test('recovery key and code', async () => {
    const k = load('recovery-key.json');
    for (const c of k.cases) {
      expect(await formatRecoveryKey(base, unhex(c.skHex))).toBe(c.text);
      expect(hexOf(await parseRecoveryKey(base, c.text))).toBe(c.skHex);
    }
    for (const c of k.lenientValid)
      expect(hexOf(await parseRecoveryKey(base, c.input)), c.input).toBe(c.skHex);
    for (const c of k.invalid)
      await expect(parseRecoveryKey(base, c.input), c.name).rejects.toMatchObject({
        code: 'E_INVALID_RECOVERY_KEY',
      });

    const r = load('recovery-code.json');
    for (const c of r.textCases) {
      expect(await formatRecoveryCode(base, unhex(c.rcHex))).toBe(c.text);
      expect(hexOf(await parseRecoveryCode(base, c.text))).toBe(c.rcHex);
    }
    for (const c of r.lenientValid)
      expect(hexOf(await parseRecoveryCode(base, c.input)), c.input).toBe(c.rcHex);
    for (const c of r.invalid)
      await expect(parseRecoveryCode(base, c.input), c.name).rejects.toMatchObject({
        code: 'E_INVALID_RECOVERY_CODE',
      });

    const d = r.derivation;
    const keys = await deriveRecoveryCodeKeys(base, unhex(d.rcHex), d.accountId);
    expect([hexOf(keys.rcId), hexOf(keys.kekRC), hexOf(keys.authRC)]).toEqual([
      d.rcIdHex,
      d.kekRCHex,
      d.authRCHex,
    ]);
    const det = createDeterministicProvider(base);
    det.enqueueRandom(unhex(d.wrapNonceHex));
    expect(
      await createRecoveryCodeRegistration(
        det,
        unhex(d.rcHex),
        d.accountId,
        unhex(d.vkHex),
        d.vkVersion,
      ),
    ).toEqual(d.registration);
    expect(
      hexOf(
        await unwrapVaultKeyWithRecoveryCode(
          base,
          unhex(d.rcHex),
          d.accountId,
          d.registration.wrappedVK,
          d.vkVersion,
        ),
      ),
    ).toBe(d.vkHex);
    for (const n of r.negative)
      await expect(
        unwrapVaultKeyWithRecoveryCode(base, unhex(d.rcHex), d.accountId, n.wrappedVK, n.vkVersion),
        n.name,
      ).rejects.toMatchObject(E_DECRYPT);
  });

  test('export file', { timeout: 300_000 }, async () => {
    const v = load('export-file.json');
    const det = createDeterministicProvider(base);
    det.enqueueRandom(
      unhex(v.saltHex),
      unhex(v.fileKeyHex),
      unhex(v.keyNonceHex),
      unhex(v.payloadNonceHex),
    );
    const file = await createExportFile(det, {
      exportPassword: v.exportPasswordUtf8,
      payload: v.payload,
      exportedAt: v.file.exportedAt,
    });
    expect(file).toEqual(v.file);
    det.assertDrained();
    expect((await openExportFile(base, v.exportPasswordUtf8, v.file)).payload).toEqual(v.payload);
    for (const n of v.negative)
      await expect(openExportFile(base, n.passwordUtf8, n.file), n.name).rejects.toMatchObject({
        code: n.expectedError,
      });
  });
});
