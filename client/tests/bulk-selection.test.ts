import { describe, expect, it } from 'vitest';
import type { InboxMessage } from '../src/api';
import { messageKey } from '../src/components/messageBody';
import {
  clearSelection,
  countLabel,
  deselectKeys,
  isEverythingSelected,
  isSelected,
  NOTHING_SELECTED,
  pruneSelection,
  selectAll,
  selectableKeys,
  selectedMessages,
  selectionKeyFor,
  toggleGroupSelection,
  toggleSelection,
} from '../src/bulkSelection';

/**
 * The selection set, exhaustively — the state a bulk action reads before
 * it touches anyone's mailbox.
 *
 * THE KEY IS THE WHOLE STORY OF THIS FILE. uids are per-mailbox, so two
 * accounts routinely share one; a selection keyed by uid alone would let
 * a tick on `harvard:9` also tick `primary:9` and archive a message the
 * user never looked at. Every test below that names two accounts exists
 * to make that mistake fail loudly rather than quietly act on the wrong
 * mail.
 */

function message(accountId: string, uid: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    account_id: accountId,
    uid,
    message_id: null,
    thread_id: null,
    folder: 'INBOX',
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
    ...overrides,
  };
}

const A1 = message('primary', '1');
const A2 = message('primary', '2');
const B1 = message('harvard', '1');

describe('the selection key', () => {
  it('is the same key mailboxActions hides rows by', () => {
    // Not a stylistic preference: App.tsx compares the selection against
    // the hidden set directly, so two different key shapes would mean a
    // row that moved could never be dropped from the selection.
    expect(selectionKeyFor(A1)).toBe(messageKey(A1));
    expect(selectionKeyFor(B1)).toBe(messageKey(B1));
  });

  it('separates two accounts that share a uid', () => {
    expect(A1.uid).toBe(B1.uid);
    expect(selectionKeyFor(A1)).not.toBe(selectionKeyFor(B1));
  });

  it('names the account, not just the uid', () => {
    // MUTATION TARGET (b). A key of `uid` alone passes every other test
    // in this file that uses one account and fails here.
    expect(selectionKeyFor(A1)).toContain('primary');
    expect(selectionKeyFor(A1)).not.toBe(A1.uid);
  });
});

describe('toggling one row', () => {
  it('selects a row that was not selected', () => {
    const next = toggleSelection(NOTHING_SELECTED, selectionKeyFor(A1));
    expect(isSelected(next, selectionKeyFor(A1))).toBe(true);
    expect(next.size).toBe(1);
  });

  it('deselects a row that was', () => {
    const once = toggleSelection(NOTHING_SELECTED, selectionKeyFor(A1));
    const twice = toggleSelection(once, selectionKeyFor(A1));
    expect(isSelected(twice, selectionKeyFor(A1))).toBe(false);
    expect(twice.size).toBe(0);
  });

  it('never mutates the set it was given', () => {
    const before = toggleSelection(NOTHING_SELECTED, selectionKeyFor(A1));
    const after = toggleSelection(before, selectionKeyFor(A2));
    expect(before.size).toBe(1);
    expect(after.size).toBe(2);
    expect(after).not.toBe(before);
  });

  it('returns a NEW identity even when the contents are equivalent', () => {
    // React state: a set mutated in place would not re-render the bar.
    const before = toggleSelection(NOTHING_SELECTED, selectionKeyFor(A1));
    const after = toggleSelection(before, selectionKeyFor(A1));
    expect(after).not.toBe(before);
  });

  it('ticking one account does not tick the other account sharing its uid', () => {
    const next = toggleSelection(NOTHING_SELECTED, selectionKeyFor(A1));
    expect(isSelected(next, selectionKeyFor(B1))).toBe(false);
  });
});

