// Backup export/import (FR-50..54) over VaultCore; plaintext/temp files are deleted after use.
import type { VaultCore } from '@localvault/core';

export const MIN_EXPORT_PASSWORD = 10;
export type ImportStrategy = 'append' | 'newer' | 'replace';

export function exportPasswordProblem(pw: string, again: string): 'short' | 'mismatch' | null {
  if (pw.length < MIN_EXPORT_PASSWORD) return 'short';
  if (pw !== again) return 'mismatch';
  return null;
}

/** Export -> share sheet -> delete the temp file, even when sharing fails. */
export async function exportFlow(
  core: VaultCore,
  password: string,
  share: (uri: string) => Promise<void>,
  remove: (uri: string) => Promise<void> | void = (u) => core.deleteExportFile(u),
): Promise<void> {
  const { fileUri } = await core.exportVault(password);
  try {
    await share(fileUri);
  } finally {
    await remove(fileUri);
  }
}

export async function previewImport(core: VaultCore, uri: string, password: string) {
  return core.inspectImport(uri, password);
}

export async function runImport(
  core: VaultCore,
  uri: string,
  password: string,
  strategy: ImportStrategy,
  syncAfter?: () => Promise<void>,
) {
  const r = await core.importVault(uri, password, strategy);
  await syncAfter?.().catch(() => undefined);
  return r;
}

export async function runCsvImport(
  core: VaultCore,
  uri: string,
  skipDuplicates: boolean,
  syncAfter?: () => Promise<void>,
) {
  const r = await core.importCsv(uri, { skipDuplicates });
  await syncAfter?.().catch(() => undefined);
  return r;
}
