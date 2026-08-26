import { describe, it, expect } from 'vitest';
import type { InboxMessage } from '../src/api';
import {
  allMessagesOf,
  conversationCountAnnouncement,
  conversationCountLabel,
  conversationHasAttachment,
  conversationKeyFor,
  conversationMessageKeys,
  groupIntoConversations,
  isConversationSelectable,
  isConversationStarred,
  isConversationUnread,
  newestFirst,
  membersByMessageKey,
  participantsLabel,
  participantsOf,
  representativesOf,
} from '../src/conversations';

/**
 * Every decision the collapsed list makes, asserted without rendering
 * anything — client/CLAUDE.md's standing constraint, and the reason
 * src/conversations.ts is a module rather than logic inside a row.
 *
 * The fixtures are shaped after this user's real mail, because the cases
 * that matter are not hypothetical: a 40-message thread whose two newest
 * messages are unread and whose other thirty-eight are read; threads with
 * five different senders; and four Gmail accounts that each allocate
 * their own X-GM-THRID and therefore collide.
 */

let nextUid = 1;

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  const uid = String(overrides.uid ?? nextUid++);
  return {
    account_id: 'primary',
    uid,
    message_id: `<m${uid}@x>`,
    thread_id: 't1',
    folder: 'INBOX',
    subject: 'Subject',
    from_name: 'Ann Lei',
    from_email: 'ann@example.com',
    to_emails: [],
    cc_emails: [],
    date: '2026-08-01T00:00:00.000Z',
    snippet: null,
    flags: [],
    labels: [],
    has_attach: false,
    size_bytes: '1',
    attachments: [],
    ...overrides,
  };
}

/** One conversation, built the way the component builds it. */
function conversationOf(...messages: readonly InboxMessage[]) {
  const groups = groupIntoConversations(messages);
  expect(groups).toHaveLength(1);
  return groups[0]!;
}

describe('conversationKeyFor', () => {
  it('keys on the account AND the thread, so two accounts never merge', () => {
    // THE COLLISION. Gmail allocates X-GM-THRID per mailbox, so this is
    // an ordinary Tuesday across four accounts, not a contrived case.
    const harvard = message({ account_id: 'harvard', thread_id: '18447', uid: '5' });
    const personal = message({ account_id: 'personal', thread_id: '18447', uid: '9' });
    expect(conversationKeyFor(harvard)).not.toBe(conversationKeyFor(personal));
  });

  it('gives the same key to two messages of one thread in one account', () => {
    const a = message({ account_id: 'harvard', thread_id: '18447', uid: '5' });
    const b = message({ account_id: 'harvard', thread_id: '18447', uid: '6' });
    expect(conversationKeyFor(a)).toBe(conversationKeyFor(b));
  });

  it('makes every message with no thread id its own conversation', () => {
    const a = message({ thread_id: null, uid: '5' });
    const b = message({ thread_id: null, uid: '6' });
    expect(conversationKeyFor(a)).not.toBe(conversationKeyFor(b));
  });

  it('treats an empty-string thread id as no thread id', () => {
    const a = message({ thread_id: '', uid: '5' });
    const b = message({ thread_id: '', uid: '6' });
    expect(conversationKeyFor(a)).not.toBe(conversationKeyFor(b));
  });

  it('cannot confuse a real thread id with a synthesised one', () => {
    // Without the `t`/`u` prefixes, thread "7" and unthreaded uid 7 in the
    // same account would be one conversation.
    const threaded = message({ thread_id: '7', uid: '99' });
    const unthreaded = message({ thread_id: null, uid: '7' });
    expect(conversationKeyFor(threaded)).not.toBe(conversationKeyFor(unthreaded));
  });

  it('cannot be spoofed by an account id containing the separator’s neighbours', () => {
    const a = message({ account_id: 'a:t1', thread_id: '2', uid: '1' });
    const b = message({ account_id: 'a', thread_id: '1:t2', uid: '1' });
    expect(conversationKeyFor(a)).not.toBe(conversationKeyFor(b));
  });
});

