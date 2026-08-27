import { describe, expect, it } from 'vitest';
import buttonSource from '../src/ui/Button.tsx?raw';
import alertSource from '../src/ui/Alert.tsx?raw';
// Vite's `?raw` suffix (declared in vite/client.d.ts) imports the file's
// contents as a plain string, at both test-run and typecheck time — no
// node:fs/node:url needed, keeping this file within the project's fixed
// dependency list (no @types/node).
import stylesCss from '../src/styles.css?raw';
import mainSource from '../src/main.tsx?raw';
import { DEFAULT_DARK_GROUND } from '../src/components/messageBody';

/**
 * Static guard on the theme architecture.
 *
 * REWRITTEN FOR THE PLUNK RESTYLE (task 7.6). The previous version of this
 * file guarded the hand-rolled three-block token system in src/theme.css:
 * bare `:root`, plus `@media (prefers-color-scheme: dark)
 * { :root:not([data-theme="light"]) }`, plus `:root[data-theme="dark"]`,
 * with the rule that the two dark blocks may only ever REDEFINE tokens the
 * bare `:root` already declared. That file no longer exists; src/styles.css
 * is a Tailwind v4 entry stylesheet carrying Plunk's shadcn-style HSL
 * palette (`--background`, `--muted`, `--border`, `--radius`, …) in a bare
 * `:root` light block and a `.dark` block.
 *
 * The BUG being guarded against is unchanged, because it is a property of
 * any two-palette stylesheet: a custom property whose only definition sits
 * inside the dark block resolves to nothing in the light (default) state,
 * which renders one theme's text on the other theme's ground. So the checks
 * below still assert (a) the light palette is complete in bare `:root`, and
 * (b) `.dark` redefines exactly that set and never introduces a token of
 * its own.
 *
 * REWRITTEN AGAIN FOR TASK V2 (dark mode goes live). Two of the facts this
 * file pins flipped along with the feature:
 *
 *   - `:root` now declares `color-scheme: light dark`, not a bare
 *     `light` — the app DOES stamp `.dark` now, and this is what lets
 *     native form controls, the scrollbar and the canvas follow whichever
 *     palette is actually applied.
 *   - "no source file ever applies the `.dark` class" is no longer true,
 *     and was never really the property worth protecting — the actual
 *     bug it stood in for is a SECOND, independent place deciding whether
 *     to stamp the class, which would silently fight the real one. So
 *     that check is now "src/themeController.ts is the ONLY file that
 *     ever stamps `.dark`" — still scanning every other source file for
 *     the same class-list mutation, still failing if one is found, just
 *     with a legitimate single exception instead of zero.
 *
 * Finally it verifies the entry stylesheet is actually reachable from the
 * app: a perfect palette in a file nobody imports styles nothing.
 *
 * This file only parses CSS text; it asserts nothing about the DOM.
 */

interface CssRule {
  readonly selector: string;
  readonly body: string;
}

/** Splits `css` into its top-level `selector { body }` rules via brace
 *  depth-counting — sufficient for this file, which nests at most two
 *  levels (`@layer base { :root { … } }`) and never puts a brace inside a
 *  string or comment. */
function parseTopLevelRules(css: string): readonly CssRule[] {
  const rules: CssRule[] = [];
  let selectorStart = 0;
  let i = 0;
  while (i < css.length) {
    if (css[i] === '{') {
      const selector = css.slice(selectorStart, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') depth -= 1;
        j += 1;
      }
      rules.push({ selector, body: css.slice(i + 1, j - 1) });
      i = j;
      selectorStart = j;
    } else {
      i += 1;
    }
  }
  return rules;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').replace(/'/g, '"').trim();
}

/** Every `--custom-property:` declaration directly inside `body` (does not
 *  recurse into further-nested rules). */
function extractCustomProperties(body: string): ReadonlySet<string> {
  const names = new Set<string>();
  const re = /(?:^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    names.add(match[1]!);
  }
  return names;
}

/**
 * Custom-property prefixes that live in `:root` but are NOT part of the
 * palette, and so are exempt from the light/dark set-equality rule below.
 *
 * The rule exists for one failure: a COLOUR defined in only one of the
 * two blocks renders one theme's text on the other theme's ground. A
 * value that is not a colour cannot cause it. `--safe-*` (the
 * `env(safe-area-inset-*)` layer added by the interface audit) is the
 * first such value: four lengths describing where the display cutout and
 * the home indicator are, which are the same numbers in both themes and
 * would have to be kept manually in sync if duplicated into `.dark`.
 *
 * An allowlist of PREFIXES rather than of names, so the four sides do not
 * each need an entry; deliberately narrow, so a future `--brand-blue`
 * gets no free pass.
 */
