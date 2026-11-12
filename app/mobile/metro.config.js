// Expo's default config detects the pnpm/yarn workspace root (watchFolders + node_modules lookup)
// and honours package `exports` (unstable_enablePackageExports). The workspace packages export
// TypeScript source with extensionless imports, which Metro transpiles like app code.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_enablePackageExports = true;
// zod / noble ship ESM + CJS conditions; keep Metro's defaults and add "import" for ESM-only packages.
config.resolver.unstable_conditionNames = [
  'react-native',
  'browser',
  'require',
  'import',
  'default',
];

module.exports = config;
