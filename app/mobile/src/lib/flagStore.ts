// Tiny non-secret JSON flag store (recovery sheet confirmed?, pending rotation id, biometrics on?).
// Nothing in here may be a secret: the RC itself is never stored (spec §8.11.1).
export type FlagValue = string | number | boolean | null;
export type FlagStore = {
  get<T extends FlagValue>(key: string): Promise<T | null>;
  set(key: string, value: FlagValue): Promise<void>;
  remove(key: string): Promise<void>;
};

export function createMemoryFlagStore(initial: Record<string, FlagValue> = {}): FlagStore {
  const data = new Map<string, FlagValue>(Object.entries(initial));
  return {
    async get<T extends FlagValue>(key: string) {
      return (data.has(key) ? (data.get(key) as T) : null) as T | null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

/** One JSON file in the app's document directory (not backed up secrets: flags only). */
export function createFileFlagStore(fileName = 'lv-flags.json'): FlagStore {
  // Loaded lazily so pure logic that only needs the types stays importable in plain Node tests.
  const file = async () => {
    const { File, Paths } = await import('expo-file-system');
    return new File(Paths.document, fileName);
  };
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<Record<string, FlagValue>> {
    try {
      const f = await file();
      if (!f.exists) return {};
      const parsed: unknown = JSON.parse(await f.text());
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, FlagValue>) : {};
    } catch {
      return {};
    }
  }
  async function write(data: Record<string, FlagValue>): Promise<void> {
    const f = await file();
    if (!f.exists) f.create();
    await f.write(JSON.stringify(data));
  }
  // Serialise read-modify-write so concurrent setters cannot lose updates.
  const mutate = (fn: (d: Record<string, FlagValue>) => void): Promise<void> => {
    const next = queue.then(async () => {
      const d = await read();
      fn(d);
      await write(d);
    });
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    async get<T extends FlagValue>(key: string) {
      await queue;
      const d = await read();
      return (key in d ? (d[key] as T) : null) as T | null;
    },
    set: (key, value) =>
      mutate((d) => {
        d[key] = value;
      }),
    remove: (key) =>
      mutate((d) => {
        delete d[key];
      }),
  };
}

let shared: FlagStore | null = null;
/** The app-wide store (lazily created so tests never touch the file system). */
export function getFlagStore(): FlagStore {
  shared ??= createFileFlagStore();
  return shared;
}

export const FLAGS = {
  rcSheetUnconfirmed: 'rc.sheetUnconfirmed',
  rotationId: 'rotation.id',
  biometricsOn: 'biometrics.on',
} as const;
