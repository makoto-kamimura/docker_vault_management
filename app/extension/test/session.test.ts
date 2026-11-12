import { describe, expect, it } from 'vitest';
import { content, createHarness, pairAndUnlock } from './helpers/harness';

const A = '11111111-1111-4111-8111-111111111111';

async function setup(sessionMaxSec = 3600) {
  const h = createHarness();
  h.server.sessionMaxSec = sessionMaxSec;
  await h.server.putLogin(A, {
    title: 'A',
    username: 'alice',
    password: 'hunter2-pw',
    urls: [{ url: 'https://a.test', match: 'domain' }],
  });
  return { h, ...(await pairAndUnlock(h)) };
}

describe('session lifecycle (12.3 / 12.5)', () => {
  it('keeps VK and index only in storage.session', async () => {
    const { h } = await setup();
    expect(Object.keys(h.session.dump())).toEqual(
      expect.arrayContaining(['lvs.session', 'lvs.index']),
    );
    const localText = JSON.stringify(h.local.dump());
    const vk = (h.session.dump()['lvs.session'] as { vk: string }).vk;
    expect(localText).not.toContain(vk);
    // passwords are never in the index
    expect(JSON.stringify(h.session.dump())).not.toContain('hunter2-pw');
    expect(localText).not.toContain('hunter2-pw');
  });

  it('locks at sessionMaxSec (checked before each operation and by the alarm)', async () => {
    const { h, client } = await setup(900);
    h.time.now += 899_000;
    expect(await client.checkSession()).toBe(true);
    h.time.now += 2_000;
    // an operation after expiry must fail even without the alarm
    const res = await h.boot().router.handle({ type: 'list', query: '' }, { kind: 'extension' });
    expect(res).toMatchObject({ ok: false, error: { code: 'E_LOCKED' } });
    expect(Object.keys(h.session.dump())).not.toContain('lvs.session');
    expect(Object.keys(h.session.dump())).not.toContain('lvs.index');
  });

  it('manual lock, idle and screen lock all remove VK, index and the pending unlock', async () => {
    for (const reason of ['manual', 'idle', 'screen_locked'] as const) {
      const { h, client } = await setup();
      await client.lock(reason);
      expect(Object.keys(h.session.dump())).not.toContain('lvs.session');
      expect(Object.keys(h.session.dump())).not.toContain('lvs.index');
      const started = await h.boot().client.startUnlock();
      await h.boot().client.lock(reason);
      expect((await h.boot().client.status()).pending).toBeNull();
      expect(started.code).toBeDefined();
    }
  });

  it('sessionMaxSec 0 locks right after ONE fill or copy', async () => {
    const { h, router } = await setup(0 as never);
    const f = await router.handle(
      { type: 'fill', id: A, fields: 'both' },
      content('https://a.test'),
    );
    expect(f).toMatchObject({ ok: true, data: { username: 'alice', password: 'hunter2-pw' } });
    expect((await h.boot().client.status()).locked).toBe(true);

    // copy path, via a fresh unlock
    const { client } = h.boot();
    const s = await client.startUnlock();
    await h.server.approveUnlock(s.requestId);
    await h.boot().client.pollUnlock();
    expect((await h.boot().client.status()).singleUse).toBe(true);
    const c = await h
      .boot()
      .router.handle({ type: 'copy', id: A, field: 'password' }, { kind: 'extension' });
    expect(c).toMatchObject({ ok: true, data: { value: 'hunter2-pw' } });
    expect((await h.boot().client.status()).locked).toBe(true);
  });

  it('a single-use session also times out on its own', async () => {
    const { h, client } = await setup(0 as never);
    h.time.now += 6 * 60_000;
    expect(await client.checkSession()).toBe(false);
    expect((await h.boot().client.status()).locked).toBe(true);
  });

  it('browser quit: an empty storage.session means locked and nothing to restore', async () => {
    const { h } = await setup();
    await h.session.clear();
    const st = await h.boot().client.status();
    expect(st).toMatchObject({ paired: true, locked: true, itemCount: 0 });
  });
});
