import { describe, expect, it } from 'vitest';
import appSource from '../src/App.tsx?raw';
import inboxListSource from '../src/components/InboxList.tsx?raw';
import messageRowSource from '../src/components/MessageRow.tsx?raw';
import shortcutHelpSource from '../src/components/ShortcutHelp.tsx?raw';
import hookSource from '../src/keyboard/useKeyboardShortcuts.ts?raw';
import revealSource from '../src/keyboard/revealRow.ts?raw';

/**
 * The WIRING checks, using the same `?raw`-import-and-regex technique
 * tests/message-open-static-guards.test.ts and
 * tests/opens-rail-static-guards.test.ts already use — the only tool
 * available under client/CLAUDE.md's standing constraint that no test in
 * this project renders a component.
 *
 * WHAT THESE COVER AND WHAT THEY DO NOT. The behaviour is tested properly
 * elsewhere: keyboard-shortcuts.test.ts proves every key resolves
 * correctly, keyboard-typing-guard.test.ts proves the guard catches
 * contenteditables and shadow roots, keyboard-selection.test.ts proves
 * the cursor survives an append and a folder swap. What none of those can
 * reach is whether the COMPONENTS call any of it — an App.tsx that
 * imported `resolveShortcut` and never installed a listener would leave
 * all three suites green while the user pressed `j` and nothing happened.
 * These are the wiring checks and nothing more; the browser is the real
 * proof and the task report records it separately.
 *
 * Each guard is paired with a synthetic-fixture test proving the pattern
 * would genuinely catch its own regression rather than always passing.
 */

/** Strips comments so a doc comment that merely MENTIONS an identifier —
 *  this file's own header does exactly that — is never read as live
 *  code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const APP = stripComments(appSource);
const LIST = stripComments(inboxListSource);
const ROW = stripComments(messageRowSource);
const HELP = stripComments(shortcutHelpSource);
const HOOK = stripComments(hookSource);
const REVEAL = stripComments(revealSource);

describe('the keyboard is actually installed', () => {
  it('App.tsx calls useKeyboardShortcuts', () => {
    expect(/useKeyboardShortcuts\s*\(/.test(APP)).toBe(true);
  });

  it('the hook registers a keydown listener on window', () => {
    expect(/window\.addEventListener\(\s*'keydown'/.test(HOOK)).toBe(true);
  });

  it('and removes it on unmount', () => {
    expect(/window\.removeEventListener\(\s*'keydown'/.test(HOOK)).toBe(true);
  });

  /**
   * BUBBLE PHASE, NOT CAPTURE — and this is a correctness guard, not a
   * style one. components/SearchBar.tsx's Esc calls `stopPropagation`
   * precisely so the window handler cannot ALSO see it, and
   * components/Compose.tsx binds Esc on its own subtree. A capturing
   * listener runs BEFORE both and would take the key out of their hands,
   * reintroducing the double-fire ../src/searchQuery.ts warns about.
   */
  const CAPTURING = /addEventListener\(\s*'keydown'[^)]*(true|capture)/;

  it('listens in the bubble phase so nearer handlers get the key first', () => {
    expect(CAPTURING.test(HOOK)).toBe(false);
  });

  it('would catch a capturing listener', () => {
    expect(CAPTURING.test("window.addEventListener('keydown', handle, true)")).toBe(true);
    expect(CAPTURING.test("window.addEventListener('keydown', handle, { capture: true })")).toBe(true);
  });
});

