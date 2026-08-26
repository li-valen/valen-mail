import { describe, it, expect } from 'vitest';
import stylesCss from '../src/styles.css?raw';
import indexHtml from '../index.html?raw';
import appShellSource from '../src/AppShell.tsx?raw';
import loginSource from '../src/LoginView.tsx?raw';

/**
 * THE THREE MOBILE DEFECTS THE INTERFACE AUDIT FOUND, guarded so they
 * cannot come back quietly.
 *
 * All three are invisible to this suite by construction: client/CLAUDE.md
 * forbids rendering a component in a test, so nothing here can measure a
 * layout, a tap latency or a scroll chain. What a static scan CAN do is
 * assert that the declarations responsible for each fix are still in the
 * files that need them - which is exactly the shape of the existing
 * neutral-class and theme-token guards, and for the same reason. The
 * BEHAVIOUR was verified in a browser at a notched viewport; see
 * .superpowers/sdd/2026-08-24-web-client/task-interface-audit-report.md.
 *
 * Deliberately NOT asserted here: the specific pixel values, or which
 * elements "should" be padded. Those are design decisions this file has
 * no business freezing. What it freezes is that the mechanism exists.
 */

/** Strips block and line comments, so a doc comment discussing a class
 *  name in prose is never mistaken for a live `className`. Same helper,
 *  same reason, as tests/neutral-class-guard.test.ts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('safe-area insets under viewport-fit=cover', () => {
  it('index.html still opts the app into drawing under the notch', () => {
    // If this ever goes away, the padding below becomes dead weight
    // rather than a fix - so the two facts are asserted together.
    expect(indexHtml).toMatch(/name="viewport"[^>]*viewport-fit=cover/);
  });

  it('styles.css defines all four insets from env(safe-area-inset-*)', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(stylesCss).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px)`);
    }
  });

  it('every inset falls back to a LENGTH, never a bare 0', () => {
    // These are substituted into `calc()` and into padding shorthands,
    // both of which reject a unitless zero coming out of a custom
    // property. `0px` is not a style preference here.
    expect(stylesCss).not.toMatch(/--safe-\w+:\s*env\(safe-area-inset-\w+\)\s*;/);
    expect(stylesCss).not.toMatch(/--safe-\w+:\s*env\(safe-area-inset-\w+,\s*0\)\s*;/);
  });

  it('the app shell pads all four edges of the surfaces that touch them', () => {
    const shell = stripComments(appShellSource);
    // The top bar and the drawer sit against the cutout; the scrolling
    // content column and the drawer sit against the home indicator.
    expect(shell).toContain('pt-[var(--safe-top)]');
    expect(shell).toContain('pb-[var(--safe-bottom)]');
    expect(shell).toContain('pl-[var(--safe-left)]');
    expect(shell).toContain('pr-[var(--safe-right)]');
  });

  it('the top bar grows by the inset instead of letting it eat the bar', () => {
    // `h-16` plus `pt-[...]` under `box-sizing: border-box` would leave a
    // 5px strip of search field under a 59px Dynamic Island. The calc is
    // the fix, and it is the part that is easy to lose in a refactor.
    expect(stripComments(appShellSource)).toContain('h-[calc(4rem+var(--safe-top))]');
  });

  it('the drawer widens by the left inset rather than narrowing its content', () => {
    expect(stripComments(appShellSource)).toContain('w-[calc(16rem+var(--safe-left))]');
  });

  it('the login view, which is also full-bleed, folds the insets into its padding', () => {
    const login = stripComments(loginSource);
    expect(login).toContain('var(--safe-top)');
    expect(login).toContain('var(--safe-bottom)');
  });
});

const componentSources = import.meta.glob('../src/**/*.tsx', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Every quoted or backticked string literal in a comment-stripped
 *  source. Class names in this codebase are always written as one
 *  literal per element (a `cn(...)` call takes several), which is what
 *  makes "the same literal" the right scope for the check below. */
function stringLiterals(source: string): readonly string[] {
  return stripComments(source).match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? [];
}

describe('touch-action: manipulation on every interactive control', () => {
  /**
   * `cursor-pointer` is this codebase's own marker for "a thing a person
   * clicks" - every hand-rolled control carries it, and `ui/Button.tsx`'s
   * cva base does too. Pairing the two means a new control cannot be
   * added with the ~300ms double-tap-zoom delay still on it without this
   * test noticing.
   *
   * NOT applied to `html`/`body` wholesale, on purpose: a document-wide
   * `touch-action` would also take double-tap zoom away from the message
   * body, which is the one surface where a reader may genuinely want it.
   */
  it('pairs every cursor-pointer class string with touch-manipulation', () => {
    const unpaired: string[] = [];
    for (const [path, source] of Object.entries(componentSources)) {
      for (const literal of stringLiterals(source)) {
        if (!literal.includes('cursor-pointer')) continue;
        if (literal.includes('touch-manipulation')) continue;
        unpaired.push(`${path}: ${literal.slice(0, 80)}`);
      }
    }
    expect(unpaired).toEqual([]);
  });

  it('covers the shared Button atom, which most controls route through', () => {
    const button = componentSources['../src/ui/Button.tsx'];
    expect(button).toBeDefined();
    expect(stripComments(button ?? '')).toContain('touch-manipulation');
  });
});

describe('overscroll-behavior on nested and overlay scrollers', () => {
  it('the sidebar nav (which is the mobile drawer body) contains its scroll', () => {
    expect(stripComments(appShellSource)).toContain('overflow-y-auto overscroll-contain');
  });

  it('the shortcut overlay contains its scroll', () => {
    const help = componentSources['../src/components/ShortcutHelp.tsx'];
    expect(stripComments(help ?? '')).toContain('overscroll-contain');
  });

  it('the opens rail contains its scroll', () => {
    const rail = componentSources['../src/components/OpensRail.tsx'];
    expect(stripComments(rail ?? '')).toContain('overscroll-contain');
  });
});
