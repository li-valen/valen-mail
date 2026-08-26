import type { AccountConfig, TrackingConfig } from '../config';
import type { RateLimiter } from './rate-limit';
import type { Transports } from '../send/transports';
import { json, PRIVATE_NO_STORE } from './http.ts';
import { buildMessageId, mintTokens, sendTracked } from '../send/send.ts';
import type { MintSend, MintedToken } from '../send/send';
import { buildQuotedHtml } from '../send/quote.ts';
import {
  chooseTokenStrategy,
  parseAttachments,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENT_FILENAME_CHARS,
  MAX_ATTACHMENT_CONTENT_TYPE_CHARS,
  SHARED_TOKEN_RECIPIENT,
  TRACKED_SEND_BYTE_BUDGET,
} from '../send/attachments.ts';
import type { DecodedAttachment, TokenStrategy } from '../send/attachments';

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
export const MAX_IDENTITY_ID_CHARS = 64;
/** RFC 5321's maximum forward-path length. */
export const MAX_RECIPIENT_CHARS = 254;
/**
 * One `Message-ID`, angle brackets included. Matches the 256 characters
 * tracking's POST /api/tokens accepts and the bound ../send/send.ts's
 * `buildMessageId` truncates its own output to, so the three numbers are
 * visibly the same number rather than coincidentally equal.
 */
export const MAX_MESSAGE_ID_CHARS = 256;
/**
 * How long a `References` chain this route will emit.
 *
 * The header is genuinely unbounded in RFC 5322 and grows by one id per
 * message, so a thread nobody ever leaves would eventually build a header
 * the receiving server refuses — taking the whole message with it. 50 is
 * far past any thread a human reads and short enough that the header stays
 * a few kilobytes.
 *
 * A chain longer than this is REFUSED rather than truncated: silently
 * dropping the oldest ids would produce a reply that threads correctly in
 * some clients and not others, which is worse than an honest 400.
 */
export const MAX_REFERENCES = 50;
/** The display form of the original sender, as it appears in the quote's
 *  attribution line ("Ada Lovelace <ada@example.com>"). */
export const MAX_FROM_LABEL_CHARS = 320;
/**
 * The original body a reply may quote — html and plaintext TOGETHER, in
 * bytes.
 *
 * Combined rather than per-alternative because ../send/quote.ts uses
 * exactly one of them (html when present, plaintext otherwise), so a
 * per-field cap would reserve transport budget for bytes that can never
 * both be used.
 */
export const MAX_QUOTE_BODY_BYTES = 100 * 1024;

/**
 * The largest raw HTTP body ../api/server.ts will buffer for THIS route —
 * 16 MiB.
 *
 * The caps above bound the message; this bounds the bytes on the wire, and
 * the two are not the same number. `MAX_TEXT_BODY_BYTES` is measured on
 * the DECODED string, while the transport sees the JSON encoding of it,
 * and JSON escaping expands a C0 control character to `\u00XX` — six
 * bytes for one. A body at exactly the decoded cap can therefore arrive as
 * six times its measured size, and a transport cap set to the decoded
 * number would refuse a perfectly valid message with an opaque 413 before
 * the route ever ran.
 *
 * ATTACHMENTS DO NOT ESCAPE, THEY INFLATE. Base64 is 4/3 the size of what
 * it encodes and every character of it is JSON-safe, so the attachment
 * term is a flat `ceil(bytes / 3) * 4` rather than a x6 escape factor —
 * conflating the two would over-reserve by four times.
 *
 * Worst case, all fields maximal and every escapable byte escaped:
 *
 *   attachments  ceil(10,485,760/3) x 4 = 13,981,016
 *   attachment metadata 10 x (255x6 + 255x6 + 64) =  31,240
 *   textBody     102,400 x 6            =    614,400
 *   quote body   102,400 x 6            =    614,400
 *   references        50 x (256 x 6 + 3) =    76,950
 *   recipients        25 x (254 x 4 + 3) =    25,475
 *   fromLabel        320 x 6            =      1,920
 *   inReplyTo        256 x 6            =      1,536
 *   subject          500 x 6            =      3,000
 *   identityId        64 x 4            =        256
 *   sentAtMs, field names, braces, colons ~       220
 *                                          ----------
 *                                          15,350,413  -> 16 MiB reserved
 *
 * Raised from 768 KiB by Plan 9 (a reply carries the ORIGINAL body as well
 * as the new one), and from 1,536 KiB by Plan 11, which is the raise that
 * changes the risk rather than just the arithmetic. The earlier note here
 * read "the worst an authenticated caller can hold is 30 x 1.5 MiB"; it is
 * now 30 x 16 MiB, about 480 MiB, if all 30 of the hourly budget were in
 * flight at once. That is why ../send/attachments.ts caps attachments at
 * 10 MiB rather than at Gmail's own 25 MB ceiling — the same pessimistic
 * bound at 25 MB is 1.2 GB, which this box does not have. The route is
 * still behind the auth gate and the 30-per-hour cap; the exposure is a
 * deliberate, bounded trade for being able to send a file at all.
 *
 * tests/send-route.test.ts recomputes that sum from the constants above
 * and asserts it fits, so raising any component cap without raising this
 * one fails a test rather than silently making it unreachable again.
 *
 * Deliberately a PER-ROUTE cap rather than a global raise: server.ts's
 * default 8 KiB was chosen for POST /api/session, which is
 * unauthenticated, and a tight ceiling there is real protection against an
 * anonymous caller spending this 955 MB box's memory. This route sits
 * behind the auth gate, so the same ceiling buys nothing and costs the
 * user their long emails.
 */
