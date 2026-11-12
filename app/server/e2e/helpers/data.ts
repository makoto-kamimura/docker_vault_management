import type { VaultCore } from '@localvault/core';

export type NewItem = Parameters<VaultCore['saveItem']>[0];

/** Distinctive strings so the zero-knowledge scan can look for them. */
export const sample = (tag: string): NewItem => ({
  title: `Title-${tag}-zq`,
  username: `user-${tag}@mail.zq.example`,
  password: `Pw!${tag}-Xk93vQ`,
  urls: [{ url: `https://login.${tag}-zq.example.org/signin`, match: 'domain' }],
  notes: `secret note ${tag} 7f3a`,
  favorite: false,
});
