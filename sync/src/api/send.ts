import type { AccountConfig, TrackingConfig } from '../config';
import type { RateLimiter } from './rate-limit';
import type { Transports } from '../send/transports';
import { json, PRIVATE_NO_STORE } from './http.ts';
import { buildMessageId, mintTokens, sendTracked } from '../send/send.ts';
import type { MintSend } from '../send/send';

/**
 * POST /api/send (Plan 4 Task 3) — the product's send path.
 *
 * Kept out of ./routes.ts on purpose, the same way ./push.ts and
 * ./identities.ts are: routes.ts keeps a thin branch per route and the
 * behaviour lives here. This route sits behind the router's auth gate, so
 * by the time handleSend runs the caller has already proven a credential.
 *
 * This module is the HTTP boundary and nothing more — validation, status
 * codes, freshness headers and the send budget. Minting and SMTP live in
 * ../send/send.ts; rendering lives in ../send/build.ts.
 *
 * NOTHING here logs a subject, a body, a recipient address or a token
 * (Plan 4 Global Constraints). Counts and the sending account id only.
 * tests/send-route.test.ts plants sentinel values and asserts they reach
 * no console channel at all.
 */

/** Spec/plan cap on one compose action's subject. */
export const MAX_SUBJECT_CHARS = 500;
/**
 * 100 KiB of BODY, measured in bytes rather than characters: a cap counted
 * in `String.length` lets 100,000 four-byte emoji through as a ~400 KB
 * message, which is four times the limit anyone reading the number would
 * expect it to enforce.
 */
export const MAX_TEXT_BODY_BYTES = 100 * 1024;
/** To + Cc TOGETHER. Each recipient costs one minted token and one SMTP
 *  send, so the cap is on the total, not per field. Matches the batch cap
 *  tracking's POST /api/tokens enforces on its own side. */
export const MAX_RECIPIENTS = 25;
/** Matches the bound tracking's mint route puts on `accountId`, so an id
 *  that would be refused there is refused here with a clearer status. */
const MAX_IDENTITY_ID_CHARS = 64;
/** RFC 5321's maximum forward-path length. */
const MAX_RECIPIENT_CHARS = 254;

/**
 * The global send budget: 30 sends per hour, in memory, counting EVERY
 * attempt.
 *
 * This is a runaway-script brake, not a security control — unlike the
 * session limiter in ./rate-limit.ts, this route is authenticated, so
 * anyone who can spend the budget already holds the credential and could
 * do far worse than send mail. What it actually bounds is the blast radius
 * of a loop bug in a client: 30 sends is more than a human composing by
 * hand will ever reach in an hour, and few enough that a script stuck in a
 * retry loop cannot burn the sending account's Gmail reputation before
 * someone notices.
 *
 * Its own instance and its own two constants, deliberately sharing only
 * the fixed-window MECHANISM with the session limiter. Sharing a counter
 * would mean a burst of sends could lock the owner out of signing in.
 *
 * EVERY attempt counts, including ones refused for a malformed body: the
 * runaway script this exists to brake is exactly the one whose requests
 * never reach SMTP.
 */
export const SEND_RATE_LIMIT_MAX_ATTEMPTS = 30;
export const SEND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** One fixed string for every malformed-body verdict. Never echoes any
 *  part of the request: the request is a recipient list and a subject. */
const INVALID_BODY_ERROR = 'invalid request body';

/**
 * C0 controls and DEL. CR/LF inside an address or a subject is the classic
 * SMTP header-injection vector; nodemailer would encode them, but a
 * boundary check must not depend on the library behind it.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export interface SendRouteDeps {
  readonly accounts: readonly AccountConfig[];
  /** Null when the router was built without them — sends are refused
   *  rather than attempted (503). */
  readonly transports: Transports | null;
  /** Null when TRACKING_BASE_URL/TRACKING_READ_TOKEN were not configured.
   *  Sends fail closed (502) — there is no untracked fallback. */
  readonly trackingConfig: TrackingConfig | null;
  readonly limiter: RateLimiter;
  readonly nowMs: number;
  /** Injected in tests; production always uses the real global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface ValidRequest {
  readonly identityId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly textBody: string;
}

/**
 * A recipient address as this route will accept it.
 *
 * Not an RFC 5322 parser and not trying to be — the browser client does
 * the friendly checking. What matters here is that nothing structurally
 * dangerous reaches the SMTP layer: no control characters, an `@` so it is
 * plausibly routable at all, and a length bound.
 */
function isUsableRecipient(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_RECIPIENT_CHARS &&
    trimmed.includes('@') &&
    !CONTROL_CHARACTERS.test(trimmed)
  );
}

function parseAddressList(value: unknown, required: boolean): readonly string[] | null {
  if (value === undefined || value === null) return required ? null : [];
  if (!Array.isArray(value)) return null;
  if (!value.every(isUsableRecipient)) return null;
  return value.map((address) => (address as string).trim());
}

/**
 * Validates the request body, returning the narrowed shape or null.
 *
 * One verdict for every failure (see INVALID_BODY_ERROR): a field-by-field
 * error message on this route would have to name the field that was wrong,
 * and the fields are recipients and a subject.
 */
