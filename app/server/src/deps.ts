import type { Logger } from 'pino';
import type { Clock } from './clock';
import type { Config } from './config';
import type { Database } from './db/client';
import type { PushSender, Tasks } from './push';
import type { RateLimiter } from './ratelimit';

/** Everything the app needs, injected so tests can substitute fakes. */
export type Deps = {
  db: Database;
  clock: Clock;
  config: Config;
  limiter: RateLimiter;
  push: PushSender;
  log: Logger;
  tasks: Tasks;
  /** Parse every success body with the protocol response schema (enabled in tests). */
  validateResponses: boolean;
};
