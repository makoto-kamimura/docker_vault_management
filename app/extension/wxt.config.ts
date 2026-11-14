import { defineConfig } from 'wxt';

// LV_DEV_ALLOW_HTTP (G11): development builds only. Never set it for a build that is distributed.
const devAllowHttp = process.env.LV_DEV_ALLOW_HTTP === '1';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  // Keep the manifest free of anything the spec (12.2) does not list.
  manifest: ({ mode }) => ({
    name: 'うちカギ',
    description:
      'うちカギ (Uchikagi): self-hosted, zero-knowledge password manager for your browser',
    minimum_chrome_version: '116',
    permissions: ['storage', 'unlimitedStorage', 'alarms', 'idle', 'offscreen'],
    // The server origin is requested at runtime (chrome.permissions.request), nothing else.
    optional_host_permissions:
      devAllowHttp && mode !== 'production'
        ? ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']
        : ['https://*/*'],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  }),
  vite: ({ mode }) => ({
    // Production builds strip console.* (5.12).
    define: {
      __LV_DEV_ALLOW_HTTP__: JSON.stringify(devAllowHttp),
    },
    build: {
      // No source maps in the shipped bundle, no inlined remote code.
      sourcemap: false,
      ...(mode === 'production'
        ? {
            rolldownOptions: {
              output: { minify: { compress: { dropConsole: true, dropDebugger: true } } },
            },
          }
        : {}),
    },
  }),
});
