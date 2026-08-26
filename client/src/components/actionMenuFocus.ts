/**
 * The keyboard behaviour of the reader's overflow menu, as arithmetic.
 *
 * Split out of MessageActionsMenu.tsx for the reason every other `.ts`
 * beside a `.tsx` in this directory is: client/CLAUDE.md forbids rendering
 * a component in a test, so anything that has to be VERIFIED must be
 * framework-free. A menu's focus movement is exactly the sort of thing
 * that looks obvious and is wrong at the ends.
 */

/** Which keys move focus inside an open menu. */
export type MenuKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * Where focus goes next.
 *
 * **WRAPS AT BOTH ENDS, on purpose.** WAI-ARIA's menu pattern says a menu
 * wraps: Down from the last item returns to the first. Clamping instead
 * strands a thumb or an arrow key at the bottom of a three-item menu with
 * no feedback, which reads as the control being broken rather than as
 * having reached an edge.
 *
 * `current` may be -1, meaning "nothing focused yet" — the state the menu
 * opens in when it was opened by pointer rather than by keyboard. Down
 * then lands on the first item and Up on the last, which is what makes a
 * mouse user's first arrow press do something sensible.
 */
export function nextFocusIndex(current: number, key: MenuKey, count: number): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
  }
}

/** The keys this menu handles, so the component can test membership without
 *  repeating the list and drifting from `nextFocusIndex`. */
export function isMenuKey(key: string): key is MenuKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}
