import { describe, expect, it } from 'vitest';
import {
  canUndo,
  hideMessage,
  moveFailureFor,
  moveNoticeFor,
  revealMessage,
  undoFailureFor,
  undoLabelFor,
  UNDO_WINDOW_MS,
  visibleMessages,
  type MoveDestination,
  type MoveResult,
} from '../src/mailboxActions';
import type { InboxMessage } from '../src/api';

/**
 * Archive, trash and spam — the optimistic layer and its rollback.
 *
 * THE ONE PROPERTY EVERY CASE HERE PROTECTS: a message that disappears
 * from the list and is still sitting in the user's inbox is a lie the
 * user cannot detect. The removal is a render-time overlay precisely so
 * that undoing it is a one-line set operation rather than a
 * reconstruction, and these tests pin both directions of that.
 *
 * client/CLAUDE.md's standing constraint is that no test in this project
 * renders a component, which is why the decisions live in a pure module
 * at all. The WIRING — that a component actually calls any of this — is
 * covered by tests/mailbox-wiring-static-guards.test.ts, because an
 * App.tsx that imported `hideMessage` and never rendered an Archive
 * button would leave this whole file green while the user still could not
 * get a message out of the inbox.
 */

const ALL: readonly MoveDestination[] = ['archive', 'trash', 'spam'];

function row(uid: string, accountId = 'a'): InboxMessage {
  return { account_id: accountId, uid, folder: 'INBOX' } as unknown as InboxMessage;
}

const keyOf = (message: InboxMessage) => `${message.account_id}:${message.uid}`;

describe('the optimistic overlay', () => {
  it('hides one row without touching the list it came from', () => {
    // Arrange
    const messages = [row('1'), row('2'), row('3')];

    // Act
    const hidden = hideMessage(new Set(), 'a:2');

    // Assert
    expect(visibleMessages(messages, hidden, keyOf).map(keyOf)).toEqual(['a:1', 'a:3']);
    expect(messages).toHaveLength(3);
  });

  it('never mutates the set it was given', () => {
    const before: ReadonlySet<string> = new Set(['a:1']);
    const after = hideMessage(before, 'a:2');
    expect([...before]).toEqual(['a:1']);
    expect(after).not.toBe(before);
  });

  it('PUTS THE ROW BACK when the move is rolled back', () => {
    // The whole point. A failed archive must return the message to the
    // list rather than leaving it hidden and gone-looking.
    const messages = [row('1'), row('2')];
    const hidden = hideMessage(new Set(), 'a:2');

    const rolledBack = revealMessage(hidden, 'a:2');

    expect(visibleMessages(messages, rolledBack, keyOf).map(keyOf)).toEqual(['a:1', 'a:2']);
  });

  it('rolls back only the row it names, leaving other pending moves hidden', () => {
    const messages = [row('1'), row('2'), row('3')];
    const hidden = hideMessage(hideMessage(new Set(), 'a:2'), 'a:3');

    const rolledBack = revealMessage(hidden, 'a:2');

    expect(visibleMessages(messages, rolledBack, keyOf).map(keyOf)).toEqual(['a:1', 'a:2']);
  });

  it('keeps rows from other accounts that happen to share a uid', () => {
    // Gmail uids are per-mailbox, so uid 42 exists in every account. A
    // key that ignored the account would archive one row and hide four.
    const messages = [row('42', 'a'), row('42', 'b')];

    const hidden = hideMessage(new Set(), 'a:42');

    expect(visibleMessages(messages, hidden, keyOf).map(keyOf)).toEqual(['b:42']);
  });

  it('returns the SAME array when nothing is hidden', () => {
    // Identity, not merely equality: React re-renders every row of a
    // 50-row list when this changes, and an archive nobody performed must
    // not cost that.
    const messages = [row('1'), row('2')];
    expect(visibleMessages(messages, new Set(), keyOf)).toBe(messages);
  });

  it('revealing a key that was never hidden changes nothing', () => {
    const messages = [row('1')];
    expect(visibleMessages(messages, revealMessage(new Set(), 'a:9'), keyOf).map(keyOf)).toEqual([
      'a:1',
    ]);
  });
});

