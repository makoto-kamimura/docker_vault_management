// Verifies the built manifest against spec 12.2 and the 5.12 console rule. Exit 1 on any problem.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function checkBuild(
  dir = resolve(here, '../.output/chrome-mv3'),
  { allowDevHost = false } = {},
) {
  const problems = [];
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (m.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (m.minimum_chrome_version !== '116') problems.push('minimum_chrome_version must be "116"');
  if (
    !eq([...(m.permissions ?? [])].sort(), [
      'alarms',
      'idle',
      'offscreen',
      'storage',
      'unlimitedStorage',
    ])
  )
    problems.push(`permissions differ: ${JSON.stringify(m.permissions)}`);
  const optional = allowDevHost
    ? (m.optional_host_permissions ?? []).filter(
        (h) => h !== 'http://localhost/*' && h !== 'http://127.0.0.1/*',
      )
    : m.optional_host_permissions;
  if (!eq(optional, ['https://*/*']))
    problems.push(
      `optional_host_permissions differ: ${JSON.stringify(m.optional_host_permissions)}`,
    );
  if (m.host_permissions !== undefined) problems.push('host_permissions must not be declared');
  if (m.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'")
    problems.push('extension_pages CSP differs from 12.2');
  if (m.web_accessible_resources !== undefined)
    problems.push('web_accessible_resources must not be declared');
  if (m.background?.service_worker !== 'background.js' || m.background?.type !== 'module')
    problems.push('background must be a module service worker named background.js');
  if (m.action?.default_popup !== 'popup.html') problems.push('popup missing');
  if (m.options_ui?.page !== 'options.html' || m.options_ui?.open_in_tab !== true)
    problems.push('options page missing');
  const cs = m.content_scripts ?? [];
  if (
    cs.length !== 1 ||
    cs[0].all_frames !== true ||
    cs[0].run_at !== 'document_idle' ||
    !eq([...cs[0].matches].sort(), ['http://*/*', 'https://*/*'])
  )
    problems.push('content script declaration differs from 12.2');

  const walk = (d) =>
    readdirSync(d).flatMap((f) =>
      statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)],
    );
  for (const f of walk(dir)) {
    if (
      f.endsWith('.js') &&
      /\bconsole\s*\.\s*(log|warn|error|info|debug)\b/.test(readFileSync(f, 'utf8'))
    )
      problems.push(`console.* left in ${f}`);
    if (
      f.endsWith('.html') &&
      /<script(?![^>]*\bsrc="(?!https?:)[^"]+")/i.test(readFileSync(f, 'utf8'))
    )
      problems.push(`inline or remote script in ${f}`);
  }
  return { manifest: m, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { manifest, problems } = checkBuild();
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`manifest OK; permissions: ${manifest.permissions.join(', ')}`);
}
