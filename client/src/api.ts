/**
 * Wrapper around the sync service's JSON API (GET /api/inbox, GET
 * /api/opens). The client talks to exactly ONE origin — the sync service
 * that serves this bundle — and never holds the tracking service's URL or
 * token; the sync service proxies that (sync/src/api/routes.ts
 * handleOpens). If a second base URL ever seems necessary here, that is a
 * design violation, not a missing feature.
 *
 * Auth: the sync service's routes accept EITHER a bearer token or a
 * session cookie (sync/src/api/session.ts, Task 3.5). This module only
 * ever uses the second one, and only implicitly: every request goes out
 * with `credentials: 'same-origin'` and no Authorization header, because a
 * token embedded in shipped JavaScript is readable by anyone with
 * devtools, and this API fronts four real mailboxes. The cookie is
 * HttpOnly, so this module cannot read it either — it is established once
 * by ./session.ts's `createSession` and then simply rides along.
 *
 * A 401 from any function here therefore means "no usable session", and
 * `withSession` in ./session.ts is what turns that into a login prompt and
 * a retry. Nothing in this file holds, stores, or logs a credential.
 */

import { buildInboxParams } from './inboxFilters';
import type { FolderId } from './inboxFilters';
import { buildSearchParams } from './searchQuery';

const REQUEST_INIT: RequestInit = { credentials: 'same-origin' };

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * `signal` is threaded through for exactly one caller — the speculative
 * prefetcher (./messagePrefetch.ts), which must be able to abandon a
 * guess the moment the user navigates away from what motivated it. Every
 * other call passes nothing and behaves exactly as it did: `signal:
 * undefined` is what `fetch` sees when the field is absent.
 */
async function getJson(
  path: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(path, signal === undefined ? REQUEST_INIT : { ...REQUEST_INIT, signal });
  if (!response.ok) {
    throw new ApiError(response.status, `${path} returned ${response.status}`);
  }
  return response.json();
}

