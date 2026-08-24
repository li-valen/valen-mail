import { describe, it, expect } from 'vitest';
import { classifyHit, isDuplicate, type HitContext } from '../src/classify';

const SENT_AT = 1_700_000_000_000;

function hit(overrides: Partial<HitContext> = {}): HitContext {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36',
    ip: '203.0.113.7',
    occurredAt: SENT_AT + 60_000,
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

  it('flags known corporate gateway scanners by user agent', () => {
    expect(classifyHit(hit({ userAgent: 'Mimecast Ltd Scanner' }))).toBe('scanner');
    expect(classifyHit(hit({ userAgent: 'Proofpoint-URL-Defense/2' }))).toBe('scanner');
  });

  it('flags a rapid burst on one token as a scanner', () => {
    const now = SENT_AT + 60_000;
    const burst = [now - 500, now - 1_200, now - 2_000];
    expect(classifyHit(hit({ occurredAt: now, recentHitTimes: burst }))).toBe('scanner');
  });

  it('labels Apple MPP prefetch rather than counting it as an open', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(classifyHit(hit({ userAgent: ua }))).toBe('mpp');
  });

  it('labels any fetch from Apple owned address space as MPP', () => {
    expect(classifyHit(hit({ ip: '17.58.12.9' }))).toBe('mpp');
  });

  it('prefers self over every other classification', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
    expect(classifyHit(hit({ ip: '198.51.100.1', userAgent: ua }))).toBe('self');
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
