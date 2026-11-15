// Conflict resolution — spec §7.4, as pure functions over decrypted records.
// `null` stands for a deleted record (a tombstone). IDs for new records come from the caller so the
// functions stay deterministic and testable.
import { FIELD, type LoginData, passwordHistoryOf, type RecordPlain } from '@localvault/protocol';

export type RecordState = RecordPlain | null;

export type NewRecord = { id: string; plain: RecordPlain };

export type ConflictOutcome =
  /** Keep the server's version; nothing to send. `notify` is true when a deletion was undone. */
  | { kind: 'use-server'; notify: boolean }
  /** Keep the server's version AND add the local edit as a new "conflict copy" item. */
  | { kind: 'use-server-and-copy'; copy: NewRecord }
  /** The server deleted it but we edited it: restore the edit as a NEW item and tell the user. */
  | { kind: 'restore-as-new'; record: NewRecord; notify: true }
  /** Singleton records (device / meta): send this content for the same id. */
  | { kind: 'push'; record: RecordPlain };

export type ResolveInput = {
  /** Id of the conflicting record. */
  id: string;
  local: RecordState;
  server: RecordState;
  now: Date;
  /** This device's id, written to `updatedBy` of anything created here. */
  deviceId: string;
  /** Produces a fresh UUID v4 when a new item is needed. */
  newId: () => string;
};

const COPY_PREFIX = '（競合コピー ';
const COPY_SUFFIX = '）';

/** `<title>（競合コピー YYYY-MM-DD）`, with the original title shortened to respect the 100 limit. */
export function conflictCopyTitle(title: string, now: Date): string {
  const suffix = `${COPY_PREFIX}${now.toISOString().slice(0, 10)}${COPY_SUFFIX}`;
  const budget = FIELD.titleMax - suffix.length;
  let kept = '';
  for (const ch of title) {
    if (kept.length + ch.length > budget) break;
    kept += ch;
  }
  return kept + suffix;
}

export function resolveConflict(input: ResolveInput): ConflictOutcome {
  const { local, server } = input;

  if (local === null || server === null) {
    if (local === null && server === null) return { kind: 'use-server', notify: false };
    if (local === null) {
      // We deleted, the server edited: the edit wins (singletons are never deleted on purpose).
      return { kind: 'use-server', notify: server !== null && server.kind === 'login' };
    }
    // The server deleted, we edited.
    if (local.kind !== 'login') return { kind: 'push', record: local };
    return {
      kind: 'restore-as-new',
      record: { id: input.newId(), plain: asNewItem(local, input) },
      notify: true,
    };
  }

  if (local.kind !== server.kind) return { kind: 'use-server', notify: false };

  switch (local.kind) {
    case 'login': {
      if (server.kind !== 'login') return { kind: 'use-server', notify: false };
      if (sameLoginData(local.data, server.data)) return { kind: 'use-server', notify: false };
      return {
        kind: 'use-server-and-copy',
        copy: { id: input.newId(), plain: asConflictCopy(local, input) },
      };
    }
    case 'device': {
      if (server.kind !== 'device') return { kind: 'use-server', notify: false };
      return resolveDevice(local, server, input);
    }
    case 'meta': {
      if (server.kind !== 'meta') return { kind: 'use-server', notify: false };
      // Newer updatedAt wins; a tie goes to the server.
      return local.updatedAt > server.updatedAt
        ? { kind: 'push', record: local }
        : { kind: 'use-server', notify: false };
    }
  }
}

type Device = Extract<RecordPlain, { kind: 'device' }>;
type Login = Extract<RecordPlain, { kind: 'login' }>;

/** Device records: the newer `updatedAt` wins, but `revokedAt` once set is never cleared. */
function resolveDevice(local: Device, server: Device, input: ResolveInput): ConflictOutcome {
  const newer = local.updatedAt > server.updatedAt ? local : server;
  const revokedAt = server.data.revokedAt ?? local.data.revokedAt;
  const merged = { ...newer.data, revokedAt };

  if (canonicalJson(merged) === canonicalJson(server.data))
    return { kind: 'use-server', notify: false };
  if (canonicalJson(merged) === canonicalJson(local.data)) return { kind: 'push', record: local };
  // A combination of both sides (e.g. local rename + server-side revocation): a new revision.
  return {
    kind: 'push',
    record: {
      kind: 'device',
      data: merged,
      updatedAt: input.now.toISOString(),
      updatedBy: input.deviceId,
    },
  };
}

function asConflictCopy(local: Login, input: ResolveInput): Login {
  return {
    kind: 'login',
    data: {
      ...local.data,
      title: conflictCopyTitle(local.data.title, input.now),
      conflictOf: input.id,
      passwordHistory: passwordHistoryOf(local.data),
    },
    updatedAt: input.now.toISOString(),
    updatedBy: input.deviceId,
  };
}

function asNewItem(local: Login, input: ResolveInput): Login {
  return {
    kind: 'login',
    data: { ...local.data, passwordHistory: passwordHistoryOf(local.data) },
    updatedAt: input.now.toISOString(),
    updatedBy: input.deviceId,
  };
}

function sameLoginData(a: LoginData, b: LoginData): boolean {
  return (
    canonicalJson({ ...a, passwordHistory: passwordHistoryOf(a) }) ===
    canonicalJson({ ...b, passwordHistory: passwordHistoryOf(b) })
  );
}

/** JSON with object keys sorted, so equality does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
