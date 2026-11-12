// §5.12: console.* is removed from production bundles.
module.exports = (api) => {
  api.cache.using(() => process.env.NODE_ENV);
  const isProd = process.env.NODE_ENV === 'production';
  return {
    presets: ['babel-preset-expo'],
    plugins: [...(isProd ? ['transform-remove-console'] : [])],
  };
};
