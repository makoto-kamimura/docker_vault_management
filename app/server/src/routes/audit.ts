import { DEFAULT_AUDIT_LIMIT } from '@localvault/protocol';
import { iso } from './common';
import type { Registrar } from './define';

export function registerAuditRoutes(r: Registrar): void {
  r.handle('listAuditEvents', async ({ deps, auth, query }) => {
    const limit = query.limit ?? DEFAULT_AUDIT_LIMIT;
    let q = deps.db
      .selectFrom('audit_events')
      .selectAll()
      .where('account_id', '=', auth.device.accountId)
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (query.before !== undefined) q = q.where('id', '<', query.before);
    const rows = await q.execute();
    const page = rows.slice(0, limit);
    return {
      events: page.map((e) => ({
        id: e.id,
        kind: e.kind as never,
        deviceId: e.device_id,
        createdAt: iso(e.created_at),
      })),
      hasMore: rows.length > limit,
    };
  });
}
