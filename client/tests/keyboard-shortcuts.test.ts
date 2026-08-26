import { describe, expect, it } from 'vitest';
import { CHORD_TIMEOUT_MS, resolveShortcut } from '../src/keyboard/shortcuts';
import type { PendingChord, ShortcutEvent, ShortcutState } from '../src/keyboard/shortcuts';

/**
 * The whole keyboard, exhaustively, with no DOM anywhere — which is the
 * point of ../src/keyboard/shortcuts.ts being a pure function in the
 * first place (client/CLAUDE.md: no test in this project renders a
 * component).
 */

const NOW = 10_000;

function press(key: string, overrides: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isTyping: false,
    isActivationTarget: false,
    ...overrides,
  };
}

function state(overrides: Partial<ShortcutState> = {}): ShortcutState {
  return {
    isComposerOpen: false,
    isHelpOpen: false,
    isReaderOpen: false,
    listLength: 10,
    selectedIndex: 3,
    chord: null,
    nowMs: NOW,
    ...overrides,
  };
}

const chordAt = (startedAtMs: number): PendingChord => ({ key: 'g', startedAtMs });

/* ── the guards ─────────────────────────────────────────────────────── */

describe('never steals a key the user is typing', () => {
  // THE headline requirement. Every single-letter shortcut, refused.
  it.each([
    'j',
    'k',
    'o',
    'u',
    's',
    'r',
    'a',
    'f',
    'g',
    '?',
    'Enter',
    'Escape',
    'ArrowDown',
    'ArrowUp',
  ])(
    'ignores %s when focus is in a typing context',
    (key) => {
      const result = resolveShortcut(press(key, { isTyping: true }), state());
      expect(result.action).toEqual({ kind: 'none' });
      expect(result.preventDefault).toBe(false);
    },
  );

  it('does not move the list while someone types the word "jazz"', () => {
    // The literal failure named in the brief, spelled out: four
    // keystrokes into a search box, cursor untouched every time.
    for (const key of ['j', 'a', 'z', 'z']) {
      const result = resolveShortcut(press(key, { isTyping: true }), state({ selectedIndex: 3 }));
      expect(result.action).toEqual({ kind: 'none' });
    }
  });

  it('clears a pending chord when focus lands in a field', () => {
    // A `g` from before the user clicked into the search box is stale:
    // the next letter they type must not be read as its completion.
    const result = resolveShortcut(press('i', { isTyping: true }), state({ chord: chordAt(NOW) }));
    expect(result.chord).toBeNull();
    expect(result.action).toEqual({ kind: 'none' });
  });

  it.each(['j', 'k', 'o', 'u', 's', 'g'])(
    'ignores %s while the composer is open, even outside a text field',
    (key) => {
      // `isTyping: false` on purpose — this is the composer's attachment
      // button or identity select having focus, which no field-based
      // guard would catch.
      const result = resolveShortcut(press(key), state({ isComposerOpen: true }));
      expect(result.action).toEqual({ kind: 'none' });
      expect(result.preventDefault).toBe(false);
    },
  );

  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['alt', { altKey: true }],
  ])('ignores a %s-modified letter, leaving it to the platform', (_label, modifier) => {
    expect(resolveShortcut(press('j', modifier), state()).action).toEqual({ kind: 'none' });
  });

  it('leaves Ctrl-K to searchQuery.ts rather than answering it here', () => {
    const result = resolveShortcut(press('k', { ctrlKey: true }), state());
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.preventDefault).toBe(false);
  });

  it.each(['j', 'k', 'o', 'u', 's'])('ignores Shift-%s', (key) => {
    expect(resolveShortcut(press(key, { shiftKey: true }), state()).action).toEqual({ kind: 'none' });
  });

  it.each(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])(
    'lets a bare %s keydown pass through without disturbing a chord',
    (key) => {
      // Pressing Shift on the way to the chord's second key must not
      // cancel it — on a layout where that key needs a modifier,
      // cancelling would make the chord unreachable.
      const pending = chordAt(NOW);
      const result = resolveShortcut(press(key), state({ chord: pending }));
      expect(result.chord).toBe(pending);
      expect(result.action).toEqual({ kind: 'none' });
    },
  );
});

