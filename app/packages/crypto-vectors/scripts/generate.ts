// Regenerates vectors/*.json deterministically.
//   pnpm --filter @localvault/crypto-vectors generate
// Everything runs on the WebCrypto provider behind the deterministic wrapper, EXCEPT ECDSA signing:
// WebCrypto signatures are randomised, so signatures come from noble (RFC 6979, deterministic).
// All "random" inputs are derived from fixed labels with SHA-256, so reruns are byte-identical.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adminBodyHash,
  buildAdminHeader,
  createExportFile,
  createNobleProvider,
  createRecoveryCodeRegistration,
  createWebCryptoProvider,
  deriveMasterKeys,
  deriveRecoveryCodeKeys,
  encryptRecord,
  formatRecoveryCode,
  formatRecoveryKey,
  hexEncode,
  openExportFile,
  pairingFingerprint,
  passwordBytes,
  seal,
  signAuthChallenge,
  signUnlockRequest,
  verifierOf,
  wrapVaultKey,
} from '@localvault/core';
import { createDeterministicProvider } from '@localvault/core/testing';
import {
  adminSignString,
  authSignString,
  base64urlDecode,
  base64urlEncode,
  EXPORT_AAD_KEY,
  EXPORT_AAD_PAYLOAD,
  META_RECORD_ID,
  rcAad,
  recordAad,
  sealAad,
  sealContextPair,
  sealContextUnlock,
  sealHkdfInfo,
  unlockSignString,
  utf8Encode,
  vkAad,
} from '@localvault/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../vectors');
mkdirSync(outDir, { recursive: true });

const web = createWebCryptoProvider();
const noble = createNobleProvider();
const det = createDeterministicProvider(web);
// Signing provider: deterministic randomness queue + RFC 6979 signatures.
const signer = { ...det, ecdsaSign: noble.ecdsaSign };

// ---------------------------------------------------------------- deterministic inputs
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function fill(label: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let off = 0;
  for (let i = 0; off < n; i++) {
    const h = createHash('sha256').update(`${label}#${i}`).digest();
    out.set(h.subarray(0, Math.min(32, n - off)), off);
    off += 32;
  }
  return out;
}
const hex = hexEncode;
const b64 = base64urlEncode;

