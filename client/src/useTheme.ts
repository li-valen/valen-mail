import { useCallback, useEffect, useState } from 'react';
import { getSnapshot, setPreference as applyPreference, subscribeToChanges } from './themeController';
import type { ThemeSnapshot } from './themeController';
import type { ResolvedTheme, ThemePreference } from './resolveTheme';

export interface UseThemeResult {
  /** The stored choice: `'system'`, `'light'` or `'dark'`. Drives which of
   *  ThemeToggle's three buttons reads as pressed. */
  readonly preference: ThemePreference;
  /** What is actually rendering right now. Equals `preference` for an
   *  explicit choice; follows the OS while `preference` is `'system'`. */
  readonly resolved: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

/**
 * The one hook every theme-aware component (today: ThemeToggle.tsx, MOUNTED
 * TWICE — see themeController.ts's `listeners` doc comment for why) reads
 * from. Owns exactly one thing on the React side: re-rendering when the
 * resolved theme changes, whether that change came from THIS instance
 * (`setPreference`), a DIFFERENT mounted instance (the broadcast
 * `subscribeToChanges` also carries), or the OS (the same subscription's
 * `matchMedia` listener). The actual class-stamping, meta-tag update and
 * `localStorage` access all live in ./themeController.ts — this hook only
 * calls into it and never touches `document` or `localStorage` directly,
 * so it stays the one place a test can exercise without a DOM (see
 * client/CLAUDE.md's standing constraint: no test in this suite renders a
 * component).
 */
export function useTheme(): UseThemeResult {
  const [snapshot, setSnapshot] = useState<ThemeSnapshot>(() => getSnapshot());

  useEffect(() => {
    // Re-syncs for whatever happened between the lazy initializer above
    // (which ran once, at construction) and this effect subscribing —
    // an OS change or a write from another code path in that gap would
    // otherwise be missed until the next broadcast or OS change fired.
    setSnapshot(getSnapshot());
    return subscribeToChanges(setSnapshot);
  }, []);

  const setPreference = useCallback((preference: ThemePreference) => {
    setSnapshot(applyPreference(preference));
  }, []);

  return { preference: snapshot.preference, resolved: snapshot.resolved, setPreference };
}