function buildPath(pathname: string, params: Readonly<Record<string, string | undefined>>): string {
  // Built against a throwaway base so URLSearchParams can encode values
  // correctly, then reduced back to a path — fetchImpl receives a relative
  // URL and resolves it against the current origin, never a hardcoded host.
  const url = new URL(pathname, 'http://same-origin.invalid');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Keeps the items an item-level predicate vouches for and drops the rest,
 * logging ONCE per response rather than once per item.
 *
 * `response.json()` is `unknown`, and this client is the last place a
 * malformed row can be refused before it reaches a component — after this
 * point a missing `uid` is a dead link and a numeric `date` is a literal
 * "Invalid Date" in the UI. Dropping the bad item and keeping its valid
 * siblings is the right degradation for an inbox: one corrupt row must not
 * blank a whole page of mail.
 *
 * Deliberately a hand-written predicate per caller rather than a schema
 * library — no new dependency (client/CLAUDE.md), and this mirrors the
 * boundary check sync/src/api/opens.ts already applies to the tracking
 * service's response. `items` is only read; a new array is returned.
 */
function keepValid<T>(
  items: readonly unknown[],
  isValid: (value: unknown) => value is T,
  label: string,
): readonly T[] {
  const valid = items.filter(isValid);
  if (valid.length !== items.length) {
    console.error(
      `api: dropped ${items.length - valid.length} of ${items.length} ${label} from the ` +
        'sync service response — the item did not carry the fields the UI depends on',
    );
  }
  return valid;
}

/** True for a value that is a non-null object, narrowed for field access. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A field that the wire shape declares as `string | null`. `undefined` is
 *  tolerated the same as `null`: an absent optional field is not a
 *  malformed row, but a number where a date string belongs is. */
function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/** One attachment's metadata on an inbox message (sync/src/db.ts MESSAGE_SELECT). */
export interface InboxAttachment {
  readonly partId: string;
  readonly filename: string | null;
  readonly mimeType: string | null;
  /** A JSON `number`, unlike `InboxMessage.size_bytes` below even though
   *  both mirror the same `bigint` column. MESSAGE_SELECT (sync/src/db.ts)
   *  emits this one through `json_build_object('sizeBytes',
   *  att.size_bytes)`, and Postgres serialises a bigint inside
   *  `json_build_object` unquoted — never through the pg driver's row
   *  mapping, which is what forces `InboxMessage.size_bytes` to stay a
   *  string. Confirmed against real Postgres in sync/tests/db.test.ts
   *  (`sizeBytes: 51_201`, a numeric literal that a string would fail).
   *  Not a typo; do not "fix" this to match its sibling. */
  readonly sizeBytes: number | null;
}

/**
 * One row of the unified inbox, as returned by GET /api/inbox — the raw
 * Postgres columns from sync/src/schema.sql's `messages` table (snake_case;
 * the server does no camelCase translation). `uid` and `size_bytes` are
 * bigint columns, which the pg driver returns as strings to avoid silent
 * precision loss above 2^53, so they stay strings here too.
 *
 * **THE snake_case BELOW IS DELIBERATE. IT IS NOT A STYLE SLIP.** This
 * project names things in camelCase everywhere else; these fields are the
 * one exception because they are a verbatim mirror of a wire shape this
 * client does not control. Renaming them to camelCase here would silently
 * decouple the type from the JSON it describes, and the compiler would not
 * say a word — every field would just be `undefined` at runtime.
 */
export interface InboxMessage {
  readonly account_id: string;
  readonly uid: string;
  readonly message_id: string | null;
  readonly thread_id: string | null;
  readonly folder: string;
  readonly subject: string | null;
  readonly from_name: string | null;
  readonly from_email: string | null;
  readonly to_emails: readonly string[] | null;
  readonly cc_emails: readonly string[] | null;
  readonly date: string | null;
  readonly snippet: string | null;
  readonly flags: readonly string[] | null;
  readonly labels: readonly string[] | null;
  readonly has_attach: boolean;
  /** A `string`, unlike `InboxAttachment.sizeBytes` above even though both
   *  mirror the same `bigint` column: this field comes straight off the
   *  `messages` row, so it takes the pg driver's bigint→string mapping
   *  (see interface doc above), while the attachment field is built by
   *  `json_build_object`, which serialises a bigint as an unquoted JSON
   *  number instead. Not a typo. */
  readonly size_bytes: string | null;
  readonly attachments: readonly InboxAttachment[];
}

/**
 * The keyset cursor GET /api/inbox speaks on both sides of the wire
 * (sync/src/api/routes.ts `parseInboxCursor` / `nextCursorFrom`): as
 * `?before=&beforeAccount=&beforeUid=` on a request, and as `nextCursor`
 * on a response. The shape is deliberately identical in both directions —
 * pass a page's `nextCursor` straight back as the next request's cursor,
 * never reconstruct one from a row (task-4-brief.md Amendment 1).
 *
 * `beforeAccount`/`beforeUid` are `null` in the legacy "bare timestamp"
 * request shape; a `nextCursor` this client receives never has either
 * null when `before` is non-null, and can have `before: null` with both
 * set for the NULL-date tail (rows with no timestamp, which sort last).
 */
export interface InboxCursor {
  readonly before: string | null;
  readonly beforeAccount: string | null;
  readonly beforeUid: string | null;
}

/** One page of the unified inbox: the messages, plus the cursor that
 *  reaches the next page, or `null` when this was the last page (a short
 *  page — sync/src/api/routes.ts `nextCursorFrom` never emits a cursor
 *  past the end). */
export interface InboxPage {
  readonly messages: readonly InboxMessage[];
  readonly nextCursor: InboxCursor | null;
}

/**
 * One request for a page of the unified inbox: how many rows, which
 * folder, which account, and where to resume.
 *
 * **ONE object rather than four positional parameters, on purpose.** The
 * server derives `nextCursor` purely from the last returned ROW, so it
 * carries no memory of the folder or account the page was drawn from
 * (sync/src/api/inbox.ts's `nextCursorFrom` documents this). A paged
 * request that forwards the cursor but drops the filter therefore pages
 * into a DIFFERENT result set — `folder` silently reverts to `inbox`, the
 * server answers 200, and nothing anywhere reports a problem. Bundling
 * the cursor with the filter it belongs to is what makes that mistake
 * unavailable at a call site instead of merely discouraged; see
 * ./inboxFilters.ts's header and tests/inbox-filters.test.ts.
 */
export interface InboxRequest {
  readonly limit: number;
  /** Defaults to `'inbox'`, which is also the server's default and is
   *  therefore omitted from the query string entirely. */
  readonly folder?: FolderId;
  /** `null`/omitted = all accounts merged. NEVER `''` — see
   *  ./inboxFilters.ts, that value is a 400. */
  readonly account?: string | null;
  readonly cursor?: InboxCursor | null;
}

/**
 * Fetches a page of the unified inbox, newest first.
 *
 * `cursor` is the SAME compound keyset cursor described above — omit it
 * (or pass `null`) for the first page, and pass a previous page's
 * `nextCursor` for the next one. This is deliberate, not a convenience:
 * with four accounts merged into one timeline, two messages landing on
 * the same second is ordinary (batch sends, newsletters), and a
 * `before`-only cursor skips or duplicates every row sharing that
 * boundary timestamp. `beforeAccount`/`beforeUid` also address the
 * NULL-date tail — rows with no timestamp, which sort last — with no
 * `before` at all, a cursor a bare-timestamp client could never
 * construct, which otherwise makes those rows permanently unreachable by
 * paging.
 *
 * Throws ApiError on any non-2xx response (so callers can distinguish 401
 * from 500) and rejects with the raw fetch error on a network failure —
 * neither case is swallowed. The inbox is the primary surface, so a
 * failure here is the caller's to handle, not to hide behind a fallback.
 */
export async function getInbox(
  request: InboxRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<InboxPage> {
  // The query string is built in exactly one place for every inbox
  // request this client makes — first page and paged alike — so folder
  // and account cannot be present on one and missing from the other.
  const query = buildInboxParams(request);
  const path = query === '' ? '/api/inbox' : `/api/inbox?${query}`;
  const body = await getJson(path, fetchImpl);
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  return {
    messages: keepValid(messages, isInboxMessage, 'inbox message(s)'),
    nextCursor: isRecord(body) ? parseNextCursor(body.nextCursor) : null,
  };
}

/**
 * One free-text search over the unified inbox.
 *
 * `q` is the raw box contents; `getSearch` clamps it on the way out (see
 * ./searchQuery.ts's `buildSearchParams`). The other three fields are the
 * SAME filter+cursor bundle `InboxRequest` carries, for the same
 * structural reason: /api/search reuses /api/inbox's keyset cursor
 * verbatim, so a paged search that forwards the cursor without its filter
 * pages into a different result set with an ordinary 200.
 */
export interface SearchRequest {
  readonly q: string;
  readonly limit: number;
  /** Sent ALWAYS, default included — unlike `InboxRequest.folder`. An
   *  absent `folder` means "every folder" to this route. */
  readonly folder?: FolderId;
  readonly account?: string | null;
  readonly cursor?: InboxCursor | null;
}

/**
 * Searches the unified inbox, newest first.
 *
 * Returns an `InboxPage` — the SAME envelope and the SAME row shape as
 * `getInbox`, because sync/src/api/search.ts is deliberately /api/inbox
 * with one more WHERE clause on it (same `getUnifiedInbox`, same
 * `nextCursorFrom`). That is what lets components/InboxList.tsx render
 * and page search results with the code it already has rather than a
 * parallel list.
 *
 * Throws ApiError on any non-2xx, like every other function here. A 400
 * is reachable only through a bug: an empty or over-long `q` is what the
 * server refuses, and `buildSearchParams` cannot emit an over-long one
 * while `InboxList` never calls this with an empty one.
 */
export async function getSearch(
  request: SearchRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<InboxPage> {
  const body = await getJson(`/api/search?${buildSearchParams(request)}`, fetchImpl);
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  return {
    messages: keepValid(messages, isInboxMessage, 'search result(s)'),
    nextCursor: isRecord(body) ? parseNextCursor(body.nextCursor) : null,
  };
}

/**
 * Boundary check on the response half of the cursor, same discipline as
 * `isInboxMessage` below: a malformed or missing `nextCursor` degrades to
 * `null` (read as "no next page") rather than handing a caller a value it
 * would send back uncritically — sending a half-formed cursor to the
 * server is exactly the tie-loss/skip bug Amendment 1 exists to prevent,
 * so a cursor this client cannot verify is treated as no cursor at all.
 */
function parseNextCursor(value: unknown): InboxCursor | null {
  if (!isRecord(value)) return null;
  if (!isNullableString(value.before)) return null;
  if (typeof value.beforeAccount !== 'string' || typeof value.beforeUid !== 'string') return null;
  return {
    before: (value.before as string | null | undefined) ?? null,
    beforeAccount: value.beforeAccount,
    beforeUid: value.beforeUid,
  };
}

/**
 * Narrow boundary check, deliberately not a full schema.
 *
 * `account_id`, `uid` and `folder` are the message's identity and are what
 * every body/attachment URL is built from, so a row missing any of them
 * cannot be rendered as anything a user could act on. `date` is what the
 * inbox sorts and formats by, so a wrong TYPE there is refused — though
 * `null` is a legitimate value (a message with no Date header) and stays.
 * Every other field is display-only and already tolerates `null`
 * downstream, so requiring it here would make the inbox more fragile
 * without protecting anything real.
 */
function isInboxMessage(value: unknown): value is InboxMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.account_id === 'string' &&
    typeof value.uid === 'string' &&
    typeof value.folder === 'string' &&
    isNullableString(value.date)
  );
}

/**
 * One open event, as returned by GET /api/opens (sync/src/api/opens.ts
 * OpenEvent).
 *
 * `accountId`/`messageId` (task V3, Ask 2): link an open back to the
 * message the tracking pixel rode in. The tracking service projects both
 * from `tokens`, where they are NOT NULL, so sync/src/api/opens.ts's own
 * `isValidOpenEvent` already requires them as non-empty strings before an
 * event reaches this client — `isOpenEvent` below re-checks the same two
 * fields at the same strictness, for the same reason it already
 * re-checks `token`/`occurredAt`: a redeployed sync service is a
 * separate process, and "validated upstream" is an assumption, not a
 * guarantee, at this boundary. `components/openEvents.ts`'s
 * `resolveOpenTarget` is what actually consumes them, turning
 * `(accountId, messageId)` into the `(accountId, folder, uid)` triple
 * the reader opens by.
 */
export interface OpenEvent {
  readonly token: string;
  readonly accountId: string;
  readonly messageId: string;
  readonly recipientEmail: string;
  readonly subject: string | null;
  readonly sentAt: number;
  readonly occurredAt: number;
  readonly classification: string;
  readonly deviceClass: string | null;
  readonly os: string | null;
}

/**
 * Result of getOpens. `available` distinguishes "the tracking service
 * cannot be reached" from "nobody has opened anything yet" — both would
 * otherwise be an empty `opens` array, and client/DESIGN.md §7.3 requires
 * the rail to render those two cases in visibly different ways. This
 * mirrors sync/src/api/routes.ts's handleOpens response shape
 * (`{ opens, available }`) exactly, because that route always answers 200
 * — even when the tracking service is down — with `available` carrying the
 * signal a non-2xx status can't here.
 */
export interface OpensResponse {
  readonly opens: readonly OpenEvent[];
  readonly available: boolean;
}

const UNAVAILABLE: OpensResponse = { opens: [], available: false };

/**
 * Fetches recent open events for the rail.
 *
 * Never rejects. The opens rail is secondary to the inbox (DESIGN.md
 * thesis: the inbox must keep working when tracking is down, slow, or
 * broken), so every failure mode — a non-2xx from the sync service, a
 * network error, a malformed body — degrades to the same
 * `{ opens: [], available: false }` result the sync service itself sends
 * for a live tracking outage, rather than throwing and forcing every
 * caller to special-case this endpoint.
 */
export async function getOpens(
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OpensResponse> {
  const path = buildPath('/api/opens', { limit: String(limit) });
  try {
    const body = await getJson(path, fetchImpl);
    if (!isRecord(body) || !Array.isArray(body.opens)) return UNAVAILABLE;
    return {
      opens: keepValid(body.opens, isOpenEvent, 'open event(s)'),
      available: body.available === true,
    };
  } catch (error) {
    console.error('api: opens rail degraded to unavailable', error);
    return UNAVAILABLE;
  }
}

/**
 * The four structural fields sync/src/api/opens.ts validates on its own
 * side of this hop: `token` is the join key back to a tracked send,
 * `occurredAt` is what the rail sorts and formats by, and
 * `accountId`/`messageId` (task V3) are what `resolveOpenTarget`
 * (components/openEvents.ts) resolves the opened message with — required
 * as non-empty strings, not merely present, because an empty one is
 * exactly the "can't resolve the message" case: a client is better off
 * never rendering that open than rendering a dead-end click. Checked
 * again here because the sync service is a separate process that can be
 * redeployed independently — "it was validated upstream" is an
 * assumption, not a guarantee, at a network boundary.
 */
function isOpenEvent(value: unknown): value is OpenEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.token === 'string' &&
    typeof value.occurredAt === 'number' &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0
  );
}

