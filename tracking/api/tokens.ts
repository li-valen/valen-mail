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

/**
 * tracking has no identity/account config of its own — that's sync's
 * domain (Plan 4 Task 2's GET /api/identities, backed by loadConfig's
 * accounts). `tokens.account_id` is NOT NULL regardless (schema.sql), and
 * this route's wire contract carries no accountId, so every row minted
 * here is recorded under this fixed, documented sentinel rather than a
 * guessed or empty value. Rows written by other paths (scripts/
 * send-test.mjs) keep a real account id; rows written through this route
 * are simply excluded from `tokens_account_sent`'s per-account grouping
 * until a later task threads a real identity through end to end — a known
 * limitation, not an oversight (see task-p4t1-report.md).
 */
const UNATTRIBUTED_ACCOUNT_ID = 'unattributed';

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

interface SendInput {
  readonly recipientEmail: string;
  readonly subject: string;
}

function isSendInput(value: unknown): value is SendInput {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.recipientEmail === 'string' &&
    record.recipientEmail.length > 0 &&
    typeof record.subject === 'string'
  );
}

/** Returns null for anything that isn't `{sends: SendInput[]}` — the single "malformed" verdict. */
function parseSends(body: unknown): SendInput[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const sends = (body as Record<string, unknown>).sends;
  if (!Array.isArray(sends)) return null;
  return sends.every(isSendInput) ? (sends as SendInput[]) : null;
}

/**
 * `message_id` is NOT NULL on `tokens` (schema.sql), but no real SMTP
 * Message-ID exists yet at mint time — tokens are minted *before* the SMTP
 * send, per Plan 4 Task 3's ordering — and the wire contract has no field
 * for one. Each row gets a deterministic, token-derived placeholder in the
 * same `...@postbox.local` shape `scripts/send-test.mjs` already
 * established for a locally generated correlation id: unique via the
 * token's own uniqueness, and unambiguous to anyone reading the table that
 * it is not a captured header.
 */
function placeholderMessageId(token: string): string {
  return `${token}@postbox.local`;
}

function buildRow(send: SendInput): InsertTokenInput {
  const token = generateToken();
  return {
    token,
    accountId: UNATTRIBUTED_ACCOUNT_ID,
    messageId: placeholderMessageId(token),
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
    console.error('tokens: rejected — request body did not match {sends:[{recipientEmail,subject}]}');
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
