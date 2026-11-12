import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { PushPayload } from '@localvault/protocol';
import pg from 'pg';
import type { Logger } from 'pino';
import { inject } from 'vitest';
import { createApp } from '../../src/app';
import type { Clock } from '../../src/clock';
import type { Config } from '../../src/config';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import type { Deps } from '../../src/deps';
import { createLogger } from '../../src/log';
import type { PushOptions, PushOutcome, PushSender, PushTarget } from '../../src/push';
import { Tasks } from '../../src/push';
import { RateLimiter } from '../../src/ratelimit';

export class FakeClock implements Clock {
  constructor(private t = Date.parse('2026-11-11T09:00:00Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}

export class RecordingPush implements PushSender {
  sent: { target: PushTarget; payload: PushPayload; opts: PushOptions }[] = [];
  outcome: PushOutcome = 'sent';
  async send(target: PushTarget, payload: PushPayload, opts: PushOptions): Promise<PushOutcome> {
    this.sent.push({ target, payload, opts });
    return this.outcome;
  }
}

export const TEST_CONFIG: Config = {
  databaseUrl: 'postgres://unused',
  publicOrigin: 'https://vault.test',
  tokenSecret: 'test-token-secret-0123456789abcdef0123456789abcdef',
  preloginSecret: 'test-prelogin-secret-0123456789abcdef0123456789',
  registrationMode: 'open',
  trustProxy: 1,
  logLevel: 'info',
  host: '127.0.0.1',
  port: 0,
  migrationsDir: undefined,
  apns: null,
  fcm: null,
};

export type TestEnv = {
  app: ReturnType<typeof createApp>['app'];
  registrar: ReturnType<typeof createApp>['registrar'];
  deps: Deps;
  handle: DbHandle;
  clock: FakeClock;
  push: RecordingPush;
  logs: string[];
  config: Config;
  close(): Promise<void>;
};

/** A fresh database (own name) with the real migrations applied, plus an app wired to fakes. */
export async function createTestEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const adminUrl = inject('pgAdminUrl');
  const dbName = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const handle = createDb(url.toString(), { max: 8 });
  await runMigrations(handle.pool, resolve(import.meta.dirname, '../../migrations'));

  const logs: string[] = [];
  const log: Logger = createLogger('debug', { write: (s: string) => void logs.push(s) });
  const clock = new FakeClock();
  const push = new RecordingPush();
  const config = { ...TEST_CONFIG, ...overrides };
  const deps: Deps = {
    db: handle.db,
    clock,
    config,
    limiter: new RateLimiter(),
    push,
    log,
    tasks: new Tasks(),
    validateResponses: true,
  };
  const { app, registrar } = createApp(deps);
  return {
    app,
    registrar,
    deps,
    handle,
    clock,
    push,
    logs,
    config,
    async close() {
      await deps.tasks.idle();
      await handle.db.destroy();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`drop database ${dbName} with (force)`);
      await a.end();
    },
  };
}

export const newUuid = () => randomUUID();
