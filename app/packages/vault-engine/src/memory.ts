// In-memory implementations of every engine dependency, with scripting and fault-injection hooks
// for tests. Exported as `@localvault/vault-engine/memory`.
import { type CryptoProvider, VaultCoreError } from '@localvault/core';
import {
  type AuthToken,
  BIOMETRIC_GATED_SLOTS,
  type Biometric,
  type BiometricKind,
  type Clipboard,
  type Clock,
  type EngineDeps,
  type FileAccess,
  type Keystore,
  type KeystoreSlot,
  type Storage,
  type TrustedBrowserStore,
} from './deps';

// ---------------------------------------------------------------- storage

export type StorageOp = 'write' | 'rename' | 'remove';

export class MemoryStorage implements Storage {
  readonly files = new Map<string, Uint8Array>();
  /** Every mutating call, in order (`write:vault.lv.tmp`, `rename:vault.lv->vault.lv.bak`, ...). */
  readonly log: string[] = [];
  /** Called before each mutating operation; throw to simulate a crash / I/O failure. */
  failWhen: ((op: StorageOp, detail: string, n: number) => boolean) | null = null;
  #ops = 0;

  async read(name: string): Promise<Uint8Array | null> {
    const v = this.files.get(name);
    return v ? v.slice() : null;
  }

  async exists(name: string): Promise<boolean> {
    return this.files.has(name);
  }

  #gate(op: StorageOp, detail: string): void {
    this.#ops++;
    this.log.push(`${op}:${detail}`);
    if (this.failWhen?.(op, detail, this.#ops)) throw new VaultCoreError('E_IO', 'simulated crash');
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    this.#gate('write', name);
    this.files.set(name, data.slice());
  }

  async rename(from: string, to: string): Promise<void> {
    this.#gate('rename', `${from}->${to}`);
    const v = this.files.get(from);
    if (!v) throw new VaultCoreError('E_IO', 'rename source is missing');
    this.files.set(to, v);
    this.files.delete(from);
  }

  async remove(name: string): Promise<void> {
    this.#gate('remove', name);
    this.files.delete(name);
  }

  /** Test helper: flip the low bit of one byte. */
  corrupt(name: string, offset: number): void {
    const v = this.files.get(name);
    if (!v) throw new Error(`no such file: ${name}`);
    const i = offset < 0 ? v.length + offset : offset;
    v[i] = (v[i] as number) ^ 0x01;
  }

  /** Test helper: every file as raw bytes (for "is X stored anywhere" scans). */
  dump(): Map<string, Uint8Array> {
    return new Map([...this.files].map(([k, v]) => [k, v.slice()]));
  }
}

// ---------------------------------------------------------------- biometrics

export type BiometricScript = 'success' | 'cancel' | 'fail' | 'invalidated' | 'unavailable';

export class MemoryBiometric implements Biometric {
  kind: BiometricKind = 'faceId';
  available = true;
  /** Raised by `invalidate()` (a new fingerprint / face was enrolled). */
  enrollmentGeneration = 0;
  prompts: string[] = [];
  readonly #queue: BiometricScript[] = [];
  readonly #tokens = new WeakSet<object>();
  /** Behaviour once the queue is empty. */
  defaultResult: BiometricScript = 'success';

  async availability() {
    return this.available
      ? { available: true, kind: this.kind }
      : { available: false, kind: 'none' as const };
  }

  /** Script the next prompt(s). */
  script(...results: BiometricScript[]): void {
    this.#queue.push(...results);
  }

  /** Simulates a biometric enrollment change: gated keystore slots become unreadable (FR-13). */
  invalidate(): void {
    this.enrollmentGeneration++;
  }

  async authenticate(reason: string): Promise<AuthToken> {
    this.prompts.push(reason);
    if (!this.available) throw new VaultCoreError('E_BIOMETRY_UNAVAILABLE');
    const next = this.#queue.shift() ?? this.defaultResult;
    switch (next) {
      case 'cancel':
        throw new VaultCoreError('E_AUTH_CANCELED');
      case 'fail':
        throw new VaultCoreError('E_AUTH_FAILED');
      case 'invalidated':
        throw new VaultCoreError('E_BIOMETRY_INVALIDATED');
      case 'unavailable':
        throw new VaultCoreError('E_BIOMETRY_UNAVAILABLE');
      case 'success':
        break;
    }
    const token: AuthToken = { kind: 'biometric-auth' };
    this.#tokens.add(token);
    return token;
  }

