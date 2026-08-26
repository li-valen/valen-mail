import { describe, it, expect, afterEach } from 'vitest';
import { ConnectionPool } from '../src/imap/pool';
import { ImapConnection } from '../src/imap/connection';
import { UidValidityLog } from '../src/imap/uid-validity.ts';
import {
  ACCOUNT_A,
  createFakeClient,
  createFakeDb,
  createPoolHarness,
  wait,
} from './helpers/pool-fakes.ts';

/**
 * The last-observed UIDVALIDITY per (account, folder), and the pool
 * wiring that fills it.
 *
 * Nothing inside the sync loop reads this — it exists so
 * src/api/message-cache.ts can tell a renumbered mailbox from a quiet one
 * without SELECTing the mailbox on the connection the sync loop is
 * sharing. That makes the WIRING the thing worth testing: the log itself
 * is four lines, but a pool that never calls `record` would leave the
 * cache permanently unable to notice a renumbering, and every unit test
 * of the log would still pass.
 */

const ACCOUNT = ACCOUNT_A.id;

describe('UidValidityLog', () => {
  it('remembers the last observation per (account, folder)', () => {
    const log = new UidValidityLog();
    log.record('a', 'INBOX', 4n);
    log.record('a', '[Gmail]/Sent Mail', 9n);
    log.record('b', 'INBOX', 11n);

    expect(log.get('a', 'INBOX')).toBe(4n);
    expect(log.get('a', '[Gmail]/Sent Mail')).toBe(9n);
    expect(log.get('b', 'INBOX')).toBe(11n);
  });

  it('answers null for a mailbox it has never observed', () => {
    const log = new UidValidityLog();
    expect(log.get('a', 'INBOX')).toBeNull();
  });

  it('ignores a null observation rather than forgetting what it knew', () => {
    // A cycle whose fetch was skipped by the byte budget observes
    // nothing, and "not fetched in the last three minutes" is not a
    // renumbering. Overwriting here would turn a throttled account into a
    // permanently-uncacheable one.
    const log = new UidValidityLog();
    log.record('a', 'INBOX', 4n);
    log.record('a', 'INBOX', null);
    expect(log.get('a', 'INBOX')).toBe(4n);
  });

  it('overwrites with a genuinely new observation', () => {
    const log = new UidValidityLog();
    log.record('a', 'INBOX', 4n);
    log.record('a', 'INBOX', 9n);
    expect(log.get('a', 'INBOX')).toBe(9n);
  });

  it('cannot collide two (account, folder) pairs by concatenation', () => {
    // The NUL separator's whole job: `a` + `bc` and `ab` + `c` must stay
    // two keys. A plain `:` or `/` join would make these one entry, and
    // an IMAP folder path legitimately contains both characters.
    const log = new UidValidityLog();
    log.record('a', 'bc', 1n);
    log.record('ab', 'c', 2n);
    expect(log.get('a', 'bc')).toBe(1n);
    expect(log.get('ab', 'c')).toBe(2n);
  });
});

describe('ConnectionPool.getUidValidity', () => {
  const harness = createPoolHarness();

  afterEach(async () => {
    await harness.stop();
  });

  it('reports what a completed sync cycle actually observed', async () => {
    const fake = createFakeClient({
      messages: [{ uid: 1, envelope: { messageId: '<m1@x>', subject: 's' } }],
      uidValidity: 4n,
    });
    const pool = new ConnectionPool(
      [ACCOUNT_A],
      createFakeDb(),
      () => new ImapConnection(ACCOUNT_A, () => fake.client),
    );

    // Before any cycle: never observed, which the cache reads as "cannot
    // tell" and serves through rather than flushing on.
    expect(pool.getUidValidity(ACCOUNT, 'INBOX')).toBeNull();

    harness.launch(pool);
    await wait(80);

    expect(pool.getUidValidity(ACCOUNT, 'INBOX')).toBe(4n);
    // A folder this pool never synced stays unknown rather than
    // inheriting INBOX's numbering.
    expect(pool.getUidValidity(ACCOUNT, '[Gmail]/Trash')).toBeNull();
    // As does another account entirely.
    expect(pool.getUidValidity('nobody', 'INBOX')).toBeNull();
  });
});
