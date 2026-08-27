import { ApiError } from './api';
import type { QuoteSource } from './replyDraft';

/**
 * The two calls the composer makes: GET /api/identities (which accounts
 * this mailbox can send AS) and POST /api/send (send one plain-text
 * message, tracked per recipient).
 *
 * A sibling of ./api.ts rather than an addition to it, following the
 * precedent ./session.ts and ./pushApi.ts already set: ./api.ts is built
 * around `getJson` and holds the GETs of mailbox data, and the send is
 * the third non-GET this client makes. `getIdentities` rides along here
 * rather than in ./api.ts so that one feature lives in one file — reading
 * the composer means reading this, not two halves in two places.
 *
 * Same rules as every request this client sends. Relative paths, so they
 * resolve against whatever origin served the bundle and this module never
 * learns a second base URL. `credentials: 'same-origin'`, so the HttpOnly
 * session cookie rides along without this code ever touching it. Never an
 * Authorization header — a bearer token in shipped JavaScript is readable
 * by anyone with devtools, and this API fronts four real mailboxes.
 *
 * NOTHING here logs or puts into an error message a subject, a body, or a
 * recipient address. The route on the other side is held to the same rule
 * (sync/src/api/send.ts) and it would be pointless for the browser to
 * leak what the server refuses to.
 */

const CREDENTIALS: RequestCredentials = 'same-origin';
const IDENTITIES_PATH = '/api/identities';
const SEND_PATH = '/api/send';

/** A whole number of seconds and nothing else. Retry-After may also be an
 *  HTTP-date; this route sends seconds (sync/src/api/send.ts), and a date
 *  is read as "no usable delay" rather than guessed at. */
const RETRY_AFTER_SECONDS = /^\d+$/;

/** One account this mailbox can send as (sync/src/api/identities.ts
 *  `Identity`). Carries no credential material — the app password never
 *  crosses this boundary, structurally, on the server's side. */
export interface Identity {
  readonly id: string;
  readonly email: string;
  readonly isPrimary: boolean;
}

/**
 * What happened to ONE recipient's copy (sync/src/send/send.ts
 * `SendResult`).
 *
 * POST /api/send answers 200 even when some of these are `ok: false`, on
 * purpose: the send is per-recipient, so a partial failure is a real
 * outcome rather than an error, and a 500 would tell the user only that
 * "something went wrong" about an operation that is half-done and cannot
 * be retried wholesale without double-sending to everyone it reached.
 * Treating a 200 as blanket success is therefore a defect — see
 * ./components/composeResults.ts.
 */
export interface SendResult {
  readonly recipientEmail: string;
  readonly ok: boolean;
}

/** One file as POST /api/send takes it (sync/src/send/attachments.ts
 *  `SendAttachment`). */
export interface SendAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
}

export interface SendRequest {
  readonly identityId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  /**
   * The three fields a REPLY adds, all absent for a plain compose —
   * ../replyDraft.ts's `ReplyWireFields`, spread straight in.
   *
   * `inReplyTo` and every `references` entry keep their angle brackets:
   * the route emits them verbatim as headers (sync/src/send/send.ts), and
   * a value stripped on the way through produces a reply that sends
   * cleanly and lands as a brand-new thread.
   */
  readonly inReplyTo?: string;
  /** Oldest → newest. Omitted from the wire when empty. */
  readonly references?: readonly string[];
  /**
   * The quote SOURCE — the original body — never a pre-built quote.
   *
   * The server assembles the `.gmail_quote` element itself
   * (sync/src/send/quote.ts) because spec §5.6's strip of our OWN
   * tracking pixel needs `TRACKING_BASE_URL`, and this module's header
   * rule is that the client never learns a second origin. A quote built
   * here could not perform that strip, and every reply in a thread would
   * re-fire the original recipient's token forever.
   */
  readonly quote?: QuoteSource;
  /**
   * The files riding on this message, already base64-encoded, or absent
   * for a message with none.
   *
   * BASE64 IN THE SAME JSON BODY — no second request and no multipart
   * encoding anywhere in this client. The route already accepts a JSON
   * body and `nodemailer` already turns parts into MIME on the other
   * side, so a multipart parser would be a dependency bought to solve a
   * problem neither end has.
   *
   * `contentBase64` is the ENCODED text; the route decodes it and
   * measures the result. The two differ by 4/3, and spec §5.3.1's budget
   * is in decoded bytes.
   */
  readonly attachments?: readonly SendAttachment[];
}

