import { ApiError } from '@localvault/protocol';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Deps } from './deps';
import { INTERNAL_ERROR_BODY } from './errors';
import { registerAllRoutes } from './routes';
import { type AppEnv, Registrar } from './routes/define';

/**
 * Build the Hono app from injected dependencies. Request logging records only method, route
 * pattern (`/v1/devices/{id}`), status and duration: no body, headers, tokens or IP address.
 */
export function createApp(deps: Deps): { app: Hono<AppEnv>; registrar: Registrar } {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const start = performance.now();
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
    deps.log.info(
      {
        method: c.req.method,
        route: c.get('routePattern') ?? 'unmatched',
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      },
      'request',
    );
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.code === 'E_RATE_LIMITED') {
        c.header('Retry-After', String(err.details?.retryAfterSec ?? 1));
      }
      return c.json(err.toBody(), err.status as ContentfulStatusCode);
    }
    // Only the error class and the Postgres code: messages may carry row values.
    deps.log.error(
      { errName: (err as Error).name, pgCode: (err as { code?: unknown }).code },
      'unhandled error',
    );
    return c.json(INTERNAL_ERROR_BODY, 500);
  });

  app.notFound((c) => c.json(new ApiError('E_NOT_FOUND', 'not found').toBody(), 404));

  const registrar = new Registrar(app, deps);
  registerAllRoutes(registrar);
  registrar.assertComplete();
  return { app, registrar };
}