function parseSendBody(body: unknown): ValidRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const identityId = record.identityId;
  if (
    typeof identityId !== 'string' ||
    identityId.length === 0 ||
    identityId.length > MAX_IDENTITY_ID_CHARS
  ) {
    return null;
  }

  const to = parseAddressList(record.to, true);
  if (!to || to.length === 0) return null;

  const cc = parseAddressList(record.cc, false);
  if (!cc) return null;

  if (to.length + cc.length > MAX_RECIPIENTS) return null;

  const subject = record.subject;
  if (
    typeof subject !== 'string' ||
    subject.length > MAX_SUBJECT_CHARS ||
    /[\r\n]/.test(subject)
  ) {
    return null;
  }

  const textBody = record.textBody;
  if (typeof textBody !== 'string' || Buffer.byteLength(textBody, 'utf8') > MAX_TEXT_BODY_BYTES) {
    return null;
  }

  return { identityId, to, cc, subject, textBody };
}

/**
 * POST /api/send — mint one token per recipient, then send one copy per
 * recipient carrying that recipient's own pixel.
 *
 * Order is load-bearing:
 *  1. budget (a tripped cap must cost nothing at all — no parse, no mint,
 *     no socket),
 *  2. body validation,
 *  3. identity + transport resolution — BEFORE minting, so a send that
 *     cannot happen never writes token rows to the tracking database,
 *  4. mint, fail-closed,
 *  5. dispatch.
 *
 * Answers 200 even when some copies failed. The per-recipient `results`
 * carry the truth, and a 500 would tell the user only that "something went
 * wrong" about an operation that is half-done and cannot be retried
 * wholesale without double-sending to everyone it already reached.
 */
export async function handleSend(request: Request, deps: SendRouteDeps): Promise<Response> {
  const decision = deps.limiter.check(deps.nowMs);
  if (!decision.allowed) {
    console.error('send: refused — global send cap reached for this window');
    return json({ error: 'too many sends' }, 429, {
      ...PRIVATE_NO_STORE,
      'retry-after': String(decision.retryAfterSeconds),
    });
  }
  // Charged immediately, before anything can return early: this counter is
  // "attempts", not "successes" (see SEND_RATE_LIMIT_MAX_ATTEMPTS). The
  // limiter's method is named for its only previous caller, POST
  // /api/session, which charges failures only; here every attempt is
  // charged, which is the same single act of spending one unit of budget.
  deps.limiter.recordFailure(deps.nowMs);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // The parse error is discarded rather than logged: V8 embeds
    // surrounding source in "Unexpected token" messages, and here the
    // surrounding source is the user's own message.
    console.error('send: rejected — request body was not valid JSON');
    return json({ error: INVALID_BODY_ERROR }, 400, PRIVATE_NO_STORE);
  }

  const parsed = parseSendBody(body);
  if (!parsed) {
    // Names the constraints, never the values.
    console.error(
      'send: rejected — body did not match {identityId,to,cc?,subject,textBody} within its ' +
        `caps (subject ${MAX_SUBJECT_CHARS} chars, body ${MAX_TEXT_BODY_BYTES} bytes, ` +
        `${MAX_RECIPIENTS} recipients)`,
    );
    return json({ error: INVALID_BODY_ERROR }, 400, PRIVATE_NO_STORE);
  }

  const identity = deps.accounts.find((account) => account.id === parsed.identityId);
  if (!identity) {
    console.error('send: rejected — no configured account owns the requested identity');
    return json({ error: 'unknown identity' }, 404, PRIVATE_NO_STORE);
  }

  const transport = deps.transports?.get(identity.id);
  if (!transport) {
    console.error(`send: refused — no SMTP transport available for account ${identity.id}`);
    return json({ error: 'sending is not configured' }, 503, PRIVATE_NO_STORE);
  }

  if (!deps.trackingConfig) {
    // Fail closed, exactly as an unreachable tracking service does. The
    // product IS the tracking; a send that silently went out untracked
    // would be this service lying about what it did.
    console.error(
      'send: refused — TRACKING_BASE_URL/TRACKING_READ_TOKEN not configured, so no token ' +
        'can be minted and no send may claim to be tracked',
    );
    return json({ error: 'tracking unavailable' }, 502, PRIVATE_NO_STORE);
  }

  const recipients = [...parsed.to, ...parsed.cc];
  // ONE Message-ID for the whole logical message — every per-recipient
  // copy carries it, exactly as an ordinary group email does, and the
  // tracking rows are minted against that same id.
  const messageId = buildMessageId(identity.email);
  const sends: readonly MintSend[] = recipients.map((recipientEmail) => ({
    recipientEmail,
    subject: parsed.subject,
    accountId: identity.id,
    messageId,
  }));

  const minted = await mintTokens(
    {
      baseUrl: deps.trackingConfig.baseUrl,
      token: deps.trackingConfig.readToken,
      fetchImpl: deps.fetchImpl,
    },
    sends,
  );

  if (!minted.ok) {
    console.error(
      `send: refused — could not mint ${sends.length} token(s) for account ${identity.id} ` +
        `(${minted.reason}); NOT falling back to an untracked send`,
    );
    return json({ error: 'tracking unavailable' }, 502, PRIVATE_NO_STORE);
  }

  const results = await sendTracked(
    { transport },
    {
      accountId: identity.id,
      fromEmail: identity.email,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      textBody: parsed.textBody,
      messageId,
      // The pixel base IS the tracking base url — one deployment serves
      // both the mint route and /o/{token}.png, so there is no second
      // environment variable to configure or to get out of step.
      pixelBase: deps.trackingConfig.baseUrl,
      recipients: minted.tokens,
    },
  );

  return json({ results }, 200, PRIVATE_NO_STORE);
}