/* ── j / k / arrows ─────────────────────────────────────────────────── */

describe('j and k move the cursor', () => {
  it.each(['j', 'ArrowDown'])('%s selects the next row', (key) => {
    expect(resolveShortcut(press(key), state({ selectedIndex: 3 })).action).toEqual({
      kind: 'select',
      index: 4,
    });
  });

  it.each(['k', 'ArrowUp'])('%s selects the previous row', (key) => {
    expect(resolveShortcut(press(key), state({ selectedIndex: 3 })).action).toEqual({
      kind: 'select',
      index: 2,
    });
  });

  it('stops at the last row rather than wrapping to the top', () => {
    // Wrapping would be a lie in a PAGED list: the bottom of what is
    // loaded is not the bottom of the mailbox.
    expect(resolveShortcut(press('j'), state({ selectedIndex: 9, listLength: 10 })).action).toEqual({
      kind: 'select',
      index: 9,
    });
  });

  it('stops at the first row rather than wrapping to the bottom', () => {
    expect(resolveShortcut(press('k'), state({ selectedIndex: 0 })).action).toEqual({
      kind: 'select',
      index: 0,
    });
  });

  it.each(['j', 'k'])('%s from no cursor lands on the newest row', (key) => {
    expect(resolveShortcut(press(key), state({ selectedIndex: -1 })).action).toEqual({
      kind: 'select',
      index: 0,
    });
  });

  it.each(['j', 'k'])('%s does nothing in an empty list', (key) => {
    const result = resolveShortcut(press(key), state({ listLength: 0, selectedIndex: -1 }));
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.preventDefault).toBe(false);
  });

  it('consumes the key so the browser does not scroll or quick-find', () => {
    expect(resolveShortcut(press('ArrowDown'), state()).preventDefault).toBe(true);
    expect(resolveShortcut(press('j'), state()).preventDefault).toBe(true);
  });

  it('opens rather than merely moving while the reader is showing', () => {
    // The list is hidden behind the reader, so a cursor move nobody can
    // see would be a dead keystroke.
    expect(
      resolveShortcut(press('j'), state({ isReaderOpen: true, selectedIndex: 3 })).action,
    ).toEqual({ kind: 'open', index: 4 });
    expect(
      resolveShortcut(press('k'), state({ isReaderOpen: true, selectedIndex: 3 })).action,
    ).toEqual({ kind: 'open', index: 2 });
  });

  it('does not re-open the same message at the end of the list in the reader', () => {
    // Clamped to 9, which is where the cursor already is — re-opening the
    // message already on screen would refetch nothing and look like a
    // glitch, so it resolves to `open` on the same index and App.tsx's
    // own identity check makes it a no-op. The important part is that it
    // never runs off the end.
    expect(
      resolveShortcut(press('j'), state({ isReaderOpen: true, selectedIndex: 9, listLength: 10 }))
        .action,
    ).toEqual({ kind: 'open', index: 9 });
  });
});

/* ── open / close ───────────────────────────────────────────────────── */