/**
 * One mailbox from a parsed message's address headers
 * (sync/src/api/message.ts `ParsedAddress`). `address` is always a
 * non-empty string on the wire — the server drops group entries and
 * address-less mailboxes rather than emitting a `mailto:` to nowhere —
 * and `parseAddress` below re-checks that here.
 */
export interface ParsedAddress {
  readonly name: string | null;
  readonly address: string;
}

/**
 * Attachment metadata on a PARSED message (GET /api/message/…), which is
 * a different shape from `InboxAttachment` above and must not be confused
 * with it:
 *
 *  - **`sizeBytes` here is the DECODED byte length** — the size of the
 *    saved file, a `number`. `InboxAttachment.sizeBytes` is also a
 *    `number` on the wire, but it is the ENCODED size from BODYSTRUCTURE,
 *    roughly 4/3 larger for base64 — same field name, same JSON type,
 *    ~33% apart in VALUE. This is the one to display; never
 *    cross-reference the other.
 *  - **`partId` may be the empty string**, meaning the server could not
 *    establish an IMAP part number for it and refused to guess one. That
 *    is "not addressable", not "part zero": see
 *    components/messageBody.ts's `isDownloadable`, which is the only
 *    thing that should decide whether a download link exists.
 *  - `contentId` is already bracket-stripped, so it matches a
 *    `src="cid:…"` in `html` exactly.
 */
