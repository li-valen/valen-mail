import { describe, it, expect, vi } from 'vitest';
import { createTransports } from '../src/send/transports.ts';
import type { CreateTransportFn } from '../src/send/transports';
import type { AccountConfig } from '../src/config';

/**
 * Plan 4 Task 2 — per-account SMTP transports.
 *
 * NEVER a live SMTP connection here (see ../src/send/transports.ts's own
 * doc comment): Gmail throttles repeated connections, and this repo has
 * already paid for that lesson once (tracking/scripts/send-test.mjs).
 * Every test below injects a fake `createTransport`; none call the real
 * nodemailer default.
 */

const ACCOUNT_A: AccountConfig = {
  id: 'a',
  email: 'a@example.com',
  appPassword: 'x'.repeat(16),
  isPrimary: true,
};
const ACCOUNT_B: AccountConfig = {
  id: 'b',
  email: 'b@example.com',
  appPassword: 'y'.repeat(16),
  isPrimary: false,
};

interface RecordedOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth: { readonly user: string; readonly pass: string };
}

/** A fake `createTransport` that records every call it was given and every
 *  `close()` call on the transports it handed back, in creation order —
 *  enough to prove caching, per-account isolation, and closeAll's scope
 *  without ever touching a socket. */
function makeFakeCreateTransport(): {
  createTransport: CreateTransportFn;
  calls: RecordedOptions[];
  closeCalls: string[];
} {
  const calls: RecordedOptions[] = [];
  const closeCalls: string[] = [];
  let created = 0;

  const createTransport = vi.fn((options: RecordedOptions) => {
    calls.push(options);
    created += 1;
    const id = `transport-${created}`;
    return { close: () => closeCalls.push(id) };
  }) as unknown as CreateTransportFn;

  return { createTransport, calls, closeCalls };
}

describe('createTransports', () => {
  it('builds smtp.gmail.com:465 secure, authenticated with the account email + app password', () => {
    const { createTransport, calls } = makeFakeCreateTransport();
    const transports = createTransports([ACCOUNT_A], createTransport);

    transports.get('a');

    expect(calls).toEqual([
      {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: 'a@example.com', pass: ACCOUNT_A.appPassword },
      },
    ]);
  });

  it('returns the SAME transport instance on a second get() for the same account', () => {
    const { createTransport } = makeFakeCreateTransport();
    const transports = createTransports([ACCOUNT_A], createTransport);

    const first = transports.get('a');
    const second = transports.get('a');

    // The load-bearing assertion: identity, not just structural equality —
    // a fresh object shaped the same would pass toEqual but still mean a
    // second live SMTP connection was opened per send.
    expect(second).toBe(first);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it('creates independent, separately-cached transports per account', () => {
    const { createTransport } = makeFakeCreateTransport();
    const transports = createTransports([ACCOUNT_A, ACCOUNT_B], createTransport);

    const a1 = transports.get('a');
    const b1 = transports.get('b');
    const a2 = transports.get('a');

    expect(a1).not.toBe(b1);
    expect(a2).toBe(a1);
    expect(createTransport).toHaveBeenCalledTimes(2);
  });

  it('returns undefined, and creates nothing, for an account id that is not configured', () => {
    const { createTransport } = makeFakeCreateTransport();
    const transports = createTransports([ACCOUNT_A], createTransport);

    expect(transports.get('does-not-exist')).toBeUndefined();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('closeAll() closes exactly the transports that were actually created — not every configured account', () => {
    const { createTransport, closeCalls } = makeFakeCreateTransport();
    const transports = createTransports([ACCOUNT_A, ACCOUNT_B], createTransport);

    transports.get('a'); // 'b' is configured but never sent through

    transports.closeAll();

    expect(closeCalls).toEqual(['transport-1']);
  });

  it('closeAll() closes every transport that was created', () => {
    const { createTransport, closeCalls } = makeFakeCreateTransport();
    const transports = createTransports([ACCOUNT_A, ACCOUNT_B], createTransport);

    transports.get('a');
    transports.get('b');
    transports.closeAll();

    expect(closeCalls).toEqual(['transport-1', 'transport-2']);
  });

  it('closeAll() is a harmless no-op when nothing was ever get()', () => {
    const { createTransport, closeCalls } = makeFakeCreateTransport();
    const transports = createTransports([ACCOUNT_A, ACCOUNT_B], createTransport);

    expect(() => transports.closeAll()).not.toThrow();
    expect(closeCalls).toEqual([]);
  });

  it('never lets the app password reach anything logged during get() or closeAll()', () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const { createTransport } = makeFakeCreateTransport();
    const transports = createTransports([ACCOUNT_A], createTransport);

    transports.get('a');
    transports.closeAll();

    expect(JSON.stringify(errors)).not.toContain(ACCOUNT_A.appPassword);
    spy.mockRestore();
  });

  it('does not mutate the accounts array it is given', () => {
    const accounts = [ACCOUNT_A, ACCOUNT_B];
    const snapshot = JSON.stringify(accounts);
    const { createTransport } = makeFakeCreateTransport();
    const transports = createTransports(accounts, createTransport);

    transports.get('a');
    transports.get('unknown');

    expect(JSON.stringify(accounts)).toBe(snapshot);
  });
});
