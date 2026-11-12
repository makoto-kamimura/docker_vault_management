// Content script: detection, icon, candidate list, unlock panel, fill. Never fills on page load.
import { ja } from '../i18n/ja';
import { collectShadowRoots, type FormTarget, findForms } from './detect';
import { fillFields } from './fill';
import { Overlay, type PanelItem } from './ui';
import { isVisible } from './visibility';

type Reply<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

async function send<T>(message: unknown): Promise<Reply<T>> {
  try {
    const r = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
    return r ?? { ok: false, error: { code: 'E_INTERNAL', message: '' } };
  } catch {
    return { ok: false, error: { code: 'E_INTERNAL', message: '' } };
  }
}

type Candidates =
  | { kind: 'locked'; paired: boolean }
  | { kind: 'insecure'; host: string }
  | { kind: 'unsupported' }
  | { kind: 'ok'; host: string; framed: boolean; items: PanelItem[] };

type UnlockPoll =
  | { state: 'unlocked' | 'idle' | 'denied' | 'expired' }
  | { state: 'waiting'; code: string; expiresAt: number }
  | { state: 'failed'; reason: string };

export function startContent(): void {
  if (!document.documentElement) return;
  const overlay = new Overlay(
    document,
    {
      icon: ja.content.iconLabel,
      panel: ja.content.panelLabel,
      close: ja.content.close,
      code: ja.content.codeLabel,
      cancel: ja.content.cancel,
      remaining: ja.popup.remaining,
    },
    isVisible,
  );
  let targets: FormTarget[] = [];
  let pollTimer: number | null = null;

  const stopPolling = () => {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  };
  overlay.onClose = stopPolling;

  const targetFor = (anchor: HTMLInputElement) => targets.find((t) => t.anchor === anchor);

  async function pick(target: FormTarget, id: string, insecureConfirmed: boolean) {
    const usernameVisible = target.username !== null && isVisible(target.username);
    const fields =
      target.kind === 'username-step'
        ? 'username'
        : target.kind === 'password-step' || !usernameVisible
          ? 'password'
          : 'both';
    const res = await send<{ username?: string; password?: string }>({
      type: 'fill',
      id,
      fields,
      ...(insecureConfirmed ? { insecureConfirmed: true } : {}),
    });
    if (!res.ok) {
      overlay.show(target.anchor, { kind: 'message', text: ja.content.fillFailed });
      return;
    }
    const out = fillFields([
      { el: fields === 'password' ? null : target.username, value: res.data.username },
      { el: target.password, value: res.data.password },
    ]);
    if (out.refusedInvisible > 0) {
      overlay.show(target.anchor, { kind: 'message', text: ja.content.fieldHidden });
    } else {
      overlay.closePanel(false);
    }
  }

  function startUnlock(target: FormTarget) {
    void (async () => {
      const s = await send<{ code: string; expiresAt: number }>({ type: 'unlock-start' });
      if (!s.ok) {
        overlay.show(target.anchor, { kind: 'message', text: ja.content.unlockFailed });
        return;
      }
      overlay.show(target.anchor, {
        kind: 'waiting',
        code: s.data.code,
        expiresAt: s.data.expiresAt,
        onCancel: () => {
          void send({ type: 'unlock-cancel' });
          overlay.closePanel(true);
        },
      });
      stopPolling();
      pollTimer = window.setInterval(() => {
        void (async () => {
          const p = await send<UnlockPoll>({ type: 'unlock-poll' });
          if (!p.ok) return;
          if (p.data.state === 'unlocked') {
            stopPolling();
            void openPanel(target);
          } else if (p.data.state !== 'waiting') {
            stopPolling();
            overlay.show(target.anchor, { kind: 'message', text: ja.content.unlockFailed });
          }
        })();
      }, 2000);
    })();
  }

  async function openPanel(target: FormTarget) {
    const c = await send<Candidates>({ type: 'candidates' });
    if (!c.ok) {
      overlay.show(target.anchor, { kind: 'message', text: ja.content.unlockFailed });
      return;
    }
    const d = c.data;
    if (d.kind === 'locked') {
      if (!d.paired) {
        overlay.show(target.anchor, { kind: 'not-paired', text: ja.content.notPaired });
      } else {
        overlay.show(target.anchor, {
          kind: 'locked',
          prompt: ja.content.unlockPrompt,
          button: ja.content.unlockButton,
          onUnlock: () => startUnlock(target),
        });
      }
    } else if (d.kind === 'insecure') {
      // 9.1-2 / 12.6-5: http only after an explicit warning + confirmation, then manual search.
      overlay.show(target.anchor, {
        kind: 'insecure',
        title: ja.content.insecureTitle,
        body: ja.content.insecureBody,
        button: ja.content.insecureContinue,
        onContinue: () =>
          overlay.show(target.anchor, {
            kind: 'search',
            placeholder: ja.content.searchPlaceholder,
            emptyText: ja.popup.noMatches,
            onQuery: async (q) => {
              const r = await send<PanelItem[]>({ type: 'search-insecure', query: q });
              return r.ok ? r.data : [];
            },
            onPick: (id) => void pick(target, id, true),
          }),
      });
    } else if (d.kind === 'ok') {
      overlay.show(target.anchor, {
        kind: 'candidates',
        frameLabel: d.framed ? ja.content.frameTitle(d.host) : null,
        items: d.items,
        emptyText: ja.content.noCandidates,
        onPick: (id) => void pick(target, id, false),
      });
    }
  }

  const onIcon = (anchor: HTMLInputElement) => {
    const t = targetFor(anchor);
    if (t === undefined) return;
    if (overlay.isOpen()) overlay.closePanel(false);
    void openPanel(t);
  };

  const scan = () => {
    targets = findForms(document);
    overlay.setAnchors(
      targets.map((t) => t.anchor),
      onIcon,
    );
    for (const t of targets) {
      if (!(t.anchor as HTMLInputElement & { __lv?: boolean }).__lv) {
        (t.anchor as HTMLInputElement & { __lv?: boolean }).__lv = true;
        // Keyboard: Alt+ArrowDown in the field opens the list (never automatic).
        t.anchor.addEventListener('keydown', (e) => {
          if (e.altKey && e.key === 'ArrowDown') {
            e.preventDefault();
            onIcon(t.anchor);
          }
        });
      }
    }
  };

  let scanTimer: number | null = null;
  const observed = new WeakSet<Node>();
  const observer = new MutationObserver(() => {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      observeShadows();
      scan();
    }, 150);
  });
  const opts: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'type', 'disabled'],
  };
  function observeShadows() {
    for (const sr of collectShadowRoots(document)) {
      if (!observed.has(sr)) {
        observed.add(sr);
        observer.observe(sr, opts);
      }
    }
  }
  observer.observe(document.documentElement, opts);
  observeShadows();
  scan();

  // Registers the top frame's browser-reported origin for the popup (the worker uses sender.origin).
  if (window.top === window) void send({ type: 'hello' });
}
