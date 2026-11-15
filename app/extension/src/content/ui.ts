// In-page UI inside a CLOSED shadow root: field icon, candidate list, unlock panel (12.1, 12.6-2).
// Built with createElement/textContent only: nothing page- or vault-derived is ever parsed as HTML.
import { hostThemeCss } from '../styles/tokens';

const CSS = `
${hostThemeCss}
*{box-sizing:border-box}
.icon{position:fixed;width:24px;height:24px;border-radius:6px;border:0;padding:3px;cursor:pointer;
  background:var(--lv-color-accent);color:var(--lv-color-on-accent);display:flex;align-items:center;justify-content:center;
  z-index:2147483646;box-shadow:0 1px 3px #0004}
.icon:hover{background:var(--lv-color-accent-pressed)}
.icon:focus-visible,.btn:focus-visible,.item:focus-visible,input:focus-visible{outline:2px solid var(--lv-color-focus-ring);outline-offset:2px}
.icon svg{width:16px;height:16px;fill:currentColor}
.panel{position:fixed;z-index:2147483647;width:300px;max-width:calc(100vw - 16px);max-height:340px;overflow:auto;
  background:var(--lv-color-bg-elevated);color:var(--lv-color-text);border:1px solid var(--lv-color-border);
  border-radius:12px;box-shadow:0 8px 24px #0003;padding:12px;font:14px/1.5 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Yu Gothic UI",sans-serif}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.title{font-weight:600;font-size:13px}
.sub{font-size:12px;color:var(--lv-color-text-secondary)}
.frame{font-size:12px;padding:4px 8px;border-radius:6px;background:var(--lv-color-accent-subtle);color:var(--lv-color-text);margin-bottom:8px}
.list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.item{width:100%;text-align:left;border:1px solid var(--lv-color-border);background:var(--lv-color-surface);color:inherit;
  border-radius:8px;padding:8px 10px;cursor:pointer;display:flex;flex-direction:column}
.item:hover{background:var(--lv-color-accent-subtle)}
.item .t{font-weight:600}.item .u{font-size:12px;color:var(--lv-color-text-secondary)}
.btn{border:1px solid var(--lv-color-border-strong);background:var(--lv-color-surface);color:inherit;border-radius:8px;
  padding:8px 12px;cursor:pointer;min-height:36px;font:inherit}
.btn.primary{background:var(--lv-color-accent);border-color:var(--lv-color-accent);color:var(--lv-color-on-accent);font-weight:600}
.btn.block{width:100%}
.x{border:0;background:transparent;color:var(--lv-color-text-secondary);cursor:pointer;font-size:18px;line-height:1;padding:4px}
.code{font-size:44px;font-weight:700;letter-spacing:.12em;text-align:center;color:var(--lv-color-accent);font-variant-numeric:tabular-nums;margin:8px 0}
.warn{padding:8px;border-radius:8px;border:1px solid var(--lv-color-warning);margin-bottom:8px;font-size:13px}
input{width:100%;min-height:36px;padding:6px 10px;border-radius:8px;border:1px solid var(--lv-color-border-strong);
  background:var(--lv-color-surface);color:inherit;font:inherit;margin-bottom:8px}
.msg{font-size:13px;margin:4px 0 8px}
`;

// Lock-in-shield glyph; static markup that we author ourselves.
const ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Zm0 6a2.5 2.5 0 0 1 1.2 4.7V16h-2.4v-3.3A2.5 2.5 0 0 1 12 8Z"/></svg>';

export type PanelItem = { id: string; title: string; username: string };

export type PanelView =
  | { kind: 'message'; text: string }
  | { kind: 'not-paired'; text: string }
  | { kind: 'locked'; onUnlock: () => void; prompt: string; button: string }
  | { kind: 'waiting'; code: string; expiresAt: number; onCancel: () => void }
  | {
      kind: 'candidates';
      frameLabel: string | null;
      items: PanelItem[];
      emptyText: string;
      onPick: (id: string) => void;
    }
  | {
      kind: 'insecure';
      title: string;
      body: string;
      button: string;
      onContinue: () => void;
    }
  | {
      kind: 'search';
      placeholder: string;
      onQuery: (q: string) => Promise<PanelItem[]>;
      onPick: (id: string) => void;
      emptyText: string;
    };

