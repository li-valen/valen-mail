import { describe, expect, it } from 'vitest';
import { SHORTCUT_HELP } from '../src/keyboard/shortcutTable';
import { resolveShortcut } from '../src/keyboard/shortcuts';
import type { ShortcutEvent, ShortcutState } from '../src/keyboard/shortcuts';

/**
 * The help screen and the keyboard, checked against each other in BOTH
 * directions.
 *
 * A help overlay is the one piece of UI whose whole value is that it is
 * true. A line advertising a shortcut that does nothing costs the user a
 * keystroke and then their trust in every other line; a shortcut missing
 * from the list is a feature nobody finds. Neither drift is visible in a
 * screenshot, and neither is caught by any test of ../src/keyboard/
 * shortcuts.ts on its own — so it is caught here.
 */

/** The display strings the table uses, mapped to the `event.key` values a
 *  browser actually reports. This map is the readable half of the test:
 *  everything else is derived. */
const DISPLAY_TO_EVENT_KEY: Readonly<Record<string, string>> = {
  j: 'j',
  k: 'k',
  '↓': 'ArrowDown',
  '↑': 'ArrowUp',
  Enter: 'Enter',
  o: 'o',
  u: 'u',
  Esc: 'Escape',
  s: 's',
  g: 'g',
  i: 'i',
  t: 't',
  '?': '?',
};

/** Advertised in the table but bound elsewhere — ../src/searchQuery.ts's
 *  `isSearchHotkey`, wired in components/SearchBar.tsx. Listed because
 *  the user does not care which module owns a shortcut, and excluded from
 *  the probe because `resolveShortcut` deliberately refuses every
 *  modified chord. */
const BOUND_ELSEWHERE = new Set(['⌘K', 'Ctrl K']);

function press(key: string): ShortcutEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isTyping: false,
    isActivationTarget: false,
  };
}

/** A state in which every shortcut in the table has something to act on:
 *  a list with a cursor, and the reader open so `u` is live. */
function liveState(overrides: Partial<ShortcutState> = {}): ShortcutState {
  return {
    isComposerOpen: false,
    isHelpOpen: false,
    isReaderOpen: true,
    listLength: 10,
    selectedIndex: 3,
    chord: null,
    nowMs: 1_000,
    ...overrides,
  };
}

/**
 * True when the resolver does SOMETHING for this key in ANY state the app
 * can be in — an action, or a chord it deliberately consumes without
 * acting yet.
 *
 * Every state has to be probed because several shortcuts are live in
 * exactly one of them and inert in the other: `u` and Escape need the
 * reader open, `Enter`/`o` need it closed, and `i`/`s`/`t` mean a folder
 * only with a prefix pending. A probe that checked one state would report
 * half the table as unbound.
 */
const PROBE_STATES: readonly ShortcutState[] = [
  liveState({ isReaderOpen: false }),
  liveState({ isReaderOpen: true }),
  liveState({ isReaderOpen: false, chord: { key: 'g', startedAtMs: 1_000 } }),
];

function isBound(key: string): boolean {
  return PROBE_STATES.some((state) => {
    const result = resolveShortcut(press(key), state);
    return result.action.kind !== 'none' || result.preventDefault;
  });
}

const ADVERTISED_DISPLAY_KEYS = SHORTCUT_HELP.flatMap((group) =>
  group.entries.flatMap((entry) => entry.keys),
);

describe('the help table describes shortcuts that exist', () => {
  it('maps every advertised key to a real event key', () => {
    for (const display of ADVERTISED_DISPLAY_KEYS) {
      if (BOUND_ELSEWHERE.has(display)) continue;
      expect(DISPLAY_TO_EVENT_KEY[display], `no event key mapped for "${display}"`).toBeDefined();
    }
  });

  it('binds every key it advertises', () => {
    const unbound = ADVERTISED_DISPLAY_KEYS.filter((display) => {
      if (BOUND_ELSEWHERE.has(display)) return false;
      const key = DISPLAY_TO_EVENT_KEY[display];
      return key === undefined || !isBound(key);
    });
    expect(unbound).toEqual([]);
  });
});

describe('the help table advertises every shortcut that exists', () => {
  /** Everything a user could plausibly press, so a shortcut added to
   *  ../src/keyboard/shortcuts.ts without a table entry is caught rather
   *  than merely undocumented. */
  const ALPHABET = [
    ...'abcdefghijklmnopqrstuvwxyz',
    '?',
    '/',
    'Enter',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Tab',
    ' ',
  ];

  it('leaves no bound key undocumented', () => {
    const documented = new Set(
      ADVERTISED_DISPLAY_KEYS.filter((display) => !BOUND_ELSEWHERE.has(display)).map(
        (display) => DISPLAY_TO_EVENT_KEY[display],
      ),
    );
    const undocumented = ALPHABET.filter((key) => isBound(key) && !documented.has(key));
    expect(undocumented).toEqual([]);
  });

  it('binds only what it documents — the probe is not vacuous', () => {
    // Proves the sweep above would actually catch something: these keys
    // are unbound today, and if one ever becomes bound without a table
    // entry the test above fails rather than silently passing.
    expect(ALPHABET.filter((key) => isBound(key)).sort()).toEqual(
      ['?', 'ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'g', 'i', 'j', 'k', 'o', 's', 't', 'u'].sort(),
    );
  });
});

describe('the table renders unambiguously', () => {
  it('marks the g-chords as sequences and nothing else', () => {
    const sequences = SHORTCUT_HELP.flatMap((group) => group.entries)
      .filter((entry) => entry.isSequence === true)
      .map((entry) => entry.keys.join(''));
    // `Enter or o` and `g then i` both have two keys. Only `isSequence`
    // tells them apart, and getting it backwards teaches a shortcut that
    // does not exist.
    expect(sequences.sort()).toEqual(['gi', 'gs', 'gt']);
  });

  it('gives every entry at least one key and a description', () => {
    for (const group of SHORTCUT_HELP) {
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        expect(entry.keys.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('never lists the same description twice — it is the React key', () => {
    const descriptions = SHORTCUT_HELP.flatMap((group) =>
      group.entries.map((entry) => entry.description),
    );
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});
