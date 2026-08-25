import { describe, it, expect } from 'vitest';
import {
  formatClockTime,
  formatLag,
  formatRelativeTime,
  formatSelfCountLine,
  formatOpenRowLead,
  formatOpenRowSentence,
  selfCountLine,
  describeEvent,
  partitionOpens,
  deriveRailView,
  expandedDetailFor,
  resolveOpenTarget,
  bareMessageId,
  looksLikeSentFolder,
} from '../src/components/openEvents';
import type { InboxMessage, OpenEvent, OpensResponse } from '../src/api';

/**
 * Pure-logic coverage for OpensView.tsx's supporting module, none of
 * which renders a component (client/CLAUDE.md's standing constraint).
 * The two functions the task's own report explicitly asks to be checked
 * for vacuousness live here: `partitionOpens` (self suppressed AND
 * counted) and `deriveRailView` (unavailable told apart from empty).
 *
 * `formatOpenRowSentence` and `selfCountLine` (bottom of this file) are
 * task V1b additions — the Superhuman/Mailspring restyle's row sentence
 * and the self-count line's visibility gate, respectively. Everything
 * ABOVE this point (`describeEvent` included) is untouched by V1b: its
 * contract is frozen, and OpensFeed.tsx simply stopped reading some of the
 * fields it returns. See tests/opens-feed-presentation.test.ts for the
 * companion raw-source assertions that prove OpensFeed.tsx/ReadState.tsx
 * actually stopped rendering those fields, which no pure-function test
 * here can prove on its own.
 *
 * `expandedDetailFor` and `resolveOpenTarget` (bottom of this file) are
 * task V3 additions — Ask 1's hover/focus expansion content and Ask 2's
 * click-to-open resolution, respectively.
 */

function buildEvent(overrides: Partial<OpenEvent> & { readonly token: string }): OpenEvent {
  return {
    accountId: 'acct-1',
    messageId: '<msg-1@postbox.local>',
    recipientEmail: 'someone@example.com',
    subject: 'Test subject',
    sentAt: 1_700_000_000_000,
    occurredAt: 1_700_000_060_000,
    classification: 'open',
    deviceClass: 'unknown',
    os: null,
    ...overrides,
  };
}

/** Same fixture shape tests/inbox.test.ts's own `buildMessage` uses —
 *  every `InboxMessage` field, `message_id`/`account_id`/`folder`/`uid`
 *  overridden per test, everything else a harmless default. */
function buildMessage(overrides: Partial<InboxMessage> & { readonly uid: string }): InboxMessage {
  return {
    account_id: 'acct-1',
    message_id: null,
    thread_id: null,
    folder: 'sent',
    subject: 'Test subject',
    from_name: 'Test Sender',
    from_email: 'sender@example.com',
    to_emails: [],
    cc_emails: [],
    date: null,
    snippet: null,
    flags: [],
    labels: [],
    has_attach: false,
    size_bytes: null,
    attachments: [],
    ...overrides,
  };
}

describe('formatClockTime', () => {
  it('renders 24-hour, zero-padded, no seconds and no zone label', () => {
    // 2024-01-01T14:06:00Z
    expect(formatClockTime(Date.UTC(2024, 0, 1, 14, 6, 0))).toBe('14:06');
  });

  it('zero-pads a single-digit hour', () => {
    expect(formatClockTime(Date.UTC(2024, 0, 1, 9, 4, 0))).toBe('09:04');
  });
});

describe('formatLag', () => {
  it('renders whole seconds under a minute', () => {
    expect(formatLag(4_000)).toBe('4s after sending');
  });

  it('renders hours and minutes for a multi-hour gap', () => {
    // 2h 11m = (2*60+11)*60*1000 = 7,860,000ms
    expect(formatLag(7_860_000)).toBe('2h 11m after sending');
  });

  it('drops the minutes when they are exactly zero', () => {
    expect(formatLag(2 * 60 * 60 * 1000)).toBe('2h after sending');
  });

  it('renders bare minutes under an hour', () => {
    expect(formatLag(5 * 60 * 1000)).toBe('5m after sending');
  });

  it('never prints a negative duration for clock skew', () => {
    expect(formatLag(-500)).toBe('0s after sending');
  });
});

