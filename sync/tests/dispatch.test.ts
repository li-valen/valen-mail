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

/**
 * The user's own configured accounts, exactly as
 * `createOpensPollFromConfig` (../src/api/server.ts) derives them from
 * accounts.json: two of them, because a one-element list would not
 * distinguish "checks the list" from "checks the primary account".
 *
 * Every pre-existing test in this file passes this list rather than `[]`,
 * deliberately: `[]` would make the own-address rule vacuous, and those
 * tests would keep passing against a build that had lost it. Their
 * fixture recipient (`makeOpenEvent`'s default,
 * 'yspiegler@g.harvard.edu') is not in this list, so they all exercise
 * the external-recipient path — the one that still notifies.
 */
const OWN_ADDRESSES: readonly string[] = ['valen@postbox.test', 'Valen.Alt@Postbox.Test'];

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
    // A REPORTED DEVICE, because that is now what makes an open notifiable.
    // A hit through a relay carries no platform and cannot be pinned on the
    // recipient — see shouldNotifyOpen. Cases that need the ambiguous shape
    // pass `deviceClass: null` explicitly.
    deviceClass: 'desktop',
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
    expect(shouldNotifyOpen(makeOpenEvent({ classification: 'open' }), OWN_ADDRESSES)).toBe(true);
  });

  it('never notifies for mpp, prefetch, scanner or self', () => {
    for (const c of ['mpp', 'prefetch', 'scanner', 'self']) {
      expect(shouldNotifyOpen(makeOpenEvent({ classification: c }), OWN_ADDRESSES)).toBe(false);
    }
  });

  it('does not notify for an unrecognised classification', () => {
    expect(shouldNotifyOpen(makeOpenEvent({ classification: 'future-thing' }), OWN_ADDRESSES)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldNotifyOpen — the user's own accounts
//
// The tracking service's `'self'` classification exists to stop the
// sender's own pixel fetch from being reported as the recipient reading
// the mail, and it is unreachable for server-sent mail: the mint path
// (tracking/src/db.ts's insertTokens) never writes `sender_ip`, so
// `senderIps` is always `[]` and classifyHit's first branch can never
// fire. An open of mail the user sent to THEMSELVES therefore arrives
// here as a plain `'open'` and, before this rule, pushed
// "{me} opened your mail" to my own phone.
//
// Every test below pairs a suppressed case with a case that still
// notifies. A suppression rule is only worth anything if it
// discriminates — one that suppressed everything would satisfy each
// "does not notify" assertion on its own.
// ---------------------------------------------------------------------------

describe('shouldNotifyOpen — the recipient is one of my own accounts', () => {
  it('does not notify when the recipient is exactly a configured account', () => {
    const event = makeOpenEvent({ recipientEmail: 'valen@postbox.test' });
    expect(shouldNotifyOpen(event, OWN_ADDRESSES)).toBe(false);
  });

  it('does not notify when the recipient differs only in case', () => {
    // Email local-parts are case-sensitive per RFC 5321, but no mail
    // provider in practice treats them so, and the address can arrive
    // from the tracking service in whatever case the sender typed it.
    const event = makeOpenEvent({ recipientEmail: 'VaLeN@PostBox.TEST' });
    expect(shouldNotifyOpen(event, OWN_ADDRESSES)).toBe(false);
  });

  it('does not notify when the recipient carries surrounding whitespace', () => {
    const event = makeOpenEvent({ recipientEmail: '  valen@postbox.test\n' });
    expect(shouldNotifyOpen(event, OWN_ADDRESSES)).toBe(false);
  });

  it('normalises the CONFIGURED side too, not just the incoming address', () => {
    // OWN_ADDRESSES' second entry is mixed-case on purpose. A rule that
    // lower-cased only `recipientEmail` and compared it against the raw
    // configured string would pass every test above and fail this one.
    const event = makeOpenEvent({ recipientEmail: 'valen.alt@postbox.test' });
    expect(shouldNotifyOpen(event, OWN_ADDRESSES)).toBe(false);
  });

  it('STILL notifies for an external recipient with the identical classification', () => {
    // The other half of the pair: same event shape, same `'open'`
    // classification, only the recipient differs. This is what proves the
    // check discriminates rather than suppressing every open.
    const external = makeOpenEvent({
      recipientEmail: 'yspiegler@g.harvard.edu',
      classification: 'open',
    });
    const own = makeOpenEvent({ recipientEmail: 'valen@postbox.test', classification: 'open' });
    expect(shouldNotifyOpen(external, OWN_ADDRESSES)).toBe(true);
    expect(shouldNotifyOpen(own, OWN_ADDRESSES)).toBe(false);
  });

  it('notifies for a recipient that differs from a configured account by ONE character', () => {
    // Non-vacuity. A rule implemented as a substring/prefix test, or one
    // that suppressed anything sharing our domain, would swallow this —
    // and swallowing it means a real open by a real stranger never
    // reaches the phone, which is the failure mode a suppression rule is
    // most likely to introduce and least likely to be noticed.
    expect(shouldNotifyOpen(makeOpenEvent({ recipientEmail: 'valen@postbox.tes' }), OWN_ADDRESSES))
      .toBe(true);
    expect(shouldNotifyOpen(makeOpenEvent({ recipientEmail: 'valenn@postbox.test' }), OWN_ADDRESSES))
      .toBe(true);
    expect(shouldNotifyOpen(makeOpenEvent({ recipientEmail: 'vale@postbox.test' }), OWN_ADDRESSES))
      .toBe(true);
  });

  it('notifies for every recipient when no accounts are configured at all', () => {
    // The degenerate list must not accidentally match: `[].some(...)` is
    // false, so nothing is ever suppressed. Stated as a test because the
    // opposite mistake (an empty list matching everything) is a plausible
    // way to write this and would silence the feature completely.
    expect(shouldNotifyOpen(makeOpenEvent({ recipientEmail: 'valen@postbox.test' }), [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Notification shape
// ---------------------------------------------------------------------------

describe('notification shape', () => {
  it('an open notification names the person and the subject', () => {
    const n = buildOpenNotification(makeOpenEvent());
    // "opened" is in the BODY now: the title is the sender, matching the
    // new-mail notification's shape, because iOS truncated the old
    // whole-sentence title to "tlstrauss@fas.harvard.edu opened...".
    expect(n.title).toBe('yspiegler@g.harvard.edu');
    expect(n.body).toContain('Opened');
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

  it('puts the sender in the title and the subject in the body, Gmail-style', () => {
    // The OS prefixes the app name itself on both platforms, so the title is
    // spent on WHO rather than on restating "Valen Mail". Asserting the split
    // (not just "both strings appear somewhere") is the point: a build that
    // concatenated them back into one line would still contain both.
    const m = buildMailNotification(makeMessage());
    expect(m.title).toBe('Zijun Zhou');
    expect(m.body).toContain('parse spoken numbers');
    expect(m.title).not.toContain('parse spoken numbers');
    expect(m.title).not.toMatch(/postbox/i);
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
    await notifyOpens(db, VAPID, events, OWN_ADDRESSES, sendImpl as unknown as SendImpl);
    expect(sendImpl).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there are no confirmed opens at all', async () => {
    const db = dbWithSubscriptions([subscriptionRow()]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyOpens(db, VAPID, [makeOpenEvent({ classification: 'mpp' })], OWN_ADDRESSES, sendImpl as unknown as SendImpl);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('does nothing when there are no subscriptions stored', async () => {
    const db = dbWithSubscriptions([]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyOpens(db, VAPID, [makeOpenEvent()], OWN_ADDRESSES, sendImpl as unknown as SendImpl);
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
    await notifyOpens(db, VAPID, [makeOpenEvent()], OWN_ADDRESSES, sendImpl);
    errorSpy.mockRestore();

    expect(sent).toEqual(['https://push.example/alive']);
  });

  /**
   * The two tests below are the same assertions as the `shouldNotifyOpen`
   * block's, driven through the function production actually calls. They
   * are not redundant with it: `notifyOpens` could pass the events to
   * `dispatchToAll` without consulting `shouldNotifyOpen` at all (it did
   * exactly that for the classification rule until it was wired), and no
   * predicate-level test would notice. These prove no BYTE reaches
   * `sendImpl`.
   */
  it('sends no push at all when the only open is of mail I sent to myself', async () => {
    const db = dbWithSubscriptions([subscriptionRow()]);
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    await notifyOpens(
      db,
      VAPID,
      [makeOpenEvent({ classification: 'open', recipientEmail: 'Valen@Postbox.Test' })],
      OWN_ADDRESSES,
      sendImpl as unknown as SendImpl,
    );
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('sends exactly one push when the same batch holds one self-open and one external open', async () => {
    // The discriminating pair inside a single call: the batch is
    // filtered, not dropped. A build that suppressed the whole batch on
    // seeing one own-address event would fail here while passing the test
    // above.
    const db = dbWithSubscriptions([subscriptionRow()]);
    const titles: string[] = [];
    const sendImpl: SendImpl = async (_subscription, payload) => {
      titles.push((JSON.parse(payload) as { title: string }).title);
      return { statusCode: 201 };
    };
    await notifyOpens(
      db,
      VAPID,
      [
        makeOpenEvent({ token: 'own', recipientEmail: 'valen@postbox.test' }),
        makeOpenEvent({ token: 'external', recipientEmail: 'yspiegler@g.harvard.edu' }),
      ],
      OWN_ADDRESSES,
      sendImpl,
    );
    expect(titles).toEqual(['yspiegler@g.harvard.edu']);
  });
});


describe('an open that cannot be pinned on the recipient must not buzz', () => {
  /**
   * The user, about two "tlstrauss@fas.harvard.edu opened..." notifications
   * six minutes apart: "the tlstrauss opened isnt actually tlstrauss opened it
   * was me opening it in gmail."
   *
   * The service sends one copy per recipient and Gmail files each in the
   * sender's Sent folder carrying that recipient's pixel, so opening your own
   * Sent copy fetches theirs through the same relay. Nothing in the hit tells
   * them apart — except that a relay reports no platform and a real client
   * does.
   */
  it('stays silent when the hit reported no device', () => {
    expect(shouldNotifyOpen(makeOpenEvent({ deviceClass: null }), [])).toBe(false);
    expect(shouldNotifyOpen(makeOpenEvent({ deviceClass: 'unknown' }), [])).toBe(false);
  });

  it('still notifies when a real client reported one', () => {
    expect(shouldNotifyOpen(makeOpenEvent({ deviceClass: 'desktop' }), [])).toBe(true);
  });

  it('collapses repeat fetches of one copy into one notification', () => {
    // Was tagged per-occurrence, so a proxy re-validating its cache stacked a
    // fresh notification each time. The live data showed one copy fetched at
    // 14, 18, 19 and 23 minutes after send.
    const first = buildOpenNotification(makeOpenEvent({ occurredAt: 1_000 }));
    const later = buildOpenNotification(makeOpenEvent({ occurredAt: 9_999 }));
    expect(first.tag).toBe(later.tag);
    expect(first.tag).not.toContain('1000');
  });
});
