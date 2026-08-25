import { tokenMatches } from '../src/compare';
import { generateToken } from '../src/token';
import { insertTokens, type InsertTokenInput } from '../src/db';

export const config = { runtime: 'edge' };

/** Below this, READ_API_TOKEN is treated as unset — same threshold api/opens.ts uses. */
const MIN_TOKEN_LENGTH = 32;

/**
 * Plan 4 Global Constraints: recipients ≤25 per send. This route enforces
 * it at the batch level (sends.length), since one call to POST /api/tokens
 * mints one token per recipient of one compose action.
 */
const MAX_SENDS = 25;

/** Fix round 1 bound on accountId — an account slug/email, not free text. */
const MAX_ACCOUNT_ID_CHARS = 64;

/** Fix round 1 bound on messageId — an RFC 5322 Message-ID value, stored verbatim. */
const MAX_MESSAGE_ID_CHARS = 256;

/** Single fixed string for every "the request body doesn't fit the contract" case. */
const INVALID_BODY_ERROR = 'invalid request body';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Identical to api/opens.ts's extractBearerToken (and sync/src/api/
 * routes.ts's). Not extracted alongside tokenMatches into src/compare.ts:
 * the plan named the comparison specifically for extraction ("reuse
 * api/opens.ts's Edge-safe compare — extract to src/compare.ts"), and this
 * one-line regex has no Edge-compatibility reasoning attached to it the
 * way tokenMatches does — duplicating it here is not the drift DRY exists
 * to prevent.
 */
function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

/**
 * Fix round 1: widened from {recipientEmail,subject}. accountId and
 * messageId are now required, non-synthesized fields — see the
 * `buildRow`/`isSendInput` comments below for why, and
 * task-p4t1-report.md's "Fix round 1" section for the full reconciliation.
 */
interface SendInput {
  readonly recipientEmail: string;
  readonly subject: string;
  readonly accountId: string;
  readonly messageId: string;
}

/**
 * All four fields are required non-empty strings; accountId and messageId
 * are additionally length-capped (64 / 256) as a sanity bound on values
 * that get stored verbatim — not a format check. messageId in particular
 * is deliberately validated on length and non-emptiness ONLY: whether the
 * caller includes angle brackets or matches RFC 5322's inner grammar is
 * sync's business, not this route's; this function stores whatever
 * message id sync intends to stamp on the outgoing mail, unmodified.
 */
function isSendInput(value: unknown): value is SendInput {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.recipientEmail === 'string' &&
    record.recipientEmail.length > 0 &&
    typeof record.subject === 'string' &&
    typeof record.accountId === 'string' &&
    record.accountId.length > 0 &&
    record.accountId.length <= MAX_ACCOUNT_ID_CHARS &&
    typeof record.messageId === 'string' &&
    record.messageId.length > 0 &&
    record.messageId.length <= MAX_MESSAGE_ID_CHARS
  );
}

/**
 * Returns null for anything that isn't
 * `{sends: {recipientEmail,subject,accountId,messageId}[]}` — the single
 * "malformed" verdict. `every` over the whole array means one bad element
 * fails the entire batch: there is no partial mint, by construction (the
 * caller below never sees a partially-valid array to iterate over).
 */
function parseSends(body: unknown): SendInput[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const sends = (body as Record<string, unknown>).sends;
  if (!Array.isArray(sends)) return null;
  return sends.every(isSendInput) ? (sends as SendInput[]) : null;
}

/**
 * Fix round 1: accountId/messageId are no longer synthesized here. They
 * arrive from the caller (sync knows the sending account, and generates
 * messageId before the SMTP send so it can stamp the same value on the
 * outgoing mail's Message-ID header — see task-p4t1-report.md's "Fix
 * round 1" section) and are stored verbatim, parameterized, in
 * insertTokens. thread_id stays unset here by omission from
 * InsertTokenInput/insertTokens entirely — threads attach on the receive
 * side later, not at mint time.
 */
function buildRow(send: SendInput): InsertTokenInput {
  return {
    token: generateToken(),
    accountId: send.accountId,
    messageId: send.messageId,
    recipientEmail: send.recipientEmail,
    subject: send.subject,
  };
}

export default async function handler(request: Request): Promise<Response> {
  const expected = process.env.READ_API_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    // Fail closed, same as api/opens.ts: an absent or too-short token must
    // never be read as "no auth required." Never log the value itself.
    console.error('tokens: READ_API_TOKEN missing or too short; refusing to mint');
    return json({ error: 'unavailable' }, 503);
  }

  const provided = extractBearerToken(request);
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // The parse error itself is discarded, not logged: V8 embeds
    // surrounding source in "Unexpected token" messages, and on this route
    // the surrounding source is the caller's recipient list — the same
    // trap sync/src/api/routes.ts's handleCreateSession documents for a
    // credential. Only a fixed, request-independent string is logged.
    console.error('tokens: rejected — request body was not valid JSON');
    return json({ error: INVALID_BODY_ERROR }, 400);
  }

  const sends = parseSends(body);
  if (!sends) {
    console.error(
      'tokens: rejected — request body did not match ' +
        '{sends:[{recipientEmail,subject,accountId,messageId}]}',
    );
    return json({ error: INVALID_BODY_ERROR }, 400);
  }
  if (sends.length > MAX_SENDS) {
    // 413, not 400: the shape is fine, there is simply too much of it.
    // Distinguishing the two gives a caller (sync) a clear signal to split
    // the batch rather than treat it as malformed input to fix.
    console.error(`tokens: rejected — ${sends.length} sends exceeds the cap of ${MAX_SENDS}`);
    return json({ error: 'too many sends' }, 413);
  }

  const rows = sends.map(buildRow);

  try {
    await insertTokens(rows);
  } catch (error) {
    // Never log recipient/subject content (Plan 4 Global Constraints) —
    // only that the insert failed and how many rows were involved.
    console.error(`tokens: insert failed for ${rows.length} row(s)`, error);
    return json({ error: 'insert failed' }, 500);
  }

  return json({
    tokens: rows.map((row) => ({ token: row.token, recipientEmail: row.recipientEmail })),
  });
}
