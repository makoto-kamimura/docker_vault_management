import type { CryptoProvider } from '@localvault/core';

/** Uniform integer in [min, max] by rejection sampling (no modulo bias). */
export async function randomIntInclusive(
  p: CryptoProvider,
  min: number,
  max: number,
): Promise<number> {
  const range = max - min + 1;
  if (!Number.isInteger(range) || range < 1 || range > 256) throw new Error('range must be 1..256');
  const limit = 256 - (256 % range); // largest multiple of range <= 256
  for (;;) {
    const [b] = await p.randomBytes(1);
    if (b !== undefined && b < limit) return min + (b % range);
  }
}
