import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vector files are untyped JSON documents consumed by tests only; `any` keeps the tests readable.
// biome-ignore lint/suspicious/noExplicitAny: test-only access to JSON fixtures
export type J = any;

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../vectors');
export function load(name: string): J {
  return JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
}
export const unhex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
export const hexOf = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
