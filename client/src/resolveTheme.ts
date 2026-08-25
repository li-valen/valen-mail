/**
 * The pure decision at the centre of the theme system: given what is
 * stored in `localStorage` and what the OS currently reports, which of
 * Plunk's two ported palettes (`.dark` stamped or not) should render.
 *
 * Deliberately the only piece of theme logic that is a plain function of
 * its inputs — everything that touches `document`, `localStorage` or
 * `matchMedia` lives in ./themeController.ts instead, for the same reason
 * client/CLAUDE.md's standing constraint pulled PushToggle's logic out
 * into pushSupport.ts: a function of its arguments is testable without a
 * browser; a function of the global environment is not.
 */

/** What the person picked, as persisted. `'system'` (the default) means
 *  "follow the OS", not a fourth palette. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** What actually renders: exactly one of the two palettes src/styles.css
 *  defines (bare `:root`, or `.dark`). */
export type ResolvedTheme = 'light' | 'dark';

/** Every button ThemeToggle.tsx renders, in display order. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

function isExplicitPreference(value: string | null | undefined): value is 'light' | 'dark' {
  return value === 'light' || value === 'dark';
}

/**
 * `stored` is whatever localStorage happened to hold: `null` (never set),
 * `'system'`, a valid `'light'`/`'dark'`, or a malformed string (a future
 * version's value, a hand-edited devtools mistake, anything else). Every
 * one of those — `null`, `'system'`, and malformed alike — falls through
 * to `systemPrefersDark`. That is deliberate: "we don't recognise this"
 * and "follow the OS" are the same fail-closed behaviour here, not two
 * branches that could drift apart.
 *
 * An explicit `'light'` or `'dark'` always wins over the OS, which is the
 * entire point of offering three states instead of a single OS-following
 * switch.
 */
export function resolveTheme(stored: string | null | undefined, systemPrefersDark: boolean): ResolvedTheme {
  if (isExplicitPreference(stored)) return stored;
  return systemPrefersDark ? 'dark' : 'light';
}
