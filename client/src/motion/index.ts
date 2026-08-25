/**
 * The motion layer's one public entry point.
 *
 * Components import from `../motion`, never from `../motion/tokens` or
 * `../motion/variants` directly, so retuning the system stays a change to
 * these four files rather than a grep across the tree. `motion/react`
 * itself is imported directly by the handful of components that need a
 * bespoke animation (the sidebar's shared-element pill, the opens rail's
 * per-row entrance) — those are listed in
 * tests/motion-reduced-guard.test.ts's scan, which is what keeps each of
 * them honest about `prefers-reduced-motion`.
 */

export { Settle, SettleGroup } from './Settle';
export type { SettleProps, SettleGroupProps } from './Settle';

export { Panel } from './Panel';
export type { PanelProps } from './Panel';

export {
  DURATION_MS,
  EASE,
  EASE_CSS,
  EASE_CSS_VARIABLE,
  GROUP_STAGGER_MS,
  LIFT_PX,
  MAX_DURATION_MS,
  MAX_STAGGERED_GROUPS,
  MIN_DURATION_MS,
  NAV_PILL_SPRING,
  ROW_ENTER_PX,
  seconds,
} from './tokens';
export type { Bezier, DurationName } from './tokens';

export {
  groupItemVariantsFor,
  isRemoved,
  navPillTransitionFor,
  panelVariantsFor,
  railRowVariantsFor,
  settleGroupVariantsFor,
  settleVariantsFor,
} from './variants';
export type { MotionTarget, MotionTransition, MotionVariants } from './variants';

export { scanNewEntries } from './newEntries';
export type { NewEntryScan } from './newEntries';
