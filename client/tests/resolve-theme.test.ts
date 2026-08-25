import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../src/resolveTheme';

/**
 * Table test for the one pure function the whole theme system is built
 * on. Every OTHER piece of theme logic — the `.dark` stamp, the storage
 * read/write, the `matchMedia` subscription (src/themeController.ts) and
 * the React state sync (src/useTheme.ts) — touches the DOM or a browser
 * API and is deliberately NOT exercised here; client/CLAUDE.md's standing
 * constraint is that no test in this suite renders a component or drives
 * a browser, so `resolveTheme` being a plain function of its two
 * arguments is what makes it the one part of this feature a test can
 * check directly.
 */
describe('resolveTheme', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly stored: string | null | undefined;
    readonly systemPrefersDark: boolean;
    readonly expected: 'light' | 'dark';
  }> = [
    { name: 'system + OS dark -> dark', stored: 'system', systemPrefersDark: true, expected: 'dark' },
    { name: 'system + OS light -> light', stored: 'system', systemPrefersDark: false, expected: 'light' },
    {
      name: 'explicit light overrides a dark OS',
      stored: 'light',
      systemPrefersDark: true,
      expected: 'light',
    },
    {
      name: 'explicit dark overrides a light OS',
      stored: 'dark',
      systemPrefersDark: false,
      expected: 'dark',
    },
    // Nothing ever stored (a first visit): same fail-closed behaviour as
    // an explicit 'system' — follow the OS.
    { name: 'null stored + OS dark -> dark', stored: null, systemPrefersDark: true, expected: 'dark' },
    { name: 'null stored + OS light -> light', stored: null, systemPrefersDark: false, expected: 'light' },
    {
      name: 'undefined stored + OS dark -> dark',
      stored: undefined,
      systemPrefersDark: true,
      expected: 'dark',
    },
    // A malformed value (a future version's preference string, a
    // hand-edited devtools mistake) fails closed to the OS exactly like
    // 'system' or nothing-stored, rather than throwing or defaulting to
    // one fixed theme regardless of the OS.
    {
      name: "malformed stored value ('sepia') + OS dark -> dark",
      stored: 'sepia',
      systemPrefersDark: true,
      expected: 'dark',
    },
    {
      name: "malformed stored value ('') + OS light -> light",
      stored: '',
      systemPrefersDark: false,
      expected: 'light',
    },
  ];

  it.each(cases)('$name', ({ stored, systemPrefersDark, expected }) => {
    expect(resolveTheme(stored, systemPrefersDark)).toBe(expected);
  });
});
