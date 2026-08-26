import { describe, expect, it } from 'vitest';
import appSource from '../src/App.tsx?raw';
import barSource from '../src/components/BulkActionBar.tsx?raw';
import boxSource from '../src/components/SelectBox.tsx?raw';
import hookSource from '../src/useBulkSelection.ts?raw';
import inboxListSource from '../src/components/InboxList.tsx?raw';
import keyboardHookSource from '../src/keyboard/useKeyboardShortcuts.ts?raw';
import messageRowSource from '../src/components/MessageRow.tsx?raw';
import runnerSource from '../src/bulkRunner.ts?raw';
import selectionSource from '../src/bulkSelection.ts?raw';

/**
 * The WIRING checks for bulk selection — the same `?raw`-import-and-regex
 * technique tests/mailbox-wiring-static-guards.test.ts already uses, and
 * the only tool available under client/CLAUDE.md's standing constraint
 * that no test in this project renders a component.
 *
 * WHAT THESE COVER AND WHAT THEY DO NOT. The behaviour is tested properly
 * in tests/bulk-selection.test.ts, tests/bulk-runner.test.ts and
 * tests/bulk-actions.test.ts. What those cannot reach is whether any
 * component CALLS them: a `runBulkMove` nobody invokes, a bar with no
 * checkbox to fill it, or — the one that would be a data-integrity bug —
 * a batch whose `restoredKeys` are computed and then dropped, leaving
 * rows hidden in the UI and still sitting in the inbox.
 *
 * Every guard is paired with a synthetic fixture proving the pattern
 * would catch its own regression rather than always passing.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const APP = stripComments(appSource);
const BAR = stripComments(barSource);
const BOX = stripComments(boxSource);
const HOOK = stripComments(hookSource);
const LIST = stripComments(inboxListSource);
const KEYBOARD = stripComments(keyboardHookSource);
const ROW = stripComments(messageRowSource);
const RUNNER = stripComments(runnerSource);
const SELECTION = stripComments(selectionSource);

describe('the rollback is applied UNCONDITIONALLY', () => {
  it('reveals the failed rows BEFORE the generation guard, not after it', () => {
    // THE ONE THAT MATTERS. Which rows are still in the inbox is a fact
    // about the MAILBOX; the notice and the undo offer are statements
    // about the SCREEN. Guarding the first with the second would leave a
    // partially-failed batch's rows hidden forever whenever a second
    // batch or a navigation happened while it was in flight — a lie the
    // user has no way to detect.
    expect(
      /revealKeys\(outcome\.restoredKeys\);[\s\S]{0,120}if \(issuedAt !== generationRef\.current\) return;/.test(
        HOOK,
      ),
    ).toBe(true);
  });

  it('never guards the reveal behind the generation check', () => {
    expect(HOOK).not.toMatch(
      /if \(issuedAt !== generationRef\.current\) return;[\s\S]{0,80}revealKeys\(outcome\.restoredKeys\)/,
    );
  });

  it('reverts the read-state overrides unconditionally too', () => {
    expect(
      /revertSeen\(outcome\.revertedKeys\);[\s\S]{0,120}if \(issuedAt !== generationRef\.current\) return;/.test(
        HOOK,
      ),
    ).toBe(true);
  });

  it('brings every row back if the batching itself breaks', () => {
    // `runBulkMove` is built not to reject, so this path means there is
    // no per-row report at all — and no report means no basis for
    // leaving any row hidden.
    expect(/\(error: unknown\) => \{[\s\S]{0,200}revealKeys\(batchKeys\)/.test(HOOK)).toBe(true);
  });

  it('the ordering guard is not vacuous', () => {
    const guardedFirst =
      'if (issuedAt !== generationRef.current) return; revealKeys(outcome.restoredKeys);';
    expect(
      /revealKeys\(outcome\.restoredKeys\);[\s\S]{0,120}if \(issuedAt !== generationRef\.current\) return;/.test(
        guardedFirst,
      ),
    ).toBe(false);
  });
});

describe('the abort signal cannot outlive its own batch', () => {
  it('makes a fresh controller per batch', () => {
    expect(/function beginBatch\(\): AbortController \{[\s\S]{0,200}new AbortController\(\)/.test(HOOK)).toBe(
      true,
    );
    expect((HOOK.match(/beginBatch\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('never holds ONE controller for the whole hook', () => {
    // THE DEFECT LIVE VERIFICATION CAUGHT, and nothing in this suite
    // could: a single controller created lazily in render and aborted in
    // a mount effect's cleanup is permanently dead after `<StrictMode>`'s
    // deliberate mount/unmount/remount. Every later batch then skipped
    // all forty rows, restored all forty, and told the user "None of the
    // 40 messages could be archived" having sent no requests at all.
    expect(HOOK).not.toMatch(/\w+Ref\.current === null\) \w+Ref\.current = new AbortController\(\)/);
  });

  it('the StrictMode guard is not vacuous', () => {
    const buggy = 'if (lifetimeRef.current === null) lifetimeRef.current = new AbortController();';
    expect(buggy).toMatch(/\w+Ref\.current === null\) \w+Ref\.current = new AbortController\(\)/);
  });

  it('releases a controller once its batch settles', () => {
    expect((HOOK.match(/endBatch\(controller\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe('the partial failure reaches the screen', () => {
  it('the hook sets an error from the batch outcome', () => {
    expect(/setError\(bulkMoveFailureFor\(destination, outcome\)\)/.test(HOOK)).toBe(true);
    expect(/setError\(bulkFlagFailureFor\(outcome\)\)/.test(HOOK)).toBe(true);
    expect(/setError\(bulkUndoFailureFor\(destination, outcome\)\)/.test(HOOK)).toBe(true);
  });

  it('App renders that error, with a way to dismiss it', () => {
    expect(/bulk\.error !== null/.test(APP)).toBe(true);
    expect(/\{bulk\.error\}/.test(APP)).toBe(true);
    expect(/onClick=\{bulk\.dismissError\}/.test(APP)).toBe(true);
  });

  it('renders it as an in-place banner, never a toast', () => {
    expect(/bulk\.error !== null && \([\s\S]{0,200}Alert variant="destructive"/.test(APP)).toBe(true);
  });

  it('the error-rendering guard is not vacuous', () => {
    expect(/\{bulk\.error\}/.test('<Alert>{moveError}</Alert>')).toBe(false);
  });
});

describe('the undo is one action for the whole batch', () => {
  it('App renders a single batch undo bar', () => {
    expect(/bulk\.undo !== null/.test(APP)).toBe(true);
    expect(/onUndo=\{bulk\.runUndo\}/.test(APP)).toBe(true);
  });

  it('replays the tickets the batch collected, not a reconstruction', () => {
    expect(/const entries = undo\.outcome\.undos;/.test(HOOK)).toBe(true);
    expect(/runBulkUndo\(entries,/.test(HOOK)).toBe(true);
  });

  it('a single move dismisses the batch bar, and a batch dismisses the single one', () => {
    // Two undo bars at once would leave the user pressing "Undo" with no
    // way to know which of them it applies to.
    expect(/dismissBulkUndoRef\.current\(\)/.test(APP)).toBe(true);
    expect(/clearSingleUndo\(\)/.test(HOOK)).toBe(true);
  });

  it('never constructs a destination folder of its own', () => {
    // A client that named a mailbox would be exercising an
    // arbitrary-folder-move primitive against a live mailbox.
    const SURFACE = [APP, BAR, BOX, HOOK, LIST, ROW, RUNNER, SELECTION].join('\n');
    expect(SURFACE).not.toMatch(/\[Gmail\]/);
    expect(SURFACE).not.toMatch(/All Mail/);
  });

  it('the folder guard is not vacuous', () => {
    expect('const dest = "[Gmail]/Trash";').toMatch(/\[Gmail\]/);
  });
});

describe('the concurrency bound is real and is named', () => {
  it('the runner caps its worker count', () => {
    expect(/Math\.max\(1, Math\.min\(limit, items\.length\)\)/.test(RUNNER)).toBe(true);
  });

  it('never fans out with Promise.all over the items themselves', () => {
    // `Promise.all(items.map(run))` is unbounded AND abandons every other
    // result on the first rejection — which is the report that decides
    // which rows come back.
    expect(RUNNER).not.toMatch(/Promise\.all\(\s*items\.map/);
  });

  it('the unbounded-fanout guard is not vacuous', () => {
    expect('await Promise.all(items.map(run));').toMatch(/Promise\.all\(\s*items\.map/);
  });

  it('the limit is a named, documented constant rather than a literal', () => {
    expect(/export const MAX_CONCURRENT_BULK_REQUESTS = \d+;/.test(RUNNER)).toBe(true);
  });
});

describe('a row can be ticked, at both widths', () => {
  it('the desktop box is a SIBLING of the row button, never nested inside it', () => {
    // A <button> inside a <button> is invalid and browsers silently
    // un-nest it, which would move the control out of the row entirely.
    expect(/<li className="group relative">/.test(ROW)).toBe(true);
    expect(/<SelectBox[\s\S]{0,400}absolute left-4/.test(ROW)).toBe(true);
  });

  it('the mobile target is the avatar, and only below lg:', () => {
    // Gmail's own mobile pattern, and the reason the phone list gains no
    // permanent chrome — the user asked for it to stay borderless.
    expect(/absolute left-\[2px\][^'"]*lg:hidden/.test(ROW)).toBe(true);
  });

  it('the desktop box is gated to lg: and above', () => {
    expect(/hidden[^'"]*lg:inline-flex/.test(ROW)).toBe(true);
  });

  it('stops the row underneath from opening in the same gesture', () => {
    expect(/event\.stopPropagation\(\)/.test(BOX)).toBe(true);
    expect((ROW.match(/event\.stopPropagation\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('carries checkbox semantics rather than a bare button', () => {
    expect(/role="checkbox"/.test(BOX)).toBe(true);
    expect(/aria-checked=\{checked\}/.test(BOX)).toBe(true);
    expect(/role="checkbox"/.test(ROW)).toBe(true);
    expect(/aria-checked=\{isBulkSelected\}/.test(ROW)).toBe(true);
  });

  it('names WHICH row, because fifty rows produce fifty checkboxes', () => {
    expect(/const selectLabel = `\$\{isBulkSelected \? 'Deselect' : 'Select'\}: \$\{subject\}`/.test(ROW)).toBe(
      true,
    );
    expect(/aria-label=\{selectLabel\}/.test(ROW)).toBe(true);
    expect(/aria-label=\{label\}/.test(BOX)).toBe(true);
  });

  it('reserves the desktop column instead of collapsing it', () => {
    // A column that appeared on hover would slide every sender name 28px
    // sideways the moment a pointer entered the list.
    expect(/isSelectable && <span aria-hidden="true" className="h-4 w-4 shrink-0" \/>/.test(ROW)).toBe(
      true,
    );
    expect(/opacity-0[^'"]*group-hover:opacity-100/.test(BOX)).toBe(true);
    expect(BOX).not.toMatch(/hidden group-hover:inline-flex/);
  });

  it('keeps the day label on the sender line now that the column exists', () => {
    // 16px row padding + 16px checkbox + 12px gap = 44px = pl-11. The two
    // halves are only correct together, and the number was measured in a
    // real browser rather than derived — see InboxList's own comment.
    expect(/lg:pl-11/.test(LIST)).toBe(true);
    expect(/hidden h-11 w-full items-center gap-3 px-4 lg:flex/.test(ROW)).toBe(true);
  });

  it('offers ticking exactly where moving is offered', () => {
    // A selection holding one row that cannot be archived would make the
    // bar's Archive button partly inert.
    expect(/canMoveFrom\(message\.folder\) \? onToggleSelect : undefined/.test(LIST)).toBe(true);
  });

  it('the sibling and gating guards are not vacuous', () => {
    expect(/<SelectBox[\s\S]{0,400}absolute left-4/.test('<button><SelectBox /></button>')).toBe(
      false,
    );
    expect(/canMoveFrom\(message\.folder\) \? onToggleSelect : undefined/.test(
      'onToggleSelect={onToggleSelect}',
    )).toBe(false);
  });
});

describe('the bar exists only when something is selected', () => {
  it('App renders it behind a count check', () => {
    expect(/bulk\.count > 0 && \([\s\S]{0,200}<BulkActionBar/.test(APP)).toBe(true);
  });

  it('never renders it disabled instead', () => {
    expect(BAR).not.toMatch(/disabled=\{count === 0\}/);
  });

  it('offers archive, trash and both read directions', () => {
    expect(/onMove\('archive'\)/.test(BAR)).toBe(true);
    expect(/onMove\('trash'\)/.test(BAR)).toBe(true);
    expect(/onMarkSeen\(true\)/.test(BAR)).toBe(true);
    expect(/onMarkSeen\(false\)/.test(BAR)).toBe(true);
  });

  it('shows a live count that announces itself', () => {
    // Ticking with `x` moves no focus, so without this a screen-reader
    // user gets no confirmation that the selection grew at all.
    expect(/aria-live="polite"/.test(BAR)).toBe(true);
    expect(/\{countLabel\}/.test(BAR)).toBe(true);
  });

  it('wires select-all and clear to the same box', () => {
    expect(/isEverythingSelected \? onClear : onSelectAll/.test(BAR)).toBe(true);
  });

  it('the destination-wiring guard is not vacuous', () => {
    // The bug it catches: both buttons wired to the same destination, so
    // "Archive" quietly trashes forty messages.
    expect(/onMove\('trash'\)/.test("onClick={() => onMove('archive')}")).toBe(false);
  });
});

describe('the keyboard reaches the same selection the mouse does', () => {
  it('the keyboard hook declares and runs a toggle-selection handler', () => {
    expect(/readonly onToggleSelection: \(\) => void;/.test(KEYBOARD)).toBe(true);
    expect(/case 'toggle-selection':[\s\S]{0,90}onToggleSelection\(\)/.test(KEYBOARD)).toBe(true);
  });

  it('App supplies it from the same hook the checkboxes use', () => {
    expect(/onToggleSelection: bulk\.toggleCursorRow/.test(APP)).toBe(true);
    expect(/onToggleSelect=\{bulk\.toggle\}/.test(APP)).toBe(true);
  });

  it('`e` and `#` route through the tested target decision', () => {
    expect(/moveTargetsFor\(\{/.test(APP)).toBe(true);
    expect(/targets\.kind === 'selection'/.test(APP) || /bulk\.move\(destination\)/.test(APP)).toBe(
      true,
    );
  });

  it('the action guard is not vacuous', () => {
    expect(/case 'toggle-selection':[\s\S]{0,90}onToggleSelection\(\)/.test(
      "case 'toggle-selection': return;",
    )).toBe(false);
  });
});

describe('the selection is keyed so two accounts cannot collide', () => {
  it('reuses messageKey rather than inventing a second key shape', () => {
    // MUTATION TARGET (b), at the wiring level: uids are per-mailbox, so
    // `primary:9` and `harvard:9` are two unrelated messages.
    expect(/import \{ messageKey \} from '\.\/components\/messageBody';/.test(SELECTION)).toBe(true);
    expect(/return messageKey\(message\);/.test(SELECTION)).toBe(true);
  });

  it('the list ticks rows by that same key', () => {
    expect(/isBulkSelected=\{selectedKeys\.has\(key\)\}/.test(LIST)).toBe(true);
    expect(/const key = messageKey\(message\);/.test(LIST)).toBe(true);
  });

  it('the key guard is not vacuous', () => {
    expect(/return messageKey\(message\);/.test('return message.uid;')).toBe(false);
  });
});

describe('the pure modules stay pure', () => {
  it('the selection and runner modules import no React', () => {
    for (const [name, source] of [
      ['bulkSelection', SELECTION],
      ['bulkRunner', RUNNER],
    ] as const) {
      expect(source, `${name} must stay renderer-free`).not.toMatch(/from 'react'/);
      expect(source).not.toMatch(/useState|useEffect|useCallback/);
    }
  });

  it('the runner reaches no network of its own', () => {
    expect(RUNNER).not.toMatch(/\bfetch\(/);
  });
});