describe('formatRelativeTime', () => {
  const NOW = Date.UTC(2024, 0, 1, 12, 0, 0);

  it('says "just now" inside the first minute', () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe('just now');
  });

  it('renders minutes under an hour', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });

  it('renders hours under a day', () => {
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago');
  });

  it('renders days beyond that', () => {
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d ago');
  });
});

describe('formatSelfCountLine', () => {
  it('uses the singular for exactly one', () => {
    expect(formatSelfCountLine(1)).toBe('1 view from you');
  });

  it('uses the plural for more than one', () => {
    expect(formatSelfCountLine(3)).toBe('3 views from you');
  });
});

describe('describeEvent', () => {
  it('names the recipient address in the confirmed headline', () => {
    const event = buildEvent({ token: 'a', classification: 'open', recipientEmail: 'kate@example.com' });
    expect(describeEvent(event).headline).toBe('kate@example.com opened this.');
  });

  it('gives mpp the permanent-ceiling copy, not the generic unconfirmable sentence', () => {
    const event = buildEvent({ token: 'b', classification: 'mpp' });
    const copy = describeEvent(event);
    expect(copy.headline).toMatch(/apple mail/i);
    expect(copy.sub).toMatch(/ceiling/i);
  });

  it('gives prefetch and scanner the same generic sentence, distinct from mpp', () => {
    const prefetch = describeEvent(buildEvent({ token: 'c', classification: 'prefetch' }));
    const scanner = describeEvent(buildEvent({ token: 'd', classification: 'scanner' }));
    const mpp = describeEvent(buildEvent({ token: 'e', classification: 'mpp' }));
    expect(prefetch.headline).toBe(scanner.headline);
    expect(prefetch.headline).not.toBe(mpp.headline);
  });

  // fix round 1: an unrecognised classification's meta line embeds the
  // raw token (`readStateFor`'s default branch keeps it unbounded on
  // purpose) — but the RENDERED meta string must still be bounded, or a
  // pathological wire value distorts the row's layout the same way an
  // unbounded badge would.
  it('bounds a pathologically long unrecognised classification in the meta line', () => {
    const pathological = 'x'.repeat(500);
    const copy = describeEvent(buildEvent({ token: 'f', classification: pathological }));
    expect(copy.meta.length).toBeLessThan(pathological.length);
  });
});

describe('partitionOpens — self suppressed from the rail, but counted', () => {
  it('excludes self events from `displayable`', () => {
    const events = [
      buildEvent({ token: 'a', classification: 'self' }),
      buildEvent({ token: 'b', classification: 'open' }),
    ];
    const { displayable } = partitionOpens(events);
    expect(displayable.some((e) => e.classification === 'self')).toBe(false);
  });

  it('still counts every self event in `selfCount`', () => {
    const events = [
      buildEvent({ token: 'a', classification: 'self' }),
      buildEvent({ token: 'b', classification: 'self' }),
      buildEvent({ token: 'c', classification: 'open' }),
    ];
    const { displayable, selfCount } = partitionOpens(events);
    expect(selfCount).toBe(2);
    expect(displayable).toHaveLength(1);
  });

  it('reports zero — not the length of an empty array coincidentally matching — when there are no self events', () => {
    const events = [buildEvent({ token: 'a', classification: 'open' }), buildEvent({ token: 'b', classification: 'mpp' })];
    const { selfCount, displayable } = partitionOpens(events);
    expect(selfCount).toBe(0);
    expect(displayable).toHaveLength(2);
  });

  it('sorts displayable events newest-first by occurredAt', () => {
    const older = buildEvent({ token: 'a', classification: 'open', occurredAt: 1000 });
    const newer = buildEvent({ token: 'b', classification: 'open', occurredAt: 5000 });
    const { displayable } = partitionOpens([older, newer]);
    expect(displayable.map((e) => e.token)).toEqual(['b', 'a']);
  });

  it('never mutates the array it is given', () => {
    const events = [buildEvent({ token: 'a', occurredAt: 1 }), buildEvent({ token: 'b', occurredAt: 2 })];
    const copy = [...events];
    partitionOpens(events);
    expect(events).toEqual(copy);
  });
});

