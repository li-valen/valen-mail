export type Classification = 'self' | 'prefetch' | 'mpp' | 'scanner' | 'open';

/** A Gmail proxy fetch this soon after send is delivery prefetch, not a read. */
export const PREFETCH_WINDOW_MS = 10_000;
/** Repeat hits on one token inside this window collapse to a single event. */
export const DEDUPE_WINDOW_MS = 10_000;
/** Scanner detection fires when recentHitTimes holds 3+ hits within SCANNER_BURST_WINDOW_MS, meaning the 4th or later hit is flagged. */
export const SCANNER_BURST_COUNT = 3;
/** Time window for bursts. recentHitTimes holds prior hits only; detection fires on hits beyond SCANNER_BURST_COUNT within this window. */
export const SCANNER_BURST_WINDOW_MS = 5_000;

/** Apple owns 17.0.0.0/8 outright. */
const APPLE_NET_PREFIX = '17.';

const SCANNER_UA_PATTERNS: readonly RegExp[] = [
  /Mimecast/i, /Proofpoint/i, /Barracuda/i, /SafeLinks/i,
  /Symantec/i, /Forcepoint/i, /TrendMicro/i, /MessageLabs/i,
];

export interface HitContext {
  readonly userAgent: string;
  readonly ip: string;
  readonly occurredAt: number;
  readonly sentAt: number;
  readonly senderIps: readonly string[];
  /** Prior hit timestamps for this same token. */
  readonly recentHitTimes: readonly number[];
}

/**
 * Apple Mail Privacy Protection prefetches images for every message a user
 * receives, whether or not they read it. Apple Mail is roughly half of all
 * email opens, so counting these as reads is the single largest source of
 * false positives in any tracking product. See spec L1.
 *
 * MPP fetches present an AppleWebKit UA carrying neither a Version/ nor a
 * Safari/ token. This heuristic needs calibration against the real-world
 * data Task 7 collects.
 */
export function isApplePrivacyProxy(ua: string, ip: string): boolean {
  if (ip.startsWith(APPLE_NET_PREFIX)) return true;
  const isWebKit = ua.includes('AppleWebKit');
  const isBrowser = ua.includes('Version/') || ua.includes('Safari/');
  return isWebKit && !isBrowser;
}

function isScannerBurst(ctx: HitContext): boolean {
  const recent = ctx.recentHitTimes.filter(
    (time) => ctx.occurredAt - time < SCANNER_BURST_WINDOW_MS,
  );
  return recent.length >= SCANNER_BURST_COUNT;
}

export function classifyHit(ctx: HitContext): Classification {
  if (ctx.senderIps.includes(ctx.ip)) return 'self';

  const ageSinceSend = ctx.occurredAt - ctx.sentAt;
  if (ctx.userAgent.includes('GoogleImageProxy') && ageSinceSend < PREFETCH_WINDOW_MS) {
    return 'prefetch';
  }

  if (SCANNER_UA_PATTERNS.some((pattern) => pattern.test(ctx.userAgent))) return 'scanner';
  if (isScannerBurst(ctx)) return 'scanner';
  if (isApplePrivacyProxy(ctx.userAgent, ctx.ip)) return 'mpp';

  return 'open';
}

export function isDuplicate(
  occurredAt: number,
  recentHitTimes: readonly number[],
): boolean {
  return recentHitTimes.some((time) => occurredAt - time < DEDUPE_WINDOW_MS);
}