describe('when an undo may be offered', () => {
  const ticket = { folder: '[Gmail]/Trash', uid: 900, origin: 'inbox' };

  it('offers one for an ordinary move', () => {
    expect(canUndo({ moved: true, undo: ticket })).toBe(true);
  });

  it('refuses when the server reported no ticket', () => {
    // No COPYUID, or a source folder the service cannot name. An undo
    // built on a guessed uid would move an UNRELATED message into the
    // user's inbox, which is far worse than offering nothing.
    expect(canUndo({ moved: true, undo: null })).toBe(false);
  });

  it('refuses when nothing actually moved', () => {
    // The message was already gone — archived from the Gmail app first.
    // There is nothing to put back.
    expect(canUndo({ moved: false, undo: ticket })).toBe(false);
    expect(canUndo({ moved: false, undo: null })).toBe(false);
  });

  it('is not vacuous — it distinguishes the two refusals from the accept', () => {
    const results: readonly MoveResult[] = [
      { moved: true, undo: ticket },
      { moved: true, undo: null },
      { moved: false, undo: ticket },
    ];
    expect(results.map(canUndo)).toEqual([true, false, false]);
  });
});

describe('what the user is told', () => {
  it('names the outcome in past tense for every destination', () => {
    expect(moveNoticeFor('archive')).toBe('Archived.');
    expect(moveNoticeFor('trash')).toBe('Moved to Trash.');
    expect(moveNoticeFor('spam')).toBe('Reported as spam.');
  });

  it('gives every destination its own failure sentence', () => {
    const failures = ALL.map(moveFailureFor);
    expect(new Set(failures).size).toBe(ALL.length);
    for (const failure of failures) {
      expect(failure.length).toBeGreaterThan(0);
      // Names the mailbox, not a status code — matching the star failure
      // copy this app already ships.
      expect(failure).toMatch(/mailbox/);
    }
  });

  it('says something DIFFERENT when the undo itself failed', () => {
    // The two states do not leave the message in the same place: after a
    // failed move it is still in the inbox, after a failed undo it is
    // not. One sentence for both would send the user to the wrong folder.
    for (const destination of ALL) {
      expect(undoFailureFor(destination)).not.toBe(moveFailureFor(destination));
      expect(undoFailureFor(destination)).toMatch(/back/);
    }
  });

  it('labels the undo control with what it will undo', () => {
    // "Undo" alone is fine beside a notice that says what happened, but
    // the ACCESSIBLE NAME is read without that context.
    expect(undoLabelFor('archive')).toBe('Undo archive');
    expect(undoLabelFor('trash')).toBe('Undo move to Trash');
    expect(undoLabelFor('spam')).toBe('Undo report as spam');
  });

  it('never says "deleted" — archive and trash are moves, not deletions', () => {
    // sync/src/imap/move.ts opens no expunge path, and the copy must not
    // claim one. A user told a message was "deleted" would not go looking
    // for it in All Mail, which is exactly where it still is.
    const everything = [
      ...ALL.map(moveNoticeFor),
      ...ALL.map(moveFailureFor),
      ...ALL.map(undoFailureFor),
      ...ALL.map(undoLabelFor),
    ].join(' ');
    expect(everything).not.toMatch(/delet/i);
    expect(everything).not.toMatch(/permanent/i);
  });
});

describe('the undo window', () => {
  it('is long enough to notice a mistake and short enough not to linger', () => {
    expect(UNDO_WINDOW_MS).toBeGreaterThanOrEqual(5_000);
    expect(UNDO_WINDOW_MS).toBeLessThanOrEqual(15_000);
  });
});