/**
 * A non-2xx from POST /api/send, carrying the one extra fact a status
 * code cannot: how long a 429 wants the caller to wait.
 *
 * Extends ApiError rather than replacing it so every `instanceof
 * ApiError` / `error.status` check already in this client keeps working
 * on it unchanged.
 */
export class SendRejection extends ApiError {
  /** Seconds from the response's `Retry-After`, or null when the header
   *  was absent or not a plain seconds count. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, message: string, retryAfterSeconds: number | null = null) {
    super(status, message);
    this.name = 'SendRejection';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRetryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null || !RETRY_AFTER_SECONDS.test(header.trim())) return null;
  return Number(header.trim());
}

/** Logs once per response, never once per item, and never names a
 *  dropped value — mirrors ./api.ts's `keepValid`. */
function reportDropped(dropped: number, total: number, label: string): void {
  if (dropped === 0) return;
  console.error(
    `composeApi: dropped ${dropped} of ${total} ${label} from the sync service response — ` +
      'the item did not carry the fields the composer depends on',
  );
}

/** An identity the picker can actually render and send from: it needs an
 *  id to submit and an address to show. `isPrimary` is read strictly —
 *  anything other than `true` is "not primary", so a malformed value can
 *  never quietly become the default sending account. */
function toIdentity(value: unknown): Identity | null {
  if (!isRecord(value)) return null;
  const { id, email } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof email !== 'string' || email === '') return null;
  return { id, email, isPrimary: value.isPrimary === true };
}

/**
 * Fetches the accounts this mailbox can send as, primary first (the
 * server orders them — sync/src/api/identities.ts `orderIdentities`).
 *
 * Throws ApiError on any non-2xx so a 401 stays distinguishable from a
 * 500; a malformed row is dropped and its siblings kept, the same
 * degradation ./api.ts applies to inbox rows.
 */
export async function getIdentities(fetchImpl: typeof fetch = fetch): Promise<readonly Identity[]> {
  const response = await fetchImpl(IDENTITIES_PATH, { credentials: CREDENTIALS });
  if (!response.ok) {
    throw new ApiError(response.status, `${IDENTITIES_PATH} returned ${response.status}`);
  }

  const body: unknown = await response.json();
  const rows = isRecord(body) && Array.isArray(body.identities) ? body.identities : [];
  const identities = rows
    .map(toIdentity)
    .filter((identity): identity is Identity => identity !== null);
  reportDropped(rows.length - identities.length, rows.length, 'identities');
  return identities;
}

/**
 * The identity the composer opens on: the one flagged `isPrimary` (spec
 * §7B.1's send-from default), falling back to the first the server
 * returned, and to `''` when there are none at all.
 *
 * Reads the FLAG rather than trusting position, even though
 * sync/src/api/identities.ts already sorts primary-first. Those are two
 * different promises, kept by two independently deployable processes, and
 * the cost of checking is one predicate — while the cost of not checking
 * is a message sent from the wrong address.
 */
export function primaryIdentityId(identities: readonly Identity[]): string {
  const primary = identities.find((identity) => identity.isPrimary);
  return (primary ?? identities[0])?.id ?? '';
}

/**
 * The identity a REPLY opens on: the account whose mailbox the message
 * arrived in (spec §7B — a reply sends from the account that received
 * it), falling back to the primary when that account is not a sending
 * identity.
 *
 * `InboxMessage.account_id` and `Identity.id` are the same id under two
 * names, both from accounts.json. The fallback is not decoration: an
 * account can be synced for reading and absent from the identity list,
 * and a reply that opened on an empty send-from would be unsendable with
 * no visible reason why.
 */