describe('opening and leaving the reader', () => {
  it.each(['Enter', 'o'])('%s opens the row under the cursor', (key) => {
    expect(resolveShortcut(press(key), state({ selectedIndex: 3 })).action).toEqual({
      kind: 'open',
      index: 3,
    });
  });

  it('leaves Enter to the platform when a button already has focus', () => {
    // The row IS a <button>; the browser fires its click on Enter.
    // Acting here too would run the open path twice for one keystroke.
    const result = resolveShortcut(press('Enter', { isActivationTarget: true }), state());
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.preventDefault).toBe(false);
  });

  it('still opens on o from a focused row, where Enter defers', () => {
    expect(resolveShortcut(press('o', { isActivationTarget: true }), state()).action).toEqual({
      kind: 'open',
      index: 3,
    });
  });

  it.each(['Enter', 'o'])('%s does nothing with no cursor', (key) => {
    expect(resolveShortcut(press(key), state({ selectedIndex: -1 })).action).toEqual({ kind: 'none' });
  });

  it.each(['Enter', 'o'])('%s does nothing when the reader is already open', (key) => {
    expect(resolveShortcut(press(key), state({ isReaderOpen: true })).action).toEqual({ kind: 'none' });
  });

  it('u returns to the list from the reader', () => {
    expect(resolveShortcut(press('u'), state({ isReaderOpen: true })).action).toEqual({
      kind: 'close-reader',
    });
  });

  it('u does nothing from the list', () => {
    const result = resolveShortcut(press('u'), state({ isReaderOpen: false }));
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.preventDefault).toBe(false);
  });

  it('Escape closes the reader', () => {
    expect(resolveShortcut(press('Escape'), state({ isReaderOpen: true })).action).toEqual({
      kind: 'close-reader',
    });
  });

  it('leaves Escape to the browser when there is nothing of ours to close', () => {
    // Never swallowed: Escape stops a load, cancels a native picker and
    // leaves full-screen, and an app that eats it breaks all three.
    const result = resolveShortcut(press('Escape'), state({ isReaderOpen: false }));
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.preventDefault).toBe(false);
  });
});

/* ── star ───────────────────────────────────────────────────────────── */

describe('s toggles the star', () => {
  it('acts on the row under the cursor', () => {
    expect(resolveShortcut(press('s'), state({ selectedIndex: 3 })).action).toEqual({
      kind: 'toggle-star',
    });
  });

  it('acts on the open message even with no list cursor', () => {
    expect(
      resolveShortcut(press('s'), state({ isReaderOpen: true, selectedIndex: -1 })).action,
    ).toEqual({ kind: 'toggle-star' });
  });

  it('does nothing when there is no message in hand', () => {
    const result = resolveShortcut(press('s'), state({ isReaderOpen: false, selectedIndex: -1 }));
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('does nothing when the cursor points past the end of the list', () => {
    expect(
      resolveShortcut(press('s'), state({ selectedIndex: 10, listLength: 10 })).action,
    ).toEqual({ kind: 'none' });
  });
});

describe('r, a and f open the composer', () => {
  it.each([
    ['r', 'reply'],
    ['a', 'replyAll'],
    ['f', 'forward'],
  ])('%s opens a %s', (key, mode) => {
    expect(resolveShortcut(press(key), state({ isReaderOpen: true })).action).toEqual({
      kind: 'reply',
      mode,
    });
  });

  it('works from the LIST as well as from the reader', () => {
    // A bare key that visibly does nothing is the dead interaction this
    // codebase refuses everywhere else, and Gmail's own `r` is live in
    // the list. App.tsx resolves the parsed body behind it.
    expect(resolveShortcut(press('r'), state({ isReaderOpen: false, selectedIndex: 3 })).action).toEqual(
      { kind: 'reply', mode: 'reply' },
    );
  });

  it('does nothing when there is no message in hand', () => {
    for (const key of ['r', 'a', 'f']) {
      const result = resolveShortcut(press(key), state({ isReaderOpen: false, selectedIndex: -1 }));
      expect(result.action).toEqual({ kind: 'none' });
      expect(result.preventDefault).toBe(false);
    }
  });

  it('does nothing when the cursor points past the end of the list', () => {
    expect(
      resolveShortcut(press('r'), state({ selectedIndex: 10, listLength: 10 })).action,
    ).toEqual({ kind: 'none' });
  });

  it('is suppressed WHOLESALE while the composer is open', () => {
    // Not a second typing guard — ./typingTarget.ts already covers the
    // fields. This is the blanket one: `f` while focus rests on the
    // identity select or the Add Cc button must not throw away the draft
    // being written and open a forward on top of it.
    for (const key of ['r', 'a', 'f']) {
      const result = resolveShortcut(press(key), state({ isComposerOpen: true, isReaderOpen: true }));
      expect(result.action).toEqual({ kind: 'none' });
      expect(result.preventDefault).toBe(false);
    }
  });

  it('is suppressed while the help overlay covers the list', () => {
    for (const key of ['r', 'a', 'f']) {
      expect(resolveShortcut(press(key), state({ isHelpOpen: true, isReaderOpen: true })).action).toEqual(
        { kind: 'none' },
      );
    }
  });

  it('never answers to a modified form — Cmd-R is reload and Cmd-F is find', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      for (const key of ['r', 'a', 'f']) {
        const result = resolveShortcut(press(key, { [modifier]: true }), state({ isReaderOpen: true }));
        expect(result.action).toEqual({ kind: 'none' });
        expect(result.preventDefault).toBe(false);
      }
    }
  });

  it('never answers to Shift either', () => {
    for (const key of ['r', 'a', 'f']) {
      expect(resolveShortcut(press(key, { shiftKey: true }), state({ isReaderOpen: true })).action).toEqual(
        { kind: 'none' },
      );
    }
  });

  it('claims the key it acts on, so the browser does not also see it', () => {
    expect(resolveShortcut(press('r'), state({ isReaderOpen: true })).preventDefault).toBe(true);
  });

  it('after a stray g, a and f still mean what they mean', () => {
    // The documented fall-through: `g` then a key that is not a folder
    // resolves as if the prefix had never been pressed.
    const result = resolveShortcut(press('a'), state({ isReaderOpen: true, chord: chordAt(NOW) }));
    expect(result.action).toEqual({ kind: 'reply', mode: 'replyAll' });
    expect(result.chord).toBeNull();
  });
});

