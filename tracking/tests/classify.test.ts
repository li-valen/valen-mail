import { describe, it, expect } from 'vitest';
import { classifyHit, isDuplicate, PREFETCH_WINDOW_MS, type HitContext } from '../src/classify';

const SENT_AT = 1_700_000_000_000;

// Real user-agent strings from the 2026-08-23 production calibration run
// (docs/measurement-results.md). Apple's MPP relay sends the bare 11-char
// string with no platform parenthetical at all; Gmail's proxy sends this
// full 89-char string regardless of which Gmail client actually receives
// the mail (web, iOS app, etc.) — Gmail proxies every client uniformly.
const REAL_APPLE_MPP_UA = 'Mozilla/5.0';
const REAL_GMAIL_PROXY_UA =
  'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';

function hit(overrides: Partial<HitContext> = {}): HitContext {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36',
    ip: '203.0.113.7',
    // Comfortably outside PREFETCH_WINDOW_MS regardless of future retuning,
    // so tests that don't care about prefetch timing stay unaffected by it.
    occurredAt: SENT_AT + PREFETCH_WINDOW_MS + 60_000,
    sentAt: SENT_AT,
    senderIps: ['198.51.100.1'],
    recentHitTimes: [],
    ...overrides,
  };
}

describe('classifyHit', () => {
  it('classifies a normal later fetch as a real open', () => {
    expect(classifyHit(hit())).toBe('open');
  });

  it('suppresses the sender viewing their own Sent folder', () => {
    expect(classifyHit(hit({ ip: '198.51.100.1' }))).toBe('self');
  });

  it('suppresses a Gmail proxy fetch within the prefetch window', () => {
    const ua = 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)';
    expect(classifyHit(hit({ userAgent: ua, occurredAt: SENT_AT + 2_000 })))
      .toBe('prefetch');
  });

  it('counts a Gmail proxy fetch long after send as a real open', () => {
    const ua = 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)';
    expect(classifyHit(hit({ userAgent: ua, occurredAt: SENT_AT + 3_600_000 })))
      .toBe('open');
  });

  // Real calibration data (docs/measurement-results.md): the real Gmail
  // proxy UA hit at +9s (caught under both the old and new window), and at
  // +14s / +26s — both classified `open` under the old 10s
  // PREFETCH_WINDOW_MS, very likely machine re-fetches rather than a human
  // read. The widened 60s window now suppresses both.
  it('suppresses the real Gmail proxy UA at the measured 9s lag', () => {
    expect(classifyHit(hit({ userAgent: REAL_GMAIL_PROXY_UA, occurredAt: SENT_AT + 9_000 })))
      .toBe('prefetch');
  });

  it('suppresses the real Gmail proxy UA at the measured 14s lag (was open under the old 10s window)', () => {
    expect(classifyHit(hit({ userAgent: REAL_GMAIL_PROXY_UA, occurredAt: SENT_AT + 14_000 })))
      .toBe('prefetch');
  });

  it('suppresses the real Gmail proxy UA at the measured 26s lag (was open under the old 10s window)', () => {
    expect(classifyHit(hit({ userAgent: REAL_GMAIL_PROXY_UA, occurredAt: SENT_AT + 26_000 })))
      .toBe('prefetch');
  });

  // The one confirmed human open in the calibration run (recipient replied
  // "done"), at +203s — well outside the widened window, so it must still
  // count as a genuine open.
  it('counts the real Gmail proxy UA as open at the measured 203s confirmed-human lag', () => {
    expect(classifyHit(hit({ userAgent: REAL_GMAIL_PROXY_UA, occurredAt: SENT_AT + 203_000 })))
      .toBe('open');
  });

  it('counts a Gmail proxy fetch as open exactly at the PREFETCH_WINDOW_MS boundary', () => {
    const ua = 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)';
    expect(classifyHit(hit({ userAgent: ua, occurredAt: SENT_AT + PREFETCH_WINDOW_MS })))
      .toBe('open');
  });

  it('flags known corporate gateway scanners by user agent', () => {
    expect(classifyHit(hit({ userAgent: 'Mimecast Ltd Scanner' }))).toBe('scanner');
    expect(classifyHit(hit({ userAgent: 'Proofpoint-URL-Defense/2' }))).toBe('scanner');
  });

  // This calls classifyHit() directly with a hand-built recentHitTimes, which
  // is the only way this branch runs. It does not reflect a reachable
  // production path: api/o/[token].ts always calls isDuplicate() on
  // recentHitTimes before classifyHit(), and returns early on any match
  // within DEDUPE_WINDOW_MS (10s) — which fully covers SCANNER_BURST_WINDOW_MS
  // (5s), so classifyHit() only ever receives recentHitTimes: [] in
  // production. See the NOTE on isScannerBurst in src/classify.ts and spec 9.
  it('flags a rapid burst on one token as a scanner', () => {
    const now = SENT_AT + 60_000;
    const burst = [now - 500, now - 1_200, now - 2_000];
    expect(classifyHit(hit({ occurredAt: now, recentHitTimes: burst }))).toBe('scanner');
  });

  // Calibration finding: this AppleWebKit-without-Version/Safari shape is
  // the signature of the *real* native Apple Mail app (see `appleMailClient`
  // in src/ua.ts, which uses the identical check for device attribution),
  // not of Apple's MPP proxy — the proxy sends a bare "Mozilla/5.0" with no
  // platform info at all (see the `REAL_APPLE_MPP_UA` case below). This UA
  // carries a platform parenthetical, so it is no longer treated as `mpp`;
  // doing so would have suppressed a genuine direct Apple Mail open.
  it('classifies a direct (non-proxied) Apple Mail fetch as a real open, not mpp', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(classifyHit(hit({ userAgent: ua }))).toBe('open');
  });

  // The real, calibration-measured MPP proxy signature: no AppleWebKit
  // token, no platform parenthetical, nothing but "Mozilla/5.0" — observed
  // verbatim on both the MPP-on and MPP-off sends (docs/measurement-results.md).
  it('labels the real Apple MPP proxy user agent as mpp', () => {
    expect(classifyHit(hit({ userAgent: REAL_APPLE_MPP_UA }))).toBe('mpp');
  });

  it('labels an empty user agent as mpp, since no genuine client sends one', () => {
    expect(classifyHit(hit({ userAgent: '' }))).toBe('mpp');
  });

  it('labels any fetch from Apple owned address space as MPP', () => {
    expect(classifyHit(hit({ ip: '17.58.12.9' }))).toBe('mpp');
  });

  it('prefers self over mpp when both conditions hold', () => {
    expect(classifyHit(hit({ ip: '198.51.100.1', userAgent: REAL_APPLE_MPP_UA }))).toBe('self');
  });

  it('prefers self over prefetch when both conditions hold', () => {
    const ua = 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)';
    expect(classifyHit(hit({
      ip: '198.51.100.1',
      userAgent: ua,
      occurredAt: SENT_AT + 2_000
    }))).toBe('self');
  });

  it('prefers self over scanner when both conditions hold', () => {
    expect(classifyHit(hit({
      ip: '198.51.100.1',
      userAgent: 'Mimecast Ltd Scanner'
    }))).toBe('self');
  });

  it('prefers prefetch over scanner when both conditions hold', () => {
    const ua = 'Mozilla/5.0 (via ggpht.com GoogleImageProxy Mimecast)';
    expect(classifyHit(hit({
      userAgent: ua,
      occurredAt: SENT_AT + 2_000
    }))).toBe('prefetch');
  });

  it('prefers scanner over mpp when both conditions hold', () => {
    const now = SENT_AT + PREFETCH_WINDOW_MS + 60_000;
    const burst = [now - 500, now - 1_200, now - 2_000];
    expect(classifyHit(hit({
      userAgent: REAL_APPLE_MPP_UA,
      occurredAt: now,
      recentHitTimes: burst
    }))).toBe('scanner');
  });
});

describe('isDuplicate', () => {
  it('collapses a repeat hit inside the dedupe window', () => {
    expect(isDuplicate(SENT_AT + 5_000, [SENT_AT + 1_000])).toBe(true);
  });

  it('accepts a hit outside the dedupe window', () => {
    expect(isDuplicate(SENT_AT + 60_000, [SENT_AT + 1_000])).toBe(false);
  });

  it('accepts the first ever hit on a token', () => {
    expect(isDuplicate(SENT_AT + 1_000, [])).toBe(false);
  });
});
