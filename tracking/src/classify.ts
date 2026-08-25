export type Classification = 'self' | 'prefetch' | 'mpp' | 'scanner' | 'open';

/**
 * A Gmail proxy fetch this soon after send is delivery prefetch, not a read.
 *
 * Calibration run 2026-08-23 (docs/measurement-results.md) measured
 * GoogleImageProxy lag-from-send of 9s (correctly caught as prefetch under
 * the old 10s window), 14s and 26s (both classified `open` under the old
 * window, but very likely machine — Gmail's proxy re-fetching, not a human
 * reading the message), and 203s (the one confirmed human open in this run,
 * verified by the recipient's reply). 60s clears the 14s/26s suspects with
 * ~2.3x margin for jitter, while leaving ~140s of headroom below the
 * confirmed genuine open, so it should not suppress a fast human read.
 * PROVISIONAL: six data points from one run is not enough to fit a precise
 * boundary — revisit once more real opens land, especially anything between
 * roughly 30s and 200s after send. Widening this also trades away detection
 * of a genuine open by someone who reads mail within the window; 60s was
 * chosen to sit closer to the machine-lag cluster (9-26s) than to the one
 * confirmed human lag (203s), on the theory that suppressing a fast human
 * read is rarer than a delayed Gmail re-fetch, but that theory is untested.
 */
export const PREFETCH_WINDOW_MS = 60_000;
/** Repeat hits on one token inside this window collapse to a single event. */
export const DEDUPE_WINDOW_MS = 10_000;
/**
 * Scanner detection fires when recentHitTimes holds 3+ hits within
 * SCANNER_BURST_WINDOW_MS, meaning the 4th or later hit is flagged.
 *
 * NOTE — currently unreachable from the production endpoint. In
 * `api/o/[token].ts`, `record()` calls `recentHitTimes()`, then `isDuplicate()`
 * on that same list, and returns before `classifyHit()` runs if any prior hit
 * fell within DEDUPE_WINDOW_MS (10s). Since SCANNER_BURST_WINDOW_MS (5s) is
 * inside DEDUPE_WINDOW_MS (10s), every row `recentHitTimes` could return that
 * `isScannerBurst` would count is also new enough to make `isDuplicate` true
 * and short-circuit the request before `classifyHit` is ever called — so
 * `classifyHit` only ever sees `recentHitTimes: []` in production. This path
 * is reachable only via a direct call to `classifyHit`, such as the unit
 * tests below. See spec 9 for the tracked gap and the real fix (classify
 * before dedupe, or track raw arrivals separately from recorded opens).
 */
export const SCANNER_BURST_COUNT = 3;
/**
 * Time window for bursts. recentHitTimes holds prior hits only; detection
 * fires on hits beyond SCANNER_BURST_COUNT within this window.
 *
 * NOTE — same unreachability as SCANNER_BURST_COUNT above: this window sits
 * inside DEDUPE_WINDOW_MS, so dedupe always consumes the hits this constant
 * would need before `isScannerBurst` gets a chance to see them in production.
 */
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
 * CALIBRATED 2026-08-23 (docs/measurement-results.md): the previous
 * heuristic (AppleWebKit present, neither Version/ nor Safari/ present)
 * never fired in production. Real MPP traffic — two hits, both
 * MPP-on and MPP-off sends to an iCloud address — sent the bare
 * 11-character string `"Mozilla/5.0"`: no AppleWebKit token, no platform
 * parenthetical, nothing else. Every genuine mail client identifies its
 * platform in a parenthetical segment (e.g. `"(Macintosh; Intel Mac OS X
 * 10_15_7)"`, `"(Windows NT 10.0)"`); the complete absence of `(` is a
 * clean, evidence-backed signature for a relay/proxy fetch rather than a
 * real client, and it also naturally and correctly covers an empty
 * user-agent string.
 *
 * The old AppleWebKit-without-Version/Safari condition is deliberately
 * dropped, not just widened: that shape is the signature of the *real*
 * native Apple Mail app (see `appleMailClient` in `src/ua.ts`, which uses
 * the identical check to positively identify "Apple Mail" for device
 * attribution) — not of Apple's privacy proxy, which this calibration shows
 * carries no AppleWebKit token at all. Keeping it here would misclassify a
 * genuine direct (non-proxied) Apple Mail open as unverifiable `mpp`, the
 * mirror-image of the bug this recalibration fixes. Trade-off accepted: a
 * differently-shaped Apple proxy fetch not yet observed (e.g. one that
 * still carries a platform parenthetical) would fall through to `open`
 * instead of `mpp` — mitigated, not eliminated, by the Apple-netblock IP
 * check below, which is independent of UA shape. See
 * docs/superpowers/logs/2026-08-24-classifier-recalibration.md.
 */
