import { describe, it, expect, afterEach } from 'vitest';
import { startServer } from '../src/api/server';

/**
 * Covers Amendment 4 only: API_TOKEN must fail startup closed. Both cases
 * below throw on the very first line of startServer() — before it ever
 * reads ACCOUNTS_FILE, calls loadConfig(), opens a database connection, or
 * starts the connection pool — so this file never touches Postgres or
 * IMAP. It deliberately does NOT test the success path (valid token),
 * which would require a real DATABASE_URL and would start real IMAP
 * connections via ConnectionPool.start(); that path is out of scope for
 * this task's "zero live Gmail connections" rule.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('startServer / API_TOKEN fail-closed', () => {
  it('throws when API_TOKEN is unset rather than starting with no auth', async () => {
    delete process.env.API_TOKEN;
    await expect(startServer()).rejects.toThrow(/API_TOKEN/);
  });

  it('throws when API_TOKEN is shorter than 32 characters', async () => {
    process.env.API_TOKEN = 'short-token';
    await expect(startServer()).rejects.toThrow(/API_TOKEN/);
  });
});
