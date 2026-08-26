/**
 * Whether the keyboard cursor's band is PAINTED — as pure data, with no
 * React and no DOM anywhere near it.
 *
 * ---------------------------------------------------------------------
 * WHY THE BAND IS CONDITIONAL AT ALL.
 * ---------------------------------------------------------------------
 * The cursor row is drawn by `ROW_SELECTED` (../components/MessageRow.tsx)
 * as a grey fill plus an inset bar. Hover is `hover:bg-neutral-50` and
 * press is `active:bg-neutral-100` — the SAME grey family. So a mouse
 * user coming back from the reader, whose cursor was restored to the row
 * they had just opened, sees a row that looks like it is under the
 * pointer when the pointer is somewhere else entirely: *"there is weird
 * highlighting on the mac os app. My cursor isnt hovering over it but it
 * seems like it is."*
 *
 * **THE FIX IS TO STOP PAINTING IT AT A MOUSE USER, not to repaint it in
 * some other colour.** The band is an affordance for one modality: it
 * says "this is where `j`/`k`/Enter will act." To someone driving with a
 * pointer it names a mode they are not in, so the honest thing is
 * absence, which is also what Gmail and Superhuman do. The alternative —
 * keeping it always visible under a different treatment — would still
 * paint a mark for a modality the user is not using, and would mean
 * redesigning the row to find a treatment that reads as neither hover nor
 * focus. Absence is smaller, matches the platform, and removes the
 * confusion instead of restyling it.
 *
 * NOTHING ABOUT THE CURSOR ITSELF CHANGES. Its position is still tracked,
 * still restored on Back, still what `j`/`k` move and what Enter opens,
 * and the row still carries `aria-current` so assistive tech can say
 * where it is. Only the paint is conditional. ./revealRow.ts's
 * scroll-into-view is likewise untouched — it is driven by the cursor,
 * not by this.
 *
 * THE FOCUS RING IS A DIFFERENT MARK AND IS NOT AFFECTED. `ROW_FOCUS` is
 * `focus-visible:ring-*`, a legitimate affordance the browser decides;
 * this file decides only the grey band beside it.
 */

/**
 * What the list's own focus events mean for the band.
 *
 * `viaKeyboard` is `:focus-visible` — the browser's own answer to "did
 * this focus arrive from the keyboard", and deliberately not a guess of
 * our own. It is the right signal for one case in particular that no
 * hand-rolled rule gets right: App.tsx restores focus to the opened row
 * when the reader closes, and a PROGRAMMATIC focus inherits the
 * visibility of the interaction that preceded it. Opened by click, it is
 * not focus-visible and the band stays away; opened by Enter from the
 * keyboard, it is, and the band comes back exactly where the user left
 * it.
 */
export type ListFocusEvent =
  /** Focus arrived somewhere inside the list. */
  | { readonly kind: 'entered'; readonly viaKeyboard: boolean }
  /** Focus left an element inside the list. */
  | { readonly kind: 'left'; readonly staysInsideList: boolean };

/**
 * The band's next visibility, given its current one and what just
 * happened to focus.
 *
 * A KEYBOARD ENTRY SHOWS IT AND A POINTER ENTRY HIDES IT, symmetrically.
 * The second half matters as much as the first: a user who has been on
 * the keyboard and then clicks a row has switched modality, and leaving
 * the band up would put them back in the exact situation they
 * complained about the moment they return from the reader.
 *
 * Focus moving from one row to the next fires `left` then `entered`; the
 * `left` half is a no-op because `staysInsideList` is true, so the band
 * does not flicker off and on between rows.
 */
export function nextCursorBandVisibility(isVisible: boolean, event: ListFocusEvent): boolean {
  if (event.kind === 'left') return event.staysInsideList ? isVisible : false;
  return event.viaKeyboard;
}

/**
 * Whether THIS row paints the band.
 *
 * Both halves are required, and separating them is what lets the cursor
 * keep existing while it is not drawn: `isCursorRow` is where the cursor
 * IS, `isBandVisible` is whether the list is being driven by a keyboard
 * right now.
 */
export function shouldDrawCursorBand(isCursorRow: boolean, isBandVisible: boolean): boolean {
  return isCursorRow && isBandVisible;
}