describe('deriveRailView — unavailable told apart from empty', () => {
  // The critical case: identical `opens: []` content, differing ONLY in
  // `available`, must land on different `kind`s. A version of this test
  // that only checked one branch (or that asserted on `opens.length`
  // instead of `kind`) would pass even if OpensView rendered the two
  // states identically — this asserts the actual discriminant the
  // component branches on.
  it('reports `unavailable` when available is false, even with an empty opens array', () => {
    const response: OpensResponse = { opens: [], available: false };
    expect(deriveRailView(response).kind).toBe('unavailable');
  });

  it('reports `ready` with zero displayable events when available is true and opens is empty — NOT `unavailable`', () => {
    const response: OpensResponse = { opens: [], available: true };
    const view = deriveRailView(response);
    expect(view.kind).toBe('ready');
    expect(view.kind === 'ready' && view.displayable).toEqual([]);
  });

  it('the same opens content flips `kind` on `available` alone', () => {
    const opens: readonly OpenEvent[] = [];
    const unavailable = deriveRailView({ opens, available: false });
    const empty = deriveRailView({ opens, available: true });
    expect(unavailable.kind).not.toBe(empty.kind);
  });

  it('reports unavailable even if `opens` were non-empty alongside available: false — availability wins, not array length', () => {
    const response: OpensResponse = { opens: [buildEvent({ token: 'a' })], available: false };
    expect(deriveRailView(response).kind).toBe('unavailable');
  });

  it('carries the self count and displayable list through when ready', () => {
    const response: OpensResponse = {
      opens: [buildEvent({ token: 'a', classification: 'self' }), buildEvent({ token: 'b', classification: 'open' })],
      available: true,
    };
    const view = deriveRailView(response);
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.selfCount).toBe(1);
      expect(view.displayable).toHaveLength(1);
    }
  });
});

// task V1b — the Superhuman/Mailspring restyle. `formatOpenRowSentence`
// builds the ENTIRE visible text of one row now: "{recipientEmail} opened
// "{subject}" · {relative time}". `ROW_NOW` is 5 minutes after every
// fixture event's default `occurredAt` (1_700_000_060_000), chosen so the
// expected strings below read as plain "5m ago" rather than a computed
// offset — matching this file's existing `formatRelativeTime` fixtures.
const ROW_NOW = 1_700_000_060_000 + 5 * 60_000;

describe('formatOpenRowSentence — subject is the "which email" the user asked for', () => {
  it('renders the subject, quoted, when present', () => {
    const event = buildEvent({ token: 'a', recipientEmail: 'kate@example.com', subject: 'Re: invoice' });
    expect(formatOpenRowSentence(event, ROW_NOW)).toBe('kate@example.com opened "Re: invoice" · 5m ago');
  });

  // The mutation the task brief asks to be run and reported: force the
  // `"..."` fragment to always render (as if `subjectFragment` were
  // unconditional) and confirm this specific assertion is what catches it.
  it('omits the subject fragment entirely when null — never the literal text "null", never empty quotes', () => {
    const event = buildEvent({ token: 'b', recipientEmail: 'kate@example.com', subject: null });
    const sentence = formatOpenRowSentence(event, ROW_NOW);
    expect(sentence).toBe('kate@example.com opened · 5m ago');
    expect(sentence).not.toContain('null');
    expect(sentence).not.toContain('""');
  });

  it('reflects a different subject rather than a hardcoded placeholder', () => {
    const a = formatOpenRowSentence(buildEvent({ token: 'c', subject: 'Q3 numbers' }), ROW_NOW);
    const b = formatOpenRowSentence(buildEvent({ token: 'd', subject: 'Dinner Friday?' }), ROW_NOW);
    expect(a).toContain('"Q3 numbers"');
    expect(b).toContain('"Dinner Friday?"');
    expect(a).not.toBe(b);
  });
});