export interface MessageAttachment {
  readonly partId: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly isInline: boolean;
  readonly contentId: string | null;
}

/**
 * A parsed message, as returned by GET /api/message/{accountId}/{folder}/
 * {uid} (sync/src/api/message.ts). camelCase here, unlike `InboxMessage`
 * above, because this shape is the sync service's own JSON rather than a
 * verbatim mirror of Postgres columns — the difference is deliberate on
 * both sides.
 *
 * **`html` is UNSANITISED and that is by design.** The server returns the
 * sender's markup byte for byte so that the sandboxed iframe stays the
 * one visible security boundary (see sync/src/api/message.ts's header,
 * and components/messageBody.ts's). Nothing in this client may render it
 * except through `srcDocFor`, and nothing may put it near
 * `dangerouslySetInnerHTML`.
 *
 * `date` is epoch milliseconds — this API's convention for a timestamp
 * (as on `OpenEvent`), not the ISO string an `InboxMessage` row carries.
 */
export interface ParsedMessage {
  readonly html: string | null;
  readonly text: string | null;
  readonly subject: string | null;
  readonly from: ParsedAddress | null;
  readonly to: readonly ParsedAddress[];
  readonly cc: readonly ParsedAddress[];
  readonly date: number | null;
  /**
   * This message's `Message-ID`, **with its angle brackets** — or null
   * when it carries none, which means "this cannot be replied to
   * in-thread".
   *
   * THE BRACKETS ARE LOAD-BEARING AND MUST NOT BE STRIPPED HERE. The
   * value is round-tripped straight back to POST /api/send as
   * `inReplyTo`, which emits it VERBATIM as a header
   * (sync/src/send/send.ts). Anything that trims the brackets on the way
   * through produces a reply that sends, looks perfectly normal, and
   * lands as a brand-new thread in the recipient's Gmail.
   */
  readonly messageId: string | null;
  /**
   * The `References` chain, oldest → newest, each entry with its angle
   * brackets. `[]` when the header is absent — never null, because
   * ../replyDraft.ts concatenates this and `[]` concatenates while null
   * throws.
   */
  readonly references: readonly string[];
  readonly attachments: readonly MessageAttachment[];
}

