import { describe, it, expect } from 'vitest';
import { generateToken, isValidToken } from '../src/token';

describe('generateToken', () => {
  it('returns 32 lowercase hex characters (128 bits)', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not repeat across many calls', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken));
    expect(tokens.size).toBe(1000);
  });
});

describe('isValidToken', () => {
  it('accepts a freshly generated token', () => {
    expect(isValidToken(generateToken())).toBe(true);
  });

  it('rejects wrong length, uppercase, non-hex, and path traversal', () => {
    expect(isValidToken('abc')).toBe(false);
    expect(isValidToken('A'.repeat(32))).toBe(false);
    expect(isValidToken('z'.repeat(32))).toBe(false);
    expect(isValidToken('../../etc/passwd')).toBe(false);
    expect(isValidToken('')).toBe(false);
  });
});
