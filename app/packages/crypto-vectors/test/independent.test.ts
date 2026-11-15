// Independent re-computation with node:crypto ONLY (no @localvault/* imports): guards against both
// providers sharing a misreading of the spec. Strings are written out from the spec text.
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPublicKey,
  hkdfSync,
  verify as nodeVerify,
  pbkdf2Sync,
} from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { type J, load, unhex } from './load';

const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest();
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: string, len: number) =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, len));
const uuidBytes = (u: string) => Buffer.from(u.replaceAll('-', ''), 'hex');

function gcmSeal(key: Uint8Array, nonce: Uint8Array, pt: Uint8Array, aad: string): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
function gcmOpen(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(ct.subarray(ct.length - 16)));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}
const spki = (pub: Uint8Array) =>
  createPublicKey({
    key: Buffer.concat([
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
      pub,
    ]),
    format: 'der',
    type: 'spki',
  });
const verifyP1363 = (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array) =>
  nodeVerify('sha256', msg, { key: spki(pub), dsaEncoding: 'ieee-p1363' }, sig);

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function crockford(bytes: Uint8Array, chars: number): string {
  let v = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  v <<= BigInt(chars * 5 - bytes.length * 8);
  let s = '';
  for (let i = 0; i < chars; i++) {
    s = ALPHA.charAt(Number(v & 31n)) + s;
    v >>= 5n;
  }
  return s;
}
function check(bytes: Uint8Array): string {
  const h = sha256(bytes);
  const ten = (h[0] as number) * 4 + ((h[1] as number) >> 6);
  return ALPHA.charAt(ten >> 5) + ALPHA.charAt(ten & 31);
}
const group = (s: string, n: number) => s.match(new RegExp(`.{${n}}`, 'g'))?.join('-');

