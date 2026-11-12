import { describe, expect, it } from 'vitest';
import { classifySender } from '../src/background/sender';
import { content, createHarness, page, pairAndUnlock } from './helpers/harness';

const A = '11111111-1111-4111-8111-111111111111';

describe('sender classification', () => {
  const id = 'abcdefabcdefabcdefabcdefabcdefab';
  const base = `chrome-extension://${id}/`;
  it('accepts only our own extension id', () => {
    expect(classifySender({ id: 'other', url: `${base}popup.html` }, id, base).kind).toBe(
      'unknown',
    );
    expect(classifySender({}, id, base).kind).toBe('unknown');
  });
  it('extension pages are pages, even inside a tab (options)', () => {
    expect(classifySender({ id, url: `${base}popup.html` }, id, base).kind).toBe('extension');
    expect(
      classifySender({ id, url: `${base}options.html`, tab: { id: 3 }, frameId: 0 }, id, base).kind,
    ).toBe('extension');
  });
  it('a web page frame is content, using the browser-reported origin', () => {
    expect(
      classifySender(
        { id, url: 'https://x.test/a', origin: 'https://x.test', tab: { id: 3 }, frameId: 2 },
        id,
        base,
      ),
    ).toEqual({ kind: 'content', origin: 'https://x.test', frameId: 2, tabId: 3 });
  });
  it('a lookalike url prefix is not an extension page', () => {
    expect(
      classifySender(
        { id, url: `${base.replace('chrome-extension', 'https')}x`, tab: { id: 1 }, frameId: 0 },
        id,
        base,
      ).kind,
    ).toBe('content');
  });
});

describe('message validation and sender checks', () => {
  async function ready() {
    const h = createHarness();
    await h.server.putLogin(A, {
      title: 'A',
      username: 'a',
      password: 'pw',
      urls: [{ url: 'https://a.test', match: 'domain' }],
    });
    return { h, ...(await pairAndUnlock(h)) };
  }

  it('rejects unknown senders outright', async () => {
    const { router } = await ready();
    expect(await router.handle({ type: 'status' }, { kind: 'unknown' })).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_SENDER' },
    });
  });

  it('rejects non-objects, unknown types, extra keys and bad ids', async () => {
    const { router } = await ready();
    for (const bad of [
      null,
      'x',
      5,
      {},
      { type: 'nope' },
      { type: 'status', x: 1 },
      { type: 'fill', id: 'not-a-uuid', fields: 'both' },
      { type: 'fill', id: A, fields: 'all' },
    ]) {
      const r = await router.handle(bad, content('https://a.test'));
      expect(r).toMatchObject({ ok: false, error: { code: 'E_BAD_MESSAGE' } });
    }
  });

  it('a content script cannot copy, lock, pair, unpair or change settings', async () => {
    const { router } = await ready();
    for (const m of [
      { type: 'copy', id: A, field: 'password' },
      { type: 'lock' },
      { type: 'list', query: '' },
      { type: 'pair-start', url: 'https://evil.test' },
      { type: 'unpair' },
      { type: 'set-clipboard-clear', sec: null },
      { type: 'sync' },
      { type: 'accept-server-state' },
    ]) {
      const r = await router.handle(m, content('https://a.test'));
      expect(r, JSON.stringify(m)).toMatchObject({ ok: false, error: { code: 'E_BAD_MESSAGE' } });
    }
  });

  it('an extension page cannot ask for fill (credentials only go to a verified frame)', async () => {
    const { router } = await ready();
    expect(await router.handle({ type: 'fill', id: A, fields: 'both' }, page)).toMatchObject({
      ok: false,
      error: { code: 'E_BAD_MESSAGE' },
    });
  });

  it('content status exposes no counts or names', async () => {
    const { router } = await ready();
    const r = await router.handle({ type: 'status' }, content('https://a.test'));
    expect(r).toEqual({
      ok: true,
      data: { paired: true, locked: false, pending: null, warning: false },
    });
  });

  it('errors never carry secrets', async () => {
    const { router } = await ready();
    const r = await router.handle(
      { type: 'fill', id: A, fields: 'both' },
      content('https://evil.test'),
    );
    expect(JSON.stringify(r)).not.toContain('pw');
  });

  it('maps E_INTERNAL and network failures to retryable', async () => {
    const { h, router } = await ready();
    await h.boot().client.lock();
    h.server.failNext.push({
      path: /unlock-requests/,
      status: 500,
      body: { error: { code: 'E_INTERNAL', message: 'x' } },
    });
    const r = await router.handle({ type: 'unlock-start' }, page);
    expect(r).toMatchObject({ ok: false, error: { code: 'E_INTERNAL', retryable: true } });
    h.server.offline = true;
    const n = await h.boot().router.handle({ type: 'unlock-start' }, page);
    expect(n).toMatchObject({ ok: false, error: { code: 'E_NETWORK', retryable: true } });
  });
});