describe('formatOpenRowSentence — mpp and open share the exact same sentence form', () => {
  it('an open row and an mpp row both contain "opened"', () => {
    const open = formatOpenRowSentence(buildEvent({ token: 'e', classification: 'open' }), ROW_NOW);
    const mpp = formatOpenRowSentence(buildEvent({ token: 'f', classification: 'mpp' }), ROW_NOW);
    expect(open).toContain('opened');
    expect(mpp).toContain('opened');
  });

  // Stronger than the substring check above: given the SAME recipient,
  // subject and timestamps, an open row and an mpp row are BYTE-IDENTICAL
  // — not just similarly shaped — because this function never reads
  // `event.classification` at all. This would fail immediately if a
  // future edit special-cased even a single character by classification.
  it('produces a byte-identical sentence for open vs. mpp given the same recipient/subject/time', () => {
    const shared = { recipientEmail: 'kate@example.com', subject: 'Re: invoice', occurredAt: 1_700_000_060_000 };
    const open = formatOpenRowSentence(buildEvent({ token: 'g', classification: 'open', ...shared }), ROW_NOW);
    const mpp = formatOpenRowSentence(buildEvent({ token: 'h', classification: 'mpp', ...shared }), ROW_NOW);
    expect(open).toBe(mpp);
  });

  it('never renders a classification token or the word "unconfirmable", for any classification', () => {
    for (const classification of ['open', 'mpp', 'prefetch', 'scanner', 'self', 'a-future-classifier-value']) {
      const sentence = formatOpenRowSentence(buildEvent({ token: `i-${classification}`, classification }), ROW_NOW);
      expect(sentence).not.toMatch(/MPP|PREFETCH|SCANNER|unconfirmable/i);
    }
  });
});

describe('selfCountLine — the self-count line renders for selfCount>0, nothing for 0', () => {
  it('is null at zero — not the string "0 views from you"', () => {
    expect(selfCountLine(0)).toBeNull();
  });

  it('renders formatSelfCountLine\'s singular/plural text for any positive count', () => {
    expect(selfCountLine(1)).toBe('1 view from you');
    expect(selfCountLine(2)).toBe('2 views from you');
    expect(selfCountLine(1)).toBe(formatSelfCountLine(1));
  });
});

// Task V3, Ask 1 — the fields OpensFeed.tsx's hover/keyboard-focus
// expansion renders once a row is no longer collapsed to one line.
describe('expandedDetailFor — what the hover/focus expansion shows', () => {
  it('carries the full recipient and subject through untouched', () => {
    const event = buildEvent({ token: 'a', recipientEmail: 'kate@example.com', subject: 'Re: invoice' });
    const detail = expandedDetailFor(event);
    expect(detail.recipientEmail).toBe('kate@example.com');
    expect(detail.subject).toBe('Re: invoice');
  });

  it('falls back to "(no subject)" — the same copy MessageRow.tsx uses for a missing inbox subject — never a blank or the literal "null"', () => {
    const event = buildEvent({ token: 'b', subject: null });
    const subject = expandedDetailFor(event).subject;
    expect(subject).toBe('(no subject)');
    expect(subject).not.toBe('');
    expect(subject).not.toContain('null');
  });

  it('renders the absolute time with formatClockTime — the SAME HH:MM this feed already uses elsewhere, not a second format', () => {
    const event = buildEvent({ token: 'c', occurredAt: Date.UTC(2024, 0, 1, 14, 6, 0) });
    const detail = expandedDetailFor(event);
    expect(detail.absoluteTime).toBe('14:06');
    expect(detail.absoluteTime).toBe(formatClockTime(event.occurredAt));
  });

  it('carries the SAME cause explanation readStateFor(...).title gives that classification, distinct per cause', () => {
    const open = expandedDetailFor(buildEvent({ token: 'd', classification: 'open' }));
    const mpp = expandedDetailFor(buildEvent({ token: 'e', classification: 'mpp' }));
    expect(open.cause.toLowerCase()).toContain('only signal postbox treats');
    expect(mpp.cause.toLowerCase()).toContain('apple mail privacy protection');
    expect(open.cause).not.toBe(mpp.cause);
  });

  // The non-vacuity the task brief specifically calls for: an event that
  // GENUINELY carries deviceClass/os must still never leak either value
  // through this function's result — proving the field is actually
  // absent from the output, not merely that the return TYPE happens not
  // to name it (which a bug that folded the value into another field,
  // e.g. `cause`, could still defeat).
  it('never leaks deviceClass or os, even when the input event genuinely carries them', () => {
    const event = buildEvent({ token: 'f', deviceClass: 'iPhone', os: 'iOS 17' });
    const detail = expandedDetailFor(event);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('iPhone');
    expect(serialized).not.toContain('iOS 17');
    expect(Object.keys(detail)).not.toContain('deviceClass');
    expect(Object.keys(detail)).not.toContain('os');
  });
});

