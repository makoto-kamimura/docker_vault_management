import type { TrustedBrowserStore } from '@localvault/vault-engine';
import { File } from 'expo-file-system';
import { privateDirectory } from './storage';

/** Android trusted-browser list (G8), kept in a JSON file on this device. */
export class FileTrustedBrowsers implements TrustedBrowserStore {
  #file(): File {
    return new File(privateDirectory('lv-vault'), 'trusted-browsers.json');
  }
  async load() {
    const f = this.#file();
    if (!f.exists) return [];
    try {
      return JSON.parse(await f.text()) as { packageName: string; label: string }[];
    } catch {
      return [];
    }
  }
  async save(list: { packageName: string; label: string }[]) {
    const f = this.#file();
    f.create({ overwrite: true });
    await f.write(JSON.stringify(list));
  }
}
