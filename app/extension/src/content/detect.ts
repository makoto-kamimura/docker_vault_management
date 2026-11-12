// Login form detection (12.6-1). Pure DOM, no extension APIs, so it is testable with happy-dom.
import { isVisible } from './visibility';

export type FormKind = 'login' | 'username-step' | 'password-step';

export type FormTarget = {
  kind: FormKind;
  /** The field the icon is attached to. */
  anchor: HTMLInputElement;
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
};

const TEXT_TYPES = new Set(['text', 'email', 'tel', '']);
const USER_KEYWORDS =
  /user|login|log-in|signin|sign-in|account|member|e-?mail|mail|ログイン|ユーザー|メール|アカウント|会員|id$/i;
const NOT_USER = /search|query|検索|captcha|otp|code|コード|zip|postal|郵便/i;
const LOGIN_HINT = /log-?in|sign-?in|ログイン|サインイン|auth|session/i;

/** All inputs in the document including those in OPEN shadow roots. */
export function collectInputs(root: Document | ShadowRoot | Element): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  const visit = (r: Document | ShadowRoot | Element) => {
    for (const el of r.querySelectorAll('*')) {
      if (el instanceof HTMLInputElement) out.push(el);
      const sr = el.shadowRoot; // null for closed roots
      if (sr !== null) visit(sr);
    }
  };
  visit(root);
  return out;
}

/** Open shadow roots below `root` (for the MutationObserver). */
export function collectShadowRoots(root: Document | ShadowRoot | Element): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const visit = (r: Document | ShadowRoot | Element) => {
    for (const el of r.querySelectorAll('*')) {
      const sr = el.shadowRoot;
      if (sr !== null) {
        out.push(sr);
        visit(sr);
      }
    }
  };
  visit(root);
  return out;
}

function ac(el: HTMLInputElement): string[] {
  return (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

function labelText(el: HTMLInputElement): string {
  const parts = [el.name, el.id, el.placeholder, el.getAttribute('aria-label') ?? ''];
  const root = el.getRootNode() as Document | ShadowRoot;
  if (el.id !== '') {
    for (const l of root.querySelectorAll('label')) {
      if (l.htmlFor === el.id) parts.push(l.textContent ?? '');
    }
  }
  const wrap = el.closest('label');
  if (wrap !== null) parts.push(wrap.textContent ?? '');
  return parts.join(' ');
}

function isTextCandidate(el: HTMLInputElement): boolean {
  return TEXT_TYPES.has(el.type.toLowerCase()) && !el.disabled && !el.readOnly;
}

function scopeOf(el: HTMLInputElement): ParentNode {
  return el.form ?? (el.getRootNode() as Document | ShadowRoot);
}

/** Username field for a password field: autocomplete, type=email, keywords, preceding text input. */
export function findUsernameFor(
  password: HTMLInputElement,
  all: HTMLInputElement[],
): HTMLInputElement | null {
  const scope = scopeOf(password);
  const inScope = all.filter(
    (i) => isTextCandidate(i) && isVisible(i) && (i.form === password.form || scope.contains?.(i)),
  );
  const sameScope = inScope.filter((i) => i.form === password.form);
  const candidates = sameScope.length > 0 ? sameScope : inScope;
  const byAutocomplete = candidates.find((i) =>
    ac(i).some((t) => t === 'username' || t === 'email'),
  );
  if (byAutocomplete) return byAutocomplete;
  const byEmailType = candidates.find((i) => i.type.toLowerCase() === 'email');
  if (byEmailType) return byEmailType;
  const byKeyword = candidates.find(
    (i) => USER_KEYWORDS.test(labelText(i)) && !NOT_USER.test(labelText(i)),
  );
  if (byKeyword) return byKeyword;
  // the text input that directly precedes the password field in document order
  let prev: HTMLInputElement | null = null;
  for (const i of candidates) {
    if (i.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) prev = i;
  }
  return prev !== null && !NOT_USER.test(labelText(prev)) ? prev : null;
}

function looksLikeUsernameStep(el: HTMLInputElement): boolean {
  if (!isTextCandidate(el) || el.type.toLowerCase() === 'search') return false;
  const text = labelText(el);
  if (NOT_USER.test(text) && !ac(el).includes('username')) return false;
  if (el.closest('[role="search"], search') !== null) return false;
  if (ac(el).includes('username')) return true;
  const form = el.form;
  const formText =
    form === null
      ? ''
      : `${form.id} ${form.className} ${form.getAttribute('action') ?? ''} ${form.getAttribute('name') ?? ''}`;
  // A keyword alone would flag newsletter boxes; require a login hint on the form as well.
  return (
    USER_KEYWORDS.test(text) &&
    (LOGIN_HINT.test(formText) || LOGIN_HINT.test(el.ownerDocument.location?.pathname ?? ''))
  );
}

export function findForms(root: Document | ShadowRoot | Element): FormTarget[] {
  const all = collectInputs(root);
  const passwords = all.filter(
    (i) => i.type.toLowerCase() === 'password' && isVisible(i) && !i.disabled,
  );
  const targets: FormTarget[] = [];
  const usedForms = new Set<Element | Document | ShadowRoot>();
  const usedUsernames = new Set<HTMLInputElement>();

  for (const pw of passwords) {
    if (ac(pw).includes('new-password') && passwords.length > 1) continue; // registration / change
    const group = pw.form ?? (pw.getRootNode() as Document | ShadowRoot);
    if (usedForms.has(group) && pw.form !== null) continue; // confirm-password field: first one wins
    usedForms.add(group);
    const username = findUsernameFor(pw, all);
    if (username !== null) usedUsernames.add(username);
    targets.push({ kind: 'login', anchor: pw, username, password: pw });
  }

  // A visible username field with no visible password field around it: multi-step login (step 1).
  const pwScopes = new Set(passwords.map((p) => p.form ?? p.getRootNode()));
  for (const el of all) {
    if (usedUsernames.has(el) || !isVisible(el)) continue;
    if (pwScopes.has(el.form ?? el.getRootNode())) continue;
    if (passwords.length > 0 && el.form === null) continue;
    if (looksLikeUsernameStep(el)) {
      targets.push({ kind: 'username-step', anchor: el, username: el, password: null });
    }
  }
  return targets.map((t) =>
    t.kind === 'login' && t.username === null ? { ...t, kind: 'password-step' as const } : t,
  );
}
