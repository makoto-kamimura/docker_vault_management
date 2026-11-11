import { z } from 'zod';
import { base64urlDecode } from './base64url';
import {
  BYTES,
  FIELD,
  KDF_MAX_ITERATIONS,
  KDF_MIN_ITERATIONS,
  MAX_CIPHERTEXT_BYTES,
  PC_SESSION_MAX_SEC,
  RC_WAIT_SEC,
} from './limits';

// ---------------------------------------------------------------- primitives

/** Fixed id of the singleton meta record (spec §6.2). */
export const META_RECORD_ID = '00000000-0000-4000-8000-000000000001';

/** Lower-case canonical UUID v4. */
export const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'uuid v4');

/** base64url string that decodes to exactly `n` bytes. */
export function b64Bytes(n: number) {
  return z.string().refine(
    (s) => {
      try {
        return base64urlDecode(s).length === n;
      } catch {
        return false;
      }
    },
    { message: `base64url of ${n} bytes` },
  );
}

/** base64url string decoding to 1..max bytes. */
export function b64Max(max: number) {
  return z.string().refine(
    (s) => {
      try {
        const l = base64urlDecode(s).length;
        return l >= 1 && l <= max;
      } catch {
        return false;
      }
    },
    { message: `base64url of 1..${max} bytes` },
  );
}

export const nonceSchema = b64Bytes(BYTES.nonce);
/** AES-GCM ciphertext including the 16 byte tag. */
export const ciphertextSchema = b64Max(MAX_CIPHERTEXT_BYTES);
export const signPubSchema = b64Bytes(BYTES.signPub);
export const sigSchema = b64Bytes(BYTES.sig);

/** ISO 8601 UTC (`Z`), fractional seconds allowed. */
export const isoDateTimeSchema = z.iso.datetime();
/** ISO 8601 UTC at second precision, e.g. 2026-11-11T09:00:00Z (signed strings, §8.4). */
export const isoSecondsSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .pipe(isoDateTimeSchema);

const posInt = z.int().min(1);
const nonNegInt = z.int().min(0);

/** Recovery key display form `LV2-XXXX-...` (Crockford Base32, 7 groups of 4). */
export const RECOVERY_KEY_REGEX = /^LV2(?:-[0-9A-HJKMNP-TV-Z]{4}){7}$/;
export const recoveryKeySchema = z.string().regex(RECOVERY_KEY_REGEX);

export const pcSessionMaxSecSchema = z.union([
  z.literal(PC_SESSION_MAX_SEC[0]),
  z.literal(PC_SESSION_MAX_SEC[1]),
  z.literal(PC_SESSION_MAX_SEC[2]),
  z.literal(PC_SESSION_MAX_SEC[3]),
]);
export type PcSessionMaxSec = z.infer<typeof pcSessionMaxSecSchema>;

export const rcWaitSecSchema = z.union([
  z.literal(RC_WAIT_SEC[0]),
  z.literal(RC_WAIT_SEC[1]),
  z.literal(RC_WAIT_SEC[2]),
]);
export type RcWaitSec = z.infer<typeof rcWaitSecSchema>;

// ---------------------------------------------------------------- §6.1 plaintext records

export const urlEntrySchema = z.strictObject({
  url: z.string().min(1).max(FIELD.urlMax),
  match: z.enum(['domain', 'host']),
});
export type UrlEntry = z.infer<typeof urlEntrySchema>;

export const androidAppLinkSchema = z.strictObject({
  packageName: z
    .string()
    .max(255)
    .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
  certSha256: z
    .array(z.string().regex(/^[0-9A-F]{64}$/))
    .min(1)
    .max(FIELD.androidCertsMax),
  label: z.string().max(FIELD.androidLabelMax),
  linkedAt: isoDateTimeSchema,
});
export type AndroidAppLink = z.infer<typeof androidAppLinkSchema>;

/** F2 (FR-28): newest first, max 5. */
export const passwordHistoryEntrySchema = z.strictObject({
  password: z.string().max(FIELD.passwordMax),
  changedAt: isoDateTimeSchema,
});
export type PasswordHistoryEntry = z.infer<typeof passwordHistoryEntrySchema>;

