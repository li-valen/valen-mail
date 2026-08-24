import { pixelResponse } from '../../src/pixel';
import { isValidToken } from '../../src/token';
import { parseUserAgent } from '../../src/ua';
import { classifyHit, isDuplicate, DEDUPE_WINDOW_MS } from '../../src/classify';
import { lookupToken, recentHitTimes, recordOpen, hashIp, requireIpHashSalt } from '../../src/db';

export const config = { runtime: 'edge' };

/**
 * `vercel.json` rewrites `/o/:token.png` to `/api/o/:token`. Depending on how
 * Vercel presents the rewritten request, `request.url` may carry either the
 * original path (`/o/<token>.png`) or the destination path (`/api/o/<token>`,
 * with no extension) — so the `.png` suffix must be optional here. If it were
 * required, the mismatched shape would silently record zero opens while the
 * service still deploys green: the worst kind of failure, because nothing
 * would look wrong from the outside.
 */
export function extractToken(url: string): string | null {
  const match = new URL(url).pathname.match(/\/o\/([^/]+?)(?:\.png)?$/);
  return match?.[1] ?? null;
}

async function record(request: Request): Promise<void> {
  const token = extractToken(request.url);
  if (!token || !isValidToken(token)) return;

  const row = await lookupToken(token);
  if (!row) return;

  const occurredAt = Date.now();
  // Best-effort, same as the cap in recordOpen: two concurrent hits on the
  // same token can both read an empty/stale priorHits and both pass this
  // check, so a rapid double-fetch can still write two rows. Accepted for
  // the same reason (see db.ts recordOpen) — closing it needs a
  // transactional read+write, which the HTTP driver doesn't offer here.
  const priorHits = await recentHitTimes(token, DEDUPE_WINDOW_MS);
  if (isDuplicate(occurredAt, priorHits)) return;

  const userAgent = request.headers.get('user-agent') ?? '';
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';

  const classification = classifyHit({
    userAgent,
    ip,
    occurredAt,
    sentAt: row.sentAt,
    senderIps: row.senderIp ? [row.senderIp] : [],
    recentHitTimes: priorHits,
  });

  await recordOpen({
    token,
    occurredAt,
    classification,
    userAgent,
    device: parseUserAgent(userAgent),
    ipHash: await hashIp(ip, requireIpHashSalt()),
  });
}

export default async function handler(request: Request): Promise<Response> {
  try {
    await record(request);
  } catch (error) {
    // The image must render regardless. Log for diagnosis, but never let a
    // failure change the response — a differing status or latency profile
    // would let a recipient fingerprint the tracker.
    console.error('tracking: failed to record hit', error);
  }
  return pixelResponse();
}
