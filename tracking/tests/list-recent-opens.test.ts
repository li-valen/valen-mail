import { describe, it, expect, vi, afterAll } from 'vitest';
import { createFakeTaggedSql } from './helpers/fake-neon';

/**
 * Same lazy-client reasoning as tests/insert-tokens.test.ts: src/db.ts's
 * Postgres client is built once and cached at module scope, so every test
 * here resets modules and re-imports both `@neondatabase/serverless` (to
 * install this test's own fake) and `src/db` fresh, rather than sharing
 * one import across tests.
 *
 * `listRecentOpens` uses the tagged-template call form (every other
 * function in src/db.ts except `insertTokens` does), so this file uses
 * `createFakeTaggedSql` rather than `insert-tokens.test.ts`'s
 * `createFakeSql` — see that helper's doc comment for why the two forms
 * need separate fakes.
 */
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const INERT_DATABASE_URL = 'postgresql://user:pass@127.0.0.1/db';

vi.mock('@neondatabase/serverless', () => ({ neon: vi.fn() }));

/**
 * Resets modules, installs a fresh fake sql function seeded with `rows`
 * as neon()'s return value, then imports src/db fresh so its lazily
 * constructed client binds to *this* test's fake. Same
 * resetModules-then-configure-then-import ordering as
 * insert-tokens.test.ts's freshDbWithFakeSql — see that comment for why
 * the order matters.
 */
async function freshDbWithSeededRows(rows: readonly unknown[]) {
  vi.resetModules();
  process.env.DATABASE_URL = INERT_DATABASE_URL;
  const { neon } = await import('@neondatabase/serverless');
  const { fakeSql, calls } = createFakeTaggedSql(rows);
  vi.mocked(neon).mockReturnValue(fakeSql as never);
  const db = await import('../src/db');
  return { listRecentOpens: db.listRecentOpens, calls };
}

afterAll(() => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  vi.resetModules();
});

/**
 * One `tokens`/`opens` join row exactly as Postgres would return it —
 * snake_case columns, `sent_at`/`occurred_at` as strings (neon returns
 * timestamptz columns as ISO strings, which `listRecentOpens` feeds
 * through `new Date(...).getTime()`).
 */
function seededRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    token: 'a'.repeat(32),
    account_id: 'acct-42',
    message_id: '<real-rfc-message-id@sender.example>',
    recipient_email: 'recipient@example.com',
    subject: 'Q3 numbers',
    sent_at: '2026-08-20T10:00:00.000Z',
    occurred_at: '2026-08-20T10:05:00.000Z',
    classification: 'open',
    device_class: 'desktop',
    os: 'macOS',
    ...overrides,
  };
}

describe('listRecentOpens: account_id/message_id projection', () => {
  it('round-trips both the account id and the message id onto the mapped row', async () => {
    const row = seededRow({
      account_id: 'the-sending-account',
      message_id: '<abc123@postbox.local>',
    });
    const { listRecentOpens } = await freshDbWithSeededRows([row]);

    const [result] = await listRecentOpens(50);

    expect(result!.accountId).toBe('the-sending-account');
    expect(result!.messageId).toBe('<abc123@postbox.local>');
  });

  it('still maps every pre-existing field alongside the two new ones', async () => {
    const row = seededRow();
    const { listRecentOpens } = await freshDbWithSeededRows([row]);

    const [result] = await listRecentOpens(50);

    expect(result).toEqual({
      token: row.token,
      accountId: row.account_id,
      messageId: row.message_id,
      recipientEmail: row.recipient_email,
      subject: row.subject,
      sentAt: new Date(row.sent_at as string).getTime(),
      occurredAt: new Date(row.occurred_at as string).getTime(),
      classification: row.classification,
      deviceClass: row.device_class,
      os: row.os,
    });
  });

  it('issues a query whose SQL text selects account_id and message_id from tokens', async () => {
    const { listRecentOpens, calls } = await freshDbWithSeededRows([seededRow()]);

    await listRecentOpens(50);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/t\.account_id/);
    expect(calls[0]!.text).toMatch(/t\.message_id/);
  });
});
