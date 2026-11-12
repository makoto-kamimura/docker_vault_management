// Persistence helpers: the three-step atomic write with one .bak generation (spec §6.6, NFR-06)
// and the recovery order used when reading.
import { utf8Decode, utf8Encode } from '@localvault/protocol';
import type { Storage } from './deps';

/** ① write `<name>.tmp` ② rename the current file to `<name>.bak` ③ rename tmp to `<name>`. */
export async function writeAtomic(storage: Storage, name: string, json: unknown): Promise<void> {
  const tmp = `${name}.tmp`;
  await storage.write(tmp, utf8Encode(JSON.stringify(json)));
  if (await storage.exists(name)) await storage.rename(name, `${name}.bak`);
  await storage.rename(tmp, name);
}

export type Loaded<T> = { value: T; source: 'main' | 'tmp' | 'bak' };

/**
 * Candidates in order: the file itself; the tmp file only when the main one is missing (a crash
 * after step ②); the .bak. The first one that parses and validates wins.
 */
export async function readWithRecovery<T>(
  storage: Storage,
  name: string,
  validate: (json: unknown) => T | null,
): Promise<{ loaded: Loaded<T> | null; anyFilePresent: boolean }> {
  const mainPresent = await storage.exists(name);
  const order: ['main' | 'tmp' | 'bak', string][] = [['main', name]];
  if (!mainPresent) order.push(['tmp', `${name}.tmp`]);
  order.push(['bak', `${name}.bak`]);
  let any = false;
  for (const [source, file] of order) {
    const bytes = await storage.read(file);
    if (bytes === null) continue;
    any = true;
    try {
      const v = validate(JSON.parse(utf8Decode(bytes)));
      if (v !== null) return { loaded: { value: v, source }, anyFilePresent: true };
    } catch {
      // unreadable candidate: try the next one
    }
  }
  return { loaded: null, anyFilePresent: any };
}

export async function removeAll(storage: Storage, name: string): Promise<void> {
  for (const f of [name, `${name}.tmp`, `${name}.bak`]) {
    if (await storage.exists(f)) await storage.remove(f);
  }
}
