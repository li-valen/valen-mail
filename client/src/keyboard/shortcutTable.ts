/**
 * What `?` shows, as DATA rather than as markup.
 *
 * The overlay is a rendering of this array and nothing else, which is the
 * only way the help and the behaviour can be checked against each other:
 * tests/keyboard-help.test.ts asserts that every key this table advertises
 * is a key ./shortcuts.ts actually answers to, and that nothing
 * ./shortcuts.ts answers to is missing from the table. A help screen that
 * documents a shortcut the app does not have is worse than no help
 * screen — it costs the user a keystroke AND their trust in the rest of
 * the list.
 */

export interface ShortcutHelpEntry {
  /** The keys, already in the order they are pressed. Rendered one `<kbd>`
   *  per entry, joined by `then` for a chord and by `or` otherwise —
   *  which of the two is decided by `isSequence`, not by counting. */
  readonly keys: readonly string[];
  readonly description: string;
  /** True for `g` `i`-style chords: the keys are pressed in SEQUENCE, not
   *  as alternatives. Two entries with two keys each mean opposite things
   *  without this. */
  readonly isSequence?: true;
}

export interface ShortcutHelpGroup {
  readonly title: string;
  readonly entries: readonly ShortcutHelpEntry[];
}

export const SHORTCUT_HELP: readonly ShortcutHelpGroup[] = [
  {
    title: 'Moving around',
    entries: [
      { keys: ['j', '↓'], description: 'Next message' },
      { keys: ['k', '↑'], description: 'Previous message' },
      { keys: ['Enter', 'o'], description: 'Open the selected message' },
      { keys: ['u'], description: 'Back to the list' },
      { keys: ['Esc'], description: 'Close the reader' },
    ],
  },
  {
    title: 'Acting on mail',
    entries: [{ keys: ['s'], description: 'Star or unstar' }],
  },
  {
    title: 'Going places',
    entries: [
      { keys: ['g', 'i'], description: 'Go to Inbox', isSequence: true },
      { keys: ['g', 's'], description: 'Go to Starred', isSequence: true },
      { keys: ['g', 't'], description: 'Go to Sent', isSequence: true },
      // Bound in components/SearchBar.tsx via ../searchQuery.ts, not here
      // — but the user does not care which module owns it, and a
      // shortcut list missing the app's most-used shortcut would be a
      // strange thing to hand someone.
      { keys: ['⌘K', 'Ctrl K'], description: 'Search' },
      { keys: ['?'], description: 'Show this list' },
    ],
  },
];
