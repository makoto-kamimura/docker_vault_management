import { type Href, router } from 'expo-router';

// Typed routes are generated at `expo start`/`export`; paths are plain strings in app code and the
// route guard test covers the targets, so we cast here once instead of at every call site.
export const nav = {
  replace: (path: string) => router.replace(path as Href),
  push: (path: string) => router.push(path as Href),
  back: () => (router.canGoBack() ? router.back() : undefined),
};
