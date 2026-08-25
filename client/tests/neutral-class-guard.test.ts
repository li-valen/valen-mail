import { describe, expect, it } from 'vitest';

/**
 * Guard on task V2's dark-mode audit: every hardcoded neutral/white
 * Tailwind class left in client/src/**\/*.tsx must carry a `dark:`
 * pairing for the SAME variant chain and utility family (`bg`/`text`/
 * `border`) — a component like ui/Card.tsx routing `bg-white` through the
 * semantic `bg-card` token entirely, rather than keeping a `dark:`
 * sibling, has nothing left for this file to flag, which is exactly
 * right (see src/styles.css's header and the task report for which
 * classes took which path and why).
 *
 * "Fails if any remain outside an allowlist" (the task brief's own
 * words): ALLOWLIST below is the escape hatch for a class that
 * legitimately has no dark-mode pairing — today it is empty, because
 * every neutral/white class the audit found got one. A class added later
 * without a `dark:` sibling anywhere in its file, and not named here with
 * a reason, fails this test. That is what stops the audit silently
 * regressing: a future PR pasting in a fresh `text-neutral-500` with no
 * thought for dark mode is caught here, while every already-audited
 * `text-neutral-900 dark:text-foreground` pairing this task wrote passes.
 *
 * SCOPE, deliberately narrower than "every colour in the app": this
 * checks exactly the four families the task brief names — `bg-white`,
 * `bg-neutral-*`, `text-neutral-*`, `border-neutral-*` — not `text-white`,
 * `border-white`, `bg-black`, or any red/amber/green literal (Alert.tsx's
 * and Badge.tsx's destructive/warning/success variants). Those are
 * either outside the brief's stated scope or are documented in-line at
 * their call sites as a deliberate, out-of-scope choice (see
 * ui/Alert.tsx's and ui/Button.tsx's own comments on their `destructive`
 * variants) rather than an oversight this guard should catch.
 *
 * PAIRING SCOPE is file-wide, not per-string: for a flagged token like
 * `hover:bg-neutral-100`, this looks for ANY token elsewhere in the SAME
 * FILE matching `dark:hover:bg-*` (same variant chain, same utility
 * family) — not necessarily inside the identical quoted string. That is
 * a deliberate simplification: isolating individual JSX/cva string
 * literals precisely would need a small parser (theme-tokens.test.ts
 * already carries one, for CSS rule bodies, because that file genuinely
 * needs brace-depth tracking), and every pairing this task actually wrote
 * lives in the same string anyway. Documented here so a future reader
 * knows the scope rather than assuming file-wide is an oversight.
 */

const sources = import.meta.glob('../src/**/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Strips `/* … *\/` and `// …` comments before scanning, so a doc
 *  comment that MENTIONS a class name in prose (this file's own header
 *  above does exactly that) is never mistaken for a live `className`. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Matches `bg-white`, `bg-neutral-123`, `text-neutral-123` or
 * `border-neutral-123`, optionally preceded by a chain of variant
 * segments — `hover:`, `dark:hover:`, `data-[state=checked]:`,
 * `[&>svg]:`, any mix — captured separately as `prefix` so a match can be
 * checked against its required `dark:`-scoped pairing.
 */
const NEUTRAL_TOKEN =
  /(?<prefix>(?:(?:[a-zA-Z][\w-]*(?:\[[^\]]*\])?|\[[^\]]*\]):)*)(?<utility>bg|text|border)-(?:white|neutral-\d+)\b/g;

interface Offense {
  readonly file: string;
  readonly token: string;
}

/** `{ file, reason }` pairs allowed to keep a neutral/white class with no
 *  `dark:` pairing anywhere in the file. `file` matches by path suffix
 *  (import.meta.glob keys are relative paths from this test file). Empty
 *  today — see the file header for what that means. */
const ALLOWLIST: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [];

function isAllowlisted(file: string): boolean {
  return ALLOWLIST.some((entry) => file.endsWith(entry.file));
}

/** True if `source` contains a token starting with `dark:`, followed by
 *  the same variant chain and utility family as the flagged token — i.e.
 *  its required dark-mode pairing exists somewhere in the file. */
function hasDarkPairing(source: string, prefix: string, utility: string): boolean {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pairing = new RegExp(`\\bdark:${escapedPrefix}${utility}-`);
  return pairing.test(source);
}