  isValid(token: AuthToken | undefined): boolean {
    return token !== undefined && this.#tokens.has(token);
  }
}

// ---------------------------------------------------------------- keystore

export class MemoryKeystore implements Keystore {
  readonly slots = new Map<KeystoreSlot, { value: Uint8Array; generation: number }>();
  constructor(private readonly biometric: MemoryBiometric) {}

  async read(slot: KeystoreSlot, auth?: AuthToken): Promise<Uint8Array | null> {
    const e = this.slots.get(slot);
    if (!e) return null;
    if (BIOMETRIC_GATED_SLOTS.includes(slot)) {
      if (!this.biometric.isValid(auth)) {
        throw new VaultCoreError('E_AUTH_FAILED', `slot ${slot} needs a biometric prompt`);
      }
      if (e.generation !== this.biometric.enrollmentGeneration) {
        throw new VaultCoreError('E_BIOMETRY_INVALIDATED');
      }
    }
    return e.value.slice();
  }

  async write(slot: KeystoreSlot, value: Uint8Array): Promise<void> {
    this.slots.set(slot, { value: value.slice(), generation: this.biometric.enrollmentGeneration });
  }

  async delete(slot: KeystoreSlot): Promise<void> {
    this.slots.delete(slot);
  }

  /** Test helper: raw bytes of every slot (for "is X stored anywhere" scans). */
  dump(): Map<string, Uint8Array> {
    return new Map([...this.slots].map(([k, v]) => [k, v.value.slice()]));
  }
}

// ---------------------------------------------------------------- clipboard, files, clock

export class MemoryClipboard implements Clipboard {
  text: string | null = null;
  ttlSec: number | null = null;
  history: { text: string; ttlSec: number | null }[] = [];
  async setSensitive(text: string, ttlSec: number | null): Promise<void> {
    this.text = text;
    this.ttlSec = ttlSec;
    this.history.push({ text, ttlSec });
  }
  clear(): void {
    this.text = null;
  }
}

export class MemoryFiles implements FileAccess {
  readonly files = new Map<string, Uint8Array>();
  #n = 0;
  async write(suggestedName: string, data: Uint8Array): Promise<string> {
    const uri = `mem://files/${++this.#n}/${suggestedName}`;
    this.files.set(uri, data.slice());
    return uri;
  }
  /** Test helper: register a file the user "picked" (e.g. a CSV). */
  put(name: string, data: Uint8Array | string): string {
    const uri = `mem://picked/${++this.#n}/${name}`;
    this.files.set(uri, typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
    return uri;
  }
  async read(uri: string): Promise<Uint8Array> {
    const v = this.files.get(uri);
    if (!v) throw new VaultCoreError('E_IO', 'file not found');
    return v.slice();
  }
  async delete(uri: string): Promise<void> {
    this.files.delete(uri);
  }
}

/** A clock tests can move. Pass the same instance to the engine and (in e2e) to the server. */
export class ManualClock implements Clock {
  constructor(private ms = Date.parse('2026-11-11T09:00:00Z')) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}

export class MemoryTrustedBrowserStore implements TrustedBrowserStore {
  list: { packageName: string; label: string }[] = [];
  async load() {
    return this.list.map((x) => ({ ...x }));
  }
  async save(list: { packageName: string; label: string }[]) {
    this.list = list.map((x) => ({ ...x }));
  }
}

// ---------------------------------------------------------------- bundle

export type MemoryDeps = EngineDeps & {
  storage: MemoryStorage;
  keystore: MemoryKeystore;
  biometric: MemoryBiometric;
  clipboard: MemoryClipboard;
  files: MemoryFiles;
  clock: Clock;
  trustedBrowsers: MemoryTrustedBrowserStore;
};

/** A complete set of in-memory dependencies. Keep the object to simulate "the same phone" restarting. */
export function createMemoryDeps(
  crypto: CryptoProvider,
  overrides: Partial<EngineDeps> = {},
): MemoryDeps {
  const biometric = new MemoryBiometric();
  return {
    crypto,
    storage: new MemoryStorage(),
    keystore: new MemoryKeystore(biometric),
    biometric,
    clipboard: new MemoryClipboard(),
    files: new MemoryFiles(),
    clock: new ManualClock(),
    platform: 'ios',
    trustedBrowsers: new MemoryTrustedBrowserStore(),
    allowInsecureLocalhost: true,
    ...overrides,
  } as MemoryDeps;
}
