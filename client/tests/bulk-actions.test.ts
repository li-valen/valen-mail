import { describe, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../src/api';
import type { MoveResult, PendingUndo, UndoTicket } from '../src/mailboxActions';
import { selectionKeyFor } from '../src/bulkSelection';
import {
  bulkFlagFailureFor,
  bulkMoveFailureFor,
  bulkMoveNoticeFor,
  bulkSelectionUnavailableHere,
  bulkUndoFailureFor,
  bulkUndoLabelFor,
  canBulkSelect,
  canUndoBulk,
  moveTargetsFor,
  runBulkFlag,
  runBulkMove,
  runBulkUndo,
} from '../src/bulkActions';

/**
 * THE PARTIAL BATCH — the case this whole feature is judged on.
 *
 * Forty moves are forty HTTP calls and some of them will fail. Three
 * things then have to be true at once, and each is tested here on its
 * own and in combination:
 *
 *   1. Rows that MOVED stay hidden.
 *   2. Rows that FAILED come back — visibly, in the list, not silently.
 *   3. The user is told HOW MANY failed. "Something went wrong" over an
 *      inbox the user believes is clean is the worst outcome available.
 *
 * …and a fourth, which only shows up a beat later: an undo taken after a
 * partial batch must put back EXACTLY the ones that actually moved.
 */

function message(accountId: string, uid: string, folder = 'INBOX'): InboxMessage {
  return {
    account_id: accountId,
    uid,
    message_id: null,
    thread_id: null,
    folder,
    subject: `Subject ${accountId}/${uid}`,
    from_name: 'Sender',
    from_email: 'sender@example.com',
    to_emails: [],
    cc_emails: [],
    date: '2026-08-24T10:00:00Z',
    snippet: null,
    flags: [],
    labels: [],
    has_attach: false,
    size_bytes: null,
    attachments: [],
  };
}

function ticket(uid: number): UndoTicket {
  return { folder: '[Gmail]/All Mail', uid, origin: 'inbox' };
}

function moved(uid: number): MoveResult {
  return { moved: true, undo: ticket(uid) };
}

/** A move that happened but cannot be taken back — no COPYUID, or a
 *  source folder the server could not name. */
const MOVED_NO_TICKET: MoveResult = { moved: true, undo: null };
/** The message was already gone: somebody archived it from the Gmail app. */
const ALREADY_GONE: MoveResult = { moved: false, undo: null };

const ROWS = [message('primary', '1'), message('primary', '2'), message('harvard', '1')];

function targets(messages: readonly InboxMessage[] = ROWS) {
  return messages.map((item) => ({ key: selectionKeyFor(item), message: item }));
}

describe('a batch where everything works', () => {
  it('reports every key as moved and none as restored', async () => {
    const move = vi.fn(async () => moved(9));
    const outcome = await runBulkMove(targets(), 'archive', { move });
    expect(outcome.movedKeys).toEqual(['primary:1', 'primary:2', 'harvard:1']);
    expect(outcome.restoredKeys).toEqual([]);
    expect(outcome.attempted).toBe(3);
    expect(move).toHaveBeenCalledTimes(3);
  });

  it('carries one undo ticket per moved message, keyed to the row it hid', async () => {
    let next = 100;
    const move = vi.fn(async () => moved((next += 1)));
    const outcome = await runBulkMove(targets(), 'trash', { move });
    expect(outcome.undos.map((undo) => undo.key)).toEqual(['primary:1', 'primary:2', 'harvard:1']);
    expect(outcome.undos.map((undo) => undo.accountId)).toEqual(['primary', 'primary', 'harvard']);
    expect(outcome.undos.every((undo) => undo.destination === 'trash')).toBe(true);
  });

  it('offers an undo', async () => {
    const outcome = await runBulkMove(targets(), 'archive', { move: async () => moved(1) });
    expect(canUndoBulk(outcome)).toBe(true);
  });
});

describe('a PARTIAL batch', () => {
  /** Rows 1 and 3 move; row 2's request rejects. */
  async function partial() {
    const move = async (item: InboxMessage): Promise<MoveResult> => {
      if (item.uid === '2') throw new Error('502');
      return moved(Number(item.uid) + 500);
    };
    return runBulkMove(targets(), 'archive', { move, limit: 2 });
  }

  it('keeps the rows that moved', async () => {
    const outcome = await partial();
    expect(outcome.movedKeys).toEqual(['primary:1', 'harvard:1']);
  });

  it('BRINGS BACK exactly the rows that failed', async () => {
    // MUTATION TARGET (a). An implementation that dropped the failures on
    // the floor leaves a message hidden in the UI and still sitting in
    // the inbox — a lie the user has no way to detect.
    const outcome = await partial();
    expect(outcome.restoredKeys).toEqual(['primary:2']);
  });

  it('never reports a key as both moved and restored', async () => {
    const outcome = await partial();
    const overlap = outcome.movedKeys.filter((key) => outcome.restoredKeys.includes(key));
    expect(overlap).toEqual([]);
  });

  it('accounts for every message it was given', async () => {
    const outcome = await partial();
    expect(outcome.movedKeys.length + outcome.restoredKeys.length).toBe(outcome.attempted);
  });

  it('says HOW MANY failed, not merely that something did', async () => {
    const outcome = await partial();
    const notice = bulkMoveFailureFor('archive', outcome);
    expect(notice).not.toBeNull();
    expect(notice).toContain('1 of 3');
    expect(notice).toContain('back in your inbox');
  });

  it('an undo taken afterwards restores ONLY the ones that really moved', async () => {
    const outcome = await partial();
    expect(outcome.undos.map((undo) => undo.key)).toEqual(['primary:1', 'harvard:1']);
    expect(outcome.undos.map((undo) => undo.key)).not.toContain('primary:2');
  });
});

describe('the outcomes that are not failures', () => {
  it('a message that was ALREADY gone stays hidden and offers no ticket', async () => {
    // `moved: false` means somebody archived it from the Gmail app. There
    // is nothing to put back, and putting the row back would be wrong.
    const outcome = await runBulkMove(targets([ROWS[0]!]), 'archive', {
      move: async () => ALREADY_GONE,
    });
    expect(outcome.movedKeys).toEqual(['primary:1']);
    expect(outcome.restoredKeys).toEqual([]);
    expect(outcome.undos).toEqual([]);
  });

  it('a move with no usable ticket stays hidden and offers no undo for that row', async () => {
    // An undo built on a guessed uid would move an UNRELATED message into
    // the inbox — mailboxActions.ts's `canUndo` is the only thing that
    // decides, and it decides per row here exactly as it does per message
    // there.
    const outcome = await runBulkMove(targets([ROWS[0]!, ROWS[1]!]), 'archive', {
      move: async (item) => (item.uid === '1' ? MOVED_NO_TICKET : moved(7)),
    });
    expect(outcome.movedKeys).toEqual(['primary:1', 'primary:2']);
    expect(outcome.undos.map((undo) => undo.key)).toEqual(['primary:2']);
  });

  it('offers no undo at all when not one row produced a ticket', async () => {
    const outcome = await runBulkMove(targets(), 'archive', { move: async () => ALREADY_GONE });
    expect(canUndoBulk(outcome)).toBe(false);
  });
});

describe('a batch where NOTHING worked', () => {
  it('brings every row back', async () => {
    const outcome = await runBulkMove(targets(), 'archive', {
      move: async () => {
        throw new Error('mailbox unreachable');
      },
    });
    expect(outcome.movedKeys).toEqual([]);
    expect(outcome.restoredKeys).toEqual(['primary:1', 'primary:2', 'harvard:1']);
  });

  it('says so in words that do not imply a partial success', async () => {
    const outcome = await runBulkMove(targets(), 'archive', {
      move: async () => {
        throw new Error('mailbox unreachable');
      },
    });
    const notice = bulkMoveFailureFor('archive', outcome);
    expect(notice).toContain('None of the 3');
    expect(notice).not.toContain('0 of 3');
  });
});

describe('a batch abandoned part-way', () => {
  it('brings back every row whose request was never sent', async () => {
    const controller = new AbortController();
    const move = async (item: InboxMessage): Promise<MoveResult> => {
      controller.abort();
      return moved(Number(item.uid));
    };
    const outcome = await runBulkMove(targets(), 'archive', {
      move,
      limit: 1,
      signal: controller.signal,
    });
    expect(outcome.movedKeys).toEqual(['primary:1']);
    expect(outcome.restoredKeys).toEqual(['primary:2', 'harvard:1']);
  });
});

describe('undoing a batch', () => {
  const entries: readonly PendingUndo[] = [
    { key: 'primary:1', accountId: 'primary', destination: 'archive', ticket: ticket(11) },
    { key: 'primary:2', accountId: 'primary', destination: 'archive', ticket: ticket(12) },
    { key: 'harvard:1', accountId: 'harvard', destination: 'archive', ticket: ticket(13) },
  ];

  it('reveals every row it put back', async () => {
    const outcome = await runBulkUndo(entries, { undo: async () => undefined });
    expect(outcome.restoredKeys).toEqual(['primary:1', 'primary:2', 'harvard:1']);
    expect(outcome.stuckKeys).toEqual([]);
  });

  it('leaves a row that would not come back HIDDEN, because it really is still gone', async () => {
    const outcome = await runBulkUndo(entries, {
      undo: async (entry) => {
        if (entry.key === 'primary:2') throw new Error('nope');
      },
    });
    expect(outcome.restoredKeys).toEqual(['primary:1', 'harvard:1']);
    expect(outcome.stuckKeys).toEqual(['primary:2']);
  });

  it('says how many stayed where they were, in different words from a failed move', async () => {
    const outcome = await runBulkUndo(entries, {
      undo: async (entry) => {
        if (entry.key === 'primary:2') throw new Error('nope');
      },
    });
    const notice = bulkUndoFailureFor('archive', outcome);
    expect(notice).toContain('1 of 3');
    expect(notice).toContain('archived');
    // A failed move leaves the message in the inbox; a failed undo does
    // not. Telling the user "could not be archived" here would send them
    // looking in the wrong folder.
    expect(notice).not.toContain('back in your inbox');
  });

  it('is silent when every row came back', async () => {
    const outcome = await runBulkUndo(entries, { undo: async () => undefined });
    expect(bulkUndoFailureFor('archive', outcome)).toBeNull();
  });

  it('falls back to the single-message sentence when the batch was one', async () => {
    const outcome = await runBulkUndo([entries[0]!], {
      undo: async () => {
        throw new Error('nope');
      },
    });
    expect(bulkUndoFailureFor('archive', outcome)).toBe(
      "That message stayed archived — Postbox couldn't move it back.",
    );
  });
});

describe('marking a batch read or unread', () => {
  it('reports every key it changed', async () => {
    const outcome = await runBulkFlag(targets(), true, { setSeen: async () => undefined });
    expect(outcome.changedKeys).toEqual(['primary:1', 'primary:2', 'harvard:1']);
    expect(outcome.revertedKeys).toEqual([]);
    expect(outcome.seen).toBe(true);
  });

  it('REVERTS exactly the rows whose write failed', async () => {
    const outcome = await runBulkFlag(targets(), true, {
      setSeen: async (item) => {
        if (item.uid === '2') throw new Error('502');
      },
    });
    expect(outcome.changedKeys).toEqual(['primary:1', 'harvard:1']);
    expect(outcome.revertedKeys).toEqual(['primary:2']);
  });

  it('says how many did not take', async () => {
    const outcome = await runBulkFlag(targets(), true, {
      setSeen: async (item) => {
        if (item.uid === '2') throw new Error('502');
      },
    });
    expect(bulkFlagFailureFor(outcome)).toContain('1 of 3');
    expect(bulkFlagFailureFor(outcome)).toContain('read');
  });

  it('is silent when every write took', async () => {
    const outcome = await runBulkFlag(targets(), false, { setSeen: async () => undefined });
    expect(bulkFlagFailureFor(outcome)).toBeNull();
  });

  it('names the direction the user asked for', async () => {
    const outcome = await runBulkFlag(targets(), false, {
      setSeen: async () => {
        throw new Error('502');
      },
    });
    expect(bulkFlagFailureFor(outcome)).toContain('unread');
  });

  it('passes the direction through to the write', async () => {
    const setSeen = vi.fn(async () => undefined);
    await runBulkFlag(targets([ROWS[0]!]), false, { setSeen });
    expect(setSeen).toHaveBeenCalledWith(ROWS[0], false);
  });
});

describe('what the notice says after a batch', () => {
  it('counts, and agrees with itself about plurals', () => {
    expect(bulkMoveNoticeFor('archive', 12)).toBe('Archived 12 messages.');
    expect(bulkMoveNoticeFor('archive', 1)).toBe('Archived 1 message.');
    expect(bulkMoveNoticeFor('trash', 12)).toBe('Moved 12 messages to Trash.');
    expect(bulkMoveNoticeFor('trash', 1)).toBe('Moved 1 message to Trash.');
    expect(bulkMoveNoticeFor('spam', 3)).toBe('Reported 3 messages as spam.');
  });

  it('names the batch on the undo button, so a screen reader knows what it undoes', () => {
    expect(bulkUndoLabelFor('archive', 12)).toBe('Undo archive of 12 messages');
    expect(bulkUndoLabelFor('trash', 1)).toBe('Undo move to Trash of 1 message');
  });

  it('falls back to the single-message failure sentence for a batch of one', async () => {
    const outcome = await runBulkMove(targets([ROWS[0]!]), 'archive', {
      move: async () => {
        throw new Error('502');
      },
    });
    expect(bulkMoveFailureFor('archive', outcome)).toBe(
      "That message could not be archived — Postbox couldn't reach your mailbox.",
    );
  });

  it('is silent when nothing failed', async () => {
    const outcome = await runBulkMove(targets(), 'archive', { move: async () => moved(1) });
    expect(bulkMoveFailureFor('archive', outcome)).toBeNull();
  });

  it('names the right verb for each destination', async () => {
    for (const [destination, verb] of [
      ['archive', 'archived'],
      ['trash', 'moved to Trash'],
      ['spam', 'reported as spam'],
    ] as const) {
      const outcome = await runBulkMove(targets(), destination, {
        move: async () => {
          throw new Error('502');
        },
      });
      expect(bulkMoveFailureFor(destination, outcome)).toContain(verb);
    }
  });
});

describe('which messages a keystroke acts on', () => {
  const inHand = ROWS[0]!;
  const selection = [ROWS[1]!, ROWS[2]!];

  it('acts on the whole selection from the list', () => {
    expect(moveTargetsFor({ inHand, isReaderOpen: false, selection })).toEqual(selection);
  });

  it('acts on the message in hand when nothing is selected', () => {
    expect(moveTargetsFor({ inHand, isReaderOpen: false, selection: [] })).toEqual([inHand]);
  });

  it('acts on the OPEN message from the reader, even with rows ticked behind it', () => {
    // The reader has replaced the list, so the ticks are not on screen.
    // Archiving forty invisible rows because the user pressed `e` while
    // reading one message is the opposite of what they asked for.
    expect(moveTargetsFor({ inHand, isReaderOpen: true, selection })).toEqual([inHand]);
  });

  it('acts on nothing when there is nothing in hand and nothing ticked', () => {
    expect(moveTargetsFor({ inHand: null, isReaderOpen: false, selection: [] })).toEqual([]);
  });

  it('still acts on the selection when the cursor has never moved', () => {
    expect(moveTargetsFor({ inHand: null, isReaderOpen: false, selection })).toEqual(selection);
  });
});

describe('where a row may be ticked at all', () => {
  it('allows an inbox row', () => {
    expect(canBulkSelect(message('primary', '1', 'INBOX'))).toBe(true);
  });

  it('refuses a row that lives somewhere else', () => {
    // The Starred view is a flag query ACROSS folders, so this is decided
    // per row and not per view. Archiving from Sent removes the SENT
    // label on Gmail and silently empties the follow-up queue — see
    // mailboxActions.ts's `canMoveFrom`.
    expect(canBulkSelect(message('primary', '1', '[Gmail]/Sent Mail'))).toBe(false);
  });

  it('says why, rather than letting the keystroke do nothing', () => {
    expect(bulkSelectionUnavailableHere()).toContain('Inbox');
  });
});
