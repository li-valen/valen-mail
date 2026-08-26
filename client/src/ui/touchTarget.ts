/**
 * THE HEIGHT A CONTROL NEEDS WHEN A THUMB IS AIMING AT IT.
 *
 * `size="sm"` is `h-8` — 32px, which is comfortable under a mouse and
 * cramped under a finger. Measured across this app at 393x852, every
 * control in the reader and the composer came out 32px or less, and the
 * worst cases are the ones where a mis-tap costs something: Archive sits
 * beside Trash in the reader, and Send sits beside Cancel in the composer.
 *
 * 44px is where Apple's HIG and WCAG 2.5.5 both land. Controls keep their
 * widths, so the only cost is a taller row on a phone.
 *
 * Restored above `lg:`, where the pointer is a mouse and density is worth
 * more than reach. `lg:` rather than `pointer-coarse:` because `lg:` is the
 * axis every other layout decision in this app is expressed in, and one
 * module inventing a second answer to "is this mobile" is how a codebase
 * ends up with two.
 *
 * Lives in ui/ rather than beside its first caller because it is now the
 * answer for the reader AND the composer, and a second copy is how the two
 * drift into disagreeing about what a tap target is.
 */
export const TOUCH_HEIGHT = 'h-11 lg:h-8';

/**
 * The same rule for controls whose height comes from their content rather
 * than a size variant — a chip input, a hand-rolled text button. `min-h-`
 * so content taller than 44px (a recipient field holding three chips) still
 * grows instead of clipping.
 */
export const TOUCH_MIN_HEIGHT = 'min-h-11 lg:min-h-0';

/**
 * IOS ZOOMS THE PAGE WHEN A FOCUSED INPUT'S TEXT IS UNDER 16px.
 *
 * Not a preference — Safari treats a sub-16px field as unreadable and
 * scales the whole viewport to fix it, leaving the user pinching back out
 * after tapping "To". The composer's recipient input was the one field in
 * this app still at `text-sm` (14px) while its neighbours were 16px, so it
 * zoomed and they did not.
 *
 * `lg:text-sm` keeps the denser type on a desktop, where no such scaling
 * happens.
 */
export const TOUCH_INPUT_TEXT = 'text-base lg:text-sm';