/** A field the wire shape declares as `string | null`, narrowed to a
 *  string or `null`; anything else (a number, an object) is absence. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A message whose body could not be read from the response at all. Not
 *  an error state: `bodyKind` reads it as `'empty'`, which the reader
 *  renders as an empty state rather than a failure — the same treatment a
 *  genuinely attachment-only message gets. */
const UNREADABLE_MESSAGE: ParsedMessage = {
  html: null,
  text: null,
  subject: null,
  from: null,
  to: [],
  cc: [],
  date: null,
  messageId: null,
  references: [],
  attachments: [],
};

function parseAddress(value: unknown): ParsedAddress | null {
  if (!isRecord(value)) return null;
  if (typeof value.address !== 'string' || value.address === '') return null;
  return { name: stringOrNull(value.name), address: value.address };
}

/** Drops entries with no usable address rather than rendering a header
 *  line with a blank recipient in it. */
function parseAddressList(value: unknown): readonly ParsedAddress[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseAddress)
    .filter((address): address is ParsedAddress => address !== null);
}

/**
 * Normalises one attachment. Deliberately total rather than a drop-it
 * predicate: an attachment whose metadata is partly unusable is still an
 * attachment the user should be told about.
 *
 * A `partId` that is not a string becomes `''` — which is the server's
 * own "not addressable" sentinel, so an unusable value lands in exactly
 * the same honest, non-downloadable row as a missing one instead of
 * being interpolated into a URL as `undefined`.
 */