describe('select all and clear', () => {
  it('selects every key it is given', () => {
    const next = selectAll([A1, A2, B1].map(selectionKeyFor));
    expect(next.size).toBe(3);
    expect(isSelected(next, selectionKeyFor(B1))).toBe(true);
  });

  it('replaces rather than unions — a row scrolled out of the list stays out', () => {
    const stale = selectAll(['gone:99']);
    const next = selectAll([A1].map(selectionKeyFor));
    expect(isSelected(next, 'gone:99')).toBe(false);
    expect(stale.size).toBe(1);
  });

  it('clears to an empty set', () => {
    expect(clearSelection().size).toBe(0);
  });

  it('reports when everything visible is already selected', () => {
    const keys = [A1, A2].map(selectionKeyFor);
    expect(isEverythingSelected(selectAll(keys), keys)).toBe(true);
    expect(isEverythingSelected(toggleSelection(NOTHING_SELECTED, keys[0]!), keys)).toBe(false);
  });

  it('an empty list is never "everything selected"', () => {
    // Otherwise the header checkbox would render ticked over an empty
    // inbox and "clear" would be the only thing it could do.
    expect(isEverythingSelected(NOTHING_SELECTED, [])).toBe(false);
  });

  it('ignores selected keys that are no longer in the list', () => {
    const selected = selectAll([...([A1, A2].map(selectionKeyFor)), 'gone:99']);
    expect(isEverythingSelected(selected, [A1, A2].map(selectionKeyFor))).toBe(true);
  });
});

describe('dropping keys', () => {
  it('removes exactly the keys named', () => {
    const selected = selectAll([A1, A2, B1].map(selectionKeyFor));
    const next = deselectKeys(selected, [selectionKeyFor(A1), selectionKeyFor(B1)]);
    expect([...next]).toEqual([selectionKeyFor(A2)]);
  });

  it('is a no-op identity change when nothing matched', () => {
    const selected = selectAll([selectionKeyFor(A1)]);
    const next = deselectKeys(selected, ['nothing:1']);
    expect([...next]).toEqual([selectionKeyFor(A1)]);
  });

  it('never mutates its input', () => {
    const selected = selectAll([A1, A2].map(selectionKeyFor));
    deselectKeys(selected, [selectionKeyFor(A1)]);
    expect(selected.size).toBe(2);
  });

  it('drops one account without dropping the other that shares its uid', () => {
    const selected = selectAll([A1, B1].map(selectionKeyFor));
    const next = deselectKeys(selected, [selectionKeyFor(A1)]);
    expect([...next]).toEqual([selectionKeyFor(B1)]);
  });
});

describe('pruning against the list on screen', () => {
  it('keeps keys that are still in the list', () => {
    const selected = selectAll([A1, A2].map(selectionKeyFor));
    const next = pruneSelection(selected, [A1, A2].map(selectionKeyFor));
    expect(next.size).toBe(2);
  });

  it('drops keys the list no longer holds', () => {
    // A folder change, a search, or a row that aged out of the sync
    // window. A count that keeps counting rows nobody can see is a lie.
    const selected = selectAll([A1, A2].map(selectionKeyFor));
    const next = pruneSelection(selected, [selectionKeyFor(A2)]);
    expect([...next]).toEqual([selectionKeyFor(A2)]);
  });

  it('returns the SAME set when nothing had to be dropped', () => {
    // Identity matters: a fresh Set every render would re-run every memo
    // keyed on the selection, over a fifty-row list, for nothing.
    const selected = selectAll([A1, A2].map(selectionKeyFor));
    expect(pruneSelection(selected, [A1, A2].map(selectionKeyFor))).toBe(selected);
  });

  it('empties out when the list does', () => {
    const selected = selectAll([A1].map(selectionKeyFor));
    expect(pruneSelection(selected, []).size).toBe(0);
  });

  it('an already-empty selection stays the same identity', () => {
    expect(pruneSelection(NOTHING_SELECTED, [])).toBe(NOTHING_SELECTED);
  });
});

describe('resolving keys back to messages', () => {
  it('returns the selected rows in LIST order, not selection order', () => {
    // The order the moves are issued in is the order the user sees, which
    // is what makes a partially-failed batch legible.
    const selected = selectAll([selectionKeyFor(A2), selectionKeyFor(A1)]);
    expect(selectedMessages([A1, A2], selected, selectionKeyFor)).toEqual([A1, A2]);
  });

  it('ignores selected keys with no row in the list', () => {
    const selected = selectAll([selectionKeyFor(A1), 'gone:99']);
    expect(selectedMessages([A1], selected, selectionKeyFor)).toEqual([A1]);
  });

  it('returns nothing for an empty selection without walking the list', () => {
    expect(selectedMessages([A1, A2], NOTHING_SELECTED, selectionKeyFor)).toEqual([]);
  });

  it('picks the right account when two rows share a uid', () => {
    const selected = selectAll([selectionKeyFor(B1)]);
    expect(selectedMessages([A1, B1], selected, selectionKeyFor)).toEqual([B1]);
  });
});

