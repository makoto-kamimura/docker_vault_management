/**
 * Client IP (G16). `trustProxy` is the number of trusted proxies in front of the server: the
 * address is the n-th entry counted from the RIGHT of X-Forwarded-For (each trusted proxy appends
 * the address it saw). With 0 the header is ignored and the socket address is used. Used only as
 * a rate-limit key; it is never logged or stored.
 */
export function clientIp(
  xForwardedFor: string | undefined,
  socketAddress: string | undefined,
  trustProxy: number,
): string {
  if (trustProxy > 0 && xForwardedFor !== undefined) {
    const parts = xForwardedFor
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const picked = parts[parts.length - trustProxy];
    if (picked !== undefined) return picked;
  }
  return socketAddress ?? 'unknown';
}
