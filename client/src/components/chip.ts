/**
 * The chip recipe shared by the composer's two chip lists: recipient
 * addresses (./RecipientField.tsx) and attached files (./Compose.tsx).
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
