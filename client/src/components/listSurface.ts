/**
 * The two class recipes every ROW LIST in this app shares: the inbox
 * list, the reader's attachment list, and the reader's thread context.
 *
 * Extracted from InboxList.tsx, which is where they were written and
 * where the decision behind them was made. Nothing about them is
 * inbox-specific, and the reader task ("Try to remove the outline borders
 * where possible makes it look janky") is exactly the request to apply
 * the same treatment to the other two — so they live in one place rather
 * than being pasted into three.
 *
 * A `.ts` module of strings rather than a component: the surface is an
 * override applied to the `Card` atom at each call site, so there is
 * still one place the desktop card's values are written down (ui/Card.tsx)
 * and one place the responsive override is (here).
 */

/**
 * The list surface, at two breakpoints.
 *
 * Above `lg:` it is the bordered, shadowed `Card` the inbox has always
 * been — the desktop treatment the user looked at and said *"it looks
 * pretty decent on mac"*, so it is deliberately unchanged. Below `lg:`
 * there is no card at all: no border, no shadow, no ground of its own,
 * because the user's Gmail-mobile reference separates rows with
 * whitespace and nothing else — *"dont do the outlined rectangles for the
 * inbox, have it be fluid, no lines and rounded"*.
 */
export const LIST_SURFACE =
  'rounded-none border-0 bg-transparent shadow-none lg:rounded-lg lg:border lg:bg-card lg:shadow-sm';

/** The hairlines between rows, desktop only, for the same reason. */
export const LIST_DIVIDERS = 'lg:divide-y lg:divide-neutral-100 dark:lg:divide-border';
