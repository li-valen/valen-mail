import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

import { closingRowTransitionFor } from './variants';

/**
 * THE LIST CLOSING over a row that has just been archived or trashed.
 *
 * `<Settle>` and `<Panel>` both animate arrival and say so in their own
 * headers: the outgoing content is gone in the same commit the incoming
 * content mounts. That is right for a view swap, where the thing leaving
 * is a screen the user has finished with. It left the ONE removal that is
 * the direct answer to a click — a row being archived — with nothing to
 * land on: *"it's, like, almost instant. It's, like, weird."*
 *
 * WHY THIS IS A SLIDE AND NOT AN EXIT ANIMATION. The obvious answer is
 * `<AnimatePresence exit>` on the row, and it was written, run in a real
 * browser, and removed. Two independent reasons, both found there and
 * neither visible to the suite:
 *
 *  - A row lives inside `<SettleGroup>`, itself a `motion` component, so
 *    the row is a variant CHILD — and `motion` leaves a variant child's
 *    exit to the ROOT of its tree, which here is the day group and is not
 *    the thing being removed. The archived row's exit never ran; because
 *    `AnimatePresence` unmounts on exit COMPLETION, the row stayed in the
 *    DOM, leaving a one-row hole in the card on every single archive.
 *  - Even for a surface that IS its own variant root — the bulk bar, the
 *    one place this could have worked — `AnimatePresence` under React's
 *    `<StrictMode>` (src/main.tsx) double-invokes the presence
 *    registration and `onExitComplete` never resolves. The cleared bulk
 *    bar stayed on screen, fully opaque and fully interactive, still
 *    reading "1 selected" after the selection was gone. An orphaned
 *    toolbar lying about the user's selection is far worse than no exit
 *    animation, and no aesthetic gain buys it.
 *
 * So nothing in this app waits to be removed. What is animated instead is
 * the part of an archive the eye actually follows: everything BENEATH the
 * row, gliding up into the gap.
 */

export interface ClosingRowProps {
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A list row that lets the list close over it rather than snap shut.
 *
 * The row itself is not animated: it is removed the moment
 * src/mailboxActions.ts hides it optimistically, exactly as before, and
 * that hide and its rollback are untouched. `layout` has `motion` measure
 * each row before and after the commit and animate the difference, so the
 * rows below glide into the gap instead of jumping into it.
 *
 * `"position"` AND NOT `true`: a row never changes SIZE, only where it
 * is, and measuring size as well would have `motion` correcting a
 * dimension that never moves — on every row, on every commit.
 *
 * A TRANSFORM, NOT A HEIGHT. `MotionTarget` in ./variants.ts refuses
 * `height` on purpose — a height tween is a layout pass per frame and
 * this list holds fifty rows. FLIP reaches the same visual result using
 * the one property that skips layout entirely.
 *
 * REDUCED MOTION switches `layout` off outright rather than shortening
 * it: a FLIP slide is movement whatever produced it, and the answer
 * everywhere in this system is removal, not speed. Reading the preference
 * here is also what lets InboxList stay free of any `motion/react` import
 * of its own.
 */
export function ClosingRow({ className, children }: ClosingRowProps) {
  const isReduced = useReducedMotion() ?? false;
  return (
    <motion.li
      className={className}
      layout={isReduced ? false : 'position'}
      transition={closingRowTransitionFor(isReduced)}
    >
      {children}
    </motion.li>
  );
}
