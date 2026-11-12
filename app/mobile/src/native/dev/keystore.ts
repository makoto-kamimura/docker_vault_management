// DEVELOPMENT ONLY keystore: slot values are plain files in `lv-keystore/`. THIS IS NOT SECURE
// (no Keychain / Secure Enclave, no access control): it only emulates the contract so the engine
// and the screens can be exercised. The native module replaces it with Keychain / Keystore.
// Gated slots (`vk.bio`, `admin.key`) require a token from DevBiometric and a matching
// enrollment generation, like the in-memory reference keystore.
import { VaultCoreError } from '@localvault/core';
import {
  type AuthToken,
  BIOMETRIC_GATED_SLOTS,
  type Keystore,
  type KeystoreSlot,
} from '@localvault/vault-engine';
import { File } from 'expo-file-system';
import type { DevBiometric } from './biometric';
import { privateDirectory } from './storage';

export class DevKeystore implements Keystore {
  readonly #dir = privateDirectory('lv-keystore');
  constructor(private readonly biometric: DevBiometric) {}

  #file(slot: KeystoreSlot): File {
    return new File(this.#dir, `${slot}.slot`);
  }

  // File layout: 4 bytes big-endian enrollment generation, then the value.
  async read(slot: KeystoreSlot, auth?: AuthToken): Promise<Uint8Array | null> {
    const f = this.#file(slot);
    if (!f.exists) return null;
    const raw = await f.bytes();
    const generation = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0);
    if (BIOMETRIC_GATED_SLOTS.includes(slot)) {
      if (!this.biometric.isValid(auth)) {
        throw new VaultCoreError('E_AUTH_FAILED', `slot ${slot} needs a biometric prompt`);
      }
      if (generation !== this.biometric.generation)
        throw new VaultCoreError('E_BIOMETRY_INVALIDATED');
    }
    return raw.slice(4);
  }

  async write(slot: KeystoreSlot, value: Uint8Array): Promise<void> {
    const out = new Uint8Array(4 + value.length);
    new DataView(out.buffer).setUint32(0, this.biometric.generation);
    out.set(value, 4);
    const f = this.#file(slot);
    f.create({ overwrite: true, intermediates: true });
    await f.write(out);
  }

  async delete(slot: KeystoreSlot): Promise<void> {
    const f = this.#file(slot);
    if (f.exists) f.delete();
  }
}