// Verified against this app's own live data (see the task report): every
// real open event's `messageId` arrives WITHOUT the RFC 5322 angle
// brackets a synced message's own `message_id` carries. An exact-string
// match failed on every one of 11 real events before `bareMessageId`
// existed — this is the fix, not a hypothetical edge case.
describe('bareMessageId', () => {
  it('strips a leading and trailing angle bracket', () => {
    expect(bareMessageId('<test-1@postbox.local>')).toBe('test-1@postbox.local');
  });

  it('is a no-op on an already-bare id', () => {
    expect(bareMessageId('test-1@postbox.local')).toBe('test-1@postbox.local');
  });

  it('makes a bracketed and an unbracketed spelling of the same id compare equal', () => {
    expect(bareMessageId('<test-1@postbox.local>')).toBe(bareMessageId('test-1@postbox.local'));
  });
});

// Verified against this app's own live data: a real Gmail account's Sent
// folder row carries the raw path `[Gmail]/Sent Mail`, never the
// normalised `sent` id — a bare `folder === 'sent'` check silently never
// matched a single real Sent row.
describe('looksLikeSentFolder', () => {
  it('recognises a real Gmail Sent path', () => {
    expect(looksLikeSentFolder('[Gmail]/Sent Mail')).toBe(true);
  });

  it('recognises the bare normalised id too', () => {
    expect(looksLikeSentFolder('sent')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(looksLikeSentFolder('SENT')).toBe(true);
  });

  it('is false for Inbox, Starred and other real folder paths', () => {
    expect(looksLikeSentFolder('INBOX')).toBe(false);
    expect(looksLikeSentFolder('[Gmail]/Starred')).toBe(false);
    expect(looksLikeSentFolder('[Gmail]/Spam')).toBe(false);
  });
});

// Task V3, Ask 2 — bridging an open event's (accountId, messageId) to a
// message the reader can open, using only rows the client has already
// loaded (no lookup endpoint).
describe('resolveOpenTarget — bridging messageId to a loaded row', () => {
  // The exact shape observed live: the tracking service's messageId has
  // no brackets; the synced message's own message_id does. Without
  // bareMessageId normalising both, this — the ordinary, everyday case —
  // would itself report not-found.
  it('resolves when the event\'s messageId is bracket-free but the loaded row\'s message_id carries RFC 5322 brackets', () => {
    const event = buildEvent({
      token: 'z',
      accountId: 'primary',
      messageId: 'test-1787543058009@postbox.local',
    });
    const message = buildMessage({
      uid: '1',
      account_id: 'primary',
      message_id: '<test-1787543058009@postbox.local>',
      folder: '[Gmail]/Sent Mail',
    });
    expect(resolveOpenTarget(event, [message])).toEqual({ kind: 'found', message });
  });

  it('resolves to the one loaded message sharing the event\'s messageId', () => {
    const event = buildEvent({ token: 'a', accountId: 'acct-1', messageId: '<x@postbox.local>' });
    const message = buildMessage({ uid: '1', account_id: 'acct-1', message_id: '<x@postbox.local>' });
    expect(resolveOpenTarget(event, [message])).toEqual({ kind: 'found', message });
  });

  it('reports not-found when no loaded message shares the messageId', () => {
    const event = buildEvent({ token: 'b', messageId: '<missing@postbox.local>' });
    const message = buildMessage({ uid: '1', message_id: '<other@postbox.local>' });
    expect(resolveOpenTarget(event, [message])).toEqual({ kind: 'not-found' });
  });

  it('reports not-found against an empty loaded-messages list, never throwing', () => {
    const event = buildEvent({ token: 'c', messageId: '<x@postbox.local>' });
    expect(resolveOpenTarget(event, [])).toEqual({ kind: 'not-found' });
  });

  // MULTIPLE CANDIDATES: two loaded rows legitimately sharing one
  // messageId — the same physical send synced into two of the user's own
  // accounts, or Gmail's per-label UIDs. The rule, tested one step at a
  // time: (1) prefer the event's own account, (2) among same-account
  // candidates prefer the Sent folder, (3) still tied, take the first
  // candidate in `loadedMessages` order.
  it('MULTIPLE CANDIDATES, step 1: prefers the candidate from the event\'s own account', () => {
    const event = buildEvent({ token: 'd', accountId: 'acct-1', messageId: '<shared@postbox.local>' });
    const wrongAccount = buildMessage({
      uid: '1',
      account_id: 'acct-2',
      message_id: '<shared@postbox.local>',
      folder: 'inbox',
    });
    const rightAccount = buildMessage({
      uid: '2',
      account_id: 'acct-1',
      message_id: '<shared@postbox.local>',
      folder: 'inbox',
    });
    expect(resolveOpenTarget(event, [wrongAccount, rightAccount])).toEqual({
      kind: 'found',
      message: rightAccount,
    });
  });

  it('MULTIPLE CANDIDATES, step 2: same account on both — prefers the Sent-folder copy over Inbox', () => {
    const event = buildEvent({ token: 'e', accountId: 'acct-1', messageId: '<shared@postbox.local>' });
    const inboxCopy = buildMessage({
      uid: '1',
      account_id: 'acct-1',
      message_id: '<shared@postbox.local>',
      folder: 'inbox',
    });
    const sentCopy = buildMessage({
      uid: '2',
      account_id: 'acct-1',
      message_id: '<shared@postbox.local>',
      folder: 'sent',
    });
    expect(resolveOpenTarget(event, [inboxCopy, sentCopy])).toEqual({ kind: 'found', message: sentCopy });
  });

  it('MULTIPLE CANDIDATES, step 3: still tied — takes the first candidate in loadedMessages order, deterministically', () => {
    const event = buildEvent({ token: 'f', accountId: 'acct-1', messageId: '<shared@postbox.local>' });
    const first = buildMessage({
      uid: '1',
      account_id: 'acct-1',
      message_id: '<shared@postbox.local>',
      folder: 'inbox',
    });
    const second = buildMessage({
      uid: '2',
      account_id: 'acct-1',
      message_id: '<shared@postbox.local>',
      folder: 'starred',
    });
    expect(resolveOpenTarget(event, [first, second])).toEqual({ kind: 'found', message: first });
    // Same two candidates, reversed order — the rule follows
    // `loadedMessages`'s own order rather than a hidden stable sort;
    // this is what "deterministic given the input" means here, not
    // "constant regardless of it".
    expect(resolveOpenTarget(event, [second, first])).toEqual({ kind: 'found', message: second });
  });

  it('a stale accountId does not make an otherwise-unambiguous message unreachable — falls back to every candidate, not to not-found', () => {
    const event = buildEvent({ token: 'g', accountId: 'acct-nonexistent', messageId: '<shared@postbox.local>' });
    const inboxCopy = buildMessage({
      uid: '1',
      account_id: 'acct-1',
      message_id: '<shared@postbox.local>',
      folder: 'inbox',
    });
    const sentCopy = buildMessage({
      uid: '2',
      account_id: 'acct-1',
      message_id: '<shared@postbox.local>',
      folder: 'sent',
    });
    expect(resolveOpenTarget(event, [inboxCopy, sentCopy])).toEqual({ kind: 'found', message: sentCopy });
  });

  it('never mutates loadedMessages', () => {
    const event = buildEvent({ token: 'h', messageId: '<x@postbox.local>' });
    const messages = [buildMessage({ uid: '1', message_id: '<x@postbox.local>' })];
    const copy = [...messages];
    resolveOpenTarget(event, messages);
    expect(messages).toEqual(copy);
  });
});

/**
 * The rail row is drawn in two pieces so its time can be pinned to a
 * right-hand column instead of truncated away (OpensFeed.tsx). These hold
 * the split honest: the lead is the sentence minus the time, and the
 * sentence is still built from the lead rather than beside it.
 */
describe('formatOpenRowLead — the who-and-what half, without the time', () => {
  it('is the sentence with the time removed', () => {
    const event = buildEvent({ token: 'lead-a', subject: 'Re: invoice' });
    expect(formatOpenRowLead(event)).toBe('someone@example.com opened "Re: invoice"');
    expect(formatOpenRowSentence(event, ROW_NOW)).toBe(`${formatOpenRowLead(event)} · 5m ago`);
  });

  it('drops the subject fragment entirely when there is no subject', () => {
    expect(formatOpenRowLead(buildEvent({ token: 'lead-b', subject: null }))).toBe(
      'someone@example.com opened',
    );
  });

  it('carries an attacker-authored subject through as plain text, never markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    expect(formatOpenRowLead(buildEvent({ token: 'lead-c', subject: hostile }))).toContain(hostile);
  });
});
