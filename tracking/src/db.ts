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
    try {
      client = neon(url);
    } catch {
      // neon() throws "Database connection string provided to `neon()` is
      // not a valid URL. Connection string: <url>" for a malformed value —
      // the raw DATABASE_URL, password included, interpolated straight
      // into the message (confirmed in
      // node_modules/@neondatabase/serverless/index.mjs). That original
      // error must never propagate: every caller of sql_() catches
      // whatever it throws and passes it to console.error, and Vercel
      // ships that straight to its logs. Rethrowing a fixed message with
      // no interpolated value closes that off at the one place every
      // route's query path runs through, so no future call site has to
      // remember to redact. Deliberately no `cause` either — most log
      // serializers walk and print `cause`, which would carry the
      // credential back in through the side door this rethrow exists to
      // close.
      throw new Error('DATABASE_URL is not a valid connection string');
    }
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

/**
 * Row shape accepted by `insertTokens` (Plan 4 Task 1, POST /api/tokens).
 * `account_id` and `message_id` are NOT NULL on `tokens` (see schema.sql).
 *
 * Fix round 1: the wire contract widened to
 * `{sends:[{recipientEmail,subject,accountId,messageId}]}` — both fields
 * are now required, caller-supplied values (sync knows the sending
 * account, and generates the RFC 5322 Message-ID before the SMTP send so
 * the same value can be stamped on the outgoing mail — see
 * task-p4t1-report.md's "Fix round 1" section for the full
 * reconciliation). The two placeholder values this module briefly used
 * (a fixed `'unattributed'` account id and a token-derived
 * `...@postbox.local` message id, back when the contract carried neither
 * field) are gone entirely — a leftover placeholder path would silently
 * mask a caller bug now that real values are expected on every element.
 * `api/tokens.ts` validates both fields (non-empty, length-capped) and
 * passes them straight through unmodified; `insertTokens` itself still
 * just persists whatever fully-formed row it's given, matching every
 * other function in this file (compare `RecordOpenInput` above).
 */
export interface InsertTokenInput {
  readonly token: string;
  readonly accountId: string;
  readonly messageId: string;
  readonly recipientEmail: string;
  readonly subject: string;
}

/** token, account_id, message_id, recipient_email, subject — see the INSERT below. */
const TOKEN_INSERT_COLUMNS = 5;

/**
 * One INSERT for all N rows, built with neon's "ordinary function" call
 * form — `sql_()(text, params)` — rather than the tagged-template form
 * every other function in this file uses. The tagged-template form fixes
 * its number of interpolation slots at the call site, which can't flex to
 * however many rows a given batch has; `(text, params)` is neon's own
 * documented alternative for exactly this (see `NeonQueryFunction` in
 * `@neondatabase/serverless`), and it carries the same safety property.
 * `text` is assembled here from nothing but loop-counter arithmetic, so it
 * can only ever contain digits and punctuation — never a caller-supplied
 * value. Every value from `rows` lands solely in the `params` array, bound
 * server-side the same way a literal `$1` substitution is elsewhere in
 * this file — no string-built SQL, no recipient data ever touches `text`.
 *
 * `sent_at` is deliberately absent from the column list, matching
 * `scripts/send-test.mjs`'s own `insert into tokens (...)` — the only
 * other token-insert in this codebase — which also omits it and relies on
 * schema.sql's `default now()` (a `timestamptz`) to populate it. Not
 * passing it here keeps that one established convention in one place
 * rather than reintroducing it as an epoch-ms value that would need its
 * own conversion.
 *
 * A no-op on an empty array short-circuits before building any SQL: a
 * zero-row `values` clause is not valid syntax, and an empty batch is a
 * legitimate (if degenerate) input from `api/tokens.ts` — an empty
 * `sends` array in the request body — not an error condition.
 */
export async function insertTokens(rows: readonly InsertTokenInput[]): Promise<void> {
  if (rows.length === 0) return;

  const placeholderGroups: string[] = [];
  const params: string[] = [];
  rows.forEach((row, i) => {
    const base = i * TOKEN_INSERT_COLUMNS;
    placeholderGroups.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`,
    );
    params.push(row.token, row.accountId, row.messageId, row.recipientEmail, row.subject);
  });

  const text =
    'insert into tokens (token, account_id, message_id, recipient_email, subject) ' +
    `values ${placeholderGroups.join(',')}`;

  await sql_()(text, params);
}

export interface OpenRow {
  readonly token: string;
  readonly accountId: string;
  readonly messageId: string;
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
 *
 * `account_id`/`message_id` are projected alongside the existing columns
 * (Plan: link an open back to its message) so a caller can resolve which
 * message a given open belongs to. Both are NOT NULL on `tokens` — see
 * `InsertTokenInput` above — so no null-handling is needed for them here,
 * unlike `subject`/`device_class`/`os`.
 */
export async function listRecentOpens(limit: number): Promise<OpenRow[]> {
  const rows = await sql_()`
    select o.token, t.account_id, t.message_id, t.recipient_email, t.subject, t.sent_at,
           o.occurred_at, o.classification, o.device_class, o.os
    from opens o
    join tokens t on t.token = o.token
    order by o.occurred_at desc
    limit ${limit}::int
  `;
  return rows.map((row) => ({
    token: row.token,
    accountId: row.account_id,
    messageId: row.message_id,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    sentAt: new Date(row.sent_at).getTime(),
    occurredAt: new Date(row.occurred_at).getTime(),
    classification: row.classification,
    deviceClass: row.device_class,
    os: row.os,
  }));
}
