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

const REQUEST_INIT: RequestInit = { credentials: 'same-origin' };

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function getJson(path: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(path, REQUEST_INIT);
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
  readonly sizeBytes: string | null;
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
 * Fetches a page of the unified inbox, newest first.
 *
 * `cursor` is the SAME compound keyset cursor described above — pass
 * `null`/`undefined` for the first page, and a previous page's
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
  limit: number,
  cursor?: InboxCursor | null,
  fetchImpl: typeof fetch = fetch,
): Promise<InboxPage> {
  const path = buildPath('/api/inbox', {
    limit: String(limit),
    before: cursor?.before ?? undefined,
    beforeAccount: cursor?.beforeAccount ?? undefined,
    beforeUid: cursor?.beforeUid ?? undefined,
  });
  const body = await getJson(path, fetchImpl);
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  return {
    messages: keepValid(messages, isInboxMessage, 'inbox message(s)'),
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

/** One open event, as returned by GET /api/opens (sync/src/api/opens.ts OpenEvent). */
export interface OpenEvent {
  readonly token: string;
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
 * The same two structural fields sync/src/api/opens.ts validates on its own
 * side of this hop: `token` is the join key back to a tracked send and
 * `occurredAt` is what the rail sorts and formats by. Checked again here
 * because the sync service is a separate process that can be redeployed
 * independently — "it was validated upstream" is an assumption, not a
 * guarantee, at a network boundary.
 */
function isOpenEvent(value: unknown): value is OpenEvent {
  if (!isRecord(value)) return false;
  return typeof value.token === 'string' && typeof value.occurredAt === 'number';
}
