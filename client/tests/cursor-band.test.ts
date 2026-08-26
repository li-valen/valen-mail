import { describe, expect, it } from 'vitest';
import { nextCursorBandVisibility, shouldDrawCursorBand } from '../src/keyboard/cursorBand';
import rowSource from '../src/components/MessageRow.tsx?raw';
import listSource from '../src/components/InboxList.tsx?raw';

/**
 * The keyboard cursor's band, and when it is painted.
 *
 * The defect: the cursor row is drawn in the SAME grey family as hover
 * and press, so a mouse user returning from the reader — whose cursor was
 * restored to the row they opened — saw a row that looked hovered while
 * the pointer was elsewhere. *"There is weird highlighting on the mac os
 * app. My cursor isnt hovering over it but it seems like it is."*
 *
 * The decision is pure (../src/keyboard/cursorBand.ts) so it can be
 * tested at all — client/CLAUDE.md's standing constraint is that no test
 * here renders a component — and the wiring is a static guard, because
 * no unit test can see which flag a component chose to pass.
 */

describe('nextCursorBandVisibility', () => {
  it('shows the band when focus arrives from the keyboard', () => {
    // Tab into the list, or `j`/`k` (which focus the row through
    // ../src/keyboard/revealRow.ts).
    expect(nextCursorBandVisibility(false, { kind: 'entered', viaKeyboard: true })).toBe(true);
  });

  it('does NOT show it when focus arrives from a pointer', () => {
    // THE DEFECT ITSELF. Clicking a row focuses it; so does App.tsx
    // restoring focus to that row when the reader closes. Neither is a
    // request to be shown where `j` would go next.
    expect(nextCursorBandVisibility(false, { kind: 'entered', viaKeyboard: false })).toBe(false);
  });

  it('HIDES a band that was showing when the user switches to the pointer', () => {
    // Symmetry, and it is load-bearing: a keyboard user who then clicks a
    // row would otherwise come back from the reader to the exact
    // highlight they complained about.
    expect(nextCursorBandVisibility(true, { kind: 'entered', viaKeyboard: false })).toBe(false);
  });

  it('hides it when focus leaves the list entirely', () => {
    // Click a folder in the sidebar: the cursor stays where it was, but
    // nothing is going to act on it until focus comes back.
    expect(nextCursorBandVisibility(true, { kind: 'left', staysInsideList: false })).toBe(false);
  });

  it('does not flicker while focus moves from one row to the next', () => {
    // `j` fires `left` then `entered`. The `left` half must be a no-op or
    // the band blinks off and on down the whole list.
    expect(nextCursorBandVisibility(true, { kind: 'left', staysInsideList: true })).toBe(true);
    expect(nextCursorBandVisibility(false, { kind: 'left', staysInsideList: true })).toBe(false);
  });

  it('comes back the moment the keyboard is used again', () => {
    // The full round trip: keyboard, away to the sidebar, back with Tab.
    let visible = nextCursorBandVisibility(false, { kind: 'entered', viaKeyboard: true });
    visible = nextCursorBandVisibility(visible, { kind: 'left', staysInsideList: false });
    expect(visible).toBe(false);
    visible = nextCursorBandVisibility(visible, { kind: 'entered', viaKeyboard: true });
    expect(visible).toBe(true);
  });
});

describe('shouldDrawCursorBand', () => {
  it('needs BOTH the cursor and a visible band', () => {
    expect(shouldDrawCursorBand(true, true)).toBe(true);
    expect(shouldDrawCursorBand(true, false)).toBe(false);
    expect(shouldDrawCursorBand(false, true)).toBe(false);
    expect(shouldDrawCursorBand(false, false)).toBe(false);
  });
});

/** Strips comments so a doc comment MENTIONING an identifier — these
 *  files discuss this at length — is never read as live code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const ROW = stripComments(rowSource);
const LIST = stripComments(listSource);

describe('the band is wired to focus, not merely to the cursor', () => {
  it('the row gates ROW_SELECTED on the shared decision', () => {
    // THE MUTATION GUARD. Reverting to `isSelected && ROW_SELECTED` paints
    // the band whenever the cursor is on a row, focused or not — which is
    // the reported defect, restored.
    expect(/shouldDrawCursorBand\(isSelected, isCursorBandVisible\) && ROW_SELECTED/.test(ROW)).toBe(
      true,
    );
    expect(/isSelected && ROW_SELECTED/.test(ROW)).toBe(false);
  });

  it('and that guard would catch its own regression', () => {
    // Non-vacuity, the discipline the other static-guard suites use.
    const reverted = 'className={cn(ROW_FOCUS, isSelected && ROW_SELECTED)}';
    expect(/isSelected && ROW_SELECTED/.test(reverted)).toBe(true);
    expect(
      /shouldDrawCursorBand\(isSelected, isCursorBandVisible\) && ROW_SELECTED/.test(reverted),
    ).toBe(false);
  });

  it('the list tracks focus in and out and feeds the row', () => {
    expect(/onFocus=\{handleRowFocus\}/.test(LIST)).toBe(true);
    expect(/onBlur=\{handleRowBlur\}/.test(LIST)).toBe(true);
    expect(/isCursorBandVisible=\{isCursorBandVisible\}/.test(LIST)).toBe(true);
  });

  it('asks the BROWSER whether focus came from the keyboard', () => {
    // `:focus-visible` rather than a hand-rolled last-input-device
    // tracker: only the browser gets the programmatic-refocus case right.
    expect(/:focus-visible/.test(LIST)).toBe(true);
  });

  it('leaves the focus ring alone — it is a different, legitimate mark', () => {
    // ROW_FOCUS must stay unconditional. Gating it would remove the one
    // affordance a keyboard user genuinely needs.
    expect(/ROW_FOCUS,/.test(ROW)).toBe(true);
    expect(/shouldDrawCursorBand\([^)]*\) && ROW_FOCUS/.test(ROW)).toBe(false);
  });

  it('leaves the cursor POSITION and its announcement alone', () => {
    // Only the paint is conditional. `aria-current` still says where the
    // cursor is, and ../src/keyboard/revealRow.ts still scrolls to it.
    expect(/aria-current=\{isSelected \? true : undefined\}/.test(ROW)).toBe(true);
  });
});
