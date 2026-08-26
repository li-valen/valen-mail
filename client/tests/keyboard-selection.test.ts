import { describe, expect, it } from 'vitest';
import { NO_SELECTION, reconcileSelection, snapshotSelection } from '../src/keyboard/selection';
import type { SelectionResult } from '../src/keyboard/selection';

/**
 * What happens to the cursor when the list changes under it — the three
 * ways it changes, and why they do not want the same answer. See
 * ../src/keyboard/selection.ts's header; these are the cases it claims to
 * get right.
 */

const INBOX = ['a:1', 'a:2', 'a:3', 'a:4', 'a:5'];

describe('an append leaves the cursor exactly where it was', () => {
  it('keeps the index when loadMore splices a second page onto the end', () => {
    const previous = snapshotSelection(INBOX, 2);
    const appended = [...INBOX, 'a:6', 'a:7', 'a:8'];
    expect(reconcileSelection(previous, appended)).toEqual({ key: 'a:3', index: 2 });
  });

  it('keeps the cursor on the LAST row of page one after page two arrives', () => {
    // The row a user is most likely to be sitting on when they reach for
    // "Load more", and the one an index-based cursor would be most
    // likely to strand.
    const previous = snapshotSelection(INBOX, 4);
    expect(reconcileSelection(previous, [...INBOX, 'a:6'])).toEqual({ key: 'a:5', index: 4 });
  });

  it('follows the message rather than the index when rows are prepended', () => {
    // New mail arriving at the top shifts every index by one. Keying on
    // identity is what stops the cursor sliding to a different message —
    // the same defect src/motion/newEntries.ts documents for the feed.
    const previous = snapshotSelection(INBOX, 1);
    expect(reconcileSelection(previous, ['a:0', ...INBOX])).toEqual({ key: 'a:2', index: 2 });
  });
});

describe('a wholesale swap puts the cursor on the newest message', () => {
  it('does NOT clamp the old index onto a different folder', () => {
    // The case the brief singles out: row 3 of Inbox must not become row
    // 3 of Trash. Clamping always produces a plausible-looking index,
    // which is exactly why nothing would ever report it as wrong.
    const previous = snapshotSelection(INBOX, 3);
    const trash = ['t:9', 't:8', 't:7', 't:6', 't:5', 't:4'];
    expect(reconcileSelection(previous, trash)).toEqual({ key: 't:9', index: 0 });
  });

  it('lands on index 0 even when the new list is longer than the old one', () => {
    const previous = snapshotSelection(INBOX, 4);
    const sent = ['s:1', 's:2', 's:3', 's:4', 's:5', 's:6', 's:7', 's:8'];
    expect(reconcileSelection(previous, sent).index).toBe(0);
  });

  it('lands on index 0 when a search narrows the list to one result', () => {
    const previous = snapshotSelection(INBOX, 3);
    expect(reconcileSelection(previous, ['a:9'])).toEqual({ key: 'a:9', index: 0 });
  });

  it('treats a swap that happens to be shorter as a swap, not as a shrink', () => {
    // Both "different folder" and "same folder minus rows" produce a
    // shorter list. Only the HEAD tells them apart.
    const previous = snapshotSelection(INBOX, 4);
    expect(reconcileSelection(previous, ['z:1', 'z:2']).index).toBe(0);
  });
});

describe('a removal from the same list clamps', () => {
  it('keeps the position when the cursor row itself disappears mid-list', () => {
    // Same head, so this is the same query answered again. The user's
    // place is approximately preserved rather than reset to the top.
    const previous = snapshotSelection(INBOX, 2);
    expect(reconcileSelection(previous, ['a:1', 'a:2', 'a:4', 'a:5'])).toEqual({
      key: 'a:4',
      index: 2,
    });
  });

  it('clamps to the last row when the list shrank past the cursor', () => {
    const previous = snapshotSelection(INBOX, 4);
    expect(reconcileSelection(previous, ['a:1', 'a:2'])).toEqual({ key: 'a:2', index: 1 });
  });

  it('clamps to the only remaining row', () => {
    const previous = snapshotSelection(INBOX, 3);
    expect(reconcileSelection(previous, ['a:1'])).toEqual({ key: 'a:1', index: 0 });
  });
});

describe('no cursor, and no list', () => {
  it('does not invent a cursor when the user has never pressed a key', () => {
    // A selection ring appearing on load for a mouse user who never
    // asked for one is noise, and `s` would then act on a message they
    // never chose.
    const previous = snapshotSelection(INBOX, NO_SELECTION);
    expect(reconcileSelection(previous, INBOX)).toEqual({ key: null, index: NO_SELECTION });
  });

  it('drops the cursor when the new list is empty', () => {
    const previous = snapshotSelection(INBOX, 2);
    expect(reconcileSelection(previous, [])).toEqual({ key: null, index: NO_SELECTION });
  });

  it('stays cursorless across an empty list and back', () => {
    const emptied = reconcileSelection(snapshotSelection(INBOX, 2), []);
    const refilled = reconcileSelection(snapshotSelection([], emptied.index), INBOX);
    expect(refilled).toEqual({ key: null, index: NO_SELECTION });
  });
});

describe('snapshotSelection', () => {
  it('captures the key, the index and the head from one array', () => {
    expect(snapshotSelection(INBOX, 2)).toEqual({ key: 'a:3', index: 2, headKey: 'a:1' });
  });

  it('reports a null key for no cursor but still captures the head', () => {
    expect(snapshotSelection(INBOX, NO_SELECTION)).toEqual({
      key: null,
      index: NO_SELECTION,
      headKey: 'a:1',
    });
  });

  it('reports nulls for an empty list', () => {
    expect(snapshotSelection([], 0)).toEqual({ key: null, index: 0, headKey: null });
  });

  it('reports a null key for an index past the end', () => {
    // Cannot happen through the normal path, and must degrade to "no
    // cursor" rather than to `undefined` reaching a lookup.
    expect(snapshotSelection(INBOX, 99).key).toBeNull();
  });
});

describe('the cursor survives a realistic session', () => {
  it('holds through load-more, a folder round trip, and back', () => {
    // j×3 → cursor on a:4.
    let selection: SelectionResult = { key: 'a:4', index: 3 };
    let keys = INBOX;

    // Load more: unchanged.
    const page2 = [...INBOX, 'a:6', 'a:7'];
    selection = reconcileSelection(snapshotSelection(keys, selection.index), page2);
    keys = page2;
    expect(selection).toEqual({ key: 'a:4', index: 3 });

    // g t → Sent. Cursor goes to the newest sent message, not to row 3.
    const sent = ['s:1', 's:2'];
    selection = reconcileSelection(snapshotSelection(keys, selection.index), sent);
    keys = sent;
    expect(selection).toEqual({ key: 's:1', index: 0 });

    // g i → back to Inbox. The old cursor is long gone; the newest
    // message is the honest place to be.
    selection = reconcileSelection(snapshotSelection(keys, selection.index), page2);
    expect(selection).toEqual({ key: 'a:1', index: 0 });
  });
});
