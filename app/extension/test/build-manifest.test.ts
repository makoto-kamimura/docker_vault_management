import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { checkBuild } from '../scripts/check-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.output/chrome-mv3');

describe('production build vs spec 12.2 / 5.12', () => {
  beforeAll(() => {
    // Always build fresh so the test checks what would ship.
    execFileSync(join(root, 'node_modules/.bin/wxt'), ['build'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'production', LV_DEV_ALLOW_HTTP: '' },
    });
  }, 240_000);

  it('manifest matches 12.2 and no console.* is shipped', () => {
    expect(existsSync(out)).toBe(true);
    const { manifest, problems } = checkBuild(out) as {
      manifest: { permissions: string[] };
      problems: string[];
    };
    expect(problems).toEqual([]);
    expect([...manifest.permissions].sort()).toEqual([
      'alarms',
      'idle',
      'offscreen',
      'storage',
      'unlimitedStorage',
    ]);
  });

  it('bundles stay small and the content script does not pull in React or the PSL', () => {
    const size = (p: string) => statSync(join(out, p)).size;
    expect(size('content-scripts/content.js')).toBeLessThan(80_000);
    expect(readdirSync(out)).toContain('offscreen.html');
  });
});
