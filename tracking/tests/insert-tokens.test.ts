import { describe, it, expect, vi, afterAll } from 'vitest';
import { createFakeSql } from './helpers/fake-neon';
import type { InsertTokenInput } from '../src/db';

/**
 * Same lazy-client reasoning as tests/db.test.ts: src/db.ts's Postgres
 * client is built once and cached at module scope, so every test here
 * resets modules and re-imports both `@neondatabase/serverless` (to
 * install this test's own fake) and `src/db` fresh, rather than sharing
 * one import across tests.
 *
 * `neon` is mocked at the module boundary — the only place a call to
 * `insertTokens` can be observed without a live database, since `sql_()`
 * always goes through neon's exported factory.
 */
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const INERT_DATABASE_URL = 'postgresql://user:pass@127.0.0.1/db';

vi.mock('@neondatabase/serverless', () => ({ neon: vi.fn() }));

/**
 * Resets modules, installs a fresh fake sql function as neon()'s return
 * value, then imports src/db fresh so its lazily-constructed client binds
 * to *this* test's fake. The neon mock must be configured after
 * resetModules (which re-evaluates the mocked module too) and before
 * importing src/db (which resolves its own import of
 * @neondatabase/serverless to whatever is configured at that point).
 */
async function freshDbWithFakeSql() {
  vi.resetModules();
  process.env.DATABASE_URL = INERT_DATABASE_URL;
  const { neon } = await import('@neondatabase/serverless');
  const { fakeSql, calls } = createFakeSql();
  vi.mocked(neon).mockReturnValue(fakeSql as never);
  const db = await import('../src/db');
  return { insertTokens: db.insertTokens, calls };
}

afterAll(() => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  vi.resetModules();
});

function row(recipientEmail: string, i: number): InsertTokenInput {
  return {
    token: String(i).padStart(32, '0'),
    accountId: 'acct',
    messageId: `m${i}@postbox.local`,
    recipientEmail,
    subject: 'hi',
  };
}

describe('insertTokens', () => {
  it('issues exactly one statement regardless of row count', async () => {
    const { insertTokens, calls } = await freshDbWithFakeSql();
    await insertTokens([row('a@x.com', 0), row('b@x.com', 1), row('c@x.com', 2)]);
    expect(calls).toHaveLength(1);
  });

  it('does not touch the database for an empty batch', async () => {
    const { insertTokens, calls } = await freshDbWithFakeSql();
    await insertTokens([]);
    expect(calls).toHaveLength(0);
  });

  it('binds recipientEmail as a parameter, never inlined into the SQL text', async () => {
    const { insertTokens, calls } = await freshDbWithFakeSql();
    const recipientEmail = "inject@evil.example'); drop table tokens; --";
    await insertTokens([row(recipientEmail, 0)]);

    expect(calls[0]!.text).not.toContain(recipientEmail);
    expect(calls[0]!.text).toMatch(/\$1/);
    expect(calls[0]!.params).toContain(recipientEmail);
  });

  it('binds every row of a multi-row batch as parameters, one placeholder group per row', async () => {
    const { insertTokens, calls } = await freshDbWithFakeSql();
    await insertTokens([row('a@x.com', 0), row('b@x.com', 1)]);

    const placeholderCount = (calls[0]!.text.match(/\$\d+/g) ?? []).length;
    expect(placeholderCount).toBe(10); // 2 rows * 5 columns
    expect(calls[0]!.params).toEqual([
      '00000000000000000000000000000000', 'acct', 'm0@postbox.local', 'a@x.com', 'hi',
      '00000000000000000000000000000001', 'acct', 'm1@postbox.local', 'b@x.com', 'hi',
    ]);
  });

  it('targets the tokens table with an insert', async () => {
    const { insertTokens, calls } = await freshDbWithFakeSql();
    await insertTokens([row('a@x.com', 0)]);
    expect(calls[0]!.text).toMatch(/insert into tokens/);
  });
});