export function isContentlessProxy(ua: string, ip: string): boolean {
  if (ip.startsWith(APPLE_NET_PREFIX)) return true;
  return !ua.includes('(');
}

/**
 * Unreachable from the production endpoint: `api/o/[token].ts` fetches
 * `recentHitTimes`, checks it with `isDuplicate`, and returns early on any
 * match before `classifyHit` (and therefore this function) ever runs, so
 * `ctx.recentHitTimes` is always `[]` by the time real traffic gets here.
 * This function only fires when `classifyHit` is called directly with a
 * non-empty `recentHitTimes`, as the unit tests below do. Widening the
 * fetch window doesn't fix it either — dedupe still returns before
 * `recordOpen`, so `opens` holds at most one row per token per dedupe
 * window regardless. Left in place (not deleted) as a documented, known
 * limitation — see spec 9.
 */
function isScannerBurst(ctx: HitContext): boolean {
  const recent = ctx.recentHitTimes.filter(
    (time) => ctx.occurredAt - time < SCANNER_BURST_WINDOW_MS,
  );
  return recent.length >= SCANNER_BURST_COUNT;
}

export function classifyHit(ctx: HitContext): Classification {
  // 'self' — the account owner's own fetch of their own pixel.
  //
  // UNREACHABLE FOR SERVER-SENT MAIL. `insertTokens` (src/db.ts) mints
  // every production token with the column list
  // `(token, account_id, message_id, recipient_email, subject)` and never
  // writes `sender_ip`, so `sender_ip` is NULL on every row minted by
  // `POST /api/tokens`; `api/o/[token].ts` therefore always passes
  // `senderIps: []`, and this comparison can never be true in production.
  // The only writer that names the column at all is
  // `scripts/send-test.mjs`, whose own doc comment tells operators to
  // leave `SENDER_IP` unset — so this branch is live only for a
  // deliberate `SENDER_IP=...` calibration run and for direct
  // `classifyHit` calls such as tests/classify.test.ts. Kept, not
  // deleted, for exactly those two callers.
  //
  // WIRING `sender_ip` INTO THE MINT PATH WOULD NOT FIX THIS, which is
  // why it was considered and rejected rather than left as a TODO. The
  // dominant self-open is the sender reading their own Sent copy in Gmail
  // web: the pixel is fetched by Google's image proxy, whose IP is
  // Google's and never the sender's, so the comparison below still fails.
  // This column's premise — that the sender's own mail client fetches the
  // pixel directly from the sender's own network — predates both
  // server-side sending and browser-based reading. Spec 7.2 also
  // deliberately avoids storing raw IPs, so populating it would trade a
  // real privacy property for an unreliable partial fix.
  //
  // WHAT PROTECTS THE USER INSTEAD, AND THE RESIDUAL. The sync service
  // suppresses the PUSH (never the opens feed) when an open's recipient is
  // one of the user's own configured accounts — `shouldNotifyOpen` in
  // sync/src/push/dispatch.ts. That closes self-sends completely. It
  // closes nothing else: a sender viewing their own Sent copy of mail sent
  // to an EXTERNAL recipient produces a hit that nothing recorded here
  // distinguishes from that recipient's genuine read. It falls through to
  // 'open' below and is reported as one.
  if (ctx.senderIps.includes(ctx.ip)) return 'self';

  const ageSinceSend = ctx.occurredAt - ctx.sentAt;
  if (ctx.userAgent.includes('GoogleImageProxy') && ageSinceSend < PREFETCH_WINDOW_MS) {
    return 'prefetch';
  }

  if (SCANNER_UA_PATTERNS.some((pattern) => pattern.test(ctx.userAgent))) return 'scanner';
  if (isScannerBurst(ctx)) return 'scanner';
  if (isContentlessProxy(ctx.userAgent, ctx.ip)) return 'mpp';

  return 'open';
}

export function isDuplicate(
  occurredAt: number,
  recentHitTimes: readonly number[],
): boolean {
  return recentHitTimes.some((time) => occurredAt - time < DEDUPE_WINDOW_MS);
}
