// Device signing key (spec 5.2 / 5.6): ECDSA P-256 `CryptoKey`, extractable: false, kept in
// IndexedDB. The private scalar can never be read back by JavaScript (not even by this code).
import type { DeviceKeyStore } from './types';

type Stored = { privateKey: CryptoKey; publicKey: Uint8Array };

export interface KeyBackend {
  get(): Promise<Stored | undefined>;
  put(value: Stored): Promise<void>;
  delete(): Promise<void>;
}

export function createDeviceKeyStore(
  backend: KeyBackend,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): DeviceKeyStore {
  return {
    async create() {
      const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
        'verify',
      ]);
      // Public keys are always exportable, even when the key pair was created with extractable=false.
      const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      if (pair.privateKey.extractable) throw new Error('device key must not be extractable');
      await backend.put({ privateKey: pair.privateKey, publicKey });
      return publicKey;
    },
    async getPublicKey() {
      return (await backend.get())?.publicKey ?? null;
    },
    async sign(message) {
      const stored = await backend.get();
      if (stored === undefined) throw new Error('no device key');
      // WebCrypto ECDSA already emits IEEE P1363 (r || s, 64 bytes for P-256).
      const sig = await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        stored.privateKey,
        message as BufferSource,
      );
      return new Uint8Array(sig);
    },
    async delete() {
      await backend.delete();
    },
  };
}

const DB_NAME = 'localvault';
const STORE = 'device-key';
const KEY_ID = 'device';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('indexeddb request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
  });
}

export function createIdbBackend(factory: IDBFactory = globalThis.indexedDB): KeyBackend {
  async function open(): Promise<IDBDatabase> {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    return request(req);
  }
  return {
    async get() {
      const db = await open();
      try {
        const v = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY_ID));
        return (v as Stored | undefined) ?? undefined;
      } finally {
        db.close();
      }
    },
    async put(value) {
      const db = await open();
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, KEY_ID);
        await transactionDone(tx);
      } finally {
        db.close();
      }
    },
    async delete() {
      const db = await open();
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY_ID);
        await transactionDone(tx);
      } finally {
        db.close();
      }
    },
  };
}

/** Test backend that keeps the (still non-extractable) CryptoKey in memory. */
export function createMemoryBackend(): KeyBackend {
  let value: Stored | undefined;
  return {
    async get() {
      return value;
    },
    async put(v) {
      value = v;
    },
    async delete() {
      value = undefined;
    },
  };
}