export function identityIdForAccount(
  accountId: string,
  identities: readonly Identity[],
): string {
  const match = identities.find((identity) => identity.id === accountId);
  return match?.id ?? primaryIdentityId(identities);
}

/** `ok` is read strictly: anything that is not literally `true` is a
 *  failure. That is the direction the uncertainty has to fall — counting
 *  an unreadable result as delivered is exactly the confident wrong
 *  answer this product refuses. */
function toSendResult(value: unknown): SendResult | null {
  if (!isRecord(value)) return null;
  const recipientEmail = value.recipientEmail;
  if (typeof recipientEmail !== 'string' || recipientEmail === '') return null;
  return { recipientEmail, ok: value.ok === true };
}

/**
 * Sends one message: one SMTP copy per recipient, each carrying its own
 * tracking pixel, minted server-side.
 *
 * Resolves with the per-recipient results on 200 — INCLUDING when some of
 * them failed. Throws SendRejection on any non-2xx.
 *
 * A 200 whose body cannot be read as JSON rejects rather than resolving
 * empty, and that is deliberate: the server answered 200, so copies did
 * go out, and reporting "nothing was sent" would be worse than reporting
 * "Valen Mail cannot tell" (which is what ./components/composeResults.ts
 * turns the rejection into).
 */
export async function sendMail(
  request: SendRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly SendResult[]> {
  const response = await fetchImpl(SEND_PATH, {
    method: 'POST',
    credentials: CREDENTIALS,
    headers: { 'content-type': 'application/json' },
    // Named field by field rather than spread, so a field added to
    // SendRequest later cannot ride onto the wire unnoticed.
    //
    // THE REPLY FIELDS ARE OMITTED WHEN ABSENT, NOT SENT AS null OR [].
    // A plain compose must put the same bytes on the wire it always has —
    // the route's own tests assert that a message with no reply fields is
    // byte-identical to what shipped before Plan 9, and an explicit
    // `inReplyTo: null` would be a present-and-unusable field, which that
    // route answers with a 400.
    body: JSON.stringify({
      identityId: request.identityId,
      to: [...request.to],
      cc: [...request.cc],
      subject: request.subject,
      textBody: request.textBody,
      ...(request.inReplyTo === undefined ? {} : { inReplyTo: request.inReplyTo }),
      ...(request.references === undefined || request.references.length === 0
        ? {}
        : { references: [...request.references] }),
      // OMITTED WHEN EMPTY, exactly like `references` above: a message
      // with no files must put the bytes on the wire it always has, and
      // the route's own tests assert that a send with no attachments is
      // byte-identical to what shipped before Plan 11.
      ...(request.attachments === undefined || request.attachments.length === 0
        ? {}
        : {
            // Named field by field for the same reason the request itself
            // is: whatever the picker carries locally must not ride onto
            // the wire because someone added a field to the type.
            attachments: request.attachments.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.contentType,
              contentBase64: attachment.contentBase64,
            })),
          }),
      ...(request.quote === undefined
        ? {}
        : {
            quote: {
              originalHtml: request.quote.originalHtml,
              originalText: request.quote.originalText,
              fromLabel: request.quote.fromLabel,
              // Epoch MILLISECONDS. The route refuses an ISO string
              // rather than coercing it.
              sentAtMs: request.quote.sentAtMs,
            },
          }),
    }),
  });

  if (!response.ok) {
    // Names the path and the status only. The request was a recipient
    // list, a subject and a body.
    throw new SendRejection(
      response.status,
      `${SEND_PATH} returned ${response.status}`,
      readRetryAfter(response),
    );
  }

  const body: unknown = await response.json();
  const rows = isRecord(body) && Array.isArray(body.results) ? body.results : [];
  const results = rows
    .map(toSendResult)
    .filter((result): result is SendResult => result !== null);
  reportDropped(rows.length - results.length, rows.length, 'send result(s)');
  return results;
}
