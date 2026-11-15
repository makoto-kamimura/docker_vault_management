import { fakeB64, fakeId, fakeKeyset } from '../src/native/fake/FakeVaultCore';

export { fakeB64, fakeId, fakeKeyset };

export type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

export type Handler = (call: Call) => Response | Promise<Response> | undefined;

export function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function apiError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): Response {
  return json(status, { error: { code, message: code, ...(details ? { details } : {}) } });
}

/** A fake fetch that records calls and answers with the first handler returning a Response. */
export function makeFetch(...handlers: Handler[]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const h of handlers) {
      const r = await h(call);
      if (r) return r;
    }
    return apiError(404, 'E_NOT_FOUND');
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export const record = (id = fakeId(), rev = 1) => ({
  id,
  rev,
  deleted: false as const,
  vkVersion: 1,
  nonce: fakeB64(12),
  ct: fakeB64(40),
});
