// Export / import / CSV files for the development core: bytes live in the cache directory;
// `pickFile` (expo-document-picker) and `shareFile` (expo-sharing) are used by the backup screens.
import { VaultCoreError } from '@localvault/core';
import type { FileAccess } from '@localvault/vault-engine';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export class DevFiles implements FileAccess {
  #dir(): Directory {
    const d = new Directory(Paths.cache, 'lv-files');
    if (!d.exists) d.create({ intermediates: true, idempotent: true });
    return d;
  }

  async write(suggestedName: string, data: Uint8Array): Promise<string> {
    const safe = suggestedName.replace(/[^A-Za-z0-9._-]/g, '_');
    const f = new File(this.#dir(), `${Date.now()}-${safe}`);
    f.create({ overwrite: true });
    await f.write(data);
    return f.uri;
  }

  async read(uri: string): Promise<Uint8Array> {
    const f = new File(uri);
    if (!f.exists) throw new VaultCoreError('E_IO', 'file not found');
    return f.bytes();
  }

  async delete(uri: string): Promise<void> {
    const f = new File(uri);
    if (f.exists) f.delete();
  }
}

/** Lets the user choose a file; returns its URI or null when canceled. */
export async function pickFile(): Promise<string | null> {
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
  return r.canceled ? null : (r.assets[0]?.uri ?? null);
}

export async function shareFile(uri: string): Promise<void> {
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
}