describe('the live count', () => {
  it('says how many, in words a person reads', () => {
    expect(countLabel(1)).toBe('1 selected');
    expect(countLabel(12)).toBe('12 selected');
  });

  it('never renders a zero — the bar is absent instead', () => {
    expect(countLabel(0)).toBe('0 selected');
  });
});

/**
 * Ticking a COLLAPSED CONVERSATION — one row, N keys, one decision.
 *
 * The keys stay per message (a move is one request per message, and the
 * hidden set is per message); what changes is that they go in and come
 * out together. A half-ticked conversation is the failure these two
 * functions exist to make unreachable: its row's box asks whether the
 * WHOLE conversation is selected, so a partial selection draws as
 * unticked while an Archive would take part of it.
 */
describe('toggleGroupSelection', () => {
  const group = ['harvard:9', 'harvard:4', 'harvard:1'];

  it('ticks every key of an untouched group', () => {
    const next = toggleGroupSelection(NOTHING_SELECTED, group);
    expect([...next].sort()).toEqual([...group].sort());
  });

  it('unticks every key of a fully-ticked group — the exact inverse', () => {
    const ticked = toggleGroupSelection(NOTHING_SELECTED, group);
    expect(toggleGroupSelection(ticked, group).size).toBe(0);
  });

  it('COMPLETES a partly-ticked group rather than inverting each key', () => {
    // Toggling per key would leave two ticked and one not — a row whose
    // box says "not selected" over a selection that Archive would act on.
    const partial = new Set(['harvard:4']);
    const next = toggleGroupSelection(partial, group);
    expect([...next].sort()).toEqual([...group].sort());
  });

  it('leaves keys outside the group alone', () => {
    const other = new Set(['primary:7']);
    const next = toggleGroupSelection(other, group);
    expect(next.has('primary:7')).toBe(true);
  });

  it('returns the SAME set for an empty group, so nothing re-renders', () => {
    const current = new Set(['primary:7']);
    expect(toggleGroupSelection(current, [])).toBe(current);
  });

  it('never mutates the set it was given', () => {
    const current = new Set(['primary:7']);
    toggleGroupSelection(current, group);
    expect([...current]).toEqual(['primary:7']);
  });
});

describe('selectableKeys', () => {
  const inInbox = (m: InboxMessage) => m.folder === 'INBOX';

  it('is exactly the ungrouped filter when every row stands for itself', () => {
    const rows = [
      message('harvard', '1'),
      message('harvard', '2', { folder: '[Gmail]/Sent Mail' }),
      message('primary', '1'),
    ];
    expect(selectableKeys(rows, inInbox)).toEqual(['harvard:1', 'primary:1']);
  });

  it('drops EVERY member of a conversation one of whose members cannot move', () => {
    // Starred is the one view that merges folders, so a conversation
    // there can hold an INBOX message and a Sent one. Selecting the INBOX
    // half alone is the half-ticked conversation this prevents.
    const inbox = message('harvard', '9');
    const sent = message('harvard', '4', { folder: '[Gmail]/Sent Mail' });
    const solo = message('primary', '1');
    const membersOf = new Map<string, readonly InboxMessage[]>([
      ['harvard:9', [inbox, sent]],
      ['harvard:4', [inbox, sent]],
      ['primary:1', [solo]],
    ]);
    const keys = selectableKeys(
      [inbox, sent, solo],
      inInbox,
      (m) => membersOf.get(messageKey(m)) ?? [m],
    );
    expect(keys).toEqual(['primary:1']);
  });

  it('keeps every member of a conversation that can move as a whole', () => {
    const a = message('harvard', '9');
    const b = message('harvard', '4');
    const keys = selectableKeys([a, b], inInbox, () => [a, b]);
    expect(keys).toEqual(['harvard:9', 'harvard:4']);
  });
});
