import { innermostTarget } from './typingTarget';
import type { KeyEventLike } from './typingTarget';

/**
 * Bringing the cursor's row on screen without fighting the user.
 *
 * **`block: 'nearest'`, AND THAT IS THE WHOLE ANTI-FIGHTING MECHANISM.**
 * `nearest` scrolls by the minimum amount needed, and by ZERO when the
 * row is already visible — so a user who has scrolled the list themselves
 * and then presses `j` on a row that is already in view gets no scroll at
 * all. `center` or `start` would yank the list on every keystroke,
 * including the ones that did not need it, which is precisely the
 * "fighting the user's own scrolling" this must avoid.
 *
 * **`behavior: 'auto'` — INSTANT, NOT SMOOTH, and this is deliberate
 * rather than an oversight of src/motion/.** Holding `j` autorepeats at
 * roughly 30 keystrokes a second. Smooth scrolls do not queue; each new
 * one retargets the one in flight, so the viewport lags permanently
 * behind a cursor that is already several rows further on, and releasing
 * the key leaves the list still gliding to a stop somewhere behind where
 * the user stopped. The motion system's own rule — Plan 7's "never
 * animate layout properties on a list of 50+ rows" — points the same way.
 * Instant also means this path needs no `prefers-reduced-motion` branch:
 * there is no motion in it to reduce.
 *
 * **FOCUS MOVES WITH `preventScroll`.** The row is a `<button>`, and
 * focusing it is what makes the move audible to a screen reader (see
 * components/MessageRow.tsx on the roving-tabindex choice). But
 * `focus()`'s own implicit scroll is the browser's, not `nearest`, and
 * would undo the restraint above — so it is suppressed and the scroll is
 * asked for explicitly, in that order. App.tsx's Back-restore layout
 * effect already uses exactly this pairing for exactly this reason.
 */

/** The attribute components/MessageRow.tsx stamps on its one `<button>`.
 *  Named here rather than spelled inline at three call sites. */
export const ROW_KEY_ATTRIBUTE = 'data-message-key';

/** The selector for one row, with the key escaped — a `messageKey` is
 *  `account_id:uid` and both halves come from the server, so neither is
 *  safe to concatenate into a selector raw. */
export function rowSelector(key: string): string {
  return `[${ROW_KEY_ATTRIBUTE}="${CSS.escape(key)}"]`;
}

/**
 * Focuses and reveals the row for `key`, if it is currently rendered.
 *
 * Silently does nothing when the row is not in the DOM — which is the
 * ordinary case while the reader is open (the list is `hidden`, so its
 * rows are out of the layout, out of the tab order and out of the
 * accessibility tree) and after a folder change whose new list has not
 * rendered yet. A missing row is not an error; it is the cursor pointing
 * at something that is not on screen right now.
 */
export function revealRow(key: string): void {
  if (typeof document === 'undefined') return;
  const row = document.querySelector<HTMLElement>(rowSelector(key));
  if (row === null) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

/**
 * True when a keystroke landed on (or inside) one of the list's message
 * rows.
 *
 * WHAT THIS IS FOR, and it is a bug fix rather than a nicety. Enter on a
 * focused `<button>` is SUPPOSED to fire that button's click, which for a
 * row means opening it — so ./shortcuts.ts originally deferred to the
 * platform and did nothing itself. Live verification found the platform
 * not doing it: focus on the cursor row, a real Enter delivered to the
 * window, `click` never fired, and one of the two documented ways to open
 * a message silently did nothing.
 *
 * Rather than trust it, the rule is narrowed: Enter is deferred only when
 * focus is on an activation element that is NOT a row — "Load more",
 * "Clear search", a sidebar item — where the platform's action is a
 * genuinely different one this app must not duplicate. On a row, both
 * paths produce the identical state (the same message, the same object
 * reference, so React bails on the second update), which makes acting
 * safe whether or not the click ever arrives.
 *
 * The lesson is components/SearchBar.tsx's own, restated: "it cannot
 * reach the other handler" is a fact about today's tree rather than a
 * property anything enforces.
 */
export function isRowTarget(event: KeyEventLike): boolean {
  const node = innermostTarget(event) as { closest?: (selector: string) => unknown } | null | undefined;
  if (node === null || node === undefined || typeof node.closest !== 'function') return false;
  return node.closest(`[${ROW_KEY_ATTRIBUTE}]`) !== null;
}