function parseAttachment(value: Record<string, unknown>): MessageAttachment {
  const sizeBytes = value.sizeBytes;
  const mimeType = value.mimeType;
  return {
    partId: typeof value.partId === 'string' ? value.partId : '',
    filename: stringOrNull(value.filename),
    mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'application/octet-stream',
    sizeBytes: typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? sizeBytes : null,
    isInline: value.isInline === true,
    contentId: stringOrNull(value.contentId),
  };
}

function parseAttachments(value: unknown): readonly MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return keepValid(value, isRecord, 'attachment(s)').map(parseAttachment);
}

/**
 * The `References` chain, degraded field-wise like everything else on
 * this boundary: a non-array is absence, and an entry that is not a
 * usable string is dropped rather than carried forward.
 *
 * `[]` rather than null for the absent case, matching
 * sync/src/api/message.ts's `normalizeReferences` exactly — the value
 * round-trips back to POST /api/send unchanged in shape, and every
 * caller concatenates it.
 *
 * A DROPPED ENTRY IS NOT SILENT-SAFE AND IS DROPPED ANYWAY. An entry that
 * is not a string cannot become a header, so the alternatives are "drop
 * it" or "refuse to render the message". Dropping loses one link in a
 * thread chain; refusing loses the message. Only the first is
 * recoverable by the user.
 */