/* ── the g chord ────────────────────────────────────────────────────── */

describe('g is a chord prefix', () => {
  it('opens the chord without doing anything yet', () => {
    const result = resolveShortcut(press('g'), state({ nowMs: 500 }));
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.chord).toEqual({ key: 'g', startedAtMs: 500 });
    // Consumed even though nothing happened — `g` must not reach the
    // browser while it stands for "go to".
    expect(result.preventDefault).toBe(true);
  });

  it.each([
    ['i', 'inbox'],
    ['s', 'starred'],
    ['t', 'sent'],
  ])('g then %s goes to %s', (key, folder) => {
    const result = resolveShortcut(press(key), state({ chord: chordAt(NOW) }));
    expect(result.action).toEqual({ kind: 'go-folder', folder });
    expect(result.chord).toBeNull();
  });

  it('lets the chord win over the bare meaning of the same key', () => {
    // Bare `s` stars. `g s` goes to Starred. Both are Gmail's, and the
    // pending prefix is what tells them apart.
    expect(resolveShortcut(press('s'), state({ chord: null })).action).toEqual({
      kind: 'toggle-star',
    });
    expect(resolveShortcut(press('s'), state({ chord: chordAt(NOW) })).action).toEqual({
      kind: 'go-folder',
      folder: 'starred',
    });
  });

  it('re-arms rather than stalling when g is pressed twice', () => {
    const result = resolveShortcut(press('g'), state({ chord: chordAt(1_000), nowMs: 1_200 }));
    expect(result.chord).toEqual({ key: 'g', startedAtMs: 1_200 });
  });
});

describe('the chord timeout', () => {
  it('completes at the very edge of the window', () => {
    const result = resolveShortcut(
      press('i'),
      state({ chord: chordAt(0), nowMs: CHORD_TIMEOUT_MS }),
    );
    expect(result.action).toEqual({ kind: 'go-folder', folder: 'inbox' });
  });

  it('has expired one millisecond later', () => {
    // Past the window, `i` is just a letter with no meaning of its own —
    // and specifically NOT a folder change the user did not ask for.
    const result = resolveShortcut(
      press('i'),
      state({ chord: chordAt(0), nowMs: CHORD_TIMEOUT_MS + 1 }),
    );
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.chord).toBeNull();
  });

  it('expires on read, so a timer that never fires cannot strand the app', () => {
    // The buffer is a value with a timestamp, not a machine waiting for
    // one. An hour later, `s` is a star again.
    const result = resolveShortcut(press('s'), state({ chord: chordAt(0), nowMs: 3_600_000 }));
    expect(result.action).toEqual({ kind: 'toggle-star' });
  });

  it('keeps the window closed for a chord started in the future', () => {
    // A clock that jumped backwards must not make the chord immortal;
    // it only ever makes it younger, which the window already handles.
    const result = resolveShortcut(press('i'), state({ chord: chordAt(NOW + 5_000), nowMs: NOW }));
    expect(result.action).toEqual({ kind: 'go-folder', folder: 'inbox' });
  });
});

