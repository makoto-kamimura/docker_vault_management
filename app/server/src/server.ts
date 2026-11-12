import { serve } from '@hono/node-server';
import { createApp } from './app';
import { systemClock } from './clock';
import { ConfigError, loadConfig } from './config';
import { createDb } from './db/client';
import { assertSchemaUpToDate, defaultMigrationsDir } from './db/migrate';
import { startCleanupJob } from './jobs/cleanup';
import { createLogger } from './log';
import { createPushSender, Tasks } from './push';
import { RateLimiter } from './ratelimit';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const { db, pool } = createDb(config.databaseUrl);
  await assertSchemaUpToDate(pool, defaultMigrationsDir(config.migrationsDir));

  const push = createPushSender(config, systemClock, log);
  const tasks = new Tasks();
  const { app } = createApp({
    db,
    clock: systemClock,
    config,
    limiter: new RateLimiter(),
    push,
    log,
    tasks,
    validateResponses: false,
  });
  const stopJob = startCleanupJob(db, systemClock, (e) =>
    log.warn({ errName: (e as Error).name }, 'cleanup job failed'),
  );
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
    log.info({ port: info.port }, 'listening'),
  );

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    stopJob();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => {
      await tasks.idle();
      push.close();
      await db.destroy();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // ConfigError / SchemaBehindError messages never contain secret values.
  const e = err as Error;
  process.stderr.write(
    `localvault-server: ${e.name === 'ConfigError' || e.name === 'SchemaBehindError' || e.name === 'Error' ? e.message : e.name}\n`,
  );
  void ConfigError;
  process.exit(1);
});
