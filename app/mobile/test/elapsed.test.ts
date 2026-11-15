import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../src/lib/elapsed';

describe('formatElapsed', () => {
  it('formats m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9)).toBe('0:09');
    expect(formatElapsed(65)).toBe('1:05');
    expect(formatElapsed(600.7)).toBe('10:00');
    expect(formatElapsed(-3)).toBe('0:00');
  });
});
