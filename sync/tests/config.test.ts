import { describe, it, expect } from 'vitest';
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

  it('allows isPrimary to be absent and defaults to false', () => {
    const noPrimary = [{ id: 'primary', email: 'a@gmail.com', appPassword: 'abcdefghijklmnop' }];
    const config = loadConfig(noPrimary, ENV);
    expect(config.accounts[0]?.isPrimary).toBe(false);
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
