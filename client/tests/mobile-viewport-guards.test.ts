import { describe, it, expect } from 'vitest';
import appSource from '../src/App.tsx?raw';
import messageBodyContentSource from '../src/components/MessageBodyContent.tsx?raw';
import stylesCss from '../src/styles.css?raw';
import indexHtml from '../index.html?raw';
import appShellSource from '../src/AppShell.tsx?raw';
import loginSource from '../src/LoginView.tsx?raw';
import messageViewSource from '../src/components/MessageView.tsx?raw';
import touchTargetSource from '../src/ui/touchTarget.ts?raw';
import composeSource from '../src/components/Compose.tsx?raw';
import recipientFieldSource from '../src/components/RecipientField.tsx?raw';
import inputSource from '../src/ui/Input.tsx?raw';
import selectSource from '../src/ui/Select.tsx?raw';

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

/** The class list the recipient `<input>` actually carries — a template
 *  literal, so a plain `toContain` on the file would also match the import
 *  line and pass while the input itself had been reverted. */
function recipientInputClasses(): string {
  const source = stripComments(recipientFieldSource);
  const input = source.slice(source.indexOf('<input'));
  return /className=\{`([^`]*)`\}/.exec(input)?.[1] ?? '';
}

describe('the composer, on a phone', () => {
  it('never leaves an input under 16px, because iOS ZOOMS THE PAGE if it does', () => {
    // Not a preference: Safari treats a sub-16px field as unreadable and
    // scales the whole viewport on focus, leaving the user pinching back
    // out after tapping "To". Every other field was already 16px via the
    // atoms' `text-base md:text-sm`; the recipient input was the one left
    // at a flat `text-sm`, so it zoomed and its neighbours did not.
    expect(touchTargetSource).toMatch(/const TOUCH_INPUT_TEXT = 'text-base md:text-sm'/);

    // The APPLIED class list, not merely the import. An earlier version of
    // this test asserted `toContain('TOUCH_INPUT_TEXT')`, which a mutation
    // reverting the input to a flat `text-sm` sailed straight through —
    // the import line still mentioned the constant. Read the className the
    // input actually carries.
    const applied = recipientInputClasses();
    expect(applied).toContain('${TOUCH_INPUT_TEXT}');
    expect(applied).not.toMatch(/\btext-sm\b/);
  });

  it('gives the recipient chip input a real tap target', () => {
    // It measured 24px tall — the smallest control in the composer, and a
    // primary field.
    expect(recipientInputClasses()).toContain('${TOUCH_MIN_HEIGHT}');
  });

  it('sizes the composer’s icon controls for a thumb', () => {
    // Close, attach and send are icon buttons in the header now rather than
    // labelled Buttons, so TOUCH_HEIGHT (which sets a height only) is the
    // wrong tool: an icon button needs a square target. `size-11` is 44px in
    // both axes — the same floor, expressed for the shape it applies to.
    const src = stripComments(composeSource);
    expect(src).toMatch(/inline-flex size-11 shrink-0 items-center justify-center rounded-full/);
  });

  it('sizes Send, which is the one control that must not be missed', () => {
    // It carries the shared icon-button class, so it inherits that 44px.
    const src = stripComments(composeSource);
    const sendAt = src.indexOf('type="submit"');
    expect(sendAt).toBeGreaterThan(-1);
    expect(src.slice(sendAt, sendAt + 400)).toContain('iconButton');
  });

  it('makes the shared field atoms touch-height on phones and dense on desktop', () => {
    for (const source of [inputSource, selectSource]) {
      expect(source).toMatch(/'flex h-11 w-full rounded-md md:h-9/);
    }
  });
});

describe('reading or writing a message strips the shell back to it, below lg:', () => {
  const shell = stripComments(appShellSource);

  it('takes the prop that says a single task has the column', () => {
    // App.tsx's `selected !== null`. The shell cannot infer this: the
    // reader REPLACES the list inside `children`, so from out here the two
    // states look identical.
    expect(shell).toMatch(/readonly isImmersive\?: boolean;/);
    expect(stripComments(appShellSource)).toMatch(/isImmersive = false,/);
  });

  it('counts BOTH reading and composing, which is the half the shell cannot see', () => {
    // The shell is handed a boolean; it cannot tell what put the column into
    // a single task. Asserting only the shell's side let a mutation reverting
    // App.tsx to `selected !== null` pass green while the composer got its
    // search bar back — caught by mutation-testing this guard, not by
    // reading it.
    expect(stripComments(appSource)).toMatch(
      /isImmersive=\{selected !== null \|\| view === 'compose'\}/,
    );
  });

  it('hides the search bar and hamburger while reading, on phones only', () => {
    // The user, with Valen Mail beside Gmail on an iPhone: "When you click
    // into an email on ios remove the inbox and like all the junk at the
    // top besides title and email." The reader carries its own back
    // control, so a nav bar above it spends 64px offering a second way off
    // the same screen.
    expect(shell).toMatch(/isImmersive && 'hidden lg:block'/);
  });

  it('moves the notch inset onto the content column when that bar goes', () => {
    // The header is what normally pads for the cutout. Hiding it without
    // this renders the subject line behind the status bar.
    expect(shell).toMatch(/isImmersive && 'pt-\[var\(--safe-top\)\] lg:pt-0'/);
  });

  it('hides the folder heading VISUALLY but keeps it for the outline', () => {
    // "Inbox" is junk on a phone showing one message. It is also the
    // document's h1, and deleting it would start a screen reader's outline
    // at the message's own h2.
    expect(shell).toMatch(/isImmersive && 'sr-only'/);
  });

  it('withdraws the floating Compose button while reading', () => {
    // Gmail does the same. It would also collide with the reader's own
    // actions, and the reserved space it implies would be a gap.
    expect(shell).toMatch(/const showComposeFab = view !== 'compose' && !isImmersive;/);
  });
});

describe('the reader\'s controls, under a thumb', () => {
  const view = stripComments(messageViewSource);

  it('sizes them for touch and gives the density back above lg:', () => {
    // Measured at 393x852 before this: every control 32px tall, and the
    // worst pair is Archive beside Trash — adjacent, alike, one of them
    // destructive. 44px is where Apple's HIG and WCAG 2.5.5 both land.
    expect(touchTargetSource).toMatch(/const TOUCH_HEIGHT = 'h-11 lg:h-8'/);
    // Stated once, in ui/, because it is now the answer for the reader AND
    // the composer. A second copy is how the two drift into disagreeing
    // about what a tap target is.
    expect(view).toContain("from '../ui/touchTarget'");
  });

  it('applies it to EVERY small control in the reader, not most of them', () => {
    // A toolbar where one button is 32px and its neighbour is 44px is
    // worse than one where they agree, so this counts rather than samples.
    const small = view.match(/size="sm"/g) ?? [];
    const sized = view.match(/size="sm" className=\{TOUCH_HEIGHT\}/g) ?? [];
    expect(small.length).toBeGreaterThan(0);
    expect(sized.length).toBe(small.length);
  });

  it('covers the one control that is not a Button either', () => {
    // "Show original colours" is hand-rolled and measured 24px — the WCAG
    // 2.5.8 floor exactly, and the smallest thing in the reader.
    expect(touchTargetSource).toMatch(/const TOUCH_MIN_HEIGHT = 'min-h-11 lg:min-h-0'/);
    // "Show original colours" lives in MessageBodyContent.tsx now — the body
    // renderer became its own file when the reader learned to stack a whole
    // conversation. The reader's surface is several files; the control is
    // what matters, not which one holds it.
    expect(messageViewSource + messageBodyContentSource).toContain('TOUCH_MIN_HEIGHT');
  });
});

describe('reaching Compose below lg:, where the sidebar is a closed drawer', () => {
  const shell = stripComments(appShellSource);

  it('offers a fixed Compose control that mobile can see without opening the drawer', () => {
    // The drawer's copy is two taps and an animation away, and it closes
    // again behind you. This is the one action in a mailbox that is not a
    // response to something already on screen, so it gets a permanent
    // affordance. Verified in a browser at 393x852: 56x56 at the bottom
    // right, inside the viewport, clear of the last row at scroll-bottom.
    expect(shell).toMatch(/className="fixed z-30[^"]*lg:hidden[^"]*"/);
  });

  it('keeps it out of the way of the drawer rather than floating over the scrim', () => {
    // The scrim is z-40 and the panel z-50. A fixed button at z-40+ would
    // sit on top of a dimmed page looking live while doing nothing.
    const fab = /className="fixed z-(\d+)[^"]*lg:hidden/.exec(shell);
    expect(fab).not.toBeNull();
    expect(Number(fab![1])).toBeLessThan(40);
  });

  it('gives the icon-only button a name, since it has no visible text', () => {
    expect(shell).toMatch(/<span className="sr-only">Compose<\/span>/);
  });

  it('reserves the space it covers, and only while it is showing', () => {
    // Space with no button is a gap at the foot of every list; a button
    // with no space covers the last row. The two come from ONE flag so
    // they cannot drift apart.
    expect(shell).toMatch(/const showComposeFab = view !== 'compose'/);
    // One flag now covers BOTH bottom-pinned things — the Compose button on
    // a list and the reader's sticky Reply bar on a message — because the
    // failure is identical either way: space with nothing over it is a gap,
    // something over it with no space hides the last line.
    expect(shell).toMatch(/const reservesBottomBar = showComposeFab \|\| isImmersive;/);
    expect(shell).toMatch(/reservesBottomBar\s*\n?\s*\?\s*'pb-\[calc\(var\(--safe-bottom\)\+5rem\)\] lg:pb-\[var\(--safe-bottom\)\]'/);
    expect(shell).toMatch(/:\s*'pb-\[var\(--safe-bottom\)\]'/);
  });

  it('sits inside the safe area on a notched phone, like every other fixed edge here', () => {
    expect(shell).toMatch(/bottom-\[calc\(1rem\+var\(--safe-bottom\)\)\]/);
    expect(shell).toMatch(/right-\[calc\(1rem\+var\(--safe-right\)\)\]/);
  });

  it('does NOT remove the drawer copy, which is where keyboard focus returns', () => {
    // AppShell hands `composeButtonRef` to the rail/drawer button so the
    // composer can return focus to it. Deleting that copy in favour of the
    // floating one would strand focus.
    expect(shell).toMatch(/ref=\{composeButtonRef\}/);
  });
});

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
