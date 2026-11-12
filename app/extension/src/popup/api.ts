export type Reply<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

export async function call<T>(message: unknown): Promise<Reply<T>> {
  try {
    const r = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
    return r ?? { ok: false, error: { code: 'E_INTERNAL', message: '' } };
  } catch {
    return { ok: false, error: { code: 'E_INTERNAL', message: '' } };
  }
}

export type Status = {
  paired: boolean;
  serverUrl: string | null;
  deviceName: string | null;
  locked: boolean;
  expiresAt: number | null;
  singleUse: boolean;
  pending:
    | null
    | { kind: 'unlock'; code: string; expiresAt: number }
    | { kind: 'pair'; expiresAt: number };
  itemCount: number;
  skipped: number;
  lastSyncedAt: number | null;
  warning: { kind: 'rollback'; detail: string; at: number } | null;
  notice: { kind: 'revoked' | 'account_deleted' | 'unpaired'; at: number } | null;
  clipboardClearSec: 30 | 60 | 120 | null;
};

export function themeStyle(css: string): void {
  const s = document.createElement('style');
  s.textContent = css;
  document.head.append(s);
}