export const MAX_SEND_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

/**
 * The global send budget: 30 sends per hour, in memory, counting EVERY
 * attempt.
 *
 * This is a runaway-script brake, not a security control — unlike the
 * session limiter in ./rate-limit.ts, this route is authenticated, so
 * anyone who can spend the budget already holds the credential and could
 * do far worse than send mail. What it bounds is the blast radius of a
 * loop bug in a client: 30 requests is far more than a human composing by
 * hand will reach in an hour, and few enough that a stuck retry loop stops
 * early instead of running all night.
 *
 * It bounds REQUESTS, not messages, and the difference matters (fix round
 * 1). At the 25-recipient cap, 30 requests is 750 SMTP messages inside one
 * window — against Gmail's ~500-per-DAY limit (spec 5.3), so a single hour
 * at this cap is 1.5x the daily quota. This therefore must NOT be read as
 * protecting the sending account's quota or reputation: Gmail's own limit
 * is the backstop for that, and it is what will actually refuse.
 *
 * A second counter over recipients-per-window was considered and NOT
 * added. It would duplicate a limit the provider already enforces
 * authoritatively and per-account, while this process only ever sees its
 * own in-memory tally — cleared by a restart, and blind to anything the
 * same account sent through Gmail's web UI or another client. Requests are
 * what this process can honestly count, so requests are what it counts.
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

/**
 * True when a value must never be interpolated into a header.
 *
 * `inReplyTo` and each `references` entry become RAW header values, so a CR
 * or LF inside one TERMINATES that header and lets whatever follows become
 * a header of the caller's choosing — `Bcc:` being the one that matters,
 * since it silently copies the user's mail somewhere they never asked for.
 *
 * The whole C0 range is refused rather than just CR/LF: no legal
 * message-id or display name carries one, and a check narrower than the
 * one already applied to recipients and subjects would be an asymmetry
 * this file cannot justify.
 *
 * Callers REJECT on true — never strip and continue. A silently mangled
 * thread id is indistinguishable from a working one until the reply lands
 * unthreaded days later, with no error anywhere; a 400 is the honest
 * answer while there is still a person watching.
 */
function hasHeaderInjection(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

/** One message-id as this route will emit it: non-empty, bounded, and
 *  carrying nothing that could close the header it lands in. */
function isUsableMessageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MESSAGE_ID_CHARS &&
    !hasHeaderInjection(value)
  );
}

/**
 * The `References` chain, or null when the field was present and unusable.
 *
 * Absent becomes `[]` rather than null — the same rule
 * ../api/message.ts's `normalizeReferences` follows on the read side, so
 * the value round-trips through the client unchanged in shape.
 */
