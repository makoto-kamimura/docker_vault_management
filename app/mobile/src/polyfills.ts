// Hermes has no WebCrypto. The development VaultCore uses `createNobleProvider()` from
// @localvault/core, whose randomness comes from `crypto.getRandomValues`. We install it from
// expo-crypto (native CSPRNG only; nothing is sent anywhere). This file is imported FIRST by
// index.ts because @noble/hashes reads `globalThis.crypto` at import time.
import { getRandomValues } from 'expo-crypto';

type CryptoLike = { getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T };

const g = globalThis as unknown as { crypto?: CryptoLike };

if (g.crypto === undefined) {
  g.crypto = { getRandomValues } as CryptoLike;
} else if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = getRandomValues as CryptoLike['getRandomValues'];
}