describe('a stray g never swallows the next keystroke', () => {
  it('falls through to the ordinary meaning of an unrecognised second key', () => {
    // THE failure mode a chord must not have. `g` then `j` moves the
    // cursor; it does not silently discard the `j`.
    const result = resolveShortcut(press('j'), state({ chord: chordAt(NOW), selectedIndex: 3 }));
    expect(result.action).toEqual({ kind: 'select', index: 4 });
    expect(result.chord).toBeNull();
  });

  it.each([
    ['o', { kind: 'open', index: 3 }],
    ['?', { kind: 'open-help' }],
  ])('g then %s still does what that key means on its own', (key, expected) => {
    const result = resolveShortcut(press(key), state({ chord: chordAt(NOW) }));
    expect(result.action).toEqual(expected);
    expect(result.chord).toBeNull();
  });

  it('clears the chord even for a key that means nothing at all', () => {
    const result = resolveShortcut(press('q'), state({ chord: chordAt(NOW) }));
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.chord).toBeNull();
  });

  it('never reports a chord it was not handed and did not open', () => {
    // Every resolution returns the COMPLETE next buffer, so no caller can
    // leave a stale one behind by forgetting to clear it.
    for (const key of ['j', 'k', 'o', 'u', 's', 'Enter', 'Escape', '?', 'q']) {
      expect(resolveShortcut(press(key), state()).chord).toBeNull();
    }
  });
});

/* ── help ───────────────────────────────────────────────────────────── */

describe('the ? overlay', () => {
  it('opens on ?', () => {
    expect(resolveShortcut(press('?'), state()).action).toEqual({ kind: 'open-help' });
  });

  it('opens on a shifted ? — the key value already accounts for the layout', () => {
    expect(resolveShortcut(press('?', { shiftKey: true }), state()).action).toEqual({
      kind: 'open-help',
    });
  });

  it('closes on a second ?', () => {
    expect(resolveShortcut(press('?'), state({ isHelpOpen: true })).action).toEqual({
      kind: 'close-help',
    });
  });

  it('closes on Escape', () => {
    expect(resolveShortcut(press('Escape'), state({ isHelpOpen: true })).action).toEqual({
      kind: 'close-help',
    });
  });

  it('closes the overlay before the reader when both are showing', () => {
    expect(
      resolveShortcut(press('Escape'), state({ isHelpOpen: true, isReaderOpen: true })).action,
    ).toEqual({ kind: 'close-help' });
  });

  it.each(['j', 'k', 'o', 'u', 's', 'g'])('swallows nothing and does nothing on %s while up', (key) => {
    // The overlay covers the list: moving a cursor under it is
    // invisible, and starring from behind it is worse than invisible.
    const result = resolveShortcut(press(key), state({ isHelpOpen: true }));
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.preventDefault).toBe(false);
  });

  it('does not open while the composer has the keyboard', () => {
    expect(resolveShortcut(press('?'), state({ isComposerOpen: true })).action).toEqual({
      kind: 'none',
    });
  });

  it('does not open while the user is typing a question mark', () => {
    expect(resolveShortcut(press('?', { isTyping: true }), state()).action).toEqual({ kind: 'none' });
  });
});

describe('preventDefault tracks whether the app acted', () => {
  it('is true for every resolution that produced an action', () => {
    const acted = [
      resolveShortcut(press('j'), state()),
      resolveShortcut(press('o'), state()),
      resolveShortcut(press('s'), state()),
      resolveShortcut(press('u'), state({ isReaderOpen: true })),
      resolveShortcut(press('?'), state()),
      resolveShortcut(press('i'), state({ chord: chordAt(NOW) })),
    ];
    for (const result of acted) {
      expect(result.action.kind).not.toBe('none');
      expect(result.preventDefault).toBe(true);
    }
  });

  it('is false for every no-op except the chord prefix', () => {
    const ignored = [
      resolveShortcut(press('q'), state()),
      resolveShortcut(press('j', { isTyping: true }), state()),
      resolveShortcut(press('Escape'), state()),
      resolveShortcut(press('u'), state()),
      resolveShortcut(press('j', { metaKey: true }), state()),
    ];
    for (const result of ignored) {
      expect(result.preventDefault).toBe(false);
    }
  });
});

