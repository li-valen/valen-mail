import { describe, it, expect, vi } from 'vitest';
import { loadConfig, MAX_ACCOUNTS } from '../src/config';

const ENV = { DATABASE_URL: 'postgresql://localhost/x', PORT: '8080' } as NodeJS.ProcessEnv;

const ONE = [{ id: 'primary', email: 'a@gmail.com', appPassword: 'abcdefghijklmnop', isPrimary: true }];

describe('loadConfig', () => {
  it('accepts a well-formed single account', () => {
    const config = loadConfig(ONE, ENV);
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0]?.email).toBe('a@gmail.com');
    expect(config.port).toBe(8080);
  });

  it('strips spaces from an app password pasted from Google', () => {
    const spaced = [{ ...ONE[0], appPassword: 'abcd efgh ijkl mnop' }];
    expect(loadConfig(spaced, ENV).accounts[0]?.appPassword).toBe('abcdefghijklmnop');
  });

  it('names the offending account when an app password is the wrong length', () => {
    const bad = [{ ...ONE[0], id: 'work', appPassword: 'tooshort' }];
    expect(() => loadConfig(bad, ENV)).toThrow(/work/);
  });

  it('rejects duplicate account ids', () => {
    const dupe = [ONE[0], { ...ONE[0], email: 'b@gmail.com' }];
    expect(() => loadConfig(dupe, ENV)).toThrow(/duplicate/i);
  });

  it('rejects more than MAX_ACCOUNTS accounts', () => {
    const many = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => ({
      ...ONE[0], id: `a${i}`, email: `a${i}@gmail.com`,
    }));
    expect(() => loadConfig(many, ENV)).toThrow(new RegExp(String(MAX_ACCOUNTS)));
  });

  it('rejects a config that is not an array', () => {
    expect(() => loadConfig({ accounts: [] }, ENV)).toThrow(/array/i);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig(ONE, { PORT: '8080' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('never includes an app password in an error message', () => {
    const bad = [{ ...ONE[0], appPassword: 'SECRETVALUE123' }];
    let thrown = false;
    try {
      loadConfig(bad, ENV);
    } catch (error) {
      thrown = true;
      expect(String(error)).not.toContain('SECRETVALUE123');
    }
    expect(thrown).toBe(true);
  });

  it('trims whitespace from email and stores trimmed value', () => {
    const spaced = [{ ...ONE[0], email: '  b@gmail.com  ' }];
    const config = loadConfig(spaced, ENV);
    expect(config.accounts[0]?.email).toBe('b@gmail.com');
  });

  it('rejects empty email after trimming', () => {
    const whitespace = [{ ...ONE[0], id: 'bad', email: '   ' }];
    expect(() => loadConfig(whitespace, ENV)).toThrow(/bad/);
  });

  it('rejects non-boolean isPrimary', () => {
    const stringPrimary = [{ ...ONE[0], id: 'work', isPrimary: 'true' }];
    expect(() => loadConfig(stringPrimary, ENV)).toThrow(/work/);
  });

  // Spec 7B.1: "Exactly one account MUST be primary, and the config loader
  // MUST enforce it before Plan 4 consumes the field." This block replaces
  // an earlier test that asserted the opposite — that a config with no
  // primary at all was accepted and defaulted to false. That test encoded
  // the spec violation rather than the spec, so it is rewritten, not
  // weakened: the default-to-false behaviour it was really guarding is
  // still asserted below, in a config that does have a primary.
  it('rejects a config where no account is primary (spec 7B.1)', () => {
    const noPrimary = [{ id: 'primary', email: 'a@gmail.com', appPassword: 'abcdefghijklmnop' }];
    expect(() => loadConfig(noPrimary, ENV)).toThrow(/exactly one account must set isPrimary/i);
    expect(() => loadConfig(noPrimary, ENV)).toThrow(/found 0/);
  });

  it('rejects a config where more than one account is primary (spec 7B.1)', () => {
    const twoPrimaries = [
      { id: 'primary', email: 'a@gmail.com', appPassword: 'abcdefghijklmnop', isPrimary: true },
      { id: 'work', email: 'b@gmail.com', appPassword: 'qrstuvwxyzabcdef', isPrimary: true },
    ];
    expect(() => loadConfig(twoPrimaries, ENV)).toThrow(/exactly one account must set isPrimary/i);
    expect(() => loadConfig(twoPrimaries, ENV)).toThrow(/found 2/);
  });

  it('still defaults an absent isPrimary to false when a different account is primary', () => {
    const mixed = [
      { id: 'primary', email: 'a@gmail.com', appPassword: 'abcdefghijklmnop', isPrimary: true },
      { id: 'work', email: 'b@gmail.com', appPassword: 'qrstuvwxyzabcdef' },
    ];
    const config = loadConfig(mixed, ENV);
    expect(config.accounts[0]?.isPrimary).toBe(true);
    expect(config.accounts[1]?.isPrimary).toBe(false);
  });

  it('accepts the shipped accounts.example.json shape (exactly one primary)', () => {
    const example = [
      { id: 'primary', email: 'you@gmail.com', appPassword: 'abcdefghijklmnop', isPrimary: true },
      { id: 'work', email: 'you.work@gmail.com', appPassword: 'qrstuvwxyzabcdef', isPrimary: false },
    ];
    expect(loadConfig(example, ENV).accounts).toHaveLength(2);
  });

  it('rejects duplicate emails case-insensitively', () => {
    const dupe = [
      { id: 'primary', email: 'user@gmail.com', appPassword: 'abcdefghijklmnop', isPrimary: true },
      { id: 'work', email: 'USER@GMAIL.COM', appPassword: 'qrstuvwxyzabcdef', isPrimary: false },
    ];
    expect(() => loadConfig(dupe, ENV)).toThrow(/duplicate email/i);
  });

  it('defaults PORT to 8080 when absent', () => {
    const config = loadConfig(ONE, { DATABASE_URL: 'postgresql://localhost/x' } as NodeJS.ProcessEnv);
    expect(config.port).toBe(8080);
  });

  it('defaults PORT to 8080 when empty string', () => {
    const config = loadConfig(ONE, { DATABASE_URL: 'postgresql://localhost/x', PORT: '' } as NodeJS.ProcessEnv);
    expect(config.port).toBe(8080);
  });

  it('parses valid PORT numbers', () => {
    const config = loadConfig(ONE, { DATABASE_URL: 'postgresql://localhost/x', PORT: '3000' } as NodeJS.ProcessEnv);
    expect(config.port).toBe(3000);
  });

  it('rejects PORT outside valid range', () => {
    expect(() => loadConfig(ONE, { DATABASE_URL: 'postgresql://localhost/x', PORT: '0' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
    expect(() => loadConfig(ONE, { DATABASE_URL: 'postgresql://localhost/x', PORT: '70000' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it('rejects non-numeric PORT', () => {
    expect(() => loadConfig(ONE, { DATABASE_URL: 'postgresql://localhost/x', PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it('ensures MAX_ACCOUNTS is 10 per spec', () => {
    // Spec: "up to 10 Gmail accounts"
    expect(MAX_ACCOUNTS).toBe(10);
  });
});

/**
 * Task 2, Amendment: TRACKING_BASE_URL/TRACKING_READ_TOKEN are the one
 * deliberate exception to this file's fail-closed rule. A missing or
 * malformed value must not throw — email sync must still start — but it
 * must warn loudly exactly once at startup and leave trackingConfig null,
 * which is what routes.ts's handleOpens uses to skip the network call
 * entirely and answer `available: false`.
 */
describe('loadConfig trackingConfig', () => {
  const withTracking = (overrides: Record<string, string>): NodeJS.ProcessEnv =>
    ({ ...ENV, ...overrides } as NodeJS.ProcessEnv);

  it('is null and warns once when both TRACKING_* vars are absent', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(ONE, ENV);
    expect(config.trackingConfig).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('is null and warns when only TRACKING_BASE_URL is set', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(ONE, withTracking({ TRACKING_BASE_URL: 'https://t.example' }));
    expect(config.trackingConfig).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is null and warns when only TRACKING_READ_TOKEN is set', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(ONE, withTracking({ TRACKING_READ_TOKEN: 'r'.repeat(32) }));
    expect(config.trackingConfig).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is null and warns when TRACKING_BASE_URL is not a valid URL', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(
      ONE,
      withTracking({ TRACKING_BASE_URL: 'not a url', TRACKING_READ_TOKEN: 'r'.repeat(32) }),
    );
    expect(config.trackingConfig).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns a populated TrackingConfig and does not warn when both are set and valid', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig(
      ONE,
      withTracking({ TRACKING_BASE_URL: 'https://t.example', TRACKING_READ_TOKEN: 'r'.repeat(32) }),
    );
    expect(config.trackingConfig).toEqual({ baseUrl: 'https://t.example', readToken: 'r'.repeat(32) });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('never includes the tracking token in a warning message', () => {
    const secretToken = 'super-secret-tracking-token-value';
    const warnings: unknown[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    loadConfig(ONE, withTracking({ TRACKING_BASE_URL: 'not a url', TRACKING_READ_TOKEN: secretToken }));
    expect(JSON.stringify(warnings)).not.toContain(secretToken);
    vi.restoreAllMocks();
  });
});
