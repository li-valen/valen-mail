import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db';
import type { ConnectionPool } from '../imap/pool';
import type { ImapConnection } from '../imap/connection';
import { fetchBodyPart } from '../imap/fetch.ts';

/** A client asking for `limit=999999` must not be honoured — this caps how
 *  many rows a single /api/inbox request can pull regardless of what the
 *  query string asks for. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Constant-time comparison. A plain `===` short-circuits on the first
 * differing byte, leaking token length and prefix through response timing.
 * This endpoint fronts four (soon up to ten) real mailboxes on the public
 * internet — `timingSafeEqual` throws on a length mismatch, so the length
 * check must happen first, and that check itself leaks nothing the caller
 * doesn't already know (their own input's length).
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

/**
 * Clamps `limit` to [1, MAX_LIMIT] and falls back to DEFAULT_LIMIT for
 * anything that isn't a usable positive number — a missing param, a
 * non-numeric string, NaN, or a negative value — so a malformed or hostile
 * query string is handled rather than thrown on (Resolution 2).
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const requested = Number(raw);
  if (!Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(requested)), MAX_LIMIT);
}

/** Ignores an unparsable `before` value rather than throwing — an
 *  unfiltered inbox read is a safe fallback for a malformed date. */
function parseBeforeDate(raw: string | null): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Validates and converts a UID route parameter. Amendment 2: a UID coming
 * out of the database is a string (Postgres bigint), but a UID coming in
 * from a URL path is also a string that has never been validated as a
 * number at all — this is the one deliberate conversion point for that
 * value on the way into fetchBodyPart/db.query, rather than trusting it to
 * already look like the number it claims to be.
 */
function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Strips characters that could break out of a quoted Content-Disposition
 *  filename or inject a header (CRLF) — the filename originates from a
 *  message a Gmail sender controls, not from us. */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[\r\n"]/g, '_');
}

async function handleHealth(pool: ConnectionPool): Promise<Response> {
  // Resolution 1: account ids and statuses only — no email addresses, no
  // message counts, nothing beyond what an operator needs to see which
  // accounts are connected versus reconnecting. This is the one route
  // served without a token, so it must stay incapable of leaking mailbox
  // contents by construction, not just by convention.
  const accounts = [...pool.status.entries()].map(([id, status]) => ({ id, status }));
  return json({ ok: true, accounts });
}

async function handleInbox(db: Db, url: URL): Promise<Response> {
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBeforeDate(url.searchParams.get('before'));
  const messages = await db.getUnifiedInbox({ limit, before });
  return json({ messages });
}

async function handleThread(db: Db, threadId: string): Promise<Response> {
  // Resolution 3: an unknown thread id is not distinguished from an empty
  // one. A 404 here would let a caller probe which thread ids exist across
  // the unified inbox; returning 200 with an empty array either way removes
  // that signal.
  const messages = await db.getThread(threadId);
  return json({ messages });
}

/**
 * Looks up a live connection for `accountId` and confirms the pool
 * considers it connected before any IMAP call is attempted, returning a
 * ready-to-send Response instead when it can't proceed. Shared by the body
 * and attachment handlers so both fail the same way for the same reasons.
 */
function resolveConnection(pool: ConnectionPool, accountId: string): ImapConnection | Response {
  const connection = pool.getConnection(accountId);
  if (!connection) return json({ error: 'unknown account' }, 404);

  const status = pool.status.get(accountId);
  if (status !== 'connected') {
    return json({ error: `account not connected (status: ${status ?? 'unknown'})` }, 503);
  }

  return connection;
}

async function handleBody(
  pool: ConnectionPool,
  accountId: string,
  folder: string,
  uidRaw: string,
): Promise<Response> {
  const uid = parsePositiveInt(uidRaw);
  if (uid === null) return json({ error: 'invalid uid' }, 400);

  const resolved = resolveConnection(pool, accountId);
  if (resolved instanceof Response) return resolved;

  try {
    // No partId: fetchBodyPart falls through to imapflow's own "whole raw
    // message" download when the part is omitted (see imap/fetch.ts).
    const bytes = await fetchBodyPart(resolved, folder, uid);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'message/rfc822' } });
  } catch (error) {
    console.error(`api: failed to fetch body for account "${accountId}" uid ${uid}`, error);
    return json({ error: 'failed to fetch message body' }, 502);
  }
}

