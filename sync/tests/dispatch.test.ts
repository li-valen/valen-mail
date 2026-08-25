import { describe, it, expect, vi } from 'vitest';
import {
  buildOpenNotification,
  buildMailNotification,
  shouldNotifyOpen,
  notifyNewMail,
  notifyOpens,
} from '../src/push/dispatch';
import type { OpenEvent } from '../src/api/opens';
import type { MessageInput } from '../src/db';
import type { VapidConfig } from '../src/push/vapid';
import type { SendImpl } from '../src/push/send';
import { makeFakeDb } from './helpers/api-fakes.ts';

/**
 * Task 7 — dispatching both notification kinds.
 *
 * Amendment 1: the brief's own fixtures typed `occurredAt` as an ISO
 * string with an `as never` cast, which would have hidden the mismatch
 * from TypeScript entirely. The REAL wire type — `OpenEvent` in
 * ../src/api/opens.ts, confirmed against the deployed tracking service —
 * has `occurredAt`/`sentAt` as epoch milliseconds (numbers). These fixtures
 * use the real `OpenEvent` and `MessageInput` types directly, with no `as
 * never` anywhere, so a future field-shape drift fails typecheck here
 * instead of shipping silently.
 */

const VAPID: VapidConfig = {
  publicKey: 'pub',
  privateKey: 'priv',
  subject: 'https://postbox.example',
};

