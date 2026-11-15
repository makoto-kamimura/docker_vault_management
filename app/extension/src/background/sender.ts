// Classifies `chrome.runtime.MessageSender`. Only data the browser fills in is used.
export type RawSender = {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  tab?: { id?: number };
};

export type SenderInfo =
  | { kind: 'content'; origin: string | undefined; frameId: number; tabId: number | undefined }
  | { kind: 'extension' }
  | { kind: 'unknown' };

export function classifySender(
  s: RawSender,
  extensionId: string,
  extensionBaseUrl: string,
): SenderInfo {
  if (s.id !== extensionId) return { kind: 'unknown' };
  // Extension pages (popup, options — the latter may be inside a tab).
  if (s.url?.startsWith(extensionBaseUrl) === true) return { kind: 'extension' };
  if (s.tab !== undefined && typeof s.frameId === 'number') {
    return { kind: 'content', origin: s.origin, frameId: s.frameId, tabId: s.tab.id };
  }
  return { kind: 'unknown' };
}