describe('newestFirst — which message the row stands for', () => {
  it('puts the newest message first however the input was ordered', () => {
    const oldest = message({ uid: '1', date: '2026-08-01T00:00:00.000Z' });
    const middle = message({ uid: '2', date: '2026-08-05T00:00:00.000Z' });
    const newest = message({ uid: '3', date: '2026-08-09T00:00:00.000Z' });
    // Deliberately shuffled: the answer must come from the DATES, not
    // from position zero of whatever arrived.
    expect(newestFirst([middle, oldest, newest]).map((m) => m.uid)).toEqual(['3', '2', '1']);
  });

  it('breaks a shared timestamp on uid, numerically and not as text', () => {
    // Gmail timestamps are second-resolution and bulk deliveries share
    // one. Compared as text, "9" sorts above "10" and the row would show
    // the wrong message of the pair.
    const nine = message({ uid: '9', date: '2026-08-01T00:00:00.000Z' });
    const ten = message({ uid: '10', date: '2026-08-01T00:00:00.000Z' });
    expect(newestFirst([nine, ten]).map((m) => m.uid)).toEqual(['10', '9']);
  });

  it('sorts a message with no date LAST, matching the server', () => {
    // Postgres coalesces a null date to '-infinity' precisely so these do
    // not pin themselves above all real mail. A client that sorted them
    // first would show a dateless message as the row for a live thread.
    const dated = message({ uid: '1', date: '2020-01-01T00:00:00.000Z' });
    const dateless = message({ uid: '2', date: null });
    expect(newestFirst([dateless, dated]).map((m) => m.uid)).toEqual(['1', '2']);
  });

  it('sorts an UNPARSEABLE date last too, rather than throwing or floating', () => {
    const dated = message({ uid: '1', date: '2020-01-01T00:00:00.000Z' });
    const broken = message({ uid: '2', date: 'not a date at all' });
    expect(newestFirst([broken, dated]).map((m) => m.uid)).toEqual(['1', '2']);
  });

  it('never mutates its input', () => {
    const a = message({ uid: '1', date: '2026-08-01T00:00:00.000Z' });
    const b = message({ uid: '2', date: '2026-08-09T00:00:00.000Z' });
    const input = [a, b];
    newestFirst(input);
    expect(input.map((m) => m.uid)).toEqual(['1', '2']);
  });

  it('is total on the empty list', () => {
    expect(newestFirst([])).toEqual([]);
  });
});