const NON_PALETTE_PREFIXES = ['--safe-'] as const;

function isPaletteToken(name: string): boolean {
  return !NON_PALETTE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

interface PaletteBlocks {
  /** Union of every custom property declared in a bare, unqualified
   *  `:root { … }` rule, at the top level or inside an `@layer`. */
  readonly light: ReadonlySet<string>;
  /** Custom properties declared in a bare `.dark { … }` rule. Empty if the
   *  stylesheet has no dark block at all, which is a legal shape. */
  readonly dark: ReadonlySet<string>;
}

/**
 * Collects the light and dark palettes out of a CSS source string,
 * descending through `@layer`/`@media` wrappers so it does not care
 * whether the palette sits at the top level or inside `@layer base`.
 *
 * Deliberately ignores `@theme { … }` — that block holds Tailwind's own
 * mapping of theme keys onto `hsl(var(--token))`, not the palette values,
 * and it has no dark counterpart by design.
 */
function parsePaletteBlocks(css: string): PaletteBlocks {
  const light = new Set<string>();
  const dark = new Set<string>();

  function walk(source: string): void {
    for (const rule of parseTopLevelRules(source)) {
      const selector = normalizeSelector(rule.selector);
      if (selector === ':root') {
        for (const name of extractCustomProperties(rule.body)) {
          if (isPaletteToken(name)) light.add(name);
        }
        continue;
      }
      if (selector === '.dark') {
        for (const name of extractCustomProperties(rule.body)) {
          if (isPaletteToken(name)) dark.add(name);
        }
        continue;
      }
      if (selector.startsWith('@layer') || selector.startsWith('@media')) {
        walk(rule.body);
      }
    }
  }

  walk(stripComments(css));
  return { light, dark };
}

function findMissingFromLight(light: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
  return [...other].filter((name) => !light.has(name));
}

/** The palette tokens every ported atom reads through Tailwind's `@theme`
 *  mapping. If one of these disappears, `focus-visible:ring-ring`,
 *  `border-border` and friends silently resolve to nothing. */
const REQUIRED_TOKENS = [
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--border',
  '--input',
  '--ring',
  '--card',
  '--card-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--popover',
  '--popover-foreground',
  '--radius',
] as const;

describe('src/styles.css palette structure', () => {
  const source = stylesCss;
  const blocks = parsePaletteBlocks(source);

  // Sanity: if this is empty, the parser silently failed to find the block
  // it is supposed to check, which would make every assertion below
  // vacuously true. A parser regression must fail loudly, not pass quietly.
  it('finds a non-empty bare :root palette', () => {
    expect(blocks.light.size).toBeGreaterThan(0);
  });

  // Non-vacuity guard for the set-equality test below: if the parser stopped
  // finding the `.dark` block, that test would early-return and pass while
  // checking nothing. Valen Mail ships the ported dark palette (unapplied), so
  // it must be found. A future task that genuinely deletes the block updates
  // this line deliberately rather than losing the check by accident.
  it('finds the ported .dark palette block', () => {
    expect(blocks.dark.size).toBeGreaterThan(0);
  });

  it('declares every token the ported atoms depend on, in bare :root', () => {
    const missing = REQUIRED_TOKENS.filter((name) => !blocks.light.has(name));
    expect(missing).toEqual([]);
  });

  it('never lets the .dark block introduce a token bare :root has not defined', () => {
    const missing = findMissingFromLight(blocks.light, blocks.dark);
    expect(missing).toEqual([]);
  });

  it('redefines the identical token set in .dark, if a .dark block exists at all', () => {
    if (blocks.dark.size === 0) return;
    expect([...blocks.dark].sort()).toEqual([...blocks.light].sort());
  });

  it('declares color-scheme: light dark, so native controls follow whichever palette is applied', () => {
    expect(source).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light\s+dark\b/);
  });

  it('gives body an explicit, non-transparent background', () => {
    expect(source).toMatch(/body\s*\{[\s\S]*?@apply[^;]*\bbg-background\b/);
  });
});

describe('the entry stylesheet is reachable from the app', () => {
  it('is imported by src/main.tsx', () => {
    expect(mainSource).toMatch(/import\s+['"]\.\/styles\.css['"]/);
  });

  it('pulls in Tailwind', () => {
    expect(stylesCss).toMatch(/@import\s+['"]tailwindcss['"]/);
  });
});

describe('src/themeController.ts is the ONLY source file that stamps .dark', () => {
  // Plunk's atoms hardcode `bg-white` / `bg-neutral-900` / `bg-neutral-100`
  // rather than reading the semantic tokens (task V2's audit fixed every
  // ported atom; see src/styles.css's header for the summary), so a
  // SECOND place independently deciding whether `.dark` is stamped is
  // exactly how a stray "helpful" `classList.add('dark')` added to some
  // other component later would silently fight src/themeController.ts and
  // produce a half-rendered page. Scoping the check to "every file except
  // the controller" — rather than asserting the controller itself never
  // stamps, which would be vacuously wrong the moment it does its job —
  // is what makes this a regression guard instead of a snapshot.
  const CONTROLLER_PATH = '../src/themeController.ts';

  const sources = import.meta.glob('../src/**/*.{ts,tsx}', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>;

  // `(?!:)` after `\bdark\b` is the one change this rewrite makes to the
  // regex itself (task 7.6's original had no need for it — no file
  // legitimately said "dark" anywhere). Task V2 fills every ported
  // component with legitimate `dark:bg-accent`-style Tailwind variant
  // classes; without the lookahead, `\bdark\b` alone matches "dark"
  // inside `dark:` too (`:` is a non-word character, so it still counts
  // as a word boundary), which would flag nearly every file this task
  // touched as if it were stamping the class. The lookahead requires the
  // word "dark" NOT be immediately followed by `:` — true for a literal
  // stamped class (`className="dark bg-background"`), false for a
  // variant prefix (`className="dark:bg-accent"`).
  const DARK_CLASS_STAMP =
    /classList\.(add|toggle)\(\s*['"]dark['"]|className\s*=\s*['"][^'"]*\bdark\b(?!:)/;

  function stampOffenders(fileSources: Record<string, string>): string[] {
    return Object.entries(fileSources)
      .filter(([path]) => path !== CONTROLLER_PATH)
      .filter(([, text]) => DARK_CLASS_STAMP.test(text))
      .map(([path]) => path);
  }

  it('finds source files to scan (the glob is not empty)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it('finds src/themeController.ts itself (so excluding it from the scan below is not vacuous)', () => {
    expect(Object.keys(sources)).toContain(CONTROLLER_PATH);
  });

  it('src/themeController.ts really does stamp `.dark` — the one legitimate call site exists', () => {
    expect(sources[CONTROLLER_PATH]).toMatch(DARK_CLASS_STAMP);
  });

  it('no file OTHER than src/themeController.ts ever adds `dark` to a class list', () => {
    expect(stampOffenders(sources)).toEqual([]);
  });

  it('the stamp regex is not vacuous', () => {
    expect('document.documentElement.classList.add("dark");').toMatch(DARK_CLASS_STAMP);
    expect('<div className="dark bg-background">').toMatch(DARK_CLASS_STAMP);
    expect('<div className="rounded-lg border">').not.toMatch(DARK_CLASS_STAMP);
  });

  it('does not mistake a dark: Tailwind variant for a literal stamp', () => {
    // The precise bug the `(?!:)` lookahead above exists to avoid: every
    // component task V2 touched now legitimately contains `dark:`
    // variant classes, and a regex that could not tell those apart from
    // an actual `classList.add('dark')` / `className="dark ..."` would
    // fail this file's own real source (src/AppShell.tsx, ui/Button.tsx,
    // …) the moment the audit shipped.
    expect('<div className="rounded-lg border dark:bg-accent dark:text-accent-foreground">').not.toMatch(
      DARK_CLASS_STAMP,
    );
  });

  it('the exclusion is scoped to the controller specifically — a stray stamp elsewhere still fails', () => {
    // Proves the "no file OTHER than..." check above is a real guard and
    // not vacuously passing just because today's codebase happens to be
    // clean: a synthetic offender OUTSIDE the controller must still be
    // caught even alongside a legitimate stamp INSIDE it.
    const withARogueStamp: Record<string, string> = {
      [CONTROLLER_PATH]: sources[CONTROLLER_PATH] ?? 'document.documentElement.classList.add("dark");',
      '../src/components/RogueComponent.tsx': 'document.documentElement.classList.add("dark");',
    };
    expect(stampOffenders(withARogueStamp)).toEqual(['../src/components/RogueComponent.tsx']);
  });
});

describe('parsePaletteBlocks (the checker itself, against synthetic fixtures)', () => {
  // Proves the guard above is not vacuous: it must FAIL a file that has the
  // exact bug it exists to catch — a token whose only definition sits
  // inside the dark block.
  it('flags a token that is only ever defined inside .dark', () => {
    const buggyCss = `
      @layer base {
        :root {
          --foreground: 0 0% 0%;
        }
        .dark {
          --foreground: 0 0% 100%;
          --leaked-only-in-dark: 0 100% 50%;
        }
      }
    `;
    const blocks = parsePaletteBlocks(buggyCss);
    expect(findMissingFromLight(blocks.light, blocks.dark)).toEqual(['--leaked-only-in-dark']);
  });

  it('passes a correctly structured fixture with no bug', () => {
    const goodCss = `
      @layer base {
        :root {
          --foreground: 0 0% 0%;
        }
        .dark {
          --foreground: 0 0% 100%;
        }
      }
    `;
    const blocks = parsePaletteBlocks(goodCss);
    expect(findMissingFromLight(blocks.light, blocks.dark)).toEqual([]);
  });

  it('descends into @layer and @media wrappers rather than missing the palette', () => {
    const nested = `
      @media (min-width: 100px) {
        @layer base {
          :root { --nested-token: 1; }
        }
      }
    `;
    expect([...parsePaletteBlocks(nested).light]).toEqual(['--nested-token']);
  });
});

/**
 * The message reader's fallback ground must agree with the palette it is
 * standing in for.
 *
 * `DEFAULT_DARK_GROUND` (../src/components/messageBody.ts) is used only
 * when `--color-card` cannot be read or does not validate. That is a rare
 * path, which is exactly why it needs pinning: a palette change would
 * otherwise leave a stale colour in a branch nobody exercises, and the
 * seam would come back only for the users who hit it.
 */
describe('the message ground and the palette agree', () => {
  /** One token's VALUE out of the bare `.dark { … }` rule.
   *  `parsePaletteBlocks` above collects NAMES, which is what its own
   *  tests need; these two need the values. */
  function darkTokenValue(token: string): string | null {
    const block = /(?:^|[^-\w])\.dark\s*\{([\s\S]*?)\}/.exec(stylesCss);
    if (block === null) return null;
    const decl = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(block[1]!);
    return decl === null ? null : decl[1]!.trim();
  }

  /** `224 71% 4%` -> `#030711`, the same conversion the browser does. */
  function hslTripletToHex(triplet: string): string | null {
    const m = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(triplet.trim());
    if (m === null) return null;
    const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const seg = Math.floor(h / 60) % 6;
    const channels = [
      [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ][seg]!;
    const to = (v: number) => Math.round((v + l - c / 2) * 255).toString(16).padStart(2, '0');
    return `#${channels.map((v) => to(v!)).join('')}`;
  }

  it('the fallback equals the dark --card the reader paints against', () => {
    // `--card` and not `--background`: the frame sits INSIDE the card, so
    // the card is the colour a seam would be measured against. The two are
    // the same value in dark, which the next test states outright.
    const card = darkTokenValue('--card');
    expect(card).not.toBeNull();
    expect(hslTripletToHex(card!)).toBe(DEFAULT_DARK_GROUND);
  });

  it('--card and --background are the same in dark, so frame, card and app ground agree', () => {
    // This is what makes the seam impossible rather than merely fixed. If
    // these ever diverge, the message frame will match its card and the
    // card will not match the page, and the edge moves rather than goes.
    expect(darkTokenValue('--card')).toBe(darkTokenValue('--background'));
    expect(darkTokenValue('--card')).not.toBeNull();
  });

  it('the conversion itself is right, so the two tests above are not vacuous', () => {
    expect(hslTripletToHex('0 0% 100%')).toBe('#ffffff');
    expect(hslTripletToHex('0 0% 0%')).toBe('#000000');
    expect(hslTripletToHex('224 71% 4%')).toBe('#030711');
    expect(hslTripletToHex('not a triplet')).toBeNull();
  });
});


describe('surfaces a control can be placed ON, not just the page ground', () => {
  it('gives the outline button no ground of its own', () => {
    // `bg-card` is a PAGE-ground colour. An outline button carrying it can
    // never blend with a tinted surface, and inside a destructive Alert it
    // rendered as a solid white block in light mode and a near-black one in
    // dark. Measured after the fix: the button resolves to the alert's own
    // rgb(254,242,242) light / rgb(37,8,13) dark in both themes.
    expect(buttonSource).toMatch(/outline:\s*\n?\s*'border border-neutral-200 bg-transparent/);
    expect(buttonSource).not.toMatch(/outline:\s*\n?\s*'[^']*\bbg-card\b/);
  });

  it('gives every tinted alert a dark half', () => {
    // These three were explicitly deferred out of an earlier neutral audit
    // ("left exactly as shipped"), whose guard only looked at
    // bg-white/bg-neutral-*/text-neutral-*/border-neutral-*. What that left
    // behind was a pale panel glowing in a dark app with dark text on it.
    for (const tone of ['red', 'amber', 'green']) {
      expect(alertSource).toMatch(new RegExp(`dark:bg-${tone}-950`));
      expect(alertSource).toMatch(new RegExp(`dark:text-${tone}-100`));
      expect(alertSource).toMatch(new RegExp(`dark:border-${tone}-900`));
    }
  });
});
