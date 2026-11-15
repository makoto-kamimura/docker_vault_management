// Cross-implementation check: restore an account that the NATIVE (Swift) core created, using the
// TypeScript reference engine against a real server, and print what it can decrypt. If the Swift
// port derived keys, wrapped the VK or encrypted records differently, this fails.
//
//   pnpm --filter @localvault/mobile interop:restore <serverUrl> <accountName> <masterPassword> <recoveryKey>
//
// It registers one more device on the account (a test device); remove it from the app afterwards.
import { createWebCryptoProvider } from '../../../../packages/core/src/index';
import { createVaultEngine } from '../../../../packages/vault-engine/src/index';
import { createMemoryDeps } from '../../../../packages/vault-engine/src/memory';

const [server, account, password, recoveryKey] = process.argv.slice(2);
if (!server || !account || !password || !recoveryKey) {
  console.error('usage: interop-restore <serverUrl> <accountName> <masterPassword> <recoveryKey>');
  process.exit(2);
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  // biome-ignore lint/suspicious/noExplicitAny: server JSON; the engine validates what it uses
): Promise<any> {
  const r = await fetch(`${server}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const e = createVaultEngine(
  createMemoryDeps(createWebCryptoProvider(), { clock: { now: () => new Date() } }),
);
const pre = await req('GET', `/v1/prelogin?account=${encodeURIComponent(account)}`);
const authKey = await e.deriveAuthKey({
  accountId: pre.accountId,
  kdf: pre.kdf,
  masterPassword: password,
  recoveryKey,
});
const rr = await e.buildRecoverRequest({ accountName: account, authKey });
const recovered = await req(rr.method, rr.path, rr.body, rr.headers ?? {});
await e.restoreAccount({
  serverUrl: server,
  accountName: account,
  accountId: pre.accountId,
  keyset: recovered.keyset,
  masterPassword: password,
  recoveryKey,
});
const auth = { Authorization: `Bearer ${recovered.accessToken}` };
let cursor = 0;
for (;;) {
  const page = await req('GET', `/v1/records?since=${cursor}&limit=500`, undefined, auth);
  await e.applyPulled({ ...page, fullResync: false });
  cursor = page.cursor;
  if (!page.hasMore) break;
}
const items = await e.listItems({ includeTrashed: true });
console.log(`TS engine decrypted ${items.length} item(s) created by the native core:`);
for (const i of items) {
  const pw = await e.revealPassword(i.id);
  console.log(
    `- ${i.title} / ${i.username} / password ${pw.length} chars${i.trashedAt ? ' (trash)' : ''}`,
  );
}
const devices = await e.listDevices();
console.log(
  `devices: ${devices.map((d) => `${d.name}(${d.platform}${d.revokedAt ? ', revoked' : ''})`).join(', ')}`,
);
