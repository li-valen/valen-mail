import { MAX_LIMIT, DEFAULT_LIMIT } from './limits.ts';

/**
 * The tracking service is a separate deployment on its own network path; a
 * hung connection must not hang the inbox request that triggered it.
 * Exported so tests can assert against it directly rather than
 * hardcoding a second copy of the number.
 */
export const REQUEST_TIMEOUT_MS = 5000;

/**
 * One open event as returned by the tracking service's GET /api/opens
 * (sync/../tracking/, Task 1). `sentAt`/`occurredAt` are epoch
 * milliseconds — numbers, not ISO strings (confirmed against the deployed
 * service; see Amendment 2). `subject`, `deviceClass` and `os` are
 * genuinely nullable. `classification` is deliberately left as `string`
 * rather than narrowed to a union: an unrecognised value from a future
 * classifier must still parse rather than be rejected at this boundary.
 */
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
 * Result of a fetchOpens call. A plain `readonly OpenEvent[]` return type
 * cannot express "the tracking service is down" separately from "nobody
 * has opened anything yet" — both would be `[]`. Task 5's rail needs to
 * render an explicit unavailable state, which requires that distinction to
 * survive past this function (Amendment 1).
 *
 * `unreachable`: the fetch itself threw or was aborted (timeout, DNS
 * failure, connection refused, etc.) — we never got a response at all.
 * `upstream_error`: we got a response, but it was a non-2xx status, or a
 * 2xx body that was not valid JSON in the expected shape.
 */
export type OpensResult =
  | { readonly ok: true; readonly opens: readonly OpenEvent[] }
  | { readonly ok: false; readonly reason: 'unreachable' | 'upstream_error' };

export interface FetchOpensDeps {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

/**
 * Narrow, hand-written boundary check (Amendment 3) — not a schema
 * library, just the two fields the rest of the system actually depends
 * on structurally. `token` is the join key back to a specific tracked
 * send; `occurredAt` is what the rail sorts and formats by. Every other
 * field is display-only and already tolerates `null`/unexpected values
 * downstream, so requiring them here would only make the endpoint more
 * fragile without protecting anything real.
 */
function isValidOpenEvent(value: unknown): value is OpenEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === 'string' && typeof record.occurredAt === 'number';
}

/**
 * Extracts and validates the `opens` array from a parsed response body.
 * Never throws: an unexpected shape (no `opens` array at all) degrades to
 * zero results rather than propagating a TypeError, and malformed elements
 * are dropped rather than trusted verbatim (never trust external data at a
 * system boundary). Logs once per call summarising how many elements were
 * dropped, rather than once per element, so a bad upstream response
 * produces one log line instead of a flood.
 */
function parseOpensBody(body: unknown): readonly OpenEvent[] {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  const rawOpens = Array.isArray(record?.opens) ? record.opens : [];

  const valid: OpenEvent[] = [];
  let droppedCount = 0;
  for (const item of rawOpens) {
    if (isValidOpenEvent(item)) {
      valid.push(item);
    } else {
      droppedCount += 1;
    }
  }

  if (droppedCount > 0) {
    console.error(
      `opens: dropped ${droppedCount} of ${rawOpens.length} open event(s) from the tracking ` +
      'service response — missing a string token or a numeric occurredAt',
    );
  }

  return valid;
}

/**
 * Reads open events from the tracking service, which is a separate
 * deployment with its own database (Vercel Edge + Neon, Task 1). Never
 * throws: the inbox is the primary surface and must keep working when the
 * tracking service is down, slow, or returns garbage. Callers get an
 * OpensResult instead and decide how to degrade (see routes.ts's
 * handleOpens, which always answers 200 and folds any failure into
 * `available: false`).
 */
export async function fetchOpens(limit: number, deps: FetchOpensDeps): Promise<OpensResult> {
  const bounded = clampLimit(limit);
  const doFetch = deps.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    // Constructing the URL is inside this try deliberately: a malformed
    // TRACKING_BASE_URL throws synchronously from `new URL`, and that must
    // degrade the same way a network failure does, not escape as an
    // uncaught exception.
    const url = new URL('/api/opens', deps.baseUrl);
    url.searchParams.set('limit', String(bounded));
    response = await doFetch(url, {
      headers: { authorization: `Bearer ${deps.token}` },
      signal: controller.signal,
    });
  } catch (error) {
    console.error('opens: tracking service unreachable', error);
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    console.error(`opens: tracking service returned ${response.status}`);
    return { ok: false, reason: 'upstream_error' };
  }

  try {
    const body: unknown = await response.json();
    return { ok: true, opens: parseOpensBody(body) };
  } catch (error) {
    console.error('opens: tracking service returned a body that was not valid JSON', error);
    return { ok: false, reason: 'upstream_error' };
  }
}
