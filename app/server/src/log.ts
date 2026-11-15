import { type DestinationStream, type Logger, pino } from 'pino';

/**
 * Structured logger. Request logging lives in app.ts and writes only method, route pattern,
 * status and duration. Never pass request bodies, headers, tokens or IP addresses to it.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, base: { svc: 'localvault-server' } }, destination);
}

export type { Logger };
