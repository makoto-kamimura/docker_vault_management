// Holds the freshly issued sheet between the status screen and the sheet screen. Module memory
// only (never persisted); `take` hands it over once and `clear` wipes it.
import type { RecoverySheet } from '@localvault/core';

let held: { sheet: RecoverySheet; waitSec: number; serverUrl: string; accountName: string } | null =
  null;

export const sheetHolder = {
  put(v: NonNullable<typeof held>) {
    held = v;
  },
  peek() {
    return held;
  },
  clear() {
    held = null;
  },
};