export type Labels = {
  icon: string;
  panel: string;
  close: string;
  code: string;
  cancel: string;
  remaining: (s: number) => string;
};

export class Overlay {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly layer: HTMLDivElement;
  private icons = new Map<HTMLInputElement, HTMLButtonElement>();
  private panel: HTMLDivElement | null = null;
  private panelAnchor: HTMLInputElement | null = null;
  private timer: number | null = null;
  private raf = 0;
  onClose: (() => void) | null = null;

  constructor(
    private readonly doc: Document,
    private readonly labels: Labels,
    private readonly isVisible: (el: Element) => boolean,
  ) {
    this.host = doc.createElement('div');
    this.host.setAttribute(
      'style',
      'all:initial;position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483647;',
    );
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    this.layer = doc.createElement('div');
    this.root.append(style, this.layer);
    // Keystrokes typed into our UI must not reach page scripts.
    for (const ev of ['keydown', 'keyup', 'keypress', 'input'] as const) {
      this.layer.addEventListener(ev, (e) => {
        if (ev === 'keydown' && (e as KeyboardEvent).key === 'Escape') {
          this.closePanel(true);
        }
        e.stopPropagation();
      });
    }
    (doc.documentElement ?? doc.body).append(this.host);
    const reposition = () => this.schedule();
    doc.defaultView?.addEventListener('scroll', reposition, { capture: true, passive: true });
    doc.defaultView?.addEventListener('resize', reposition, { passive: true });
  }