function scalar(label: string): Uint8Array {
  const v = (BigInt(`0x${hex(fill(label, 32))}`) % (P256_N - 1n)) + 1n;
  return Uint8Array.from(v.toString(16).padStart(64, '0').match(/../g) as string[], (h) =>
    Number.parseInt(h, 16),
  );
}
async function keyPair(label: string) {
  const privateKey = scalar(label);
  return { privateKey, publicKey: await web.publicKeyOf(privateKey) };
}
function write(name: string, value: unknown): void {
  writeFileSync(resolve(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log('wrote', name);
}
function flipLast(b64s: string): string {
  const b = base64urlDecode(b64s);
  b[b.length - 1] = (b[b.length - 1] as number) ^ 1;
  return b64(b);
}
function flipFirst(b64s: string): string {
  const b = base64urlDecode(b64s);
  b[0] = (b[0] as number) ^ 1;
  return b64(b);
}

const ACCOUNT = '5f0c2a9e-7d3b-4c1a-9e8f-1a2b3c4d5e6f';
const OTHER_ACCOUNT = '6a1d3b0f-8e4c-4d2b-8f90-2b3c4d5e6f70';
const DEVICE = '7b2e4c10-9f5d-4e3c-a001-3c4d5e6f7081';
const REC_A = '8c3f5d21-a06e-4f4d-b112-4d5e6f708192';
const REC_B = '9d4a6e32-b17f-4a5e-8223-5e6f708192a3';

// ---------------------------------------------------------------- primitives.json
async function primitives() {
  const sha = ['', 'abc', 'LocalVault'].map(async (s) => ({
    messageUtf8: s,
    sha256: hex(await web.sha256(utf8Encode(s))),
  }));
  const hmacKey = fill('hmac-key', 20);
  const hkdfIkm = fill('hkdf-ikm', 48);
  const hkdfSalt = fill('hkdf-salt', 16);
  const pbk = [
    { passwordUtf8: 'password', salt: fill('pbkdf2-salt', 16), iterations: 1, length: 32 },
    { passwordUtf8: 'パスワード', salt: fill('pbkdf2-salt2', 16), iterations: 4096, length: 32 },
  ];
  const gcmKey = fill('gcm-key', 32);
  const gcmCases = [
    { name: 'empty plaintext, empty aad', pt: new Uint8Array(0), aad: new Uint8Array(0) },
    { name: 'text with aad', pt: utf8Encode('hello localvault'), aad: utf8Encode('lv|v2|test') },
  ];
  const a = await keyPair('ecdh-a');
  const b = await keyPair('ecdh-b');
  const sigKey = await keyPair('ecdsa-primitive');
  const msg = utf8Encode('ecdsa primitive message');
  const sig = await noble.ecdsaSign(sigKey.privateKey, msg);
  const s = BigInt(`0x${hex(sig.slice(32))}`);
  const high = new Uint8Array(sig);
  high.set(
    Uint8Array.from((P256_N - s).toString(16).padStart(64, '0').match(/../g) as string[], (h) =>
      Number.parseInt(h, 16),
    ),
    32,
  );
  const offCurve = new Uint8Array(sigKey.publicKey);
  offCurve[64] = (offCurve[64] as number) ^ 1;

  write('primitives.json', {
    description: 'Primitive-level vectors. All binary values are lower-case hex.',
    sha256: await Promise.all(sha),
    hmacSha256: [
      {
        keyHex: hex(hmacKey),
        messageUtf8: 'what do ya want for nothing?',
        mac: hex(await web.hmacSha256(hmacKey, utf8Encode('what do ya want for nothing?'))),
      },
    ],
    hkdfSha256: [
      {
        ikmHex: hex(hkdfIkm),
        saltHex: hex(hkdfSalt),
        infoUtf8: 'localvault/v2/test',
        length: 42,
        okmHex: hex(await web.hkdfSha256(hkdfIkm, hkdfSalt, utf8Encode('localvault/v2/test'), 42)),
      },
    ],
    pbkdf2Sha256: await Promise.all(
      pbk.map(async (c) => ({
        passwordUtf8: c.passwordUtf8,
        saltHex: hex(c.salt),
        iterations: c.iterations,
        length: c.length,
        dkHex: hex(
          await web.pbkdf2Sha256(utf8Encode(c.passwordUtf8), c.salt, c.iterations, c.length),
        ),
      })),
    ),
    aesGcm: await Promise.all(
      gcmCases.map(async (c, i) => {
        const nonce = fill(`gcm-nonce-${i}`, 12);
        return {
          name: c.name,
          keyHex: hex(gcmKey),
          nonceHex: hex(nonce),
          aadHex: hex(c.aad),
          plaintextHex: hex(c.pt),
          ciphertextAndTagHex: hex(await web.aesGcmEncrypt(gcmKey, nonce, c.pt, c.aad)),
        };
      }),
    ),
    ecdh: [
      {
        privateKeyAHex: hex(a.privateKey),
        publicKeyAHex: hex(a.publicKey),
        privateKeyBHex: hex(b.privateKey),
        publicKeyBHex: hex(b.publicKey),
        sharedXHex: hex(await web.ecdh(a.privateKey, b.publicKey)),
      },
    ],
    ecdsaVerify: {
      publicKeyHex: hex(sigKey.publicKey),
      messageHex: hex(msg),
      valid: [
        { name: 'low-S', signatureHex: hex(sig) },
        { name: 'high-S', signatureHex: hex(high) },
      ],
      invalid: [
        {
          name: 'flipped bit in r',
          signatureHex: hex(Uint8Array.from(sig, (x, i) => (i === 0 ? x ^ 1 : x))),
        },
        { name: 'wrong length (63 bytes)', signatureHex: hex(sig.slice(0, 63)) },
        { name: 'zero signature', signatureHex: hex(new Uint8Array(64)) },
        { name: 'DER instead of P1363', signatureHex: `3044${hex(sig).slice(0, 136)}` },
      ],
      invalidPublicKeys: [
        { name: 'point not on curve', publicKeyHex: hex(offCurve) },
        { name: 'compressed encoding', publicKeyHex: hex(sigKey.publicKey.slice(0, 33)) },
      ],
    },
  });
}

// ---------------------------------------------------------------- kdf.json + wrapped-vk.json
async function keys() {
  const cases = [
    {
      name: 'ascii',
      masterPassword: 'correct horse battery staple',
      sk: fill('sk-1', 16),
      salt: fill('kdf-salt-1', 16),
    },
    // NFKC folds the full-width letters/digits and the ideographic space; trailing space is kept.
    {
      name: 'nfkc-no-trim',
      masterPassword: 'ＰＡＳＳ　ｗｏｒｄ１２３４ ',
      sk: fill('sk-2', 16),
      salt: fill('kdf-salt-2', 16),
    },
  ];
  const out = [];
  for (const c of cases) {
    const kdf = { alg: 'PBKDF2-HMAC-SHA256', iterations: 600000, salt: b64(c.salt) };
    const p = await web.pbkdf2Sha256(passwordBytes(c.masterPassword), c.salt, 600000, 32);
    const ikm = new Uint8Array([...p, ...c.sk]);
    const { kek, authKey } = await deriveMasterKeys(web, {
      masterPassword: c.masterPassword,
      kdf: kdf as never,
      recoveryKey: c.sk,
      accountId: ACCOUNT,
    });
    out.push({
      name: c.name,
      masterPasswordUtf8: c.masterPassword,
      accountId: ACCOUNT,
      recoveryKeyHex: hex(c.sk),
      recoveryKeyText: await formatRecoveryKey(web, c.sk),
      kdf,
      expected: {
        pbkdf2Hex: hex(p),
        ikmHex: hex(ikm),
        kekHex: hex(kek),
        authKeyHex: hex(authKey),
        verifier: b64(await verifierOf(web, authKey)),
      },
    });
  }
  write('kdf.json', {
    description: 'Spec 5.4. salt for HKDF = raw 16 bytes of accountId.',
    cases: out,
  });

  // wrapped VK, using the KEK of the first case
  const kek = Uint8Array.from(
    Buffer.from((out[0] as { expected: { kekHex: string } }).expected.kekHex, 'hex'),
  );
  const vk = fill('vk-1', 32);
  const nonce = fill('vk-nonce-1', 12);
  det.enqueueRandom(nonce);
  const keysetVersion = 3;
  const wrapped = await wrapVaultKey(det, kek, vk, ACCOUNT, keysetVersion);
  det.assertDrained();
  write('wrapped-vk.json', {
    description: 'wrappedVK = AES-256-GCM(KEK, VK, AAD). Negative cases must fail to unwrap.',
    kekHex: hex(kek),
    vkHex: hex(vk),
    accountId: ACCOUNT,
    keysetVersion,
    aad: vkAad(ACCOUNT, keysetVersion),
    nonceHex: hex(nonce),
    wrappedVK: wrapped,
    negative: [
      {
        name: 'wrong keysetVersion in AAD',
        accountId: ACCOUNT,
        keysetVersion: 4,
        wrappedVK: wrapped,
      },
      {
        name: 'wrong accountId in AAD',
        accountId: OTHER_ACCOUNT,
        keysetVersion,
        wrappedVK: wrapped,
      },
      {
        name: 'tampered tag',
        accountId: ACCOUNT,
        keysetVersion,
        wrappedVK: { nonce: wrapped.nonce, ct: flipLast(wrapped.ct) },
      },
      {
        name: 'tampered ciphertext',
        accountId: ACCOUNT,
        keysetVersion,
        wrappedVK: { nonce: wrapped.nonce, ct: flipFirst(wrapped.ct) },
      },
      {
        name: 'tampered nonce',
        accountId: ACCOUNT,
        keysetVersion,
        wrappedVK: { nonce: flipFirst(wrapped.nonce), ct: wrapped.ct },
      },
    ],
  });
}

// ---------------------------------------------------------------- records.json + record-padding.json
const signPub = async (l: string) => b64((await keyPair(l)).publicKey);
function login(over: Record<string, unknown> = {}) {
  return {
    kind: 'login',
    data: {
      title: 'GitHub',
      username: 'alice@example.com',
      password: 'p@ss-Wörd-日本語',
      urls: [{ url: 'https://github.com/login', match: 'domain' }],
      androidApps: [],
      notes: '',
      favorite: true,
      createdAt: '2026-11-01T09:00:00.000Z',
      trashedAt: null,
      conflictOf: null,
      passwordHistory: [],
      ...over,
    },
    updatedAt: '2026-11-02T09:00:00.000Z',
    updatedBy: DEVICE,
  };
}

async function records() {
  const vk = fill('record-vk', 32);
  const device = {
    kind: 'device',
    data: {
      deviceId: DEVICE,
      name: 'Chrome（Windows）',
      type: 'extension',
      platform: 'chrome',
      signPub: await signPub('dev-sign'),
      adminPub: null,
      addedAt: '2026-11-01T09:00:00.000Z',
      addedBy: REC_A,
      addedVia: 'pairing',
      revokedAt: null,
    },
    updatedAt: '2026-11-01T09:00:00.000Z',
    updatedBy: REC_A,
  };
  const meta = {
    kind: 'meta',
    data: {
      recoveryKey: 'LV2-0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV',
      pcSessionMaxSec: 3600,
      createdAt: '2026-11-01T09:00:00.000Z',
    },
    updatedAt: '2026-11-01T09:00:00.000Z',
    updatedBy: DEVICE,
  };
  const specs = [
    { name: 'login', id: REC_A, vkVersion: 1, plain: login() },
    {
      name: 'login-history',
      id: REC_B,
      vkVersion: 2,
      plain: login({
        title: 'Bank',
        passwordHistory: [{ password: 'old1', changedAt: '2026-10-01T00:00:00.000Z' }],
      }),
    },
    { name: 'device', id: DEVICE, vkVersion: 1, plain: device },
    { name: 'meta', id: META_RECORD_ID, vkVersion: 1, plain: meta },
  ];
  const cases = [];
  for (const [i, s] of specs.entries()) {
    const nonce = fill(`record-nonce-${i}`, 12);
    det.enqueueRandom(nonce);
    const enc = await encryptRecord(
      det,
      vk,
      { accountId: ACCOUNT, recordId: s.id, vkVersion: s.vkVersion },
      s.plain as never,
    );
    det.assertDrained();
    const json = JSON.stringify(s.plain);
    cases.push({
      name: s.name,
      recordId: s.id,
      vkVersion: s.vkVersion,
      aad: recordAad(ACCOUNT, s.id, s.vkVersion),
      plain: s.plain,
      nonceHex: hex(nonce),
      jsonByteLength: utf8Encode(json).length,
      paddedByteLength: base64urlDecode(enc.ct).length - 16,
      encrypted: enc,
    });
  }
  const first = cases[0] as (typeof cases)[number];
  write('records.json', {
    description:
      'Spec 6.2. plaintext = JSON.stringify(plain) padded with 0x20 to a multiple of 256 bytes.',
    vkHex: hex(vk),
    accountId: ACCOUNT,
    cases,
    negative: [
      {
        name: 'tampered tag',
        accountId: ACCOUNT,
        recordId: first.recordId,
        vkVersion: first.vkVersion,
        encrypted: { nonce: first.encrypted.nonce, ct: flipLast(first.encrypted.ct) },
      },
      {
        name: 'tampered ciphertext',
        accountId: ACCOUNT,
        recordId: first.recordId,
        vkVersion: first.vkVersion,
        encrypted: { nonce: first.encrypted.nonce, ct: flipFirst(first.encrypted.ct) },
      },
      {
        name: 'wrong vkVersion in AAD',
        accountId: ACCOUNT,
        recordId: first.recordId,
        vkVersion: first.vkVersion + 1,
        encrypted: first.encrypted,
      },
      {
        name: 'swapped record id',
        accountId: ACCOUNT,
        recordId: REC_B,
        vkVersion: first.vkVersion,
        encrypted: first.encrypted,
      },
      {
        name: 'wrong accountId',
        accountId: OTHER_ACCOUNT,
        recordId: first.recordId,
        vkVersion: first.vkVersion,
        encrypted: first.encrypted,
      },
    ],
  });

  const pad = [];
  for (const notesLength of [0, 1, 100, 150, 200, 300, 600, 1000]) {
    const plain = login({ notes: 'x'.repeat(notesLength) });
    det.enqueueRandom(fill('pad-nonce', 12));
    const enc = await encryptRecord(
      det,
      vk,
      { accountId: ACCOUNT, recordId: REC_A, vkVersion: 1 },
      plain as never,
    );
    const jsonByteLength = utf8Encode(JSON.stringify(plain)).length;
    pad.push({
      notesLength,
      jsonByteLength,
      paddedByteLength: Math.ceil(jsonByteLength / 256) * 256,
      ciphertextBytes: base64urlDecode(enc.ct).length,
    });
  }
  write('record-padding.json', {
    description:
      'ciphertextBytes = paddedByteLength + 16 (GCM tag). Record = login with notes of N ASCII chars.',
    vkHex: hex(vk),
    accountId: ACCOUNT,
    recordId: REC_A,
    nonceHex: hex(fill('pad-nonce', 12)),
    cases: pad,
  });
}

// ---------------------------------------------------------------- seal.json
async function sealVectors() {
  const recipient = await keyPair('seal-recipient');
  const cases = [];
  const specs = [
    { name: 'pairing', ctx: sealContextPair(REC_A), label: 'seal-eph-1' },
    { name: 'unlock', ctx: sealContextUnlock(REC_B), label: 'seal-eph-2' },
  ];
  for (const s of specs) {
    const eph = await keyPair(s.label);
    const nonce = fill(`${s.label}-nonce`, 12);
    const m = {
      vk: b64(fill('seal-vk', 32)),
      vkVersion: 1,
      sessionMaxSec: 3600,
      issuedAt: '2026-11-11T09:00:00.000Z',
    };
    det.enqueueKeyPair(eph);
    det.enqueueRandom(nonce);
    const envelope = await seal(det, recipient.publicKey, s.ctx, m as never);
    det.assertDrained();
    const z = await web.ecdh(eph.privateKey, recipient.publicKey);
    const salt = await web.sha256(new Uint8Array([...eph.publicKey, ...recipient.publicKey]));
    const k = await web.hkdfSha256(z, salt, utf8Encode(sealHkdfInfo(s.ctx)), 32);
    cases.push({
      name: s.name,
      ctx: s.ctx,
      hkdfInfo: sealHkdfInfo(s.ctx),
      aad: sealAad(s.ctx),
      senderPrivateKeyHex: hex(eph.privateKey),
      senderPublicKeyHex: hex(eph.publicKey),
      nonceHex: hex(nonce),
      plaintext: m,
      plaintextJson: JSON.stringify(m),
      intermediates: { sharedXHex: hex(z), saltHex: hex(salt), keyHex: hex(k) },
      envelope,
    });
  }
  const c0 = cases[0] as (typeof cases)[number];
  const stranger = await keyPair('seal-stranger');
  write('seal.json', {
    description:
      'Spec 8.5. salt = SHA-256(S || R), info = "localvault/v2/seal|" + ctx, nonce given.',
    recipientPrivateKeyHex: hex(recipient.privateKey),
    recipientPublicKeyHex: hex(recipient.publicKey),
    cases,
    negative: [
      { name: 'wrong context', ctx: sealContextUnlock(REC_A), envelope: c0.envelope },
      {
        name: 'tampered ciphertext',
        ctx: c0.ctx,
        envelope: { ...c0.envelope, ct: flipFirst(c0.envelope.ct) },
      },
      {
        name: 'tampered tag',
        ctx: c0.ctx,
        envelope: { ...c0.envelope, ct: flipLast(c0.envelope.ct) },
      },
      {
        name: 'wrong recipient key',
        ctx: c0.ctx,
        recipientPrivateKeyHex: hex(stranger.privateKey),
        envelope: c0.envelope,
      },
    ],
  });
}

// ---------------------------------------------------------------- signed-strings.json + pairing
async function signed() {
  const key = await keyPair('signer');
  const eph = await keyPair('unlock-eph');
  const deviceKey = await keyPair('pair-device');
  const challenge = b64(fill('challenge', 32));
  const requestNonce = b64(fill('unlock-nonce', 16));
  const unlockFields = {
    accountId: ACCOUNT,
    deviceId: DEVICE,
    requestNonce,
    ephPub: b64(eph.publicKey),
    code: '42',
    issuedAt: '2026-11-11T09:00:00Z',
  };
  const body = utf8Encode('{"keyset":{"keysetVersion":2}}');
  const adminNonce = fill('admin-nonce', 16);
  const adminFields = {
    method: 'PUT' as const,
    path: '/v1/keyset',
    bodyHash: await adminBodyHash(web, body),
    ts: 1_794_387_600,
    nonce: b64(adminNonce),
  };
  const adminNoBody = {
    method: 'GET' as const,
    path: '/v1/devices?x=1',
    bodyHash: await adminBodyHash(web, undefined),
    ts: 1_794_387_601,
    nonce: b64(fill('admin-nonce-2', 16)),
  };

  const highS = async (sigB64: string) => {
    const sig = base64urlDecode(sigB64);
    const s = BigInt(`0x${hex(sig.slice(32))}`);
    const out = new Uint8Array(sig);
    out.set(
      Uint8Array.from((P256_N - s).toString(16).padStart(64, '0').match(/../g) as string[], (h) =>
        Number.parseInt(h, 16),
      ),
      32,
    );
    return b64(out);
  };
  const sign = async (text: string) => b64(await noble.ecdsaSign(key.privateKey, utf8Encode(text)));

  const authText = authSignString(DEVICE, challenge);
  const authSig = await signAuthChallenge(signer, key.privateKey, DEVICE, challenge);
  const unlockText = unlockSignString(unlockFields);
  const unlockSig = await signUnlockRequest(signer, key.privateKey, unlockFields);
  const adminText = adminSignString(adminFields);
  const adminSig = await sign(adminText);
  det.enqueueRandom(adminNonce);
  const adminHeader = await buildAdminHeader(signer, key.privateKey, {
    method: 'PUT',
    path: '/v1/keyset',
    body,
    deviceId: DEVICE,
    nowSec: adminFields.ts,
  });
  det.assertDrained();
  const adminNoBodyText = adminSignString(adminNoBody);

  const items = [
    {
      name: 'auth challenge',
      text: authText,
      signature: authSig,
      input: { deviceId: DEVICE, challenge },
    },
    { name: 'unlock request', text: unlockText, signature: unlockSig, input: unlockFields },
    {
      name: 'admin (with body)',
      text: adminText,
      signature: adminSig,
      input: { ...adminFields, bodyUtf8: new TextDecoder().decode(body) },
    },
    {
      name: 'admin (no body)',
      text: adminNoBodyText,
      signature: await sign(adminNoBodyText),
      input: adminNoBody,
    },
  ];
  write('signed-strings.json', {
    description:
      'UTF-8 text is exactly what is signed (SHA-256 + ECDSA P-256, P1363). Signatures are valid; high-S variants must verify too. Newlines are LF, no trailing newline.',
    signerPrivateKeyHex: hex(key.privateKey),
    signerPublicKey: b64(key.publicKey),
    items: await Promise.all(
      items.map(async (i) => ({
        ...i,
        signatureHighS: await highS(i.signature),
        tamperedSignature: flipFirst(i.signature),
      })),
    ),
    adminHeader: {
      value: adminHeader,
      request: { method: 'PUT', path: '/v1/keyset', bodyUtf8: new TextDecoder().decode(body) },
    },
  });

  const fp = await pairingFingerprint(web, b64(deviceKey.publicKey), b64(eph.publicKey));
  write('pairing-fingerprint.json', {
    description:
      'Spec 8.3: base64url(SHA-256(signPub || ephPub)), 65-byte uncompressed public keys.',
    cases: [{ signPub: b64(deviceKey.publicKey), ephPub: b64(eph.publicKey), fingerprint: fp }],
    negative: [
      {
        name: 'swapped order',
        signPub: b64(eph.publicKey),
        ephPub: b64(deviceKey.publicKey),
        fingerprint: fp,
      },
    ],
  });
}

// ---------------------------------------------------------------- recovery key / code
async function recovery() {
  const sks = [
    new Uint8Array(16),
    new Uint8Array(16).fill(255),
    fill('rk-1', 16),
    fill('rk-2', 16),
  ];
  const keyCases = [];
  for (const sk of sks) {
    const text = await formatRecoveryKey(web, sk);
    keyCases.push({ skHex: hex(sk), text, checkChars: text.replaceAll('-', '').slice(-2) });
  }
  const k = keyCases[2] as (typeof keyCases)[number];
  const body = k.text.slice(4).replaceAll('-', '');
  const lenientKey = [
    { input: k.text.toLowerCase() },
    { input: k.text.replaceAll('-', '') },
    { input: k.text.replaceAll('-', ' ') },
    { input: `  ${k.text}  ` },
    { input: body },
    { input: k.text.replaceAll('1', 'l').replaceAll('0', 'o') },
    { input: k.text.replaceAll('1', 'I').replaceAll('0', 'O') },
  ].map((c) => ({ ...c, skHex: k.skHex }));
  const swap = (s: string, i: number) =>
    s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  write('recovery-key.json', {
    description:
      'Spec 5.5. 26 Crockford chars (last 2 bits zero) + 2 check chars from the first 10 bits of SHA-256(SK).',
    cases: keyCases,
    lenientValid: lenientKey,
    invalid: [
      { name: 'wrong check characters', input: swap(body, 27) },
      { name: 'typo in data', input: swap(body, 3) },
      { name: 'too short', input: body.slice(1) },
      { name: 'too long', input: `${body}0` },
      { name: 'letter U not allowed', input: `U${body.slice(1)}` },
      { name: 'empty', input: '' },
    ],
  });

  const rcs = [new Uint8Array(32), fill('rc-1', 32), fill('rc-2', 32)];
  const codeCases = [];
  for (const rc of rcs) {
    const text = await formatRecoveryCode(web, rc);
    codeCases.push({ rcHex: hex(rc), text, checkChars: text.replaceAll('-', '').slice(-2) });
  }
  const c = codeCases[1] as (typeof codeCases)[number];
  const cbody = c.text.slice(5).replaceAll('-', '');
  const rc1 = rcs[1] as Uint8Array;
  const vk = fill('rc-vk', 32);
  const nonce = fill('rc-wrap-nonce', 12);
  det.enqueueRandom(nonce);
  const reg = await createRecoveryCodeRegistration(det, rc1, ACCOUNT, vk, 2);
  det.assertDrained();
  const keysD = await deriveRecoveryCodeKeys(web, rc1, ACCOUNT);
  write('recovery-code.json', {
    description:
      'Spec 8.11.1 derivations and 8.11.2 text format (52 data + 2 check chars, 9 groups of 6).',
    textCases: codeCases,
    lenientValid: [
      c.text.toLowerCase(),
      c.text.replaceAll('-', ' '),
      cbody,
      c.text.replaceAll('1', 'l'),
    ].map((input) => ({ input, rcHex: c.rcHex })),
    invalid: [
      { name: 'wrong check characters', input: swap(cbody, 53) },
      { name: 'typo in data', input: swap(cbody, 10) },
      { name: 'too short', input: cbody.slice(1) },
      { name: 'empty', input: '' },
    ],
    derivation: {
      rcHex: hex(rc1),
      accountId: ACCOUNT,
      vkHex: hex(vk),
      vkVersion: 2,
      rcIdHex: hex(keysD.rcId),
      kekRCHex: hex(keysD.kekRC),
      authRCHex: hex(keysD.authRC),
      aad: rcAad(ACCOUNT, reg.rcId, 2),
      wrapNonceHex: hex(nonce),
      registration: reg,
    },
    negative: [
      { name: 'wrong vkVersion in AAD', vkVersion: 3, wrappedVK: reg.wrappedVK },
      {
        name: 'tampered tag',
        vkVersion: 2,
        wrappedVK: { nonce: reg.wrappedVK.nonce, ct: flipLast(reg.wrappedVK.ct) },
      },
    ],
  });
}

// ---------------------------------------------------------------- export file
async function exportFile() {
  const password = 'export-passphrase 日本語';
  const payload = {
    items: [{ id: REC_A, data: login().data, updatedAt: '2026-11-02T09:00:00.000Z' }],
  };
  const salt = fill('exp-salt', 16);
  const fileKey = fill('exp-key', 32);
  const keyNonce = fill('exp-nonce-key', 12);
  const payloadNonce = fill('exp-nonce-payload', 12);
  det.enqueueRandom(salt, fileKey, keyNonce, payloadNonce);
  const file = await createExportFile(det, {
    exportPassword: password,
    payload: payload as never,
    exportedAt: '2026-11-12T09:00:00.000Z',
  });
  det.assertDrained();
  const opened = await openExportFile(web, password, file);
  if (JSON.stringify(opened.payload) !== JSON.stringify(payload))
    throw new Error('export round trip mismatch');
  write('export-file.json', {
    description:
      'Spec 6.5. Random draw order: kdf salt, file key, wrappedKey nonce, payload nonce. Key = PBKDF2(NFKC(password)).',
    exportPasswordUtf8: password,
    aadKey: EXPORT_AAD_KEY,
    aadPayload: EXPORT_AAD_PAYLOAD,
    saltHex: hex(salt),
    fileKeyHex: hex(fileKey),
    keyNonceHex: hex(keyNonce),
    payloadNonceHex: hex(payloadNonce),
    payload,
    file,
    negative: [
      {
        name: 'wrong password',
        passwordUtf8: 'another-password-1',
        file,
        expectedError: 'E_WRONG_PASSWORD',
      },
      {
        name: 'tampered payload',
        passwordUtf8: password,
        file: { ...file, payload: { ...file.payload, ct: flipLast(file.payload.ct) } },
        expectedError: 'E_IMPORT_FORMAT',
      },
      {
        name: 'tampered wrappedKey',
        passwordUtf8: password,
        file: { ...file, wrappedKey: { ...file.wrappedKey, ct: flipLast(file.wrappedKey.ct) } },
        expectedError: 'E_WRONG_PASSWORD',
      },
    ],
  });
}

await primitives();
await keys();
await records();
await sealVectors();
await signed();
await recovery();
await exportFile();
