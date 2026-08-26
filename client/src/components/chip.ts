/**
 * The chip recipe shared by the composer's two chip lists — recipient
 * addresses (./RecipientField.tsx) and attached files (./Compose.tsx) —
 * and by the search interpretation line (./InboxList.tsx).
 *
 * A `.ts` module of class strings rather than a component, following
 * ./listSurface.ts's precedent exactly — the chips differ in what they
 * hold and how wide they may grow, so there is no one component to share,
 * but the SHAPE and the PALETTE are one decision and belong in one place.
 *
 * They were written in RecipientField.tsx and moved here when the file
 * chips needed the same treatment. The palette reasoning is the load-
 * bearing part: semantic tokens throughout, so the chips follow the
 * palette in both colour schemes with no light literal to pair a dark one
 * against — the failure mode client/CLAUDE.md's standing constraint calls
 * out, where a colour defined only in one scheme renders one theme's text
 * on the other theme's ground.
 */
export const CHIP_BASE =
  'inline-flex max-w-full items-center gap-1 rounded-md border py-0.5 pl-2 pr-0.5 text-xs font-medium';

/** The ordinary chip. */
export const CHIP_NEUTRAL = 'border-border bg-secondary text-secondary-foreground';

/** A chip that cannot be sent — an unusable address, or one a send failed
 *  to reach. Explicit light AND dark reds: no semantic token carries a
 *  "subtle destructive" role (see ../ui/Alert.tsx's note on the same gap). */
export const CHIP_BAD =
  'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200';

/** The chip's own remove control: a 20px hit target that dims until
 *  hovered or focused, so a list of chips reads as text rather than as a
 *  row of buttons. */
export const CHIP_REMOVE =
  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed';

/**
 * A secondary value inside a chip — the file size beside a filename.
 *
 * `text-secondary-foreground/70` rather than `text-muted-foreground`, and
 * that is a measured decision, not a taste one: muted-foreground is toned
 * for the page ground, and on the chip's own `bg-secondary` it measures
 * **4.34:1 at 12px** — under WCAG AA's 4.5:1 for normal text. Caught in
 * the browser, not by the suite. Fading the chip's OWN foreground keeps
 * the hierarchy and the ratio, and does it with one token, so there is no
 * light literal for a dark one to drift away from.
 */
export const CHIP_SECONDARY = 'shrink-0 text-secondary-foreground/70';

/**
 * A READ-ONLY chip — the search interpretation line's filter pills.
 *
 * Same shape and the same palette as CHIP_BASE + CHIP_NEUTRAL above, with
 * symmetric horizontal padding: `CHIP_BASE`'s `pr-0.5` exists to leave
 * room for CHIP_REMOVE, and a chip with no remove control that keeps it
 * reads as visually broken on the right edge.
 */
export const CHIP_STATIC =
  'inline-flex max-w-full items-center rounded-md border border-border bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground';

/**
 * The same line's LITERAL terms — the part of a query that is being
 * searched for as characters rather than applied as a filter, whether
 * because it is an ordinary word or because it is a `before:yesterday`
 * the grammar could not read.
 *
 * Deliberately NOT a pill. The whole signal that `before:yesterday` did
 * not become a date filter is that it does not look like the chips
 * beside it — a difference the eye reads in one pass, and the only way
 * to say it that respects the user's standing "i dont need any liek side
 * notes".
 *
 * `text-neutral-700 dark:text-muted-foreground` rather than the token
 * alone, matching the search banner this sits under: that exact pairing
 * was chosen by measuring rendered pixels against this surface, and
 * `text-muted-foreground` on its own falls under WCAG AA in the light
 * scheme here.
 */
export const CHIP_LITERAL =
  'inline-flex max-w-full items-center px-1 py-0.5 text-xs text-neutral-700 dark:text-muted-foreground';
