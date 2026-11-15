// Development storage: files in the app's private document directory (`lv-vault/`).
// The engine implements the §6.6 write protocol (tmp -> bak -> rename) on top of these primitives.
// iCloud backup exclusion: expo-file-system exposes no "exclude from backup" call, so the
// real native module must set NSURLIsExcludedFromBackupKey / noBackupFilesDir; this dev build
// does not (the vault file is ciphertext only).
import { VaultCoreError } from '@localvault/core';
import type { Storage } from '@localvault/vault-engine';
import { Directory, File, Paths } from 'expo-file-system';

export function privateDirectory(name: string): Directory {
  const dir = new Directory(Paths.document, name);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const wrap = (e: unknown): VaultCoreError => {
  // Never forward the native message: it may contain paths. Codes only.
  void e;
  return new VaultCoreError('E_IO', 'file operation failed');
};

export class FileStorage implements Storage {
  readonly #dir: Directory;
  constructor(dirName = 'lv-vault') {
    this.#dir = privateDirectory(dirName);
  }

  #file(name: string): File {
    return new File(this.#dir, name);
  }

  async read(name: string): Promise<Uint8Array | null> {
    try {
      const f = this.#file(name);
      return f.exists ? await f.bytes() : null;
    } catch (e) {
      throw wrap(e);
    }
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    try {
      const f = this.#file(name);
      f.create({ overwrite: true, intermediates: true });
      await f.write(data);
    } catch (e) {
      throw wrap(e);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      const src = this.#file(from);
      if (!src.exists) throw new VaultCoreError('E_IO', 'rename source is missing');
      const dst = this.#file(to);
      if (dst.exists) dst.delete();
      await src.move(dst);
    } catch (e) {
      if (e instanceof VaultCoreError) throw e;
      throw wrap(e);
    }
  }

  async remove(name: string): Promise<void> {
    try {
      const f = this.#file(name);
      if (f.exists) f.delete();
    } catch (e) {
      throw wrap(e);
    }
  }

  async exists(name: string): Promise<boolean> {
    return this.#file(name).exists;
  }
}