function parseReferences(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Turns the response body into a `ParsedMessage`, field by field, and
 * never throws.
 *
 * The same boundary discipline `keepValid` applies to list endpoints,
 * applied to a single object: a field of the wrong type is absence, not a
 * reason to blank the whole message. A reader that refuses to open a
 * message because its `cc` came back as a string would be strictly worse
 * than one that shows the body and no cc line.
 */
function parseMessage(value: unknown): ParsedMessage {
  if (!isRecord(value)) {
    console.error('api: the message response was not an object — nothing to render');
    return UNREADABLE_MESSAGE;
  }
  const date = value.date;
  return {
    html: stringOrNull(value.html),
    text: stringOrNull(value.text),
    subject: stringOrNull(value.subject),
    from: parseAddress(value.from),
    to: parseAddressList(value.to),
    cc: parseAddressList(value.cc),
    date: typeof date === 'number' && Number.isFinite(date) ? date : null,
    messageId: stringOrNull(value.messageId),
    references: parseReferences(value.references),
    attachments: parseAttachments(value.attachments),
  };
}

/**
 * Fetches one parsed message for the reader.
 *
 * Path shape mirrors sync/src/api/routes.ts's `parsedMessageMatch`:
 * `/api/message/{accountId}/{folder}/{uid}`, three `([^/]+)` segments, no
 * `/body` suffix — that sibling route still exists and still returns raw
 * RFC822, and this one does not replace it. Every segment is
 * percent-encoded for the same reason `attachmentUrl` encodes its own: a
 * Gmail folder name can contain a literal `/`.
 *
 * Throws ApiError on any non-2xx so the reader can tell a 401 (session
 * gone) from a 502 (IMAP unreachable) and say so; a malformed 200 body
 * degrades field-wise through `parseMessage` instead.
 */
export async function getMessage(
  accountId: string,
  folder: string,
  uid: string,
  fetchImpl: typeof fetch = fetch,
  /** Aborts the request. Used by ./messagePrefetch.ts to abandon a
   *  speculative fetch on navigation, and by the reader for nothing — an
   *  open the user asked for is never cancelled out from under them. */
  signal?: AbortSignal,
): Promise<ParsedMessage> {
  const segments = [accountId, folder, uid].map(encodeURIComponent);
  const body = await getJson(`/api/message/${segments.join('/')}`, fetchImpl, signal);
  return parseMessage(body);
}

/**
 * Fetches every message in one thread, for the reader's thread context.
 *
 * GET /api/thread/{threadId} answers `{messages:[…]}` with the SAME row
 * shape as GET /api/inbox, so this reuses `isInboxMessage` rather than
 * introducing a second, drifting definition of a row — and so the thread
 * list can render with the very same `MessageRow` the inbox uses.
 *
 * An unknown thread id is not distinguishable from an empty one: the
 * server answers 200 with an empty array either way, on purpose (it
 * refuses to leak which thread ids exist). An empty result here therefore
 * means "no thread context to show", never "not found".
 */
export async function getThread(
  threadId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly InboxMessage[]> {
  const body = await getJson(`/api/thread/${encodeURIComponent(threadId)}`, fetchImpl);
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  return keepValid(messages, isInboxMessage, 'thread message(s)');
}

/**
 * PATCH /api/message/{accountId}/{folder}/{uid}/flags — the ONE call in
 * this client that changes state in the user's real Gmail.
 *
 * Path shape mirrors `getMessage` above exactly (three percent-encoded
 * segments, because a Gmail folder name can contain a literal `/`), plus
 * a `/flags` suffix. The body names exactly one flag and one direction;
 * sync/src/api/flags.ts refuses two keys, zero keys, an unknown key or a
 * non-boolean with a 400 that reaches no IMAP call — so this function's
 * signature is deliberately shaped so a caller CANNOT assemble an invalid
 * body: one field name, one boolean.
 *
 * NOTHING HERE IS BULK, and nothing here should become bulk. The server
 * says the same thing in the same words and for the same reason: one
 * request changes one flag on one message, which is what bounds the
 * damage a bug on either side can do to a live mailbox.
 *
 * Throws ApiError on any non-2xx, exactly like the GETs above, so a
 * caller can tell a 401 (session gone) from a 502 (IMAP unreachable) and
 * revert its optimistic state either way.
 */
export type FlagField = 'seen' | 'flagged';

export async function setMessageFlag(
  accountId: string,
  folder: string,
  uid: string,
  field: FlagField,
  value: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const segments = [accountId, folder, uid].map(encodeURIComponent);
  const path = `/api/message/${segments.join('/')}/flags`;
  const response = await fetchImpl(path, {
    ...REQUEST_INIT,
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    // `{[field]: value}` and nothing else. Two keys is a 400 by design.
    body: JSON.stringify({ [field]: value }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, `${path} returned ${response.status}`);
  }
}

/**
 * The five engagement states GET /api/followup puts on every row
 * (sync/src/followup/classify.ts `EngagementState`).
 *
 * `never-opened` and `unverifiable` are DIFFERENT FACTS and the whole
 * reason this union is five values rather than a boolean: spec §7A.2
 * makes "we cannot tell" a first-class state, and a client that collapsed
 * the two would be the lying UI that spec forbids. The server decides
 * which one applies, because only the server knows how much of the opens
 * history it was able to read.
 */
export type EngagementState =
  | 'opened-no-reply'
  | 'opened-replied'
  | 'opened-repeatedly'
  | 'never-opened'
  | 'unverifiable';

/**
 * One row of the follow-up queue (sync/src/followup/query.ts
 * `FollowupRow`).
 *
 * TIMESTAMPS ARE EPOCH-MS NUMBERS, not ISO strings — matching `OpenEvent`
 * above rather than `InboxMessage`, whose `date` is a verbatim mirror of a
 * Postgres column. `uid` is a NUMBER here for the same reason: this row is
 * shaped by the server rather than passed through from the driver, so it
 * carries the type its consumers actually want.
 */
export interface FollowupRow {
  readonly accountId: string;
  readonly uid: number;
  readonly folder: string;
  readonly subject: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly recipients: readonly string[];
  readonly sentAtMs: number;
  readonly openCount: number;
  readonly distinctRecipientOpens: number;
  readonly lastOpenAtMs: number | null;
  readonly hasReply: boolean;
  readonly state: EngagementState;
}

/**
 * One page of the follow-up queue.
 *
 * `opensAvailable` is the same distinction `OpensResponse.available`
 * carries, for the same reason: "nobody has opened anything" and "we
 * could not read the tracking service" are different facts, and the empty
 * state must not report the second as the first.
 */
export interface FollowupPage {
  readonly rows: readonly FollowupRow[];
  readonly nextCursor: InboxCursor | null;
  readonly opensAvailable: boolean;
}

export interface FollowupRequest {
  readonly limit: number;
  /** `null`/omitted = every account's sent mail merged. */
  readonly account?: string | null;
  readonly cursor?: InboxCursor | null;
}

/**
 * Narrow boundary check. The identity triple is what a row is opened by,
 * `sentAtMs` is what it is ordered and formatted by, and `state` is what
 * it is ranked and labelled by — a row missing any of them cannot be
 * rendered as something a user could act on. Everything else already
 * tolerates a missing value downstream.
 *
 * `state` is checked as a plain non-empty string rather than against the
 * five known literals: an unrecognised state must still reach
 * `engagementCopy`, which degrades it to the honest unknown. Refusing the
 * row here would silently shrink the queue instead.
 */
function isFollowupRow(value: unknown): value is FollowupRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.accountId === 'string' &&
    typeof value.uid === 'number' &&
    typeof value.folder === 'string' &&
    typeof value.sentAtMs === 'number' &&
    typeof value.state === 'string' &&
    value.state.length > 0
  );
}

/**
 * Fetches a page of outbound mail with an engagement state on every row —
 * spec §7A's "Sent & Waiting" and "Opened, no reply", which are one list
 * the view filters rather than two endpoints.
 *
 * Throws ApiError on a non-2xx exactly like `getInbox`, so the session
 * gate can turn a 401 into a login prompt. A tracking outage is NOT a
 * non-2xx: the route answers 200 with `opensAvailable: false` and every
 * row honestly unknown, so there is nothing to catch for that case.
 */
export async function getFollowup(
  request: FollowupRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<FollowupPage> {
  const path = buildPath('/api/followup', {
    limit: String(request.limit),
    account: request.account ?? undefined,
    before: request.cursor?.before ?? undefined,
    beforeAccount: request.cursor?.beforeAccount ?? undefined,
    beforeUid: request.cursor?.beforeUid ?? undefined,
  });
  const body = await getJson(path, fetchImpl);
  const rows = isRecord(body) && Array.isArray(body.rows) ? body.rows : [];
  return {
    rows: keepValid(rows, isFollowupRow, 'follow-up row(s)'),
    nextCursor: isRecord(body) ? parseNextCursor(body.nextCursor) : null,
    // Absent or malformed reads as "not available", never as available:
    // the failure direction that renders uncertainty as certainty is the
    // one this whole feature exists to refuse.
    opensAvailable: isRecord(body) && body.opensAvailable === true,
  };
}
