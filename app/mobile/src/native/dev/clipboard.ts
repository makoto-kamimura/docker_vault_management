// DEVELOPMENT STUB: React Native's built-in clipboard needs a package this project forbids
// (expo-clipboard). The value is kept in memory only (never the system pasteboard) and a toast
// tells the developer that a copy happened. The native module writes the real, sensitive pasteboard item.
import type { Clipboard } from '@localvault/vault-engine';
import { useToastStore } from '../../state/toastStore';

export class DevClipboard implements Clipboard {
  /** In-memory only. */
  text: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  async setSensitive(text: string, ttlSec: number | null): Promise<void> {
    this.text = text;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (ttlSec !== null) {
      this.#timer = setTimeout(() => {
        this.text = null;
      }, ttlSec * 1000);
    }
    useToastStore.getState().push('info', '（開発用）クリップボードに書き込みました');
  }
}
