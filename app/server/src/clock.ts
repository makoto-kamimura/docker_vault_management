/** Time source. Everything in the server reads time through this so tests can move it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
