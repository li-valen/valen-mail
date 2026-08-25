import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { Classification } from './classify';
import type { DeviceInfo } from './ua';

/**
 * The spec's most emphatic invariant is that the pixel endpoint always
 * returns an identical 200 PNG, in every case, because any variation lets a
 * recipient fingerprint the tracker. `neon('')` / `neon(undefined)` throw
 * synchronously, and constructing the client eagerly at module evaluation
 * would put that throw *above* the handler's try/catch (isolate init runs
 * before any request-scoped code), turning a missing env var into a
 * platform 500 instead of a swallowed error. Deferring construction to
 * first use moves the throw inside the handler's try, so a misconfigured
 * deploy still serves the pixel and simply records nothing.
 *
 * Typed as the concrete `NeonQueryFunction<false, false>` — the type `neon()`
 * actually returns when called with no options, matching every call site
 * below — rather than `ReturnType<typeof neon>`: because `neon` is generic,
 * that utility resolves to the union across all `ArrayMode`/`FullResults`
 * instantiations and loses the indexable-row shape the query call sites rely
 * on (`rows[0]`, `rows.map(...)`).
 */
let client: NeonQueryFunction<false, false> | null = null;

function sql_(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    client = neon(url);
  }
  return client;
}

/**
 * Minimum acceptable length for IP_HASH_SALT. Chosen so the salt itself
 * carries enough entropy that appending it to a raw IPv4 address defeats a
 * brute-force reversal — a shorter or absent salt turns `raw_ip_hash` into
 * an unsalted SHA-256 of a 32-bit address, i.e. reversible in seconds.
 */
const MIN_IP_HASH_SALT_LENGTH = 32;

/**
 * Fails closed: spec 7.2/7.5 treat a salted IP hash as a named privacy
 * commitment, not best-effort. A missing or implausibly short salt must
 * throw rather than silently degrade to an unsalted (and therefore
 * reversible) hash stored in the same column as a correctly-salted one —
 * that would be indistinguishable from correct operation. The handler's
 * existing catch turns this throw into "record nothing" rather than a
 * privacy violation, which is the correct trade.
 */
export function requireIpHashSalt(): string {
  const salt = process.env.IP_HASH_SALT;
  if (!salt || salt.length < MIN_IP_HASH_SALT_LENGTH) {
    throw new Error(
      `IP_HASH_SALT is missing or shorter than ${MIN_IP_HASH_SALT_LENGTH} characters`,
    );
  }
  return salt;
}

/**
 * A real message never legitimately accumulates this many opens. Past the cap
 * the rows are noise, and without it a repeatedly-fetched pixel is an unbounded
 * write against a 0.5 GB free tier.
 */
export const MAX_OPENS_PER_TOKEN = 200;

/** The only unbounded-width column. Nothing past this carries device signal. */
export const MAX_USER_AGENT_CHARS = 256;

export interface TokenRow {
  readonly token: string;
  readonly accountId: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly recipientEmail: string;
  readonly subject: string | null;
  readonly sentAt: number;
  readonly senderIp: string | null;
}

export interface RecordOpenInput {
  readonly token: string;
  readonly occurredAt: number;
  readonly classification: Classification;
  readonly userAgent: string;
  readonly device: DeviceInfo;
  readonly ipHash: string;
}

/**
 * Raw recipient IPs are never persisted. Superhuman shipped IP-derived
 * location, took public backlash in 2019, removed the feature and deleted
 * the historical data. See spec 7.2.
 */
export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function lookupToken(token: string): Promise<TokenRow | null> {
  const rows = await sql_()`
    select token, account_id, message_id, thread_id,
           recipient_email, subject, sent_at, sender_ip
    from tokens where token = ${token}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    token: row.token,
    accountId: row.account_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    sentAt: new Date(row.sent_at).getTime(),
    senderIp: row.sender_ip,
  };
}

export async function recentHitTimes(token: string, sinceMs: number): Promise<number[]> {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const rows = await sql_()`
    select occurred_at from opens
    where token = ${token} and occurred_at > ${cutoff}
    order by occurred_at desc limit 50
  `;
  return rows.map((row) => new Date(row.occurred_at).getTime());
}

/**
 * Enforces MAX_OPENS_PER_TOKEN inside a single statement via a correlated
 * subquery in the WHERE clause, rather than a separate count-then-insert.
 * The single statement removes the *application-level* extra round trip
 * (no separate SELECT before the INSERT), not the race itself: under
 * Postgres READ COMMITTED, two concurrent hits on the same token can both
 * evaluate the subquery before either commits, so the cap is best-effort
 * and can overshoot under concurrency. That overshoot is bounded (by
 * in-flight concurrency on one token, not unbounded) and was reviewed and
 * accepted — Neon's HTTP driver has no multi-statement transactions, so
 * closing the race with SERIALIZABLE or an advisory lock would mean moving
 * to the WebSocket pool driver on a latency-sensitive request path. The
 * explicit ::type casts are required because a SELECT with no FROM gives
 * Postgres nothing to infer parameter types from.
 */
export async function recordOpen(input: RecordOpenInput): Promise<void> {
  const userAgent = input.userAgent.slice(0, MAX_USER_AGENT_CHARS);
  await sql_()`
    insert into opens
      (token, occurred_at, classification, user_agent, device_class, os, raw_ip_hash)
    select ${input.token}::text,
           ${new Date(input.occurredAt).toISOString()}::timestamptz,
           ${input.classification}::text,
           ${userAgent}::text,
           ${input.device.deviceClass}::text,
           ${input.device.os}::text,
           ${input.ipHash}::text
    where (select count(*) from opens where token = ${input.token}::text)
          < ${MAX_OPENS_PER_TOKEN}::int
  `;
}

export interface OpenRow {
  readonly token: string;
  readonly recipientEmail: string;
  readonly subject: string | null;
  readonly sentAt: number;
  readonly occurredAt: number;
  readonly classification: Classification;
  readonly deviceClass: string | null;
  readonly os: string | null;
}

/**
 * Read side for the endpoint added in Plan 3 Task 1 (`api/opens.ts`). Joins
 * `opens` to `tokens` so a caller gets recipient/subject context alongside
 * each hit in one round trip, without any route running arbitrary SQL
 * against this database — every query stays inside this file, same as
 * every other function above.
 *
 * `limit` is trusted the same way `recentHitTimes`'s `sinceMs` above is
 * trusted: the caller (`api/opens.ts`) is the system boundary that clamps a
 * request-supplied value before this is ever called. The `::int` cast is
 * defence in depth against a non-integer reaching Postgres's LIMIT clause,
 * not a substitute for that clamp.
 *
 * Ordered newest-first so the caller can render "opened N ago" without a
 * second sort.
 */
export async function listRecentOpens(limit: number): Promise<OpenRow[]> {
  const rows = await sql_()`
    select o.token, t.recipient_email, t.subject, t.sent_at,
           o.occurred_at, o.classification, o.device_class, o.os
    from opens o
    join tokens t on t.token = o.token
    order by o.occurred_at desc
    limit ${limit}::int
  `;
  return rows.map((row) => ({
    token: row.token,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    sentAt: new Date(row.sent_at).getTime(),
    occurredAt: new Date(row.occurred_at).getTime(),
    classification: row.classification,
    deviceClass: row.device_class,
    os: row.os,
  }));
}
