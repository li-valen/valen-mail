import { describe, it, expect, afterAll } from 'vitest';
import { ImapConnection } from '../src/imap/connection';

const EMAIL = process.env.TEST_IMAP_EMAIL;
const PASSWORD = process.env.TEST_IMAP_PASSWORD;
const maybe = EMAIL && PASSWORD ? describe : describe.skip;

maybe('ImapConnection (live Gmail)', () => {
  const connection = new ImapConnection({
    id: 'test', email: EMAIL!, appPassword: PASSWORD!, isPrimary: true,
  });
  afterAll(async () => { await connection.disconnect(); });

  it('connects and authenticates', async () => {
    await connection.connect();
    expect(connection.isConnected).toBe(true);
  }, 30_000);

  it('lists mailboxes including INBOX', async () => {
    const boxes = await connection.listMailboxes();
    expect(boxes.some((b) => b.toUpperCase() === 'INBOX')).toBe(true);
  }, 30_000);

  it('opens INBOX and reports uidValidity and uidNext', async () => {
    const info = await connection.openMailbox('INBOX');
    expect(info.path.toUpperCase()).toBe('INBOX');
    expect(info.uidValidity).toBeGreaterThan(0n);
    expect(info.uidNext).toBeGreaterThan(0n);
  }, 30_000);

  it('rejects a bad password without leaking it in the error', async () => {
    const bad = new ImapConnection({
      id: 'bad', email: EMAIL!, appPassword: 'wrongwrongwrong1', isPrimary: false,
    });
    await expect(bad.connect()).rejects.toThrow();
    try { await bad.connect(); } catch (error) {
      expect(String(error)).not.toContain('wrongwrongwrong1');
    }
  }, 30_000);
});
