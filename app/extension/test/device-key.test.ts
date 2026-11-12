import 'fake-indexeddb/auto';
import { createWebCryptoProvider } from '@localvault/core';
import { describe, expect, it } from 'vitest';
import { createDeviceKeyStore, createIdbBackend } from '../src/core/device-key';

describe('device key in IndexedDB', () => {
  it('persists a non-extractable key across store instances and signs verifiably', async () => {
    const a = createDeviceKeyStore(createIdbBackend());
    expect(await a.getPublicKey()).toBeNull();
    const pub = await a.create();
    expect(pub).toHaveLength(65);
    const b = createDeviceKeyStore(createIdbBackend());
    expect(await b.getPublicKey()).toEqual(pub);
    const msg = new TextEncoder().encode('hello');
    const sig = await b.sign(msg);
    expect(sig).toHaveLength(64);
    expect(await createWebCryptoProvider().ecdsaVerify(pub, msg, sig)).toBe(true);
    await b.delete();
    expect(await a.getPublicKey()).toBeNull();
    await expect(a.sign(msg)).rejects.toThrow();
  });
});
