import { describe, expect, it } from 'vitest';
// Vite's `?raw` suffix (declared in vite/client.d.ts) imports the file's
// contents as a plain string, at both test-run and typecheck time — no
// node:fs/node:url needed, keeping this file within the project's fixed
// dependency list (client/CLAUDE.md; no @types/node).
import themeCss from '../src/theme.css?raw';

/**
 * Static guard on client/src/theme.css's three-block theme structure
 * (DESIGN.md §2.1). No test in this plan renders a component, so this is
 * the only automated check standing between a future edit and "a colour
 * defined only inside a media/data-theme block" — one theme's text
 * rendered on the other theme's ground in the unstamped default state.
 *
 * This file only parses CSS text; it asserts nothing about the DOM.
 */

interface CssRule {
  readonly selector: string;
  readonly body: string;
}

/** Splits `css` into its top-level `selector { body }` rules via brace
 *  depth-counting — sufficient for this file, which nests at most one
 *  level (`@media { :root:not(...) { ... } }`) and never puts a brace
 *  inside a string or comment. */
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

interface ThemeBlocks {
  /** Union of every custom property declared in a bare, unqualified
   *  `:root { … }` rule at the top level of the file. */
  readonly bareRoot: ReadonlySet<string>;
  /** Custom properties inside
   *  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`. */
  readonly mediaDark: ReadonlySet<string>;
  /** Custom properties inside `:root[data-theme="dark"] { … }`. */
  readonly dataThemeDark: ReadonlySet<string>;
}

/** Parses the three-block structure DESIGN.md §2.1 mandates out of a CSS
 *  source string. Exported implicitly via module scope so both the real
 *  file and the synthetic fixtures below run through the identical logic —
 *  the guard the real file needs is only as good as this function. */
function parseThemeBlocks(css: string): ThemeBlocks {
  const clean = stripComments(css);
  const topLevel = parseTopLevelRules(clean);

  const bareRoot = new Set<string>();
  let mediaDark = new Set<string>();
  let dataThemeDark = new Set<string>();

  for (const rule of topLevel) {
    const selector = normalizeSelector(rule.selector);

    if (selector === ':root') {
      for (const name of extractCustomProperties(rule.body)) bareRoot.add(name);
      continue;
    }

    if (selector === ':root[data-theme="dark"]') {
      dataThemeDark = new Set([...dataThemeDark, ...extractCustomProperties(rule.body)]);
      continue;
    }

    if (selector.startsWith('@media') && selector.includes('prefers-color-scheme') && selector.includes('dark')) {
      const nested = parseTopLevelRules(rule.body);
      for (const nestedRule of nested) {
        const nestedSelector = normalizeSelector(nestedRule.selector);
        if (nestedSelector === ':root:not([data-theme="light"])') {
          mediaDark = new Set([...mediaDark, ...extractCustomProperties(nestedRule.body)]);
        }
      }
    }
  }

  return { bareRoot, mediaDark, dataThemeDark };
}

function findMissingFromBareRoot(bareRoot: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
  return [...other].filter((name) => !bareRoot.has(name));
}

describe('theme.css token structure (client/DESIGN.md §2.1)', () => {
  const source = themeCss;
  const blocks = parseThemeBlocks(source);

  // Sanity: if these are empty, the parser silently failed to find the
  // blocks it's supposed to check, which would make every assertion below
  // vacuously true. A parser regression must fail loudly, not pass quietly.
  it('finds a non-empty bare :root block', () => {
    expect(blocks.bareRoot.size).toBeGreaterThan(0);
  });
  it('finds a non-empty @media (prefers-color-scheme: dark) block', () => {
    expect(blocks.mediaDark.size).toBeGreaterThan(0);
  });
  it('finds a non-empty :root[data-theme="dark"] block', () => {
    expect(blocks.dataThemeDark.size).toBeGreaterThan(0);
  });

  it('defines every dark-media token in bare :root first', () => {
    const missing = findMissingFromBareRoot(blocks.bareRoot, blocks.mediaDark);
    expect(missing).toEqual([]);
  });

  it('defines every [data-theme="dark"] token in bare :root first', () => {
    const missing = findMissingFromBareRoot(blocks.bareRoot, blocks.dataThemeDark);
    expect(missing).toEqual([]);
  });

  it('redefines the identical token set in both dark blocks (DESIGN.md §2.3: block 3 duplicates block 2)', () => {
    expect([...blocks.dataThemeDark].sort()).toEqual([...blocks.mediaDark].sort());
  });

  it('sets an explicit, non-transparent body background token', () => {
    expect(source).toMatch(/body\s*\{[^}]*background:\s*var\(--bg-page\)/);
  });
});

describe('parseThemeBlocks (the checker itself, against synthetic fixtures)', () => {
  // Proves the guard above is not vacuous: it must FAIL a file that has the
  // exact bug it exists to catch (DESIGN.md §2.1's "THE BUG THIS PREVENTS")
  // — a token whose only definition sits inside the media block.
  it('flags a token that is only ever defined inside the dark-media block', () => {
    const buggyCss = `
      :root {
        --fg-primary: black;
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) {
          --fg-primary: white;
          --leaked-only-in-dark: red;
        }
      }
      :root[data-theme="dark"] {
        --fg-primary: white;
        --leaked-only-in-dark: red;
      }
    `;
    const blocks = parseThemeBlocks(buggyCss);
    const missing = findMissingFromBareRoot(blocks.bareRoot, blocks.mediaDark);
    expect(missing).toEqual(['--leaked-only-in-dark']);
  });

  it('flags the same bug in the [data-theme="dark"] block', () => {
    const buggyCss = `
      :root {
        --fg-primary: black;
      }
      :root[data-theme="dark"] {
        --fg-primary: white;
        --leaked-only-in-dark-attr: red;
      }
    `;
    const blocks = parseThemeBlocks(buggyCss);
    const missing = findMissingFromBareRoot(blocks.bareRoot, blocks.dataThemeDark);
    expect(missing).toEqual(['--leaked-only-in-dark-attr']);
  });

  it('passes a correctly structured fixture with no bug', () => {
    const goodCss = `
      :root {
        --fg-primary: black;
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) {
          --fg-primary: white;
        }
      }
      :root[data-theme="dark"] {
        --fg-primary: white;
      }
    `;
    const blocks = parseThemeBlocks(goodCss);
    expect(findMissingFromBareRoot(blocks.bareRoot, blocks.mediaDark)).toEqual([]);
    expect(findMissingFromBareRoot(blocks.bareRoot, blocks.dataThemeDark)).toEqual([]);
  });
});