  /** Syncs the icon set with the detected anchors. */
  setAnchors(anchors: HTMLInputElement[], onClick: (anchor: HTMLInputElement) => void): void {
    for (const [anchor, btn] of this.icons) {
      if (!anchors.includes(anchor)) {
        btn.remove();
        this.icons.delete(anchor);
      }
    }
    for (const anchor of anchors) {
      if (this.icons.has(anchor)) continue;
      const btn = this.doc.createElement('button');
      btn.type = 'button';
      btn.className = 'icon';
      btn.setAttribute('aria-label', this.labels.icon);
      btn.title = this.labels.icon;
      btn.innerHTML = ICON_SVG; // static, author-controlled markup
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(anchor);
      });
      this.layer.append(btn);
      this.icons.set(anchor, btn);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.raf !== 0) return;
    const win = this.doc.defaultView;
    if (win === null) return;
    this.raf = win.requestAnimationFrame(() => {
      this.raf = 0;
      this.position();
    });
  }

  private position(): void {
    for (const [anchor, btn] of this.icons) {
      const show = anchor.isConnected && this.isVisible(anchor);
      btn.style.display = show ? 'flex' : 'none';
      if (!show) continue;
      const r = anchor.getBoundingClientRect();
      btn.style.left = `${Math.max(0, r.right - 30)}px`;
      btn.style.top = `${r.top + (r.height - 24) / 2}px`;
    }
    if (this.panel !== null && this.panelAnchor !== null) this.placePanel(this.panelAnchor);
  }

  private placePanel(anchor: HTMLInputElement): void {
    if (this.panel === null) return;
    const win = this.doc.defaultView;
    const r = anchor.getBoundingClientRect();
    const vw = win?.innerWidth ?? 800;
    const vh = win?.innerHeight ?? 600;
    const width = 300;
    const left = Math.min(Math.max(8, r.right - width), Math.max(8, vw - width - 8));
    const below = r.bottom + 6;
    const top = below + 340 > vh && r.top > 346 ? Math.max(8, r.top - 346) : below;
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
  }

  closePanel(restoreFocus = false): void {
    if (this.timer !== null) {
      this.doc.defaultView?.clearInterval(this.timer);
      this.timer = null;
    }
    const anchor = this.panelAnchor;
    this.panel?.remove();
    this.panel = null;
    this.panelAnchor = null;
    this.onClose?.();
    if (restoreFocus) anchor?.focus();
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  show(anchor: HTMLInputElement, view: PanelView): void {
    if (this.timer !== null) {
      this.doc.defaultView?.clearInterval(this.timer);
      this.timer = null;
    }
    this.panel?.remove();
    const d = this.doc;
    const panel = d.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.labels.panel);

    const head = d.createElement('div');
    head.className = 'head';
    const title = d.createElement('span');
    title.className = 'title';
    title.textContent = this.labels.panel;
    const x = d.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.textContent = '×';
    x.setAttribute('aria-label', this.labels.close);
    x.addEventListener('click', () => this.closePanel(true));
    head.append(title, x);
    panel.append(head);

    const text = (cls: string, t: string) => {
      const p = d.createElement('p');
      p.className = cls;
      p.textContent = t;
      return p;
    };
    const button = (label: string, onClick: () => void, primary = true) => {
      const b = d.createElement('button');
      b.type = 'button';
      b.className = `btn block${primary ? ' primary' : ''}`;
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };
    let focusTarget: HTMLElement | null = x;

    switch (view.kind) {
      case 'message':
      case 'not-paired':
        panel.append(text('msg', view.text));
        break;
      case 'locked': {
        panel.append(text('msg', view.prompt));
        const b = button(view.button, view.onUnlock);
        panel.append(b);
        focusTarget = b;
        break;
      }
      case 'waiting': {
        panel.append(text('msg', this.labels.code));
        const code = text('code', view.code);
        code.setAttribute('aria-live', 'polite');
        const remain = text('sub', '');
        const tick = () => {
          const s = Math.max(0, Math.ceil((view.expiresAt - Date.now()) / 1000));
          remain.textContent = this.labels.remaining(s);
        };
        tick();
        this.timer = this.doc.defaultView?.setInterval(tick, 1000) ?? null;
        const c = button(this.labels.cancel, view.onCancel, false);
        panel.append(code, remain, c);
        focusTarget = c;
        break;
      }
      case 'candidates': {
        if (view.frameLabel !== null) panel.append(text('frame', view.frameLabel));
        if (view.items.length === 0) panel.append(text('msg', view.emptyText));
        else panel.append(this.list(view.items, view.onPick));
        focusTarget = panel.querySelector<HTMLElement>('.item') ?? x;
        break;
      }
      case 'insecure': {
        const w = d.createElement('div');
        w.className = 'warn';
        const t = d.createElement('strong');
        t.textContent = view.title;
        w.append(t, d.createElement('br'), d.createTextNode(view.body));
        const b = button(view.button, view.onContinue);
        panel.append(w, b);
        focusTarget = b;
        break;
      }
      case 'search': {
        const input = d.createElement('input');
        input.type = 'search';
        input.placeholder = view.placeholder;
        input.setAttribute('aria-label', view.placeholder);
        input.autocomplete = 'off';
        const holder = d.createElement('div');
        let seq = 0;
        const run = async () => {
          const n = ++seq;
          const items = await view.onQuery(input.value);
          if (n !== seq) return;
          holder.replaceChildren(
            items.length === 0 ? text('msg', view.emptyText) : this.list(items, view.onPick),
          );
        };
        input.addEventListener('input', () => void run());
        panel.append(input, holder);
        void run();
        focusTarget = input;
        break;
      }
    }

    this.layer.append(panel);
    this.panel = panel;
    this.panelAnchor = anchor;
    this.placePanel(anchor);
    focusTarget?.focus();
  }

  private list(items: PanelItem[], onPick: (id: string) => void): HTMLElement {
    const ul = this.doc.createElement('ul');
    ul.className = 'list';
    ul.setAttribute('role', 'listbox');
    for (const it of items) {
      const li = this.doc.createElement('li');
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.className = 'item';
      b.setAttribute('role', 'option');
      const t = this.doc.createElement('span');
      t.className = 't';
      t.textContent = it.title;
      const u = this.doc.createElement('span');
      u.className = 'u';
      u.textContent = it.username;
      b.append(t, u);
      b.addEventListener('click', () => onPick(it.id));
      b.addEventListener('keydown', (e) => {
        const ev = e as KeyboardEvent;
        if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
        ev.preventDefault();
        const all = [...ul.querySelectorAll<HTMLButtonElement>('.item')];
        const i = all.indexOf(b);
        all[(i + (ev.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
      });
      li.append(b);
      ul.append(li);
    }
    return ul;
  }

  destroy(): void {
    this.closePanel();
    this.host.remove();
  }
}