export const loginDataSchema = z.strictObject({
  title: z.string().min(FIELD.titleMin).max(FIELD.titleMax),
  username: z.string().max(FIELD.usernameMax),
  password: z.string().max(FIELD.passwordMax),
  urls: z.array(urlEntrySchema).max(FIELD.urlsMax),
  androidApps: z.array(androidAppLinkSchema).max(FIELD.androidAppsMax),
  notes: z.string().max(FIELD.notesMax),
  favorite: z.boolean(),
  createdAt: isoDateTimeSchema,
  trashedAt: isoDateTimeSchema.nullable(),
  conflictOf: uuidSchema.nullable(),
  passwordHistory: z.array(passwordHistoryEntrySchema).max(FIELD.passwordHistoryMax).optional(),
});
export type LoginData = z.infer<typeof loginDataSchema>;

/** Absent `passwordHistory` is treated as `[]`. */
export function passwordHistoryOf(
  data: Pick<LoginData, 'passwordHistory'>,
): PasswordHistoryEntry[] {
  return data.passwordHistory ?? [];
}

export const devicePlatformSchema = z.enum(['ios', 'android', 'chrome', 'edge', 'brave']);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;
export const deviceTypeSchema = z.enum(['mobile', 'extension']);
export type DeviceType = z.infer<typeof deviceTypeSchema>;

export const deviceDataSchema = z.strictObject({
  deviceId: uuidSchema,
  name: z.string().min(FIELD.deviceNameMin).max(FIELD.deviceNameMax),
  type: deviceTypeSchema,
  platform: devicePlatformSchema,
  signPub: signPubSchema,
  adminPub: signPubSchema.nullable(),
  addedAt: isoDateTimeSchema,
  addedBy: uuidSchema,
  addedVia: z.enum(['setup', 'pairing', 'recovery-key', 'recovery-code']),
  revokedAt: isoDateTimeSchema.nullable(),
});
export type DeviceData = z.infer<typeof deviceDataSchema>;

export const metaDataSchema = z.strictObject({
  recoveryKey: recoveryKeySchema,
  pcSessionMaxSec: pcSessionMaxSecSchema,
  createdAt: isoDateTimeSchema,
});
export type MetaData = z.infer<typeof metaDataSchema>;

const recordMeta = { updatedAt: isoDateTimeSchema, updatedBy: uuidSchema };

export const recordPlainSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('login'), data: loginDataSchema, ...recordMeta }),
  z.strictObject({ kind: z.literal('device'), data: deviceDataSchema, ...recordMeta }),
  z.strictObject({ kind: z.literal('meta'), data: metaDataSchema, ...recordMeta }),
]);
export type RecordPlain = z.infer<typeof recordPlainSchema>;
export type RecordKind = RecordPlain['kind'];

// ---------------------------------------------------------------- §6.2 encrypted records

const liveCipher = { deleted: z.literal(false), nonce: nonceSchema, ct: ciphertextSchema };
const goneCipher = { deleted: z.literal(true), nonce: z.null(), ct: z.null() };

export const encryptedRecordSchema = z.discriminatedUnion('deleted', [
  z.strictObject({ id: uuidSchema, rev: nonNegInt, vkVersion: posInt, ...liveCipher }),
  z.strictObject({ id: uuidSchema, rev: nonNegInt, vkVersion: posInt, ...goneCipher }),
]);
export type EncryptedRecord = z.infer<typeof encryptedRecordSchema>;

export const recordChangeSchema = z.discriminatedUnion('deleted', [
  z.strictObject({ id: uuidSchema, baseRev: nonNegInt, vkVersion: posInt, ...liveCipher }),
  z.strictObject({ id: uuidSchema, baseRev: nonNegInt, vkVersion: posInt, ...goneCipher }),
]);
export type RecordChange = z.infer<typeof recordChangeSchema>;

export const pushResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ id: uuidSchema, status: z.literal('ok'), rev: posInt }),
  z.strictObject({ id: uuidSchema, status: z.literal('conflict'), current: encryptedRecordSchema }),
]);
export type PushResult = z.infer<typeof pushResultSchema>;

/** A staged record of a key rotation (G12): no rev, vkVersion is the rotation's newVkVersion. */
export const rotationRecordSchema = z.discriminatedUnion('deleted', [
  z.strictObject({ id: uuidSchema, ...liveCipher }),
  z.strictObject({ id: uuidSchema, ...goneCipher }),
]);
export type RotationRecord = z.infer<typeof rotationRecordSchema>;

// ---------------------------------------------------------------- keyset

export const kdfSchema = z.strictObject({
  alg: z.literal('PBKDF2-HMAC-SHA256'),
  iterations: z.int().min(KDF_MIN_ITERATIONS).max(KDF_MAX_ITERATIONS),
  salt: b64Bytes(BYTES.kdfSalt),
});
export type Kdf = z.infer<typeof kdfSchema>;

