import { describe, expect, it } from 'vitest';
import { content, createHarness, page, pairAndUnlock } from './helpers/harness';

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

type Case = {
  name: string;
  stored: string;
  match: 'domain' | 'host';
  origin: string;
  expect: boolean;
};

const cases: Case[] = [
  {
    name: 'T-01',
    stored: 'https://example.com',
    match: 'domain',
    origin: 'https://www.example.com',
    expect: true,
  },
  {
    name: 'T-02',
    stored: 'https://example.com',
    match: 'domain',
    origin: 'https://login.example.com',
    expect: true,
  },
  {
    name: 'T-03',
    stored: 'https://www.example.co.jp',
    match: 'domain',
    origin: 'https://accounts.example.co.jp',
    expect: true,
  },
  {
    name: 'T-04',
    stored: 'https://example.com',
    match: 'domain',
    origin: 'https://example.com.evil.net',
    expect: false,
  },
  {
    name: 'T-05',
    stored: 'https://example.com',
    match: 'domain',
    origin: 'https://examp1e.com',
    expect: false,
  },
  {
    name: 'T-06',
    stored: 'https://alice.github.io',
    match: 'domain',
    origin: 'https://bob.github.io',
    expect: false,
  },
  {
    name: 'T-07',
    stored: 'https://example.com',
    match: 'host',
    origin: 'https://www.example.com',
    expect: false,
  },
  {
    name: 'T-08',
    stored: 'https://example.com',
    match: 'domain',
    origin: 'http://example.com',
    expect: false,
  },
  {
    name: 'T-09',
    stored: 'https://192.168.0.1',
    match: 'domain',
    origin: 'https://192.168.0.1:8443',
    expect: true,
  },
  {
    name: 'T-10',
    stored: 'https://日本語.jp',
    match: 'domain',
    origin: 'https://xn--wgv71a119e.jp',
    expect: true,
  },
];

async function setupWith(stored: string, match: 'domain' | 'host', extra?: { trashed?: boolean }) {
  const h = createHarness();
  await h.server.putLogin(id(1), {
    title: 'Item',
    username: 'u',
    password: 'p-secret',
    urls: [{ url: stored, match }],
    trashed: extra?.trashed,
  });
  return { h, ...(await pairAndUnlock(h)) };
}

