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
    try { loadConfig(bad, ENV); } catch (error) {
      expect(String(error)).not.toContain('SECRETVALUE123');
    }
  });
});
