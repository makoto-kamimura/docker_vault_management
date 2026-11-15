// Password generator — FR-23. Uniform (rejection sampling), every selected class guaranteed.
import type { CryptoProvider } from './crypto/provider';
import { VaultCoreError } from './errors';

export type GeneratorOptions = {
  /** 8..64 */
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  /** Exclude look-alike characters (`Il1|O0o`). */
  excludeAmbiguous: boolean;
};

export const GENERATOR_MIN_LENGTH = 8;
export const GENERATOR_MAX_LENGTH = 64;
export const GENERATOR_DEFAULT_LENGTH = 20;

export const CHAR_CLASSES = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
} as const;

export const AMBIGUOUS_CHARS = 'Il1|O0o';

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  length: GENERATOR_DEFAULT_LENGTH,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

/** Alphabets of the selected classes (ambiguous characters already removed). */
export function selectedAlphabets(o: GeneratorOptions): string[] {
  const keys = (['upper', 'lower', 'digits', 'symbols'] as const).filter((k) => o[k]);
  return keys
    .map((k) =>
      o.excludeAmbiguous
        ? [...CHAR_CLASSES[k]].filter((c) => !AMBIGUOUS_CHARS.includes(c)).join('')
        : CHAR_CLASSES[k],
    )
    .filter((a) => a.length > 0);
}

/** Uniform random integers in [0, n) from a byte stream, without modulo bias. */
class UniformSource {
  #buf: Uint8Array = new Uint8Array(0);
  #pos = 0;
  constructor(private readonly p: CryptoProvider) {}

  async #byte(): Promise<number> {
    if (this.#pos >= this.#buf.length) {
      this.#buf = await this.p.randomBytes(256);
      this.#pos = 0;
    }
    return this.#buf[this.#pos++] as number;
  }

  /** n in 1..256. Values >= floor(256/n)*n are rejected so every residue is equally likely. */
  async below(n: number): Promise<number> {
    const limit = 256 - (256 % n);
    for (;;) {
      const b = await this.#byte();
      if (b < limit) return b % n;
    }
  }
}

export async function generatePassword(
  p: CryptoProvider,
  options: GeneratorOptions,
): Promise<string> {
  if (
    !Number.isInteger(options.length) ||
    options.length < GENERATOR_MIN_LENGTH ||
    options.length > GENERATOR_MAX_LENGTH
  ) {
    throw new VaultCoreError('E_INVALID_INPUT', 'password length must be 8-64');
  }
  const alphabets = selectedAlphabets(options);
  if (alphabets.length === 0)
    throw new VaultCoreError('E_INVALID_INPUT', 'select at least one class');

  const all = alphabets.join('');
  const rnd = new UniformSource(p);
  const chars: string[] = [];
  // One character from each selected class first, so the guarantee holds by construction.
  for (const a of alphabets) chars.push(a.charAt(await rnd.below(a.length)));
  while (chars.length < options.length) chars.push(all.charAt(await rnd.below(all.length)));
  // Fisher-Yates so the guaranteed characters are not always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = await rnd.below(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}
