// Offscreen document (reason CLIPBOARD): overwrites the clipboard with an empty string (5.10).
chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { target?: string; type?: string };
  if (m.target !== 'offscreen' || m.type !== 'clear-clipboard') return false;
  void clearClipboard().then(() => sendResponse({ ok: true }));
  return true;
});

async function clearClipboard(): Promise<void> {
  try {
    await navigator.clipboard.writeText('');
    return;
  } catch {
    // The offscreen document is not focused; fall back to execCommand.
  }
  const ta = document.createElement('textarea');
  ta.value = ' ';
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