describe('groupIntoConversations', () => {
  it('collapses one thread into one conversation and counts its messages', () => {
    const conversation = conversationOf(
      message({ uid: '3', date: '2026-08-09T00:00:00.000Z' }),
      message({ uid: '2', date: '2026-08-05T00:00:00.000Z' }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z' }),
    );
    expect(conversation.count).toBe(3);
    expect(conversation.messages.map((m) => m.uid)).toEqual(['3', '2', '1']);
  });

  it('picks the NEWEST message as the representative, not the oldest', () => {
    // The row's timestamp, subject and preview all come from this
    // message. Picking the oldest would give a row whose time disagrees
    // with its own position in a list sorted by time.
    const conversation = conversationOf(
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', subject: 'first ask' }),
      message({ uid: '9', date: '2026-08-20T00:00:00.000Z', subject: 'Re: first ask' }),
    );
    expect(conversation.representative.uid).toBe('9');
    expect(conversation.representative.subject).toBe('Re: first ask');
  });

  it('picks the newest even when the input arrives oldest-first', () => {
    // The one arrangement in which "take element zero" and "take the
    // newest" disagree — which is what makes this a rule rather than a
    // coincidence of how the server happens to order its answer.
    const conversation = conversationOf(
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z' }),
      message({ uid: '2', date: '2026-08-05T00:00:00.000Z' }),
      message({ uid: '3', date: '2026-08-09T00:00:00.000Z' }),
    );
    expect(conversation.representative.uid).toBe('3');
  });

  it('keys the conversation on the representative’s messageKey', () => {
    const conversation = conversationOf(
      message({ account_id: 'harvard', uid: '9', date: '2026-08-20T00:00:00.000Z' }),
      message({ account_id: 'harvard', uid: '1', date: '2026-08-01T00:00:00.000Z' }),
    );
    expect(conversation.key).toBe('harvard:9');
  });

  it('keeps two accounts’ same-id threads apart', () => {
    const groups = groupIntoConversations([
      message({ account_id: 'harvard', thread_id: '18447', uid: '5' }),
      message({ account_id: 'personal', thread_id: '18447', uid: '9' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((c) => c.count)).toEqual([1, 1]);
  });

  it('preserves the order the list gave, which is conversation-by-recency', () => {
    // The server answers newest-first, so a conversation's FIRST
    // appearance is its newest message. Re-sorting here would be a second
    // copy of Postgres's comparator; preserving order is what makes that
    // unnecessary.
    const groups = groupIntoConversations([
      message({ thread_id: 'b', uid: '9', date: '2026-08-20T00:00:00.000Z' }),
      message({ thread_id: 'a', uid: '8', date: '2026-08-19T00:00:00.000Z' }),
      message({ thread_id: 'b', uid: '2', date: '2026-01-01T00:00:00.000Z' }),
      message({ thread_id: 'a', uid: '1', date: '2025-01-01T00:00:00.000Z' }),
    ]);
    expect(groups.map((c) => c.representative.uid)).toEqual(['9', '8']);
  });

  it('loses no messages: the counts always add back up to the input', () => {
    const input = [
      message({ thread_id: 'a', uid: '1' }),
      message({ thread_id: 'b', uid: '2' }),
      message({ thread_id: 'a', uid: '3' }),
      message({ thread_id: null, uid: '4' }),
      message({ account_id: 'harvard', thread_id: 'a', uid: '5' }),
    ];
    const groups = groupIntoConversations(input);
    expect(groups.reduce((total, c) => total + c.count, 0)).toBe(input.length);
  });

  it('is total on the empty list', () => {
    expect(groupIntoConversations([])).toEqual([]);
  });

  it('handles the real 40-message thread', () => {
    // Shaped after masterman/1844765969375414761: forty messages from one
    // sender spread over twenty-five days, the two newest unread.
    const messages = Array.from({ length: 40 }, (_, index) =>
      message({
        account_id: 'masterman',
        thread_id: '1844765969375414761',
        uid: String(11269 - index),
        subject: 'annoying shyt',
        from_name: 'Annabelle Lei (Google Docs)',
        from_email: 'comments-noreply@docs.google.com',
        date: new Date(Date.UTC(2025, 9, 26 - index * 0.6)).toISOString(),
        flags: index < 2 ? [] : ['\\Seen'],
      }),
    );
    const conversation = conversationOf(...messages);
    expect(conversation.count).toBe(40);
    expect(conversation.representative.uid).toBe('11269');
    expect(conversationCountLabel(conversation.count)).toBe('(40)');
    expect(participantsLabel(conversation)).toBe('Annabelle Lei (Google Docs)');
  });
});

describe('conversationMessageKeys', () => {
  it('names every member, in list order, using the same key everything else does', () => {
    const conversation = conversationOf(
      message({ account_id: 'harvard', uid: '9', date: '2026-08-20T00:00:00.000Z' }),
      message({ account_id: 'harvard', uid: '4', date: '2026-08-10T00:00:00.000Z' }),
      message({ account_id: 'harvard', uid: '1', date: '2026-08-01T00:00:00.000Z' }),
    );
    expect(conversationMessageKeys(conversation)).toEqual([
      'harvard:9',
      'harvard:4',
      'harvard:1',
    ]);
  });
});

describe('isConversationUnread', () => {
  const unreadOf = (m: InboxMessage) => !(m.flags ?? []).includes('\\Seen');

  it('is UNREAD when one message among many read ones is unread', () => {
    // The real case, and the whole failure collapsing a list can
    // introduce: new mail hidden behind a row that looks dealt with.
    const messages = Array.from({ length: 12 }, (_, index) =>
      message({ uid: String(index + 1), flags: index === 4 ? [] : ['\\Seen'] }),
    );
    expect(isConversationUnread(conversationOf(...messages), unreadOf)).toBe(true);
  });

  it('is unread when the unread one is the OLDEST message', () => {
    // The case a representative-only check gets wrong: the row's own
    // message is read, and the thing that needs attention is underneath.
    const conversation = conversationOf(
      message({ uid: '9', date: '2026-08-20T00:00:00.000Z', flags: ['\\Seen'] }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', flags: [] }),
    );
    expect(isConversationUnread(conversation, unreadOf)).toBe(true);
  });

  it('is READ only when every message is read', () => {
    const conversation = conversationOf(
      message({ uid: '9', date: '2026-08-20T00:00:00.000Z', flags: ['\\Seen'] }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', flags: ['\\Answered', '\\Seen'] }),
    );
    expect(isConversationUnread(conversation, unreadOf)).toBe(false);
  });

  it('reads the resolver rather than `flags`, so an optimistic mark-read shows', () => {
    // App.tsx marks a batch read before the mailbox agrees; the row must
    // stop being bold in the same frame. Passing a resolver that reports
    // everything read has to be enough.
    const conversation = conversationOf(
      message({ uid: '9', flags: [] }),
      message({ uid: '1', flags: [] }),
    );
    expect(isConversationUnread(conversation, () => false)).toBe(false);
  });
});

describe('isConversationStarred and conversationHasAttachment', () => {
  const starredOf = (m: InboxMessage) => (m.flags ?? []).includes('\\Flagged');

  it('shows a star when any message in the conversation is starred', () => {
    const conversation = conversationOf(
      message({ uid: '9', date: '2026-08-20T00:00:00.000Z', flags: ['\\Seen'] }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', flags: ['\\Flagged'] }),
    );
    expect(isConversationStarred(conversation, starredOf)).toBe(true);
  });

  it('shows no star when none is starred', () => {
    const conversation = conversationOf(message({ uid: '9', flags: ['\\Seen'] }));
    expect(isConversationStarred(conversation, starredOf)).toBe(false);
  });

  it('shows a paperclip when any message carries an attachment', () => {
    // Reading has_attach off the representative alone would hide the clip
    // the moment anyone replied without one.
    const conversation = conversationOf(
      message({ uid: '9', date: '2026-08-20T00:00:00.000Z', has_attach: false }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', has_attach: true }),
    );
    expect(conversationHasAttachment(conversation)).toBe(true);
  });

  it('shows no paperclip when none carries one', () => {
    expect(conversationHasAttachment(conversationOf(message({ has_attach: false })))).toBe(false);
  });
});

describe('isConversationSelectable', () => {
  const inInbox = (m: InboxMessage) => m.folder === 'INBOX';

  it('is selectable when every member can be acted on', () => {
    const conversation = conversationOf(
      message({ uid: '9', date: '2026-08-20T00:00:00.000Z' }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z' }),
    );
    expect(isConversationSelectable(conversation, inInbox)).toBe(true);
  });

  it('is NOT selectable when one member cannot be, even if the row’s own can', () => {
    // The Starred view merges folders, so one conversation there can hold
    // an INBOX message and a Sent one. Ticking on the strength of the
    // representative would arm an Archive that moves half of what the row
    // stands for and refuses the rest.
    const conversation = conversationOf(
      message({ uid: '9', date: '2026-08-20T00:00:00.000Z', folder: 'INBOX' }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', folder: '[Gmail]/Sent Mail' }),
    );
    expect(isConversationSelectable(conversation, inInbox)).toBe(false);
  });
});

describe('participantsOf and participantsLabel', () => {
  it('prints ONE sender’s full name, exactly as an ungrouped row does', () => {
    // 99% of rows in this inbox are conversations of one. Shortening
    // their sender would change every one of them, which this feature is
    // explicitly not allowed to do.
    const conversation = conversationOf(message({ from_name: 'Annabelle Lei (Google Docs)' }));
    expect(participantsLabel(conversation)).toBe('Annabelle Lei (Google Docs)');
  });

  it('falls back the same way a row does when there is no display name', () => {
    const conversation = conversationOf(message({ from_name: null, from_email: 'a@x.com' }));
    expect(participantsLabel(conversation)).toBe('a@x.com');
  });

  it('falls back again when there is neither a name nor an address', () => {
    const conversation = conversationOf(message({ from_name: null, from_email: null }));
    expect(participantsLabel(conversation)).toBe('Unknown sender');
  });

  it('orders participants OLDEST first — who started it, then who joined', () => {
    const conversation = conversationOf(
      message({
        uid: '9', date: '2026-08-20T00:00:00.000Z',
        from_name: 'Bob Stone', from_email: 'bob@x.com',
      }),
      message({
        uid: '1', date: '2026-08-01T00:00:00.000Z',
        from_name: 'Ann Lei', from_email: 'ann@x.com',
      }),
    );
    expect(participantsOf(conversation)).toEqual(['Ann Lei', 'Bob Stone']);
    expect(participantsLabel(conversation)).toBe('Ann, Bob');
  });

  it('counts one person once across the display names a long thread accrues', () => {
    // Three spellings of one person. They ARE three identities — the
    // dedupe that matters happens on the short names about to be printed,
    // where "Ann, …, Ann" would be the visible nonsense — so the label
    // falls back to the single-sender full name from the newest message.
    const conversation = conversationOf(
      message({ uid: '3', date: '2026-08-20T00:00:00.000Z', from_name: 'Ann Lei (Docs)', from_email: 'ann@x.com' }),
      message({ uid: '2', date: '2026-08-10T00:00:00.000Z', from_name: 'Ann Lei', from_email: 'ANN@x.com' }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', from_name: 'Ann', from_email: 'ann@X.com' }),
    );
    expect(participantsLabel(conversation)).toBe('Ann Lei (Docs)');
  });

  it('counts one person once when only the CASE of the name differs', () => {
    const conversation = conversationOf(
      message({ uid: '2', date: '2026-08-10T00:00:00.000Z', from_name: 'ANN LEI', from_email: 'a@x.com' }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', from_name: 'Ann Lei', from_email: 'b@x.com' }),
    );
    // The name kept is the NEWEST message's, so a sender who changed how
    // they capitalise it renders as whatever they call themselves now.
    expect(participantsOf(conversation)).toEqual(['ANN LEI']);
    expect(participantsLabel(conversation)).toBe('ANN LEI');
  });

  it('names each human in a thread that RELAYS them all through one address', () => {
    /*
     * THE CASE LIVE VERIFICATION CAUGHT, and it is not an edge case: of
     * the 578 multi-message conversations in this user's real inbox, 169
     * — 29% — have more distinct display names than addresses, because
     * GitHub, Google Docs and every mailing list send as one relay
     * address on behalf of many people. Keyed on the address, this
     * fifteen-message Google Docs thread between four people renders as
     * ONE participant, which is the whole point of the label deleted.
     *
     * Shaped after masterman/1843246705920591126, "Questbridge Stuff".
     */
    const relay = 'comments-noreply@docs.google.com';
    const conversation = conversationOf(
      message({ uid: '4', date: '2026-08-20T00:00:00.000Z', from_name: 'Vivina Dong (Google Docs)', from_email: relay }),
      message({ uid: '3', date: '2026-08-15T00:00:00.000Z', from_name: 'Mrdeadmemes (Google Docs)', from_email: relay }),
      message({ uid: '2', date: '2026-08-10T00:00:00.000Z', from_name: 'Jack Zhou (Google Docs)', from_email: relay }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', from_name: 'Helen Li (Google Docs)', from_email: relay }),
    );
    expect(participantsOf(conversation)).toHaveLength(4);
    expect(participantsLabel(conversation)).toBe('Helen, …, Vivina');
  });

  it('names the last JOINER, which need not be the newest message’s sender', () => {
    /*
     * Shaped after personal/1873522533146683018, the real 23-message
     * thread: Arav Kumar starts it, two bots join, and every one of the
     * nineteen newest messages is Arav's again. So the newest message is
     * from the FIRST participant, and the last name in the label is the
     * bot that joined last.
     *
     * That is the intended answer, not a slip: this column says who is in
     * the conversation, and the subject, preview and timestamp beside it
     * already say what the latest message is.
     */
    const relay = 'notifications@github.com';
    const conversation = conversationOf(
      message({ uid: '5', date: '2026-08-26T08:16:00.000Z', from_name: 'Arav Kumar', from_email: relay }),
      message({ uid: '4', date: '2026-08-14T18:03:00.000Z', from_name: 'chatgpt-codex-connector[bot]', from_email: relay }),
      message({ uid: '3', date: '2026-08-14T17:58:00.000Z', from_name: 'cursor[bot]', from_email: relay }),
      message({ uid: '2', date: '2026-08-14T17:57:00.000Z', from_name: 'Arav Kumar', from_email: relay }),
    );
    expect(participantsOf(conversation)).toEqual([
      'Arav Kumar',
      'cursor[bot]',
      'chatgpt-codex-connector[bot]',
    ]);
    expect(participantsLabel(conversation)).toBe('Arav, …, chatgpt-codex-connector[bot]');
    expect(conversation.representative.from_name).toBe('Arav Kumar');
  });

  it('names both humans in a two-person bot thread', () => {
    // personal/1872639775144644505: coderabbitai[bot] and Zijun Zhou,
    // both arriving as notifications@github.com.
    const relay = 'notifications@github.com';
    const conversation = conversationOf(
      message({ uid: '2', date: '2026-08-10T00:00:00.000Z', from_name: 'coderabbitai[bot]', from_email: relay }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', from_name: 'Zijun Zhou', from_email: relay }),
    );
    expect(participantsLabel(conversation)).toBe('Zijun, coderabbitai[bot]');
  });

  it('elides the MIDDLE at three or more, keeping the first and the last', () => {
    // First appearance, oldest to newest: who started the conversation
    // and who joined it most recently. A trailing "…" would print only
    // the beginning of a thread and never who is in it now.
    const conversation = conversationOf(
      message({ uid: '4', date: '2026-08-20T00:00:00.000Z', from_name: 'Zed Ryerson', from_email: 'zed@x.com' }),
      message({ uid: '3', date: '2026-08-15T00:00:00.000Z', from_name: 'Carl Gilken', from_email: 'carl@x.com' }),
      message({ uid: '2', date: '2026-08-10T00:00:00.000Z', from_name: 'Bob Stone', from_email: 'bob@x.com' }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', from_name: 'Ann Lei', from_email: 'ann@x.com' }),
    );
    expect(participantsLabel(conversation)).toBe('Ann, …, Zed');
  });

  it('shortens a bare address to its local part rather than printing the domain', () => {
    const conversation = conversationOf(
      message({ uid: '2', date: '2026-08-10T00:00:00.000Z', from_name: null, from_email: 'coderabbitai@bots.example.com' }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', from_name: null, from_email: 'zijun@x.com' }),
    );
    expect(participantsLabel(conversation)).toBe('zijun, coderabbitai');
  });

  it('leaves a single-word display name alone', () => {
    const conversation = conversationOf(
      message({ uid: '2', date: '2026-08-10T00:00:00.000Z', from_name: 'cursor[bot]', from_email: 'c@x.com' }),
      message({ uid: '1', date: '2026-08-01T00:00:00.000Z', from_name: 'Arav Kumar', from_email: 'arav@x.com' }),
    );
    expect(participantsLabel(conversation)).toBe('Arav, cursor[bot]');
  });
});

describe('conversationCountLabel', () => {
  it('says nothing at all for a conversation of one', () => {
    // Not '(1)', and not ''. Almost every row in this inbox is a single
    // message; a badge on each would be chrome restating "this is a
    // message" forty-nine times a page, and an empty string still renders
    // a node carrying its parent's gap.
    expect(conversationCountLabel(1)).toBeNull();
    expect(conversationCountAnnouncement(1)).toBeNull();
  });

  it('prints Gmail’s bare parenthesised count from two upwards', () => {
    expect(conversationCountLabel(2)).toBe('(2)');
    expect(conversationCountLabel(40)).toBe('(40)');
  });

  it('announces the number with a noun, because "Ann Lei 3" is not a name', () => {
    expect(conversationCountAnnouncement(40)).toBe('40 messages in this conversation. ');
  });
});

describe('representativesOf, allMessagesOf and membersByMessageKey', () => {
  const conversations = groupIntoConversations([
    message({ thread_id: 'b', uid: '9', date: '2026-08-20T00:00:00.000Z' }),
    message({ thread_id: 'a', uid: '8', date: '2026-08-19T00:00:00.000Z' }),
    message({ thread_id: 'b', uid: '2', date: '2026-01-01T00:00:00.000Z' }),
  ]);

  it('gives the cursor one row per conversation, not one per message', () => {
    // Otherwise `j` spends thirty-nine presses inside a forty-message
    // conversation that draws as a single row.
    expect(representativesOf(conversations).map((m) => m.uid)).toEqual(['9', '8']);
  });

  it('gives the selection every message, in list order', () => {
    expect(allMessagesOf(conversations).map((m) => m.uid)).toEqual(['9', '2', '8']);
  });

  it('resolves any MEMBER’s key back to the whole conversation', () => {
    const index = membersByMessageKey(conversations);
    // Including a member that has no row of its own — "select all" walks
    // the flattened list and asks about exactly those.
    expect(index.get('primary:2')?.map((m) => m.uid)).toEqual(['9', '2']);
    expect(index.get('primary:9')?.map((m) => m.uid)).toEqual(['9', '2']);
    expect(index.get('primary:8')?.map((m) => m.uid)).toEqual(['8']);
  });

  it('knows nothing about a message that was never in the list', () => {
    expect(membersByMessageKey(conversations).get('harvard:404')).toBeUndefined();
  });
});
