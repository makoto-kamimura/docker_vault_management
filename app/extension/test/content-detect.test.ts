// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { findForms } from '../src/content/detect';
import { fillFields } from '../src/content/fill';
import { isVisible } from '../src/content/visibility';

// happy-dom has no layout: give every element a plausible box unless data-rect says otherwise.
beforeEach(() => {
  document.body.innerHTML = '';
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const raw = this.getAttribute('data-rect');
    const [l, t, w, h] = raw ? raw.split(',').map(Number) : [10, 10, 200, 30];
    const left = l ?? 0;
    const top = t ?? 0;
    const width = w ?? 0;
    const height = h ?? 0;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

const html = (s: string) => {
  document.body.innerHTML = s;
};

describe('form detection (12.6-1)', () => {
  it('plain login form', () => {
    html(
      '<form><input id=u name=username><input id=p type=password><button>Log in</button></form>',
    );
    const forms = findForms(document);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ kind: 'login' });
    expect(forms[0]?.username?.id).toBe('u');
    expect(forms[0]?.password?.id).toBe('p');
  });

  it('username by autocomplete beats position; email type works', () => {
    html(
      '<form><input id=a name=x><input id=e type=email autocomplete=email><input id=p type=password></form>',
    );
    expect(findForms(document)[0]?.username?.id).toBe('e');
    html('<form><input id=a name=x><input id=m type=email><input id=p type=password></form>');
    expect(findForms(document)[0]?.username?.id).toBe('m');
  });

  it('falls back to the text input directly before the password', () => {
    html('<form><input id=a name=zzz><input id=p type=password></form>');
    expect(findForms(document)[0]?.username?.id).toBe('a');
  });

  it('SPA: a form injected later is found by a rescan', async () => {
    html('<div id=root></div>');
    expect(findForms(document)).toHaveLength(0);
    (document.getElementById('root') as HTMLElement).innerHTML =
      '<input id=u autocomplete=username><input id=p type=password>';
    await Promise.resolve();
    expect(findForms(document)).toHaveLength(1);
  });

  it('finds fields inside OPEN shadow roots', () => {
    html('<div id=host></div>');
    const sr = (document.getElementById('host') as HTMLElement).attachShadow({ mode: 'open' });
    sr.innerHTML = '<form><input id=u autocomplete=username><input id=p type=password></form>';
    const forms = findForms(document);
    expect(forms).toHaveLength(1);
    expect(forms[0]?.password?.id).toBe('p');
  });

  it('ignores hidden-field traps', () => {
    html(`<form>
      <input id=u1 autocomplete=username style="display:none"><input id=p1 type=password style="display:none">
      <input id=p2 type=password style="visibility:hidden">
      <input id=p3 type=password style="opacity:0">
      <input id=p4 type=password data-rect="10,10,0,0">
      <input id=p5 type=password data-rect="-9999,10,200,30">
      <div style="display:none"><input id=p6 type=password></div>
      <div style="opacity:0"><input id=p7 type=password></div>
      <input id=p8 type=password hidden>
    </form>`);
    expect(findForms(document)).toHaveLength(0);
  });

  it('only the visible field of a form with a trap is used', () => {
    html(
      '<form><input id=trap type=password style="opacity:0"><input id=u autocomplete=username><input id=p type=password></form>',
    );
    const f = findForms(document);
    expect(f).toHaveLength(1);
    expect(f[0]?.password?.id).toBe('p');
  });

  it('multi-step: username first, then password-only', () => {
    html(
      '<form id=login><input id=u name=email autocomplete=username><button>次へ</button></form>',
    );
    let f = findForms(document);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'username-step', password: null });
    html('<form><input type=hidden name=email value=a><input id=p type=password></form>');
    f = findForms(document);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'password-step', username: null });
  });

  it('does not flag search boxes or newsletter e-mail fields', () => {
    html(
      '<form role=search><input name=q type=search></form><form><input name=email placeholder="mail"><button>Subscribe</button></form>',
    );
    expect(findForms(document)).toHaveLength(0);
  });

  it('registration (new-password + confirm) gets no icon', () => {
    html(
      '<form><input id=u autocomplete=username><input id=p1 type=password autocomplete=new-password><input id=p2 type=password autocomplete=new-password></form>',
    );
    expect(findForms(document)).toHaveLength(0);
  });
});

describe('visibility', () => {
  it('rejects zero size, off-screen and transparent ancestors; accepts a normal field', () => {
    html(
      '<input id=a><input id=b data-rect="0,0,0,0"><input id=c data-rect="5000,0,200,30"><div style="opacity:0"><input id=d></div>',
    );
    const v = (id: string) => isVisible(document.getElementById(id) as Element);
    expect(v('a')).toBe(true);
    expect(v('b')).toBe(false);
    expect(v('d')).toBe(false);
    // far-right element
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    expect(v('c')).toBe(false);
  });
});

describe('fill (12.6-4, 12.6-5)', () => {
  it('sets values through the native setter and fires input + change', () => {
    html('<input id=u><input id=p type=password>');
    const u = document.getElementById('u') as HTMLInputElement;
    const p = document.getElementById('p') as HTMLInputElement;
    const events: string[] = [];
    for (const e of ['input', 'change']) u.addEventListener(e, () => events.push(e));
    // a framework that shadows .value on the instance must still see the value via the prototype setter
    let tracked = '';
    Object.defineProperty(u, 'value', {
      get: () => tracked,
      set: (v: string) => {
        tracked = `INSTANCE:${v}`;
      },
      configurable: true,
    });
    const r = fillFields([
      { el: u, value: 'alice' },
      { el: p, value: 'pw' },
    ]);
    expect(r).toEqual({ filled: 2, refusedInvisible: 0 });
    expect(tracked).toBe(''); // instance setter bypassed
    expect(events).toEqual(['input', 'change']);
    expect(p.value).toBe('pw');
  });

  it('refuses a field that became invisible after detection (AC-32)', () => {
    html('<input id=u><input id=p type=password>');
    const u = document.getElementById('u') as HTMLInputElement;
    const p = document.getElementById('p') as HTMLInputElement;
    p.style.opacity = '0';
    const r = fillFields([
      { el: u, value: 'alice' },
      { el: p, value: 'pw' },
    ]);
    expect(r).toEqual({ filled: 1, refusedInvisible: 1 });
    expect(p.value).toBe('');
  });

  it('skips undefined values and null fields', () => {
    html('<input id=u>');
    const u = document.getElementById('u') as HTMLInputElement;
    expect(
      fillFields([
        { el: u, value: undefined },
        { el: null, value: 'x' },
      ]),
    ).toEqual({ filled: 0, refusedInvisible: 0 });
  });
});