describe('the typing guard is the one that is used', () => {
  /** The hook must ask ./typingTarget.ts rather than re-deriving "is this
   *  a text field?" inline — a second, simpler copy of that test is
   *  exactly what ../src/searchQuery.ts predicts will miss a case. */
  const USES_GUARD = /isTyping:\s*isTypingContext\(/;

  it('computes isTyping through isTypingContext', () => {
    expect(USES_GUARD.test(HOOK)).toBe(true);
  });

  it('would catch a hand-rolled tagName check in its place', () => {
    expect(USES_GUARD.test("isTyping: target.tagName === 'INPUT',")).toBe(false);
  });

  it('never hand-rolls a tagName comparison anywhere in the hook', () => {
    expect(/tagName\s*===/.test(HOOK)).toBe(false);
  });
});

describe('the cursor is passed down and drawn', () => {
  it('App.tsx hands InboxList the selected key', () => {
    expect(/selectedKey=\{cursor\.key\}/.test(APP)).toBe(true);
  });

  it('InboxList hands MessageRow isSelected and a roving tabIndex', () => {
    expect(/isSelected=\{key === selectedKey\}/.test(LIST)).toBe(true);
    expect(/tabIndex=\{key === tabStopKey \? 0 : -1\}/.test(LIST)).toBe(true);
  });

  it('MessageRow applies the selection treatment when selected', () => {
    expect(/isSelected && ROW_SELECTED/.test(ROW)).toBe(true);
  });

  it('MessageRow marks the selected row for assistive tech', () => {
    expect(/aria-current=\{isSelected \? true : undefined\}/.test(ROW)).toBe(true);
  });

  it('would catch a selection class that is never applied', () => {
    expect(/isSelected && ROW_SELECTED/.test('className={cn(base, ROW_FOCUS)}')).toBe(false);
  });
});

describe('the mobile layout is not regressed', () => {
  /**
   * The user was explicit that the mobile list stays borderless and
   * untinted. A phone has no keyboard, so every keyboard-only VISUAL is
   * gated to `lg:` — the selection band here, and the help overlay and
   * chord hint below.
   */
  it('every part of the selection treatment is lg:-gated', () => {
    const selected = ROW.match(/export const ROW_SELECTED\s*=\s*'([^']*)'/)?.[1] ?? '';
    expect(selected).not.toBe('');
    const ungated = selected
      .split(/\s+/)
      .filter((token) => token !== '')
      .filter((token) => !token.startsWith('lg:') && !token.startsWith('dark:lg:'));
    expect(ungated).toEqual([]);
  });

  it('would catch an ungated class slipping into the selection treatment', () => {
    const ungated = 'bg-neutral-100 lg:shadow-md'
      .split(/\s+/)
      .filter((token) => !token.startsWith('lg:') && !token.startsWith('dark:lg:'));
    expect(ungated).toEqual(['bg-neutral-100']);
  });

  it('the help overlay is hidden below lg:', () => {
    expect(/hidden[^'"]*lg:flex/.test(HELP)).toBe(true);
  });

  it('the chord hint is hidden below lg:', () => {
    // Rendered in App.tsx, so it is checked there rather than in the
    // overlay file.
    expect(/chordKey !== null && \([\s\S]{0,600}?hidden[^'"]*lg:flex/.test(APP)).toBe(true);
  });
});

describe('scrolling does not fight the user', () => {
  /** `nearest` scrolls by the minimum amount and by ZERO when the row is
   *  already visible. `center`/`start` would yank the list on every
   *  keystroke, including the ones that needed no scroll at all. */
  const NEAREST = /scrollIntoView\(\{[^}]*block:\s*'nearest'/;

  it('reveals rows with block: nearest', () => {
    expect(NEAREST.test(REVEAL)).toBe(true);
  });

  it('would catch block: center', () => {
    expect(NEAREST.test("row.scrollIntoView({ block: 'center' })")).toBe(false);
  });

  it('focuses with preventScroll so focus cannot undo that restraint', () => {
    expect(/focus\(\{\s*preventScroll:\s*true\s*\}\)/.test(REVEAL)).toBe(true);
  });

  it('never smooth-scrolls — autorepeat retargets a smooth scroll every frame', () => {
    expect(/behavior:\s*'smooth'/.test(REVEAL)).toBe(false);
  });

  it('only reveals after a keystroke asked for it', () => {
    // The flag is what stops a folder click — which also moves the cursor
    // — from stealing focus off the sidebar button that was just pressed.
    expect(/if \(!shouldRevealRef\.current\) return;/.test(APP)).toBe(true);
    expect(/shouldRevealRef\.current = true;/.test(APP)).toBe(true);
  });
});

describe('the cursor survives list changes through the tested module', () => {
  it('App.tsx reconciles rather than clamping inline', () => {
    expect(/reconcileSelection\(/.test(APP)).toBe(true);
  });

  it('never open-codes a clamp against the list length', () => {
    // The naive fix keyboard/selection.ts exists to refuse. If this ever
    // appears in App.tsx, the tested decision has been bypassed.
    expect(/Math\.min\([^)]*visibleMessages\.length/.test(APP)).toBe(false);
    expect(/Math\.min\([^)]*visibleKeys\.length/.test(APP)).toBe(false);
  });
});

describe('the star write path is wired', () => {
  it('App.tsx calls setMessageFlag with the flagged field', () => {
    expect(/setMessageFlag\([\s\S]{0,120}'flagged'/.test(APP)).toBe(true);
  });

  it('reverts the optimistic override when the write fails', () => {
    expect(/withoutStar\(/.test(APP)).toBe(true);
  });

  it('reports the failure rather than swallowing it', () => {
    expect(/setStarError\(/.test(APP)).toBe(true);
  });

  it('the reader button and the s key share one handler', () => {
    // Two implementations that agree today are two implementations that
    // disagree eventually.
    expect(/onToggleStar=\{toggleStar\}/.test(APP)).toBe(true);
    expect(/onToggleStar:\s*toggleStar/.test(APP)).toBe(true);
  });
});
