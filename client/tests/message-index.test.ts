import { describe, it, expect } from 'vitest';
import { foldMessageIndex } from '../src/messageIndex';
import type { InboxMessage } from '../src/api';

/**
 * Task V3, Ask 2. `resolveOpenTarget` (components/openEvents.ts) can only
 * resolve a Recent-opens click against messages this client has ALREADY
 * loaded — there is no lookup endpoint. `foldMessageIndex` is what keeps
 * that "already loaded" set from forgetting a row the moment its folder
 * falls out of view, the same problem accountRoster.ts's
 * `foldAccountRoster` solves for the sidebar's account switcher (see
 * tests/account-roster.test.ts, which this file's cases deliberately
 * mirror one-for-one where the problem is the same shape).
 */

function buildMessage(overrides: Partial<InboxMessage> & { readonly uid: string }): InboxMessage {
  return {
    account_id: 'acct-1',
    message_id: null,
    thread_id: null,
    folder: 'inbox',
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

describe('foldMessageIndex', () => {
  it('is just the observed messages when nothing is known yet', () => {
    const observed = buildMessage({ uid: '1' });
    expect(foldMessageIndex([], [observed])).toEqual([observed]);
  });

  it('keeps a known message that a later, narrower observation does not repeat', () => {
    const sent = buildMessage({ uid: '1', folder: 'sent' });
    const known = [sent];
    // A later fetch for a DIFFERENT folder — sent's own row is not part
    // of this observation, but must not be forgotten because of that.
    const observed = [buildMessage({ uid: '2', folder: 'inbox' })];
    const folded = foldMessageIndex(known, observed);
    expect(folded).toContainEqual(sent);
    expect(folded).toHaveLength(2);
  });

  it('replaces a known row\'s content with the CURRENT observation for the same identity, never a stale copy', () => {
    const stale = buildMessage({ uid: '1', subject: 'Old subject' });
    const fresh = buildMessage({ uid: '1', subject: 'New subject' });
    const folded = foldMessageIndex([stale], [fresh]);
    expect(folded).toEqual([fresh]);
  });

  it('adds a message first seen in a later folder/account', () => {
    const known = [buildMessage({ uid: '1' })];
    const observed = [buildMessage({ uid: '2', account_id: 'acct-2' })];
    const folded = foldMessageIndex(known, observed);
    expect(folded.map((message) => `${message.account_id}:${message.uid}`).sort()).toEqual([
      'acct-1:1',
      'acct-2:2',
    ]);
  });

  it('keeps the registry when a later observation is completely empty (an unsynced folder)', () => {
    const known = [buildMessage({ uid: '1' }), buildMessage({ uid: '2' })];
    expect(foldMessageIndex(known, [])).toEqual(known);
  });

  // The one behaviour that genuinely differs from foldAccountRoster's
  // simpler id-keyed fold: identity here is `account_id:uid` (messageKey),
  // NOT `message_id` — two rows can legitimately share one RFC Message-ID
  // (the same send synced into two of the user's own accounts, or one
  // account's Inbox AND Starred copies of the same message under Gmail's
  // per-label UIDs), and `resolveOpenTarget` needs every such candidate
  // present to disambiguate correctly.
  it('keeps DISTINCT rows that share the same message_id — identity is account_id:uid, not message_id', () => {
    const inboxCopy = buildMessage({ uid: '1', account_id: 'acct-1', message_id: '<shared@postbox.local>' });
    const sentCopy = buildMessage({ uid: '2', account_id: 'acct-1', message_id: '<shared@postbox.local>' });
    const folded = foldMessageIndex([], [inboxCopy, sentCopy]);
    expect(folded).toHaveLength(2);
    expect(folded).toContainEqual(inboxCopy);
    expect(folded).toContainEqual(sentCopy);
  });

  it('does not mutate either input', () => {
    const known = [buildMessage({ uid: '1' })];
    const observed = [buildMessage({ uid: '2' })];
    const knownCopy = [...known];
    const observedCopy = [...observed];
    foldMessageIndex(known, observed);
    expect(known).toEqual(knownCopy);
    expect(observed).toEqual(observedCopy);
  });

  it('is idempotent — folding the same observation twice changes nothing', () => {
    const once = foldMessageIndex([], [buildMessage({ uid: '1' })]);
    const twice = foldMessageIndex(once, [buildMessage({ uid: '1' })]);
    expect(twice).toEqual(once);
  });
});
