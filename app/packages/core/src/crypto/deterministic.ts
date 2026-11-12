// Test-vector support: a provider whose randomness is a queue the test fills in advance.
// Exported from `@localvault/core/testing` only; never import it in production code.
import { CryptoError } from '../errors';
import type { CryptoProvider, KeyPair } from './provider';

export interface DeterministicProvider extends CryptoProvider {
  /** Queue the byte strings returned by the next `randomBytes` calls (each call consumes one). */
  enqueueRandom(...values: Uint8Array[]): void;
  /** Queue the key pairs returned by the next `generateKeyPair` calls. */
  enqueueKeyPair(...pairs: KeyPair[]): void;
  /** Throws if queued values were left unused (catches vectors that drift from the code path). */
  assertDrained(): void;
}

export function createDeterministicProvider(inner: CryptoProvider): DeterministicProvider {
  const randoms: Uint8Array[] = [];
  const pairs: KeyPair[] = [];
  return {
    ...inner,
    enqueueRandom(...values) {
      for (const v of values) randoms.push(new Uint8Array(v));
    },
    enqueueKeyPair(...list) {
      for (const p of list) {
        pairs.push({
          privateKey: new Uint8Array(p.privateKey),
          publicKey: new Uint8Array(p.publicKey),
        });
      }
    },
    assertDrained() {
      if (randoms.length > 0 || pairs.length > 0) {
        throw new Error(
          `deterministic provider: ${randoms.length} random / ${pairs.length} key pairs unused`,
        );
      }
    },
    async randomBytes(n) {
      const next = randoms.shift();
      if (next === undefined)
        throw new CryptoError('E_CRYPTO_INPUT', 'deterministic randomness exhausted');
      if (next.length !== n) {
        throw new CryptoError(
          'E_CRYPTO_INPUT',
          `deterministic randomness: wanted ${n} bytes, queued ${next.length}`,
        );
      }
      return next;
    },
    async generateKeyPair() {
      const next = pairs.shift();
      if (next === undefined)
        throw new CryptoError('E_CRYPTO_INPUT', 'deterministic key pairs exhausted');
      return next;
    },
  };
}