/**
 * `e` and `#` — Gmail's own archive and trash, and the reason this task
 * exists: until they worked the inbox only ever grew.
 *
 * `#` gets more coverage than any other single key here because it is
 * the ONE binding in this app that is not a bare letter, and every
 * assumption that holds for a letter has to be re-checked for it: it
 * arrives with Shift held on the most common layouts, and the resolver
 * refuses Shift for everything else.
 */
describe('getting mail out of the inbox', () => {
  it('archives on `e` from the list', () => {
    const result = resolveShortcut(press('e'), state({ isReaderOpen: false, selectedIndex: 2 }));
    expect(result.action).toEqual({ kind: 'mailbox-move', destination: 'archive' });
    expect(result.preventDefault).toBe(true);
  });

  it('archives on `e` from the reader', () => {
    const result = resolveShortcut(press('e'), state({ isReaderOpen: true, selectedIndex: -1 }));
    expect(result.action).toEqual({ kind: 'mailbox-move', destination: 'archive' });
  });

  it('trashes on `#`', () => {
    const result = resolveShortcut(press('#'), state({ isReaderOpen: false, selectedIndex: 2 }));
    expect(result.action).toEqual({ kind: 'mailbox-move', destination: 'trash' });
    expect(result.preventDefault).toBe(true);
  });

  it('trashes on `#` even though Shift is held — it is Shift-3 on a US layout', () => {
    // THE CASE THAT MAKES THIS BINDING DIFFERENT. The resolver refuses
    // every other key when Shift is down, so `#` has to be matched on the
    // produced CHARACTER before that guard. Without this it is dead on
    // every US, UK and Irish keyboard.
    const result = resolveShortcut(
      { ...press('#'), shiftKey: true },
      state({ isReaderOpen: false, selectedIndex: 2 }),
    );
    expect(result.action).toEqual({ kind: 'mailbox-move', destination: 'trash' });
  });

  it('does nothing on an empty list — a key that visibly does nothing is worse than none', () => {
    for (const key of ['e', '#']) {
      const result = resolveShortcut(
        press(key),
        state({ isReaderOpen: false, listLength: 0, selectedIndex: -1 }),
      );
      expect(result.action).toEqual({ kind: 'none' });
      expect(result.preventDefault).toBe(false);
    }
  });

  it('does nothing before the cursor exists', () => {
    for (const key of ['e', '#']) {
      const result = resolveShortcut(
        press(key),
        state({ isReaderOpen: false, listLength: 10, selectedIndex: -1 }),
      );
      expect(result.action).toEqual({ kind: 'none' });
    }
  });

  it('never fires from behind the help overlay', () => {
    // The overlay covers the list, so archiving from behind it is worse
    // than invisible: the row the user cannot see is the one that goes.
    for (const key of ['e', '#']) {
      const result = resolveShortcut(press(key), state({ isHelpOpen: true }));
      expect(result.action.kind).not.toBe('mailbox-move');
    }
  });

  it('never fires while the composer is open', () => {
    for (const key of ['e', '#']) {
      const result = resolveShortcut(press(key), state({ isComposerOpen: true }));
      expect(result.action).toEqual({ kind: 'none' });
    }
  });

  it('never fires while the user is typing — `e` is a letter in every draft', () => {
    for (const key of ['e', '#']) {
      const result = resolveShortcut({ ...press(key), isTyping: true }, state({}));
      expect(result.action).toEqual({ kind: 'none' });
    }
  });

  it('leaves the modified forms to the platform', () => {
    // ⌘E and ⌃E belong to the browser and to readline; answering to them
    // would break shortcuts this app never knew about.
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      for (const key of ['e', '#']) {
        const result = resolveShortcut({ ...press(key), [modifier]: true }, state({}));
        expect(result.action).toEqual({ kind: 'none' });
        expect(result.preventDefault).toBe(false);
      }
    }
  });

  it('cancels a pending `g` rather than being swallowed by it', () => {
    // `g` then `e` is not a chord this app has. The prefix is dropped and
    // the key resolves as though pressed on its own, which is the rule
    // every other unrecognised continuation already follows.
    const result = resolveShortcut(
      press('e'),
      state({ isReaderOpen: false, selectedIndex: 2, chord: { key: 'g', startedAtMs: 1_000 } }),
    );
    expect(result.action).toEqual({ kind: 'mailbox-move', destination: 'archive' });
    expect(result.chord).toBeNull();
  });
});