function parseReferences(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_REFERENCES) return null;
  if (!value.every(isUsableMessageId)) return null;
  return value;
}

/** The quoted original, as it arrives over HTTP. `sentAtMs` mirrors
 *  ParsedMessage.date exactly: epoch MILLISECONDS or null, never an ISO
 *  string. */
interface ValidQuote {
  readonly originalHtml: string | null;
  readonly originalText: string | null;
  readonly fromLabel: string;
  readonly sentAtMs: number | null;
}

/** A body alternative of the quoted original: a string, or null for "this
 *  message had none". */
function parseQuoteBody(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validates the quote source. Returns null for anything unusable, which
 * the caller turns into the same one 400 every other malformed field gets.
 *
 * The SOURCE arrives here, never pre-built html: the quote is assembled
 * server-side by ../send/quote.ts so that spec §5.6's strip runs against
 * the real TRACKING_BASE_URL — a value the browser client deliberately
 * never learns (client/src/composeApi.ts: "this module never learns a
 * second base URL"). A client-built quote could not perform that strip at
 * all, and would duplicate the quote builder besides.
 */
function parseQuote(value: unknown): ValidQuote | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const originalHtml = parseQuoteBody(record.originalHtml);
  const originalText = parseQuoteBody(record.originalText);
  if (originalHtml === undefined || originalText === undefined) return null;

  const quotedBytes =
    Buffer.byteLength(originalHtml ?? '', 'utf8') + Buffer.byteLength(originalText ?? '', 'utf8');
  if (quotedBytes > MAX_QUOTE_BODY_BYTES) return null;

  const fromLabel = record.fromLabel;
  if (
    typeof fromLabel !== 'string' ||
    fromLabel.length === 0 ||
    fromLabel.length > MAX_FROM_LABEL_CHARS ||
    hasHeaderInjection(fromLabel)
  ) {
    return null;
  }

  // Epoch MILLISECONDS or null, matching ParsedMessage.date. An ISO string
  // is refused rather than coerced: three separate defects in this project
  // came from a timestamp that was a string at one hop and a number at the
  // next.
  const sentAtMs = record.sentAtMs;
  if (sentAtMs !== null && typeof sentAtMs !== 'number') return null;
  if (sentAtMs !== null && !Number.isFinite(sentAtMs)) return null;

  return { originalHtml, originalText, fromLabel, sentAtMs };
}

/**
 * The three fields a reply adds, all absent for a plain compose.
 *
 * Parsed as a unit so ./parseSendBody stays about the shape of a message
 * rather than the shape of a message plus the shape of a thread.
 */
interface ReplyFields {
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly quote?: ValidQuote;
}

/**
 * Validates the reply fields, returning null when any PRESENT one is
 * unusable — a malformed field that becomes a header is a refusal, not a
 * shrug (see hasHeaderInjection).
 */
function parseReplyFields(record: Record<string, unknown>): ReplyFields | null {
  const inReplyTo = record.inReplyTo;
  if (inReplyTo !== undefined && !isUsableMessageId(inReplyTo)) return null;

  const references = parseReferences(record.references);
  if (references === null) return null;

  const quoteRaw = record.quote;
  if (quoteRaw === undefined || quoteRaw === null) return { inReplyTo, references };

  const quote = parseQuote(quoteRaw);
  if (quote === null) return null;
  return { inReplyTo, references, quote };
}

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
  /** Absent for a plain compose, which is every message this product sent
   *  before Plan 9 — and which must stay byte-identical. */
  readonly inReplyTo?: string;
  /** Oldest → newest. `[]` when absent. */
  readonly references: readonly string[];
  readonly quote?: ValidQuote;
  /** Validated and DECODED. `[]` for a message with no files, which is
   *  every message this product sent before Plan 11. */
  readonly attachments: readonly DecodedAttachment[];
  /**
   * Total DECODED attachment bytes — what spec §5.3.1's budget is measured
   * in. Carried alongside the list rather than recomputed at the call site
   * so there is exactly one place this number is derived, and no chance of
   * the base64 length being summed by mistake somewhere downstream.
   */
  readonly attachmentBytes: number;
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
 * The outcome of validating a body: the narrowed request, or a CODE
 * naming which constraint it broke.
 *
 * The code exists for the LOG, never for the response — the client still
 * gets the one INVALID_BODY_ERROR string, because a field-by-field error
 * on this route would have to name the field that was wrong and the
 * fields are recipients and a subject. A code is safe to log by
 * construction: it is drawn from a fixed vocabulary and can never carry a
 * filename, an address or a byte of the message.
 */
type SendBodyParse =
  | { readonly ok: true; readonly request: ValidRequest }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates the request body, returning the narrowed shape or the
 * constraint it broke.
 *
 * One verdict for every failure as far as the CALLER is concerned (see
 * INVALID_BODY_ERROR); the reason travels only as far as the log line.
 */
function parseSendBody(body: unknown): SendBodyParse {
  const shape = { ok: false, reason: 'shape' } as const;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return shape;
  const record = body as Record<string, unknown>;

  const identityId = record.identityId;
  if (
    typeof identityId !== 'string' ||
    identityId.length === 0 ||
    identityId.length > MAX_IDENTITY_ID_CHARS
  ) {
    return { ok: false, reason: 'identityId' };
  }

  const to = parseAddressList(record.to, true);
  if (!to || to.length === 0) return { ok: false, reason: 'to' };

  const cc = parseAddressList(record.cc, false);
  if (!cc) return { ok: false, reason: 'cc' };

  if (to.length + cc.length > MAX_RECIPIENTS) return { ok: false, reason: 'recipient_count' };

  const subject = record.subject;
  if (
    typeof subject !== 'string' ||
    subject.length > MAX_SUBJECT_CHARS ||
    /[\r\n]/.test(subject)
  ) {
    return { ok: false, reason: 'subject' };
  }

  const textBody = record.textBody;
  if (typeof textBody !== 'string' || Buffer.byteLength(textBody, 'utf8') > MAX_TEXT_BODY_BYTES) {
    return { ok: false, reason: 'textBody' };
  }

  const reply = parseReplyFields(record);
  if (reply === null) return { ok: false, reason: 'reply_fields' };

  // Attachments last: it is the only field whose validation allocates
  // (base64 has to be decoded to be checked at all), so every cheap
  // structural refusal above happens before a megabyte is copied.
  const attachments = parseAttachments(record.attachments);
  if (!attachments.ok) return { ok: false, reason: `attachment:${attachments.reason}` };

  return {
    ok: true,
    request: {
      identityId,
      to,
      cc,
      subject,
      textBody,
      ...reply,
      attachments: attachments.attachments,
      attachmentBytes: attachments.totalBytes,
    },
  };
}

/**
 * Who gets which token.
 *
 * PER-RECIPIENT: exactly what the mint returned, one token each, in
 * order — unchanged from every send this product made before Plan 11.
 *
 * SHARED: the single minted token, paired with every REAL recipient, so
 * ../send/send.ts still sends one envelope per person and the route still
 * reports one result per person. Only the pixel is shared; nobody
 * receives less mail because the message degraded.
 *
 * Returns null when a shared mint came back with nothing to share, which
 * `mintTokens` should already have refused (it checks the response length
 * against the sends it answers). Kept as a real branch rather than a
 * non-null assertion: the alternative is a crash inside the send loop,
 * after some copies have gone out.
 */
function pairTokensWithRecipients(
  strategy: TokenStrategy,
  minted: readonly MintedToken[],
  recipients: readonly string[],
): readonly MintedToken[] | null {
  if (strategy === 'per-recipient') return minted;
  const shared = minted[0];
  if (shared === undefined) return null;
  return recipients.map((recipientEmail) => ({ recipientEmail, token: shared.token }));
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

  const validated = parseSendBody(body);
  if (!validated.ok) {
    // Names the constraint that failed, never the value that failed it.
    // `reason` is a fixed vocabulary (see SendBodyParse) — for an
    // attachment it is the shape of the problem, `attachment:unsafe_filename`,
    // never the filename.
    console.error(
      `send: rejected (${validated.reason}) — body did not match ` +
        '{identityId,to,cc?,subject,textBody,inReplyTo?,references?,quote?,attachments?} ' +
        `within its caps (subject ${MAX_SUBJECT_CHARS} chars, body ${MAX_TEXT_BODY_BYTES} bytes, ` +
        `${MAX_RECIPIENTS} recipients, ${MAX_REFERENCES} references, ` +
        `quote ${MAX_QUOTE_BODY_BYTES} bytes, ${MAX_ATTACHMENT_COUNT} attachments totalling ` +
        `${MAX_ATTACHMENT_TOTAL_BYTES} decoded bytes, filename ${MAX_ATTACHMENT_FILENAME_CHARS} ` +
        `chars, content type ${MAX_ATTACHMENT_CONTENT_TYPE_CHARS} chars) or carried a CR/LF in ` +
        'a field that becomes a header',
    );
    return json({ error: INVALID_BODY_ERROR }, 400, PRIVATE_NO_STORE);
  }
  const parsed = validated.request;

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

  /**
   * SPEC §5.3.1, AND IT IS DECIDED HERE — BEFORE THE MINT, BEFORE SMTP,
   * while nothing has happened that cannot be taken back.
   *
   * Gmail files every one of the N per-recipient copies into Sent, so the
   * attachments cost `bytes x recipients` of a 15 GB quota rather than
   * `bytes`. Above the budget the message falls back to ONE token shared
   * by every copy: the files still go out to everyone, but the product
   * stops claiming per-person attribution it would be spending the quota
   * to buy. The composer says so before the user presses Send
   * (client/src/attachmentPicker.ts) — this is not a surprise sprung
   * afterwards.
   *
   * DECODED bytes, from ../send/attachments.ts's own accounting. Feeding
   * this the base64 length would degrade messages 33% early.
   */
  const strategy = chooseTokenStrategy(parsed.attachmentBytes, recipients.length);

  // A shared strategy mints ONE row, attributed to nobody
  // (SHARED_TOKEN_RECIPIENT) rather than to the first recipient — writing
  // a real address there would make the opens feed name a person on
  // evidence that says only that somebody opened it.
  const mintRecipients = strategy === 'shared' ? [SHARED_TOKEN_RECIPIENT] : recipients;
  const sends: readonly MintSend[] = mintRecipients.map((recipientEmail) => ({
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

  const perRecipientTokens = pairTokensWithRecipients(strategy, minted.tokens, recipients);
  if (perRecipientTokens === null) {
    console.error(
      `send: refused — a shared-token mint came back empty for account ${identity.id}`,
    );
    return json({ error: 'tracking unavailable' }, 502, PRIVATE_NO_STORE);
  }

  if (strategy === 'shared') {
    // Counts and the account id only — never a filename, an address or
    // the token itself.
    console.error(
      `send: attachments on ${recipients.length} copies would cost ` +
        `${parsed.attachmentBytes * recipients.length} bytes against a ` +
        `${TRACKED_SEND_BYTE_BUDGET}-byte budget for account ${identity.id}; ` +
        'degraded to one shared token (spec §5.3.1)',
    );
  }

  // Assembled HERE, from the source the client sent, and only after the
  // tracking config is known to exist — spec §5.6's strip needs the real
  // TRACKING_BASE_URL, and it must run before ../send/build.ts injects the
  // NEW pixel. Invert that order and the strip eats our own fresh pixel
  // (same origin, same /o/ path) and the reply goes out untracked while
  // looking perfectly fine. tests/send-route.test.ts pins both directions.
  const htmlQuote =
    parsed.quote === undefined
      ? undefined
      : buildQuotedHtml({ ...parsed.quote, trackingBaseUrl: deps.trackingConfig.baseUrl });

  const results = await sendTracked(
    { transport },
    {
      accountId: identity.id,
      fromEmail: identity.email,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      textBody: parsed.textBody,
      htmlQuote,
      messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      // The pixel base IS the tracking base url — one deployment serves
      // both the mint route and /o/{token}.png, so there is no second
      // environment variable to configure or to get out of step.
      pixelBase: deps.trackingConfig.baseUrl,
      recipients: perRecipientTokens,
      attachments: parsed.attachments,
    },
  );

  return json({ results }, 200, PRIVATE_NO_STORE);
}
