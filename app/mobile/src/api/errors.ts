// Client-side failures that are not server `ApiError`s. Messages never contain request/response
// bodies (they may hold secrets).
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
  readonly kind: 'network' | 'timeout';
  constructor(kind: 'network' | 'timeout') {
    super(kind);
    this.kind = kind;
  }
}

/** The server answered, but not with something the protocol schema accepts. */
export class InvalidResponseError extends Error {
  override readonly name = 'InvalidResponseError';
  constructor(route: string, status: number) {
    super(`invalid response from ${route} (HTTP ${status})`);
  }
}

/** A request built by the app failed protocol validation before being sent (programming error). */
export class InvalidRequestError extends Error {
  override readonly name = 'InvalidRequestError';
  readonly fields: string[];
  constructor(route: string, fields: string[]) {
    super(`invalid request for ${route}: ${fields.join(', ')}`);
    this.fields = fields;
  }
}