describe('x ticks the row under the cursor', () => {
  it('resolves to toggle-selection from the list', () => {
    const result = resolveShortcut(press('x'), state({ isReaderOpen: false, selectedIndex: 2 }));
    expect(result.action).toEqual({ kind: 'toggle-selection' });
    expect(result.preventDefault).toBe(true);
  });

  it('carries no index — the cursor already names the row', () => {
    // THE SELECTION IS NOT THE CURSOR. An action that carried an index
    // would invite a caller to keep the two in step, which is the one
    // thing they must never be: `j`/`k` move the cursor and must leave
    // every tick exactly where it was.
    const result = resolveShortcut(press('x'), state({ isReaderOpen: false, selectedIndex: 7 }));
    expect(Object.keys(result.action)).toEqual(['kind']);
  });

  it('is refused from inside the reader', () => {
    // The list is `hidden` behind the reader, so a tick made there would
    // change a checkbox and a count that are both off screen — worse than
    // a key that does nothing, because something DID happen.
    const result = resolveShortcut(press('x'), state({ isReaderOpen: true, selectedIndex: 2 }));
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.preventDefault).toBe(false);
  });

  it('does nothing before the cursor exists', () => {
    const result = resolveShortcut(
      press('x'),
      state({ isReaderOpen: false, listLength: 10, selectedIndex: -1 }),
    );
    expect(result.action).toEqual({ kind: 'none' });
    expect(result.preventDefault).toBe(false);
  });

  it('does nothing on an empty list', () => {
    const result = resolveShortcut(
      press('x'),
      state({ isReaderOpen: false, listLength: 0, selectedIndex: 0 }),
    );
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('never fires from behind the help overlay', () => {
    const result = resolveShortcut(press('x'), state({ isHelpOpen: true }));
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('never fires while the composer is open', () => {
    const result = resolveShortcut(press('x'), state({ isComposerOpen: true }));
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('never fires while the user is typing', () => {
    // `x` is a very common letter. A search for "linux" must not tick
    // five rows on the way through.
    const result = resolveShortcut(press('x', { isTyping: true }), state());
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('leaves ⌘X and Ctrl-X to the platform', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      const result = resolveShortcut(press('x', { [modifier]: true }), state());
      expect(result.action).toEqual({ kind: 'none' });
      expect(result.preventDefault).toBe(false);
    }
  });

  it('leaves Shift-X alone, like every other letter here', () => {
    const result = resolveShortcut(press('x', { shiftKey: true }), state());
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('cancels a stray g and still ticks — the chord falls through', () => {
    const result = resolveShortcut(
      press('x'),
      state({ chord: chordAt(NOW - 100), isReaderOpen: false, selectedIndex: 2 }),
    );
    expect(result.action).toEqual({ kind: 'toggle-selection' });
    expect(result.chord).toBeNull();
  });
});

describe('moving the cursor never disturbs the selection', () => {
  it('j and k emit a cursor move and nothing about selection', () => {
    // The guarantee stated as a test rather than only as a comment: the
    // resolver has no way to express "and also change the ticks", so
    // there is no arrangement of j/k that can.
    for (const key of ['j', 'k', 'ArrowDown', 'ArrowUp']) {
      const result = resolveShortcut(press(key), state({ selectedIndex: 3 }));
      expect(result.action.kind).toBe('select');
    }
  });
});
