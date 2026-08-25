import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

import { panelVariantsFor } from './variants';

/**
 * A whole surface arriving: the reader replacing the mail list, the
 * composer replacing the view behind it.
 *
 * WHY THIS IS NOT `<Settle>`. Same direction, same curve, one step
 * further and one step slower (200ms against 180ms, see
 * src/motion/tokens.ts). The difference is deliberate and physical: the
 * thing arriving is the size of the whole column, and large surfaces that
 * move at small-surface speed read as flicked into place rather than set
 * down. Two names rather than a `size` prop because the call sites are
 * genuinely different surfaces, not two settings of one.
 *
 * WHY NO SCALE, and no scale-from-the-trigger. Both would be defensible
 * for a popover and are wrong here. The reader is not anchored to the row
 * that opened it — it has REPLACED the entire column that row was in, so
 * there is no trigger left on screen to scale from; and a scale tween
 * across a screenful of body text resamples every glyph for the length of
 * the animation, which is the one artefact reviewers always catch.
 *
 * ENTRANCE ONLY — there is no matching exit, and that asymmetry is
 * argued rather than forgotten. Closing the reader returns the user to a
 * list that was never unmounted, at a scroll offset App.tsx restores in a
 * layout effect during the same commit. Animating that return would put
 * a fade in front of mail the user already had, and would run against a
 * scroll restore happening in the same frame. Back is instant, on
 * purpose. (Flagged in the task report as the one call worth a second
 * opinion.)
 *
 * REDUCED MOTION: read here, once, and handed to `panelVariantsFor`,
 * which answers with a pair whose two ends are identical — the motion is
 * removed, not shortened.
 */

export interface PanelProps {
  readonly className?: string;
  readonly children: ReactNode;
}

export function Panel({ className, children }: PanelProps) {
  const isReduced = useReducedMotion() ?? false;
  return (
    <motion.div className={className} variants={panelVariantsFor(isReduced)} initial="hidden" animate="visible">
      {children}
    </motion.div>
  );
}
