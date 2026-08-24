import { neon } from '@neondatabase/serverless';
import type { Classification } from './classify';
import type { DeviceInfo } from './ua';

const sql = neon(process.env.DATABASE_URL ?? '');

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
  const rows = await sql`
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
  const rows = await sql`
    select occurred_at from opens
    where token = ${token} and occurred_at > ${cutoff}
    order by occurred_at desc limit 50
  `;
  return rows.map((row) => new Date(row.occurred_at).getTime());
}

/**
 * Enforces MAX_OPENS_PER_TOKEN inside a single statement via a correlated
 * subquery in the WHERE clause, rather than a separate count-then-insert —
 * that would cost an extra round trip and race under concurrent hits. The
 * explicit ::type casts are required because a SELECT with no FROM gives
 * Postgres nothing to infer parameter types from.
 */
export async function recordOpen(input: RecordOpenInput): Promise<void> {
  const userAgent = input.userAgent.slice(0, MAX_USER_AGENT_CHARS);
  await sql`
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
