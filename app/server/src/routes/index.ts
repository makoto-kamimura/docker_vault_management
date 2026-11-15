import { registerAccountRoutes } from './accounts';
import { registerAuditRoutes } from './audit';
import { registerAuthRoutes } from './auth';
import type { Registrar } from './define';
import { registerDeviceRoutes } from './devices';
import { registerKeysetRoutes } from './keyset';
import { registerPairingRoutes } from './pairings';
import { registerRecordRoutes } from './records';
import { registerRecoveryRoutes } from './recovery';
import { registerRotationRoutes } from './rotations';
import { registerSystemRoutes } from './system';
import { registerUnlockRoutes } from './unlock';

export function registerAllRoutes(r: Registrar): void {
  registerSystemRoutes(r);
  registerAccountRoutes(r);
  registerAuthRoutes(r);
  registerKeysetRoutes(r);
  registerRecordRoutes(r);
  registerRotationRoutes(r);
  registerDeviceRoutes(r);
  registerPairingRoutes(r);
  registerUnlockRoutes(r);
  registerRecoveryRoutes(r);
  registerAuditRoutes(r);
}