function findOffenses(file: string, rawSource: string): readonly Offense[] {
  const source = stripComments(rawSource);
  const offenses: Offense[] = [];
  for (const match of source.matchAll(NEUTRAL_TOKEN)) {
    const prefix = match.groups?.prefix ?? '';
    const utility = match.groups?.utility ?? '';
    // Already dark-scoped (`dark:text-neutral-500`, however unusual) is a
    // narrower, different concern than an unconditional or
    // light-variant-only literal, which is what this guard exists to
    // catch — task V2's read-state marks are the one place a hand-picked
    // `dark:` colour is correct by design (ReadState.tsx), and none of
    // them are neutral-scale classes in the first place.
    if (prefix.startsWith('dark:')) continue;
    if (hasDarkPairing(source, prefix, utility)) continue;
    offenses.push({ file, token: match[0] });
  }
  return offenses;
}

describe('every hardcoded neutral/white class in client/src/**/*.tsx has a dark: pairing (or is allowlisted)', () => {
  it('finds source files to scan (the glob is not empty)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it('leaves no bg-white / bg-neutral-* / text-neutral-* / border-neutral-* class unpaired and unexplained', () => {
    const offenses = Object.entries(sources)
      .filter(([file]) => !isAllowlisted(file))
      .flatMap(([file, source]) => findOffenses(file, source));
    expect(offenses).toEqual([]);
  });

  it('the token regex fires on all four families and ignores semantic tokens (not vacuous)', () => {
    expect('bg-white'.match(NEUTRAL_TOKEN)?.[0]).toBe('bg-white');
    expect('bg-neutral-100'.match(NEUTRAL_TOKEN)?.[0]).toBe('bg-neutral-100');
    expect('text-neutral-900'.match(NEUTRAL_TOKEN)?.[0]).toBe('text-neutral-900');
    expect('border-neutral-200'.match(NEUTRAL_TOKEN)?.[0]).toBe('border-neutral-200');
    expect('bg-primary'.match(NEUTRAL_TOKEN)).toBeNull();
    expect('text-foreground'.match(NEUTRAL_TOKEN)).toBeNull();
  });

  it('flags a bare neutral class with no dark: pairing anywhere in the file (proves the checker can fail)', () => {
    const buggy = 'className="rounded-md bg-neutral-100 text-neutral-900 p-2"';
    const offenses = findOffenses('fixture/Buggy.tsx', buggy);
    expect(offenses.map((offense) => offense.token)).toEqual(['bg-neutral-100', 'text-neutral-900']);
  });

  it('clears a neutral class once its dark: pairing exists in the same file', () => {
    const fixed =
      'className="rounded-md bg-neutral-100 dark:bg-accent text-neutral-900 dark:text-accent-foreground p-2"';
    expect(findOffenses('fixture/Fixed.tsx', fixed)).toEqual([]);
  });

  it('requires the SAME variant chain, not just the same family — an unrelated dark: sibling does not clear it', () => {
    // `hover:bg-neutral-100`'s pairing is `dark:hover:bg-*` specifically.
    // A plain `dark:bg-accent` elsewhere in the file is a DIFFERENT
    // declaration (no hover:) and must not be accepted as this one's
    // pairing — proves the checker is not so loose it stops meaning
    // anything.
    const stillBuggy = 'className="hover:bg-neutral-100 dark:bg-accent"';
    expect(findOffenses('fixture/StillBuggy.tsx', stillBuggy)).toEqual([
      { file: 'fixture/StillBuggy.tsx', token: 'hover:bg-neutral-100' },
    ]);
  });

  it('accepts compound variant chains — data-attribute selectors and arbitrary child selectors', () => {
    const fixed =
      'data-[state=checked]:bg-neutral-900 dark:data-[state=checked]:bg-primary [&>svg]:text-neutral-950 dark:[&>svg]:text-foreground';
    expect(findOffenses('fixture/Compound.tsx', fixed)).toEqual([]);
  });

  it('ignores a class name mentioned only in a comment, never rendered', () => {
    const commentOnly = '// ported from Plunk: bg-neutral-100 text-neutral-900\nconst x = 1;';
    expect(findOffenses('fixture/CommentOnly.tsx', commentOnly)).toEqual([]);
  });
});