function makeOpenEvent(overrides: Partial<OpenEvent> = {}): OpenEvent {
  return {
    token: 'tok-1',
    // Link an open back to its message: OpenEvent now requires both as
    // non-empty strings (sync/src/api/opens.ts's isValidOpenEvent) — this
    // fixture is otherwise unrelated to that change, so it just needs
    // placeholder values that satisfy the type.
    accountId: 'acct-1',
    messageId: '<tok-1@postbox.local>',
    recipientEmail: 'yspiegler@g.harvard.edu',
    subject: 'Re: Grays M #2',
    sentAt: 1_756_000_000_000,
    occurredAt: 1_756_003_600_000,
    classification: 'open',
    deviceClass: null,
    os: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    accountId: 'a',
    uid: 42,
    folder: 'INBOX',
    messageId: '<m1@example.com>',
    threadId: 't1',
    subject: 'parse spoken numbers',
    fromName: 'Zijun Zhou',
    fromEmail: 'zijun@example.com',
    toEmails: [],
    ccEmails: [],
    date: new Date(),
    snippet: null,
    flags: [],
    labels: [],
    hasAttach: false,
    sizeBytes: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldNotifyOpen
// ---------------------------------------------------------------------------

describe('shouldNotifyOpen', () => {
  it('notifies only for a confirmed open', () => {
    expect(shouldNotifyOpen(makeOpenEvent({ classification: 'open' }))).toBe(true);
  });

  it('never notifies for mpp, prefetch, scanner or self', () => {
    for (const c of ['mpp', 'prefetch', 'scanner', 'self']) {
      expect(shouldNotifyOpen(makeOpenEvent({ classification: c }))).toBe(false);
    }
  });

  it('does not notify for an unrecognised classification', () => {
    expect(shouldNotifyOpen(makeOpenEvent({ classification: 'future-thing' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Notification shape
// ---------------------------------------------------------------------------

describe('notification shape', () => {
  it('an open notification names the person and the subject', () => {
    const n = buildOpenNotification(makeOpenEvent());
    expect(n.title).toContain('opened');
    expect(n.title).toContain('yspiegler@g.harvard.edu');
    expect(n.body).toContain('Grays M');
  });

  it('omits device entirely when attribution is unavailable (deviceClass: null)', () => {
    const n = buildOpenNotification(makeOpenEvent({ deviceClass: null }));
    expect((n.body ?? '').toLowerCase()).not.toContain('null');
    expect((n.body ?? '').toLowerCase()).not.toContain('unknown');
  });

  /**
   * Amendment 2. The brief's own "omits device" test fed `deviceClass:
   * null`, but the REAL wire value seen from the deployed tracking service
   * is the STRING 'unknown' — 10 of 10 recorded events, never null so far.
   * A naive `if (deviceClass) { append(deviceClass) }` implementation
   * treats 'unknown' as present (it's a non-empty string) and prints it as
   * if it were a fact rather than an absence — passing the brief's own
   * null-fixture test while failing on every real notification. This
   * fixture is what actually occurs in production, which is what makes
   * this test non-vacuous against that naive implementation.
   */
  it('omits device entirely when deviceClass is the string "unknown"', () => {
    const n = buildOpenNotification(makeOpenEvent({ deviceClass: 'unknown' }));
    expect((n.body ?? '').toLowerCase()).not.toContain('unknown');
  });

  it('omits device entirely when deviceClass is an empty string', () => {
    const n = buildOpenNotification(makeOpenEvent({ deviceClass: '' }));
    expect((n.body ?? '').toLowerCase()).not.toContain('unknown');
  });

  it('includes device context for a real device value', () => {
    const n = buildOpenNotification(makeOpenEvent({ deviceClass: 'iPhone' }));
    expect(n.body).toContain('iPhone');
  });

  it('a mail notification is visibly a different kind of event', () => {
    const m = buildMailNotification(makeMessage());
    expect(m.title).not.toContain('opened');
    expect(m.tag).not.toBe(buildOpenNotification(makeOpenEvent()).tag);
  });

  it('a mail notification names the sender and the subject', () => {
    const m = buildMailNotification(makeMessage());
    expect(m.title).toContain('Zijun Zhou');
    expect(m.title).toContain('parse spoken numbers');
  });

  it('mail and open notifications use different tag prefixes', () => {
    const m = buildMailNotification(makeMessage());
    const o = buildOpenNotification(makeOpenEvent());
    expect(m.tag?.split(':')[0]).not.toBe(o.tag?.split(':')[0]);
  });

  it('resolves to distinct same-origin paths', () => {
    const m = buildMailNotification(makeMessage());
    const o = buildOpenNotification(makeOpenEvent());
    expect(m.url?.startsWith('/')).toBe(true);
    expect(o.url?.startsWith('/')).toBe(true);
    expect(m.url).not.toBe(o.url);
  });

  it('falls back to the email address when no sender name is known', () => {
    const m = buildMailNotification(makeMessage({ fromName: null, fromEmail: 'a@b.com' }));
    expect(m.title).toContain('a@b.com');
  });
});

// ---------------------------------------------------------------------------
// notifyNewMail / notifyOpens — subscription fan-out, sanity window, pruning
// ---------------------------------------------------------------------------

function subscriptionRow(endpoint = 'https://push.example/a') {
  return { endpoint, p256dh: 'p', auth: 'a' };
}

function dbWithSubscriptions(rows: readonly Record<string, unknown>[], onDelete?: (endpoint: string) => void) {
  return makeFakeDb({
    query: async (text: string, values: readonly unknown[] = []) => {
      if (text.includes('select endpoint')) return rows;
      if (text.includes('delete from push_subscriptions')) {
        onDelete?.(values[0] as string);
        return [];
      }
      throw new Error(`unexpected query: ${text}`);
    },
  });
}

describe('notifyNewMail', () => {
  it('sends a push for a recent message to every stored subscription', async () => {
    const db = dbWithSubscriptions([subscriptionRow()]);
    const sent: unknown[] = [];
    const sendImpl: SendImpl = async (_sub, payload) => {
      sent.push(JSON.parse(payload));
      return { statusCode: 201 };
    };
    await notifyNewMail(db, VAPID, [makeMessage({ date: new Date() })], sendImpl);
    expect(sent).toHaveLength(1);
  });

  /**
   * Amendment 3's second guard: a message whose `date` is outside the
   * sanity window must not notify even when the pool decided it was
   * "new" (e.g. a late-arriving UID for an old message, or a flag change
   * surfacing an old row again). This is dispatch.ts's own responsibility,
   * independent of the pool's first-cycle guard.
   */
  it('does not notify for a message older than the sanity window', async () => {
    const db = dbWithSubscriptions([subscriptionRow()]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h old
    await notifyNewMail(db, VAPID, [makeMessage({ date: oldDate })], sendImpl as unknown as SendImpl);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('does not notify for a message with no date at all', async () => {
    const db = dbWithSubscriptions([subscriptionRow()]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyNewMail(db, VAPID, [makeMessage({ date: null })], sendImpl as unknown as SendImpl);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('prunes a subscription the push service says is gone', async () => {
    const deleted: string[] = [];
    const db = dbWithSubscriptions([subscriptionRow()], (endpoint) => deleted.push(endpoint));
    const sendImpl: SendImpl = async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    };
    await notifyNewMail(db, VAPID, [makeMessage({ date: new Date() })], sendImpl);
    expect(deleted).toEqual(['https://push.example/a']);
  });

  it('does not prune on a transient failure', async () => {
    const deleted: string[] = [];
    const db = dbWithSubscriptions([subscriptionRow()], (endpoint) => deleted.push(endpoint));
    const sendImpl: SendImpl = async () => {
      throw Object.assign(new Error('slow down'), { statusCode: 429 });
    };
    await notifyNewMail(db, VAPID, [makeMessage({ date: new Date() })], sendImpl);
    expect(deleted).toEqual([]);
  });

  it('does nothing when there are no subscriptions stored', async () => {
    const db = dbWithSubscriptions([]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyNewMail(db, VAPID, [makeMessage({ date: new Date() })], sendImpl as unknown as SendImpl);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('skips a malformed subscription row rather than crashing', async () => {
    const db = dbWithSubscriptions([{ endpoint: 'not-https', p256dh: 'p', auth: 'a' }]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyNewMail(db, VAPID, [makeMessage({ date: new Date() })], sendImpl as unknown as SendImpl);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('sends one push per message to every subscription (fan-out)', async () => {
    const db = dbWithSubscriptions([subscriptionRow('https://push.example/a'), subscriptionRow('https://push.example/b')]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyNewMail(
      db,
      VAPID,
      [makeMessage({ uid: 1, date: new Date() }), makeMessage({ uid: 2, date: new Date() })],
      sendImpl as unknown as SendImpl,
    );
    expect(sendImpl).toHaveBeenCalledTimes(4); // 2 messages x 2 subscriptions
  });

  // Fix round 1, Fix 8: dispatchToAll's per-subscription independence
  // (sendPush's own doc comment: "one dead device among several must not
  // abort the rest") was only ever proven with a SINGLE subscription.
  // This drives it with two, where the first one's own DELETE (the
  // prune write pruneSubscription attempts after a 410) itself fails —
  // proving the loop survives both the send failure AND a failing prune
  // write, not just "sendPush itself never throws".
  it('a pruning failure for one subscription mid-loop does not stop the send to the next subscription', async () => {
    const db = makeFakeDb({
      query: async (text: string) => {
        if (text.includes('select endpoint')) {
          return [subscriptionRow('https://push.example/dead'), subscriptionRow('https://push.example/alive')];
        }
        if (text.includes('delete from push_subscriptions')) {
          throw new Error('db unavailable');
        }
        throw new Error(`unexpected query: ${text}`);
      },
    });
    const sent: string[] = [];
    const sendImpl: SendImpl = async (subscription, _payload) => {
      if (subscription.endpoint === 'https://push.example/dead') {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      }
      sent.push(subscription.endpoint);
      return { statusCode: 201 };
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await notifyNewMail(db, VAPID, [makeMessage({ date: new Date() })], sendImpl);
    errorSpy.mockRestore();

    expect(sent).toEqual(['https://push.example/alive']);
  });

  it('never logs or otherwise carries a subscription endpoint, which is a credential', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const db = dbWithSubscriptions([subscriptionRow('https://push.example/SECRET-PATH')]);
    const sendImpl: SendImpl = async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    };
    await notifyNewMail(db, VAPID, [makeMessage({ date: new Date() })], sendImpl);
    spy.mockRestore();
    expect(JSON.stringify(errors)).not.toContain('SECRET-PATH');
  });
});

describe('notifyOpens', () => {
  it('sends a push only for confirmed opens, never mpp/prefetch/scanner/self', async () => {
    const db = dbWithSubscriptions([subscriptionRow()]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    const events = [
      makeOpenEvent({ classification: 'open', token: 'a' }),
      makeOpenEvent({ classification: 'mpp', token: 'b' }),
      makeOpenEvent({ classification: 'prefetch', token: 'c' }),
      makeOpenEvent({ classification: 'scanner', token: 'd' }),
      makeOpenEvent({ classification: 'self', token: 'e' }),
    ];
    await notifyOpens(db, VAPID, events, sendImpl as unknown as SendImpl);
    expect(sendImpl).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there are no confirmed opens at all', async () => {
    const db = dbWithSubscriptions([subscriptionRow()]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyOpens(db, VAPID, [makeOpenEvent({ classification: 'mpp' })], sendImpl as unknown as SendImpl);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('does nothing when there are no subscriptions stored', async () => {
    const db = dbWithSubscriptions([]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyOpens(db, VAPID, [makeOpenEvent()], sendImpl as unknown as SendImpl);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  // Fix round 1, Fix 8: the notifyNewMail describe block above has the
  // equivalent proof for its own caller — dispatchToAll is a helper
  // shared by both, and its "one dead subscription mid-loop does not
  // abort the rest" contract deserves proof from both callers, not an
  // assumption that proving it once transfers.
  it('a pruning failure for one subscription mid-loop does not stop the send to the next subscription', async () => {
    const db = makeFakeDb({
      query: async (text: string) => {
        if (text.includes('select endpoint')) {
          return [subscriptionRow('https://push.example/dead'), subscriptionRow('https://push.example/alive')];
        }
        if (text.includes('delete from push_subscriptions')) {
          throw new Error('db unavailable');
        }
        throw new Error(`unexpected query: ${text}`);
      },
    });
    const sent: string[] = [];
    const sendImpl: SendImpl = async (subscription, _payload) => {
      if (subscription.endpoint === 'https://push.example/dead') {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      }
      sent.push(subscription.endpoint);
      return { statusCode: 201 };
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await notifyOpens(db, VAPID, [makeOpenEvent()], sendImpl);
    errorSpy.mockRestore();

    expect(sent).toEqual(['https://push.example/alive']);
  });
});