describe('node:crypto reproduces the vectors', () => {
  test('5.4 key derivation, verifier, wrappedVK', { timeout: 60000 }, () => {
    const kdf = load('kdf.json');
    for (const c of kdf.cases as J[]) {
      const pw = Buffer.from(c.masterPasswordUtf8.normalize('NFKC'), 'utf8');
      const p = pbkdf2Sync(pw, fromB64u(c.kdf.salt), c.kdf.iterations, 32, 'sha256');
      expect(p.toString('hex')).toBe(c.expected.pbkdf2Hex);
      const ikm = Buffer.concat([p, unhex(c.recoveryKeyHex)]);
      expect(ikm.length).toBe(48);
      const salt = uuidBytes(c.accountId);
      expect(hkdf(ikm, salt, 'localvault/v2/kek', 32).toString('hex')).toBe(c.expected.kekHex);
      const authKey = hkdf(ikm, salt, 'localvault/v2/auth', 32);
      expect(authKey.toString('hex')).toBe(c.expected.authKeyHex);
      expect(b64u(sha256(authKey))).toBe(c.expected.verifier);
      expect(
        `LV2-${group(crockford(unhex(c.recoveryKeyHex), 26) + check(unhex(c.recoveryKeyHex)), 4)}`,
      ).toBe(c.recoveryKeyText);
    }
    const w = load('wrapped-vk.json');
    const ct = gcmSeal(
      unhex(w.kekHex),
      unhex(w.nonceHex),
      unhex(w.vkHex),
      `lv|v2|vk|${w.accountId}|${w.keysetVersion}`,
    );
    expect(b64u(ct)).toBe(w.wrappedVK.ct);
    expect(b64u(unhex(w.nonceHex))).toBe(w.wrappedVK.nonce);
    for (const n of w.negative as J[]) {
      expect(
        () =>
          gcmOpen(
            unhex(w.kekHex),
            fromB64u(n.wrappedVK.nonce),
            fromB64u(n.wrappedVK.ct),
            `lv|v2|vk|${n.accountId}|${n.keysetVersion}`,
          ),
        n.name,
      ).toThrow();
    }
  });

  test('primitives', () => {
    const v = load('primitives.json');
    for (const c of v.sha256 as J[])
      expect(sha256(Buffer.from(c.messageUtf8)).toString('hex')).toBe(c.sha256);
    for (const c of v.hkdfSha256 as J[])
      expect(hkdf(unhex(c.ikmHex), unhex(c.saltHex), c.infoUtf8, c.length).toString('hex')).toBe(
        c.okmHex,
      );
    for (const c of v.pbkdf2Sha256 as J[])
      expect(
        pbkdf2Sync(
          Buffer.from(c.passwordUtf8),
          unhex(c.saltHex),
          c.iterations,
          c.length,
          'sha256',
        ).toString('hex'),
      ).toBe(c.dkHex);
    for (const c of v.aesGcm as J[]) {
      const ct = gcmSeal(
        unhex(c.keyHex),
        unhex(c.nonceHex),
        unhex(c.plaintextHex),
        Buffer.from(unhex(c.aadHex)).toString('utf8'),
      );
      expect(ct.toString('hex')).toBe(c.ciphertextAndTagHex);
    }
    for (const c of v.ecdh as J[]) {
      const a = createECDH('prime256v1');
      a.setPrivateKey(unhex(c.privateKeyAHex));
      expect(a.getPublicKey().toString('hex')).toBe(c.publicKeyAHex);
      expect(a.computeSecret(unhex(c.publicKeyBHex)).toString('hex')).toBe(c.sharedXHex);
    }
    const e = v.ecdsaVerify;
    for (const s of e.valid as J[])
      expect(
        verifyP1363(unhex(e.publicKeyHex), unhex(e.messageHex), unhex(s.signatureHex)),
        s.name,
      ).toBe(true);
    expect(
      verifyP1363(unhex(e.publicKeyHex), unhex(e.messageHex), unhex(e.invalid[0].signatureHex)),
    ).toBe(false);
  });

  test('6.2 records', () => {
    const v = load('records.json');
    for (const c of v.cases as J[]) {
      const json = Buffer.from(JSON.stringify(c.plain), 'utf8');
      const padded = Buffer.concat([
        json,
        Buffer.alloc(Math.ceil(json.length / 256) * 256 - json.length, 0x20),
      ]);
      const ct = gcmSeal(
        unhex(v.vkHex),
        unhex(c.nonceHex),
        padded,
        `lv|v2|rec|${v.accountId}|${c.recordId}|${c.vkVersion}`,
      );
      expect(b64u(ct), c.name).toBe(c.encrypted.ct);
      expect(padded.length).toBe(c.paddedByteLength);
    }
    const pad = load('record-padding.json');
    for (const c of pad.cases as J[]) {
      expect(Math.ceil(c.jsonByteLength / 256) * 256).toBe(c.paddedByteLength);
      expect(c.paddedByteLength + 16).toBe(c.ciphertextBytes);
    }
  });

  test('8.5 seal', () => {
    const v = load('seal.json');
    for (const c of v.cases as J[]) {
      const s = createECDH('prime256v1');
      s.setPrivateKey(unhex(c.senderPrivateKeyHex));
      const S = s.getPublicKey();
      const R = unhex(v.recipientPublicKeyHex);
      const z = s.computeSecret(R);
      const salt = sha256(Buffer.concat([S, R]));
      const k = hkdf(z, salt, `localvault/v2/seal|${c.ctx}`, 32);
      const ct = gcmSeal(
        k,
        unhex(c.nonceHex),
        Buffer.from(JSON.stringify(c.plaintext)),
        `lv|v2|seal|${c.ctx}`,
      );
      expect(b64u(S)).toBe(c.envelope.epk);
      expect(b64u(ct)).toBe(c.envelope.ct);
      // the receiver side, from the recipient's private key
      const r = createECDH('prime256v1');
      r.setPrivateKey(unhex(v.recipientPrivateKeyHex));
      expect(r.computeSecret(S).toString('hex')).toBe(z.toString('hex'));
    }
  });

  test('signed strings (spec literals) verify with node:crypto', () => {
    const v = load('signed-strings.json');
    const pub = fromB64u(v.signerPublicKey);
    const [auth, unlock, admin] = v.items as J[];
    expect(auth.text).toBe(['lv-auth-v2', auth.input.deviceId, auth.input.challenge].join('\n'));
    const u = unlock.input;
    expect(unlock.text).toBe(
      ['lv-unlock-v2', u.accountId, u.deviceId, u.requestNonce, u.ephPub, u.code, u.issuedAt].join(
        '\n',
      ),
    );
    const a = admin.input;
    const bodyHash = b64u(sha256(Buffer.from(a.bodyUtf8)));
    expect(admin.text).toBe(
      ['lv-admin-v2', a.method, a.path, bodyHash, String(a.ts), a.nonce].join('\n'),
    );
    for (const i of v.items as J[]) {
      expect(verifyP1363(pub, Buffer.from(i.text), fromB64u(i.signature)), i.name).toBe(true);
      expect(
        verifyP1363(pub, Buffer.from(i.text), fromB64u(i.signatureHighS)),
        `${i.name} high-S`,
      ).toBe(true);
      expect(verifyP1363(pub, Buffer.from(i.text), fromB64u(i.tamperedSignature))).toBe(false);
    }
    const f = load('pairing-fingerprint.json').cases[0];
    expect(b64u(sha256(Buffer.concat([fromB64u(f.signPub), fromB64u(f.ephPub)])))).toBe(
      f.fingerprint,
    );
  });

  test('5.5 / 8.11 recovery encodings and derivations', () => {
    const k = load('recovery-key.json');
    for (const c of k.cases as J[]) {
      const sk = unhex(c.skHex);
      expect(`LV2-${group(crockford(sk, 26) + check(sk), 4)}`).toBe(c.text);
    }
    const r = load('recovery-code.json');
    for (const c of r.textCases as J[]) {
      const rc = unhex(c.rcHex);
      expect(`LVRC-${group(crockford(rc, 52) + check(rc), 6)}`).toBe(c.text);
    }
    const d = r.derivation;
    const rc = unhex(d.rcHex);
    const salt = uuidBytes(d.accountId);
    const rcId = hkdf(rc, salt, 'localvault/v2/rc-id', 16);
    const kek = hkdf(rc, salt, 'localvault/v2/rc-kek', 32);
    const authRC = hkdf(rc, salt, 'localvault/v2/rc-auth', 32);
    expect([rcId.toString('hex'), kek.toString('hex'), authRC.toString('hex')]).toEqual([
      d.rcIdHex,
      d.kekRCHex,
      d.authRCHex,
    ]);
    expect(b64u(sha256(authRC))).toBe(d.registration.verifier);
    const ct = gcmSeal(
      kek,
      unhex(d.wrapNonceHex),
      unhex(d.vkHex),
      `lv|v2|rc|${d.accountId}|${b64u(rcId)}|${d.vkVersion}`,
    );
    expect(b64u(ct)).toBe(d.registration.wrappedVK.ct);
  });

  test('6.5 export file', { timeout: 60000 }, () => {
    const v = load('export-file.json');
    const f = v.file;
    const key = pbkdf2Sync(
      Buffer.from(v.exportPasswordUtf8.normalize('NFKC')),
      fromB64u(f.kdf.salt),
      f.kdf.iterations,
      32,
      'sha256',
    );
    const wrapped = gcmSeal(key, unhex(v.keyNonceHex), unhex(v.fileKeyHex), 'lv-export|1|key');
    expect(b64u(wrapped)).toBe(f.wrappedKey.ct);
    const payload = gcmSeal(
      unhex(v.fileKeyHex),
      unhex(v.payloadNonceHex),
      Buffer.from(JSON.stringify(v.payload)),
      'lv-export|1|payload',
    );
    expect(b64u(payload)).toBe(f.payload.ct);
  });
});
