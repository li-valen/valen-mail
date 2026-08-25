import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

import { groupItemVariantsFor, settleGroupVariantsFor, settleVariantsFor } from './variants';

/**
 * "This content just arrived" — the single most-used gesture in the app,
 * extracted so that the four surfaces which need it cannot drift into
 * four slightly different fades.
 *
 * HOW IT REPLACES A HARD CUT WITHOUT DELAYING MAIL. There is no exit
 * animation and no `AnimatePresence`: the outgoing content is gone in the
 * same commit the incoming content mounts, exactly as it is today. All
 * this adds is 180ms of the NEW content resolving into place. A
 * wait-then-enter sequence would have cost the sum of both, and Plan 7 is
 * explicit that nothing may delay the user seeing their mail.
 *
 * INTERRUPTION. The caller re-keys this component when the selection
 * changes, so a second click mid-settle unmounts the first instance
 * outright and mounts a second at its own starting state. There is no
 * queue to jam and no half-finished tween to fight — the failure mode
 * behind "click a second sidebar item and it goes weird" cannot occur,
 * because the first animation no longer exists.
 *
 * REDUCED MOTION. `useReducedMotion` is read HERE, once, and handed to
 * the builders in ./variants.ts, which answer with a pair whose two ends
 * are identical. Nothing about the reduced path is a shorter version of
 * the normal one. tests/motion-reduced-guard.test.ts fails the build if
 * any component that imports `motion/react` skips this step.
 */

export interface SettleProps {
  /**
   * Whether the content travels as well as fades.
   *
   * FALSE IS NOT COSMETIC. A `transform` left on an element makes it a
   * containing block, and the Inbox's opens rail is `position: sticky`
   * beneath the view-swap wrapper — a resting `translateY(0px)` on one of
   * its ancestors un-sticks it permanently. The outermost wrapper
   * therefore fades only, and the lift is applied inside the message
   * column, which has nothing sticky under it. See
   * ./variants.ts's `settleVariantsFor`.
   */
  readonly lift?: boolean;
  /**
   * When set, direct `<SettleGroup>` children cascade instead of arriving
   * together. Pass the number of groups — the builder drops the stagger
   * above a cap rather than compressing it, so a long list cannot turn
   * into a wipe. Never pass a ROW count: rows do not stagger.
   */
  readonly groupCount?: number;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Settle({ lift = true, groupCount, className, children }: SettleProps) {
  const isReduced = useReducedMotion() ?? false;
  const variants =
    groupCount === undefined
      ? settleVariantsFor(isReduced, lift)
      : settleGroupVariantsFor(isReduced, groupCount);

  return (
    <motion.div className={className} variants={variants} initial="hidden" animate="visible">
      {children}
    </motion.div>
  );
}

export interface SettleGroupProps {
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * One cascading child of a `<Settle groupCount={n}>`.
 *
 * Declares no `initial`/`animate` of its own on purpose: `motion`
 * propagates the parent's variant LABEL down to child motion components,
 * and the parent's `staggerChildren` is what turns that propagation into
 * a cascade. Setting them here would sever the link and make every group
 * animate at once.
 */
export function SettleGroup({ className, children }: SettleGroupProps) {
  const isReduced = useReducedMotion() ?? false;
  return (
    <motion.div className={className} variants={groupItemVariantsFor(isReduced)}>
      {children}
    </motion.div>
  );
}
