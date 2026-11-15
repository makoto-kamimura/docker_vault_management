import { defineConfig } from 'tsup';

// Workspace packages are inlined (they ship TypeScript source); third-party deps stay external.
export default defineConfig({
  entry: { server: 'src/server.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  splitting: false,
  noExternal: [/^@localvault\//],
});
