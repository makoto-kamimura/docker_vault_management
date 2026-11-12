// Seal: hand a secret (the VK) to a recipient's ephemeral public key — spec §8.5.
//   z = ECDH(s, R); k = HKDF(z, salt = SHA-256(S || R), info = "localvault/v2/seal|" + ctx, 32)
//   c = AES-256-GCM(k, random nonce, m, AAD = "lv|v2|seal|" + ctx)
import {
  BYTES,
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  type SealEnvelope,
  type SealPlaintext,
  sealAad,
  sealEnvelopeSchema,
  sealHkdfInfo,
  sealPlaintextSchema,
  signPubSchema,
  utf8Decode,
  utf8Encode,
} from '@localvault/protocol';
import { wipe } from './bytes';
import type { CryptoProvider } from './crypto/provider';
import { VaultCoreError } from './errors';

async function sealKey(
  p: CryptoProvider,
  z: Uint8Array,
  senderPub: Uint8Array,
  recipientPub: Uint8Array,
  ctx: string,
): Promise<Uint8Array> {
  const salt = await p.sha256(concatBytes(senderPub, recipientPub));
  return p.hkdfSha256(z, salt, utf8Encode(sealHkdfInfo(ctx)), 32);
}

/** `ctx` is `pair|<pairingId>` or `unlock|<requestId>` (see `sealContextPair` / `sealContextUnlock`). */
export async function seal(
  p: CryptoProvider,
  recipientPub: Uint8Array,
  ctx: string,
  m: SealPlaintext,
): Promise<SealEnvelope> {
  if (!signPubSchema.safeParse(base64urlEncode(recipientPub)).success) {
    throw new VaultCoreError('E_INVALID_INPUT', 'recipient public key must be 65 bytes');
  }
  const message = sealPlaintextSchema.safeParse(m);
  if (!message.success)
    throw new VaultCoreError('E_INVALID_INPUT', 'seal plaintext does not match the schema');

  const eph = await p.generateKeyPair();
  const z = await p.ecdh(eph.privateKey, recipientPub);
  const k = await sealKey(p, z, eph.publicKey, recipientPub, ctx);
  const nonce = await p.randomBytes(BYTES.nonce);
  try {
    const ct = await p.aesGcmEncrypt(
      k,
      nonce,
      utf8Encode(JSON.stringify(message.data)),
      utf8Encode(sealAad(ctx)),
    );
    return sealEnvelopeSchema.parse({
      epk: base64urlEncode(eph.publicKey),
      nonce: base64urlEncode(nonce),
      ct: base64urlEncode(ct),
    });
  } finally {
    wipe(eph.privateKey, z, k);
  }
}

/** Throws `CryptoError('E_DECRYPT')` for a wrong key, context or tampered envelope. */
export async function open(
  p: CryptoProvider,
  recipientPrivateKey: Uint8Array,
  ctx: string,
  envelope: SealEnvelope,
): Promise<SealPlaintext> {
  const env = sealEnvelopeSchema.safeParse(envelope);
  if (!env.success) throw new VaultCoreError('E_INVALID_INPUT', 'malformed seal envelope');
  const senderPub = base64urlDecode(env.data.epk);
  const recipientPub = await p.publicKeyOf(recipientPrivateKey);
  const z = await p.ecdh(recipientPrivateKey, senderPub);
  const k = await sealKey(p, z, senderPub, recipientPub, ctx);
  try {
    const plaintext = await p.aesGcmDecrypt(
      k,
      base64urlDecode(env.data.nonce),
      base64urlDecode(env.data.ct),
      utf8Encode(sealAad(ctx)),
    );
    let json: unknown;
    try {
      json = JSON.parse(utf8Decode(plaintext));
    } catch {
      throw new VaultCoreError('E_CORRUPTED', 'seal plaintext is not JSON');
    }
    const m = sealPlaintextSchema.safeParse(json);
    if (!m.success)
      throw new VaultCoreError('E_CORRUPTED', 'seal plaintext does not match the schema');
    return m.data;
  } finally {
    wipe(z, k);
  }
}