describe('matching through the service-worker path (9.4, 9.5)', () => {
  for (const c of cases) {
    it(`${c.name}: ${c.stored} (${c.match}) vs ${c.origin}`, async () => {
      const { router } = await setupWith(c.stored, c.match);
      const res = await router.handle({ type: 'candidates' }, content(c.origin));
      expect(res.ok).toBe(true);
      const data = (res as { data: { kind: string; items?: unknown[] } }).data;
      if (c.origin.startsWith('http://')) expect(data.kind).toBe('insecure');
      else expect(data.kind === 'ok' && (data.items?.length ?? 0) > 0).toBe(c.expect);

      // fill goes through the SAME check
      const fill = await router.handle(
        { type: 'fill', id: id(1), fields: 'both' },
        content(c.origin),
      );
      expect(fill.ok).toBe(c.expect);
    });
  }

  it('T-14: host-registered item shows up for a cross-origin iframe, labelled with the iframe domain', async () => {
    const { router } = await setupWith('https://pay.example.com', 'host');
    // the sender is the IFRAME (frameId 3); the top page (shop.test) is never consulted
    const res = await router.handle({ type: 'candidates' }, content('https://pay.example.com', 3));
    expect(res).toMatchObject({
      ok: true,
      data: { kind: 'ok', host: 'pay.example.com', framed: true, items: [{ id: id(1) }] },
    });
  });

  it('T-15: an item for the top domain is not offered to an evil iframe', async () => {
    const { router } = await setupWith('https://shop.test', 'domain');
    const iframe = await router.handle({ type: 'candidates' }, content('https://ads.evil.net', 2));
    expect(iframe).toMatchObject({ ok: true, data: { kind: 'ok', framed: true, items: [] } });
    const fill = await router.handle(
      { type: 'fill', id: id(1), fields: 'both' },
      content('https://ads.evil.net', 2),
    );
    expect(fill).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN_ORIGIN' } });
    // the genuine top frame still works and is not labelled as framed
    const top = await router.handle({ type: 'candidates' }, content('https://shop.test', 0));
    expect(top).toMatchObject({ ok: true, data: { kind: 'ok', framed: false } });
  });

  it('T-16: trashed items never match', async () => {
    const { router } = await setupWith('https://example.com', 'domain', { trashed: true });
    const res = await router.handle({ type: 'candidates' }, content('https://example.com'));
    expect(res).toMatchObject({ ok: true, data: { kind: 'ok', items: [] } });
  });

  it('never matches on a claimed URL: candidate messages carry no URL at all', async () => {
    const { router } = await setupWith('https://example.com', 'domain');
    const res = await router.handle(
      { type: 'candidates', url: 'https://example.com' },
      content('https://evil.test'),
    );
    expect(res).toMatchObject({ ok: false, error: { code: 'E_BAD_MESSAGE' } });
  });

  it('opaque / missing origins get nothing', async () => {
    const { router } = await setupWith('https://example.com', 'domain');
    for (const o of ['null', undefined, 'chrome-extension://abc']) {
      const res = await router.handle({ type: 'candidates' }, content(o));
      expect(res).toMatchObject({ ok: true, data: { kind: 'unsupported' } });
    }
    const fill = await router.handle({ type: 'fill', id: id(1), fields: 'both' }, content('null'));
    expect(fill.ok).toBe(false);
  });

  it('http pages: manual search + explicit confirmation only', async () => {
    const { router } = await setupWith('https://example.com', 'domain');
    const origin = 'http://insecure.test';
    const unconfirmed = await router.handle(
      { type: 'fill', id: id(1), fields: 'both' },
      content(origin),
    );
    expect(unconfirmed).toMatchObject({ ok: false, error: { code: 'E_INSECURE_PAGE' } });
    const found = await router.handle({ type: 'search-insecure', query: 'item' }, content(origin));
    expect(found).toMatchObject({ ok: true, data: [{ id: id(1) }] });
    const ok = await router.handle(
      { type: 'fill', id: id(1), fields: 'both', insecureConfirmed: true },
      content(origin),
    );
    expect(ok).toMatchObject({ ok: true, data: { password: 'p-secret' } });
    // search-insecure is refused on https pages
    const refused = await router.handle(
      { type: 'search-insecure', query: '' },
      content('https://example.com'),
    );
    expect(refused.ok).toBe(false);
  });

  it('fill returns only the requested fields (multi-step login)', async () => {
    const { router } = await setupWith('https://example.com', 'domain');
    const u = await router.handle(
      { type: 'fill', id: id(1), fields: 'username' },
      content('https://example.com'),
    );
    expect(u).toEqual({ ok: true, data: { username: 'u' } });
  });

  it('popup lists the current tab matches first, never including passwords', async () => {
    const h = createHarness();
    await h.server.putLogin(id(1), {
      title: 'Zebra',
      username: 'z',
      password: 'pz',
      urls: [{ url: 'https://z.test', match: 'domain' }],
    });
    await h.server.putLogin(id(2), {
      title: 'Apple',
      username: 'a',
      password: 'pa',
      urls: [{ url: 'https://a.test', match: 'domain' }],
    });
    const { router } = await pairAndUnlock(h);
    await router.handle({ type: 'hello' }, content('https://z.test', 0, 7));
    const res = await h.boot().router.handle({ type: 'list', query: '', tabId: 7 }, page);
    const data = (res as { data: { id: string; matched: boolean }[] }).data;
    expect(data.map((d) => d.id)).toEqual([id(1), id(2)]);
    expect(data[0]?.matched).toBe(true);
    expect(JSON.stringify(res)).not.toContain('pz');
    // a subframe's hello must not register the tab
    await router.handle({ type: 'hello' }, content('https://a.test', 2, 7));
    const again = await h.boot().router.handle({ type: 'list', query: '', tabId: 7 }, page);
    expect((again as { data: { id: string }[] }).data[0]?.id).toBe(id(1));
  });
});