interface AttachmentMetaRow {
  readonly filename: string | null;
  readonly mime_type: string | null;
}

/**
 * Best-effort metadata lookup so the response can carry a real
 * Content-Type/filename instead of a bare octet-stream. Uses `Db.query`
 * with placeholders — never string-built SQL from route parameters
 * (Resolution 4) — and tolerates a miss (attachment metadata predates this
 * row, or was never recorded) by falling back to generic values rather than
 * failing the whole request.
 */
async function lookupAttachmentMeta(
  db: Db,
  accountId: string,
  folder: string,
  uid: number,
  partId: string,
): Promise<AttachmentMetaRow | null> {
  const rows = await db.query(
    'select filename, mime_type from attachments where account_id = $1 and folder = $2 and uid = $3 and part_id = $4',
    [accountId, folder, uid, partId],
  );
  return (rows[0] as AttachmentMetaRow | undefined) ?? null;
}

async function handleAttachment(
  db: Db,
  pool: ConnectionPool,
  accountId: string,
  folder: string,
  uidRaw: string,
  partId: string,
): Promise<Response> {
  const uid = parsePositiveInt(uidRaw);
  if (uid === null) return json({ error: 'invalid uid' }, 400);
  if (!partId) return json({ error: 'invalid part id' }, 400);

  const resolved = resolveConnection(pool, accountId);
  if (resolved instanceof Response) return resolved;

  const meta = await lookupAttachmentMeta(db, accountId, folder, uid, partId);

  try {
    const bytes = await fetchBodyPart(resolved, folder, uid, partId);
    const headers: Record<string, string> = {
      'content-type': meta?.mime_type ?? 'application/octet-stream',
    };
    if (meta?.filename) {
      headers['content-disposition'] = `attachment; filename="${sanitizeFilename(meta.filename)}"`;
    }
    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    console.error(
      `api: failed to fetch attachment for account "${accountId}" uid ${uid} part "${partId}"`,
      error,
    );
    return json({ error: 'failed to fetch attachment' }, 502);
  }
}

/**
 * Builds the request handler for the unified-inbox JSON API. Every route
 * except /api/health requires a valid bearer token (Amendment 1: three
 * arguments — auth cannot be optional on a service fronting four mailboxes
 * containing 60,000+ messages on the public internet). Auth is checked
 * before any route is matched, so an unauthenticated caller gets the same
 * 401 for a real route and a typo'd one — never a 404 that would confirm a
 * route exists before proving the caller is allowed to ask.
 */
export function createRouter(
  db: Db,
  pool: ConnectionPool,
  apiToken: string,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      return handleHealth(pool);
    }

    const token = extractBearerToken(request);
    if (!token || !tokenMatches(token, apiToken)) {
      return json({ error: 'unauthorized' }, 401);
    }

    if (request.method !== 'GET') {
      return json({ error: 'not found' }, 404);
    }

    if (path === '/api/inbox') {
      return handleInbox(db, url);
    }

    const threadMatch = path.match(/^\/api\/thread\/([^/]+)$/);
    if (threadMatch) {
      return handleThread(db, decodeURIComponent(threadMatch[1] ?? ''));
    }

    const bodyMatch = path.match(/^\/api\/message\/([^/]+)\/([^/]+)\/([^/]+)\/body$/);
    if (bodyMatch) {
      const accountId = decodeURIComponent(bodyMatch[1] ?? '');
      const folder = decodeURIComponent(bodyMatch[2] ?? '');
      const uidRaw = bodyMatch[3] ?? '';
      return handleBody(pool, accountId, folder, uidRaw);
    }

    const attachmentMatch = path.match(/^\/api\/attachment\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (attachmentMatch) {
      const accountId = decodeURIComponent(attachmentMatch[1] ?? '');
      const folder = decodeURIComponent(attachmentMatch[2] ?? '');
      const uidRaw = attachmentMatch[3] ?? '';
      const partId = decodeURIComponent(attachmentMatch[4] ?? '');
      return handleAttachment(db, pool, accountId, folder, uidRaw, partId);
    }

    return json({ error: 'not found' }, 404);
  };
}
