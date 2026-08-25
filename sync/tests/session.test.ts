import { describe, it, expect } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  buildSessionCookie,
  buildClearedSessionCookie,
  mintSessionValue,
  verifySessionValue,
} from '../src/api/session';

/**
 * Unit tests for the stateless session credential itself. The router's use
 * of it (POST/GET/DELETE /api/session, and the "bearer OR cookie" gate)
 * lives in session-route.test.ts; this file proves the primitive.
 *
 * Two of these tests are the ones most easily written vacuously — a
 * "tampered" fixture that also fails a length check, or an "expired"
 * fixture whose signature never verified in the first place. Both are
 * therefore written as a PAIR of assertions: the rejection, plus a
 * positive control on the *same* value proving the only thing that changed
 * is the property under test.
 */

const TOKEN = 'x'.repeat(64);
const OTHER_TOKEN = 'y'.repeat(64);
const NOW = 1_800_000_000_000;

describe('session value', () => {
  it('mints a v1.<expiresAt>.<hmac> triple', () => {
    const value = mintSessionValue(TOKEN, NOW);
    const parts = value.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v1');
    expect(Number(parts[1])).toBe(NOW + SESSION_TTL_MS);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts a freshly minted value', () => {
    expect(verifySessionValue(mintSessionValue(TOKEN, NOW), TOKEN, NOW)).toBe(true);
  });

  it('never embeds the API token in the cookie value', () => {
    const value = mintSessionValue(TOKEN, NOW);
    expect(value).not.toContain(TOKEN);
    expect(Buffer.from(value).toString('hex')).not.toContain(Buffer.from(TOKEN).toString('hex'));
  });

  it('rejects a tampered signature while the untampered original still verifies', () => {
    // The positive control is the whole point: if `tampered` were rejected
    // for any reason OTHER than the flipped signature byte (a length
    // change, a broken parse), `original` would fail too and this test
    // would not be evidence about tampering at all.
    const original = mintSessionValue(TOKEN, NOW);
    const [version, expiresAt, signature] = original.split('.') as [string, string, string];
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    const tampered = `${version}.${expiresAt}.${flipped}`;

    expect(tampered).toHaveLength(original.length);
    expect(tampered).not.toBe(original);
    expect(verifySessionValue(original, TOKEN, NOW)).toBe(true);
    expect(verifySessionValue(tampered, TOKEN, NOW)).toBe(false);
  });

  it('rejects a tampered expiry (extending the lifetime) because the signature covers it', () => {
    const original = mintSessionValue(TOKEN, NOW);
    const [version, expiresAt, signature] = original.split('.') as [string, string, string];
    const extended = `${version}.${Number(expiresAt) + 86_400_000}.${signature}`;

    expect(verifySessionValue(original, TOKEN, NOW)).toBe(true);
    expect(verifySessionValue(extended, TOKEN, NOW)).toBe(false);
  });

  it('rejects an expired value that is otherwise perfectly signed', () => {
    // Minted at a point far enough in the past that it has already lapsed.
    // The positive control evaluates THE SAME STRING at a moment before
    // its own expiry: if it verifies there, the rejection below can only
    // have come from the clock, not from a signature mismatch. Without
    // this pair, an "expired" fixture that also failed the HMAC check
    // would pass while proving nothing about expiry at all.
    const mintedAt = NOW - SESSION_TTL_MS - 60_000;
    const value = mintSessionValue(TOKEN, mintedAt);
    const expiresAt = Number(value.split('.')[1]);

    expect(expiresAt).toBeLessThan(NOW);
    expect(verifySessionValue(value, TOKEN, expiresAt - 1)).toBe(true);
    expect(verifySessionValue(value, TOKEN, NOW)).toBe(false);
  });

  it('rejects a value exactly at its expiry instant, not one millisecond later', () => {
    const value = mintSessionValue(TOKEN, NOW);
    const expiresAt = Number(value.split('.')[1]);
    expect(verifySessionValue(value, TOKEN, expiresAt - 1)).toBe(true);
    expect(verifySessionValue(value, TOKEN, expiresAt)).toBe(false);
  });

  it('rejects a value signed with a different key while it verifies under its own', () => {
    const foreign = mintSessionValue(OTHER_TOKEN, NOW);
    expect(verifySessionValue(foreign, OTHER_TOKEN, NOW)).toBe(true);
    expect(verifySessionValue(foreign, TOKEN, NOW)).toBe(false);
  });

  it('rejects malformed shapes rather than throwing', () => {
    const malformed = [
      '',
      'v1',
      'v1.',
      `v1.${NOW + 1000}`,
      `v2.${NOW + 1000}.AAAA`,
      'v1.not-a-number.AAAA',
      `v1.${NOW + 1000}.`,
      `v1.${NOW + 1000}.!!!not-base64url!!!`,
      TOKEN,
      `v1.${NOW + 1000}.AAAA.extra`,
    ];
    for (const value of malformed) {
      expect(verifySessionValue(value, TOKEN, NOW), `expected "${value}" to be rejected`).toBe(false);
    }
  });
});

describe('session cookie header', () => {
  it('carries every required attribute', () => {
    const header = buildSessionCookie(mintSessionValue(TOKEN, NOW));
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  });

  it('never puts the API token into the Set-Cookie header', () => {
    expect(buildSessionCookie(mintSessionValue(TOKEN, NOW))).not.toContain(TOKEN);
  });

  it('clears with Max-Age=0 and the same attributes so the browser actually drops it', () => {
    const header = buildClearedSessionCookie();
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
  });
});
