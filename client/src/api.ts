/**
 * Wrapper around the sync service's JSON API (GET /api/inbox, GET
 * /api/opens). The client talks to exactly ONE origin — the sync service
 * that serves this bundle — and never holds the tracking service's URL or
 * token; the sync service proxies that (sync/src/api/routes.ts
 * handleOpens). If a second base URL ever seems necessary here, that is a
 * design violation, not a missing feature.
 *
 * Auth: the sync service's own routes require a bearer token
 * (sync/src/api/routes.ts, extractBearerToken), but that token is
 * configuration for the SERVER, never a value this module holds or sends.
 * Every request below goes out with `credentials: 'same-origin'` and no
 * Authorization header — a token embedded in shipped JavaScript is
 * readable by anyone with devtools, which matters more here than usual
 * because this API fronts four real mailboxes. How a same-origin browser
 * request ends up authorized against the deployed service (a reverse-proxy
 * header injection, a future session mechanism, or similar) is a
 * deployment concern outside this task's scope — see task-3-report.md.
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
 * Fetches a page of the unified inbox, newest first.
 *
 * `before` is the bare-timestamp cursor sync/src/api/routes.ts still
 * supports for backward tolerance (an ISO date string) — this client does
 * not use the compound account+uid cursor, which trades tie-loss on shared
 * timestamps for a one-argument pagination interface.
 *
 * Throws ApiError on any non-2xx response (so callers can distinguish 401
 * from 500) and rejects with the raw fetch error on a network failure —
 * neither case is swallowed. The inbox is the primary surface, so a
 * failure here is the caller's to handle, not to hide behind a fallback.
 */
export async function getInbox(
  limit: number,
  before?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly InboxMessage[]> {
  const path = buildPath('/api/inbox', {
    limit: String(limit),
    before: before ?? undefined,
  });
  const body = (await getJson(path, fetchImpl)) as { messages?: unknown };
  return Array.isArray(body.messages) ? (body.messages as InboxMessage[]) : [];
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
    const body = (await getJson(path, fetchImpl)) as { opens?: unknown; available?: unknown };
    if (!Array.isArray(body.opens)) return UNAVAILABLE;
    return {
      opens: body.opens as OpenEvent[],
      available: body.available === true,
    };
  } catch (error) {
    console.error('api: opens rail degraded to unavailable', error);
    return UNAVAILABLE;
  }
}
