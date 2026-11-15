// List banners owned by the list screen: rollback warning (§7.5) and needsMasterPassword.
// Pending approvals, recovery sheet and export reminder come from <HomeBanners /> (W4b).
import { useSyncStore } from '../../state/syncStore';

export function useBanners() {
  const status = useSyncStore((s) => s.status);
  return { rollback: status.kind === 'rollback', needsMaster: status.needsMasterPassword };
}
