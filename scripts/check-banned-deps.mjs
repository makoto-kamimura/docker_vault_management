// 仕様 §16.3 / §5.11 の強制チェック: サードパーティ通信SDK（解析・クラッシュ報告・広告・通知など）を禁止する。
// package.json の依存関係名と pnpm-lock.yaml の内容を走査し、禁止パッケージが含まれていれば exit 1 で終了する。
// 依存なし（Node 標準モジュールのみ）で動作する。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.output']);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const BANNED_EXACT = [
  'expo-updates',
  'expo-secure-store',
  'expo-local-authentication',
  'expo-clipboard',
  'expo-application-insights',
  'firebase',
  '@react-native-firebase/analytics',
  '@react-native-firebase/crashlytics',
  'react-native-google-mobile-ads',
  'posthog-js',
  'posthog-react-native',
  'mixpanel-browser',
  'mixpanel-react-native',
  '@amplitude/analytics-browser',
  '@amplitude/analytics-react-native',
  'bugsnag-react-native',
];
const BANNED_PREFIXES = ['@sentry/', '@bugsnag/', '@segment/', '@datadog/'];

const isBanned = (name) =>
  BANNED_EXACT.includes(name) || BANNED_PREFIXES.some((p) => name.startsWith(p));

/** @returns {string[]} package.json パスの一覧 */
function findPackageJsons(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findPackageJsons(join(dir, entry.name), out);
    } else if (entry.name === 'package.json') {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const violations = [];

for (const file of findPackageJsons(ROOT)) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (isBanned(name)) violations.push({ file, name, where: field });
    }
  }
}

// pnpm-lock.yaml: パッケージキー（例: 'name@1.2.3' や /name@1.2.3）の先頭一致で判定する。
// 部分文字列の誤検知（例: @react-native-firebase/x の "firebase"）を避けるため、
// 直前が区切り文字（行頭・空白・引用符・"/"）であることを要求する。
const lockPath = join(ROOT, 'pnpm-lock.yaml');
if (existsSync(lockPath)) {
  const lines = readFileSync(lockPath, 'utf8').split('\n');
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactPatterns = BANNED_EXACT.map((n) => ({
    name: n,
    re: new RegExp(`(^|[\\s'"/])${escapeRegex(n)}@`),
  }));
  const prefixPatterns = BANNED_PREFIXES.map((p) => ({
    name: `${p}*`,
    re: new RegExp(`(^|[\\s'"/])${escapeRegex(p)}[^@\\s'"/]+@`),
  }));
  for (const [i, line] of lines.entries()) {
    for (const { name, re } of [...exactPatterns, ...prefixPatterns]) {
      if (re.test(line)) {
        violations.push({ file: lockPath, name, where: `pnpm-lock.yaml:${i + 1}` });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('NG: banned dependencies found (spec §16.3 / §5.11):');
  for (const v of violations) {
    console.error(`  - ${v.name}  [${relative(ROOT, v.file)}] (${v.where})`);
  }
  process.exit(1);
}

console.log('OK: no banned dependencies');
process.exit(0);