export const wrappedVkSchema = z.strictObject({
  nonce: nonceSchema,
  ct: b64Bytes(BYTES.wrappedVkCt),
});
export type WrappedVk = z.infer<typeof wrappedVkSchema>;

export const keysetSchema = z.strictObject({
  keysetVersion: posInt,
  vkVersion: posInt,
  kdf: kdfSchema,
  wrappedVK: wrappedVkSchema,
});
export type Keyset = z.infer<typeof keysetSchema>;

// ---------------------------------------------------------------- §8.5 Seal

export const sealEnvelopeSchema = z.strictObject({
  epk: b64Bytes(BYTES.ephPub),
  nonce: nonceSchema,
  ct: ciphertextSchema,
});
export type SealEnvelope = z.infer<typeof sealEnvelopeSchema>;

/** Seal plaintext `m`. For pairing / unlock responses. */
export const sealPlaintextSchema = z.strictObject({
  vk: b64Bytes(BYTES.vk),
  vkVersion: posInt,
  sessionMaxSec: pcSessionMaxSecSchema,
  issuedAt: isoDateTimeSchema,
});
export type SealPlaintext = z.infer<typeof sealPlaintextSchema>;

// ---------------------------------------------------------------- §6.3 vault file

export const vaultFileRecordSchema = z.discriminatedUnion('deleted', [
  z.strictObject({
    id: uuidSchema,
    rev: nonNegInt,
    vkVersion: posInt,
    ...liveCipher,
    dirty: z.boolean(),
    baseRev: nonNegInt,
  }),
  z.strictObject({
    id: uuidSchema,
    rev: nonNegInt,
    vkVersion: posInt,
    ...goneCipher,
    dirty: z.boolean(),
    baseRev: nonNegInt,
  }),
]);
export type VaultFileRecord = z.infer<typeof vaultFileRecordSchema>;

export const vaultFileSchema = z.strictObject({
  format: z.literal('localvault'),
  version: z.literal(2),
  accountId: uuidSchema,
  accountName: z.string().min(FIELD.accountNameMin).max(FIELD.accountNameMax),
  serverUrl: z.string().min(1).max(FIELD.urlMax),
  keyset: keysetSchema,
  records: z.array(vaultFileRecordSchema),
  sync: z.strictObject({
    cursor: nonNegInt,
    maxSeenRev: nonNegInt,
    lastSyncedAt: isoDateTimeSchema.nullable(),
  }),
});
export type VaultFile = z.infer<typeof vaultFileSchema>;

// ---------------------------------------------------------------- §6.5 export file

export const exportFileSchema = z.strictObject({
  format: z.literal('localvault-export'),
  version: z.literal(1),
  exportedAt: isoDateTimeSchema,
  kdf: kdfSchema,
  wrappedKey: z.strictObject({ nonce: nonceSchema, ct: b64Bytes(BYTES.wrappedVkCt) }),
  payload: z.strictObject({ nonce: nonceSchema, ct: b64Max(512 * 1024 * 1024) }),
});
export type ExportFile = z.infer<typeof exportFileSchema>;

/** Plaintext of the export `payload`. Logins only. */
export const exportPayloadSchema = z.strictObject({
  items: z.array(
    z.strictObject({ id: uuidSchema, data: loginDataSchema, updatedAt: isoDateTimeSchema }),
  ),
});
export type ExportPayload = z.infer<typeof exportPayloadSchema>;

// ---------------------------------------------------------------- device registration (API)

/** Device fields sent to the server on registration (§8.2, §8.11.4). */
export const deviceRegistrationSchema = z
  .strictObject({
    deviceId: uuidSchema,
    type: deviceTypeSchema,
    platform: devicePlatformSchema,
    signPub: signPubSchema,
    adminPub: signPubSchema.nullable(),
  })
  .refine((d) => (d.type === 'mobile') === (d.adminPub !== null), {
    message: 'adminPub is required for mobile devices and forbidden for extensions',
    path: ['adminPub'],
  })
  .refine(
    (d) =>
      d.type === 'mobile'
        ? d.platform === 'ios' || d.platform === 'android'
        : !(d.platform === 'ios' || d.platform === 'android'),
    { message: 'platform does not match device type', path: ['platform'] },
  );
export type DeviceRegistration = z.infer<typeof deviceRegistrationSchema>;
