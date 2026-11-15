import { type CryptoProvider, createNobleProvider, createWebCryptoProvider } from '../src';
import { defaultPsl } from '../src/psl-data';

export const providers: [string, CryptoProvider][] = [
  ['webcrypto', createWebCryptoProvider()],
  ['noble', createNobleProvider()],
];
export const psl = defaultPsl();

export const ACCOUNT = '11111111-1111-4111-8111-111111111111';
export const DEVICE = '22222222-2222-4222-8222-222222222222';
export const REC = '33333333-3333-4333-8333-333333333333';
export const REC2 = '44444444-4444-4444-8444-444444444444';
export const NOW = '2026-11-11T09:00:00.000Z';

export function loginRecord(over: Record<string, unknown> = {}) {
  return {
    kind: 'login' as const,
    data: {
      title: 'Example',
      username: 'alice',
      password: 'pw',
      urls: [{ url: 'https://example.com', match: 'domain' as const }],
      androidApps: [],
      notes: '',
      favorite: false,
      createdAt: NOW,
      trashedAt: null,
      conflictOf: null,
      passwordHistory: [],
      ...over,
    },
    updatedAt: NOW,
    updatedBy: DEVICE,
  };
}
