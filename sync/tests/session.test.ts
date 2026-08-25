import { describe, it, expect } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  buildSessionCookie,
  buildClearedSessionCookie,
  mintSessionValue,
  readSessionCookies,
  requestHasValidSession,
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

/**
 * A base64url spelling of the SAME 32 bytes that is not the canonical one.
 *
 * 32 bytes is 43 unpadded base64url characters = 258 bits, so the last
 * character's low two bits are unused and four in-alphabet strings decode
 * identically. Node emits the variant with those bits zeroed; this returns
 * a different one. Constructed rather than hardcoded so the test proves
 * the property instead of asserting a magic string.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function nonCanonicalSpelling(signature: string): string {
  const last = signature[signature.length - 1]!;
  const value = ALPHABET.indexOf(last);
  // Flip one of the two unused low bits; the decoded bytes are untouched.
  return signature.slice(0, -1) + ALPHABET[value | 0b01]!;
}

describe('session cookie name (__Host- prefix)', () => {
  it('carries the __Host- prefix', () => {
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });

  it('emits Secure + Path=/ and NO Domain — breaking any of the three makes the browser silently drop the cookie', () => {
    // READ THIS BEFORE TOUCHING COOKIE ATTRIBUTES.
    //
    // `__Host-` is not a naming convention; it is a contract the browser
    // enforces. A cookie carrying that prefix is REFUSED — not weakened,
    // not warned about, refused — unless it is `Secure`, has `Path=/`, and
    // carries no `Domain` attribute at all.
    //
    // The failure is silent and server-side invisible. The service still
    // answers `204` with a perfectly good `Set-Cookie`; the browser just
    // never stores it, so every following request is a 401 with nothing in
    // the journal to explain why. In production that is indistinguishable
    // from "sign-in does nothing", and it is a debugging session nobody
    // should have to repeat.
    //
    // Adding `Domain=` is the plausible future edit — it looks like it
    // would make the cookie work on a subdomain, and instead it stops the
    // cookie working anywhere. Hence one assertion per precondition.
    const header = buildSessionCookie(mintSessionValue(TOKEN, NOW));
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
    expect(header.toLowerCase()).not.toContain('domain=');
  });

  it('keeps the prefix and all three preconditions on the clearing header too', () => {
    // Same contract, same silent failure, worse consequence: a clearing
    // cookie the browser refuses to store is a sign-out that reports
    // success and leaves the session live.
    const header = buildClearedSessionCookie();
    expect(header.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
    expect(header.toLowerCase()).not.toContain('domain=');
  });
});

describe('canonical base64url', () => {
  it('rejects a non-canonical spelling of a signature that decodes to identical bytes', () => {
    const original = mintSessionValue(TOKEN, NOW);
    const [version, expiresAt, signature] = original.split('.') as [string, string, string];
    const restated = nonCanonicalSpelling(signature);

    // The two proofs that make this a malleability test and not a
    // corrupted-signature test: the string really is different, and it
    // really does decode to the same 32 bytes. Without them, this would
    // pass just as happily against a garbled signature and prove nothing
    // about canonical encoding.
    expect(restated).not.toBe(signature);
    expect(Buffer.from(restated, 'base64url').equals(Buffer.from(signature, 'base64url'))).toBe(true);

    expect(verifySessionValue(original, TOKEN, NOW)).toBe(true);
    expect(verifySessionValue(`${version}.${expiresAt}.${restated}`, TOKEN, NOW)).toBe(false);
  });
});

describe('reading cookies from the header', () => {
  function withCookie(header: string): Request {
    return new Request('http://x/api/inbox', { headers: { cookie: header } });
  }

  it('returns every value under this name, not just the first', () => {
    const request = withCookie(
      `${SESSION_COOKIE_NAME}=first; other=x; ${SESSION_COOKIE_NAME}=second`,
    );
    expect(readSessionCookies(request)).toEqual(['first', 'second']);
  });

  it('returns nothing when the header is absent or carries no match', () => {
    expect(readSessionCookies(new Request('http://x/api/inbox'))).toEqual([]);
    expect(readSessionCookies(withCookie('theme=dark; other=1'))).toEqual([]);
  });

  it('accepts a good session sitting BEHIND a shadowing junk cookie', () => {
    // The path-scoped shadowing vector: RFC 6265 sends longer Path matches
    // first, so a same-origin script's `path=/api` forgery arrives ahead of
    // the real cookie. A first-match read would take the junk and brick the
    // session with nothing server-side able to clear it.
    const good = mintSessionValue(TOKEN, NOW);
    const request = withCookie(`${SESSION_COOKIE_NAME}=junk; ${SESSION_COOKIE_NAME}=${good}`);
    expect(requestHasValidSession(request, TOKEN, NOW)).toBe(true);
  });

  it('accepts a good session sitting AHEAD of a junk cookie', () => {
    const good = mintSessionValue(TOKEN, NOW);
    const request = withCookie(`${SESSION_COOKIE_NAME}=${good}; ${SESSION_COOKIE_NAME}=junk`);
    expect(requestHasValidSession(request, TOKEN, NOW)).toBe(true);
  });

  it('still refuses when every candidate is bad — tolerance is not permissiveness', () => {
    const foreign = mintSessionValue('q'.repeat(64), NOW);
    const expired = mintSessionValue(TOKEN, NOW - SESSION_TTL_MS - 60_000);
    const request = withCookie(
      `${SESSION_COOKIE_NAME}=junk; ${SESSION_COOKIE_NAME}=${foreign}; ${SESSION_COOKIE_NAME}=${expired}`,
    );
    expect(requestHasValidSession(request, TOKEN, NOW)).toBe(false);
  });
});
