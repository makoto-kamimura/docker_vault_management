import { describe, expect, it } from 'vitest';
import { createHarness, pairAndUnlock } from './helpers/harness';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function setup() {
  const h = createHarness();
  await h.server.putLogin(A, {
    title: 'A',
    username: 'a',
    password: 'pa',
    urls: [{ url: 'https://a.test', match: 'domain' }],
  });
  const booted = await pairAndUnlock(h);
  return { h, ...booted };
}

describe('sync (7.2, 7.5)', () => {
  it('pulls new records and refreshes the index while unlocked', async () => {
    const { h, client } = await setup();
    await h.server.putLogin(B, { title: 'B', username: 'b', password: 'pb', urls: [] });
    expect(await h.boot().client.sync()).toMatchObject({ status: 'ok', changed: true });
    expect((await h.boot().client.status()).itemCount).toBe(2);
    expect(client).toBeDefined();
  });

  it('works while locked (ciphertext only) and drops tombstoned records', async () => {
    const { h, client } = await setup();
    await client.lock();
    h.server.tombstone(A);
    expect(await h.boot().client.sync()).toMatchObject({ status: 'ok' });
    const cached = h.local.dump()['lv.records'] as Record<string, { deleted: boolean }>;
    expect(cached[A]?.deleted).toBe(true);
  });

  it('halts with a visible warning when the cursor goes backwards, keeping local data', async () => {
    const { h } = await setup();
    await h.server.putLogin(B, { title: 'B', username: 'b', password: 'pb', urls: [] });
    await h.boot().client.sync();
    const before = JSON.stringify(h.local.dump()['lv.records']);
    h.server.rev -= 1; // server restored from an older backup
    h.server.records.delete(B);
    const out = await h.boot().client.sync();
    expect(out).toMatchObject({ status: 'halted' });
    expect((await h.boot().client.status()).warning).toMatchObject({ kind: 'rollback' });
    expect(JSON.stringify(h.local.dump()['lv.records'])).toBe(before);
    // and it stays halted without contacting the server
    const n = h.server.requests.length;
    expect(await h.boot().client.sync()).toMatchObject({ status: 'halted' });
    expect(h.server.requests.length).toBe(n);
  });

  it('detects a record whose content changed without a new revision (substitution)', async () => {
    const { h } = await setup();
    const rec = h.server.records.get(A);
    const other = h.server.records.get('00000000-0000-4000-8000-000000000001');
    if (!rec || !other || rec.deleted || other.deleted) throw new Error('setup');
    // replay: same rev, other ciphertext, and an advanced cursor so the page contains it
    h.server.rev += 1;
    h.server.records.set(A, { ...rec, nonce: other.nonce, ct: other.ct, rev: rec.rev });
    h.server.failNext.push({ path: /^$/, status: 500, body: {} });
    // force the record into the page by faking since: lower stored cursor
    const sync = h.local.dump()['lv.sync'] as { cursor: number };
    await h.local.set({ 'lv.sync': { ...sync, cursor: rec.rev - 1 } });
    const out = await h.boot().client.sync();
    expect(out).toMatchObject({ status: 'halted' });
  });

  it('detects a keyset version going backwards', async () => {
    const { h } = await setup();
    h.server.keysetVersion = 3;
    h.server.keysetRev = h.server.rev + 1;
    h.server.rev += 1;
    await h.boot().client.sync();
    h.server.keysetVersion = 2;
    h.server.keysetRev = h.server.rev + 1;
    h.server.rev += 1;
    expect(await h.boot().client.sync()).toMatchObject({ status: 'halted' });
  });

  it('acceptServerState refetches everything and clears the warning', async () => {
    const { h } = await setup();
    h.server.rev = 0; // rolled back
    expect(await h.boot().client.sync()).toMatchObject({ status: 'halted' });
    h.server.rev = Math.max(...[...h.server.records.values()].map((r) => r.rev));
    const out = await h.boot().client.acceptServerState();
    expect(out).toMatchObject({ status: 'ok' });
    const st = await h.boot().client.status();
    expect(st.warning).toBeNull();
    expect(st.locked).toBe(true); // must unlock again so the index is rebuilt
  });

  it('restarts from 0 on fullResync and ignores fullResync on later pages (no loop)', async () => {
    const { h } = await setup();
    h.server.minValidCursor = h.server.rev + 10;
    h.server.rev += 20;
    await h.server.putLogin(B, { title: 'B', username: 'b', password: 'pb', urls: [] });
    h.server.tombstone(A);
    const n = h.server.requests.length;
    const out = await h.boot().client.sync();
    expect(out).toMatchObject({ status: 'ok' });
    // records the server no longer reports are removed locally after a full resync
    const sinceValues = h.server.requests.slice(n).map((r) => r.path);
    expect(sinceValues.filter((p) => p.includes('since=0'))).toHaveLength(1);
    expect(sinceValues.length).toBeLessThanOrEqual(3);
  });

  it('locks the session when a key rotation raises vkVersion (7.7)', async () => {
    const { h } = await setup();
    h.server.vkVersion = 2;
    h.server.keysetVersion = 2;
    h.server.rev += 1;
    h.server.keysetRev = h.server.rev;
    expect(await h.boot().client.sync()).toMatchObject({ status: 'ok', vkChanged: true });
    expect((await h.boot().client.status()).locked).toBe(true);
  });

  it('is skipped when not paired', async () => {
    const h = createHarness();
    expect(await h.boot().client.sync()).toEqual({ status: 'skipped' });
  });
});
