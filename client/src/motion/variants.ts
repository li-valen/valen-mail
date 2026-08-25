import {
  DURATION_MS,
  EASE,
  GROUP_STAGGER_MS,
  LIFT_PX,
  MAX_STAGGERED_GROUPS,
  NAV_PILL_SPRING,
  ROW_ENTER_PX,
  seconds,
  type Bezier,
} from './tokens';

/**
 * Every animation this app performs, as data.
 *
 * ONE FUNCTION SHAPE, EVERYWHERE: `xVariantsFor(isReduced)`. That is not
 * a stylistic preference — it is the mechanism that makes
 * `prefers-reduced-motion` structurally impossible to forget. A component
 * cannot obtain variants without answering the reduced-motion question
 * first, because the answer is the only argument.
 *
 * WHAT "REDUCED" MEANS HERE: the motion is REMOVED, not shortened.
 * Plan 7's Global Constraints are explicit about this, and it is the one
 * place this file deliberately overrides the animation skills' own
 * guidance (which would keep a gentle opacity fade and drop only the
 * transform). Every `*VariantsFor(true)` below returns a pair whose
 * `hidden` and `visible` states are IDENTICAL and final — no transform,
 * no opacity ramp — with `duration: 0`. There is nothing left to see,
 * fast or slow. `isRemoved()` at the bottom is the predicate
 * tests/motion-variants.test.ts checks every builder against, so "reduced
 * merely got faster" fails the suite rather than shipping.
 *
 * WHY `transform` STRINGS AND NOT `y`/`scale`. `motion`'s shorthand
 * transform props are composed on the main thread every frame; the full
 * `transform` string can be handed to the browser's own animation engine
 * and run off it. On a list that repaints while mail is still fetching,
 * that is the difference between a settle and a stutter. Cost: the two
 * ends of a transform animation must have the SAME structure
 * (`translateY(6px)` -> `translateY(0px)`, never `translateY(6px)` ->
 * `none`), which every builder below respects.
 *
 * WHY NO `scale` ANYWHERE. Two reasons, both specific to this app. The
 * surfaces that arrive are large rectangles of TEXT, and a scale tween
 * across text is a half-second of resampled glyphs; and the one element
 * that could take a scale — the sidebar pill — is a `layoutId` shared
 * element, where `motion` already owns the transform.
 */

/** A cubic-bezier tuple or a spring config — the two things a
 *  `transition` can carry here. Structural, not imported from `motion`,
 *  so ./variants.ts stays a pure module the test suite can exercise
 *  without a renderer. */
export interface MotionTransition {
  readonly duration?: number;
  readonly ease?: Bezier;
  readonly staggerChildren?: number;
  readonly type?: 'spring';
  readonly bounce?: number;
}

/** One end of an animation. `transform` and `opacity` ONLY: those two are
 *  the properties that skip layout and paint, and Plan 7 forbids anything
 *  else on a per-frame path. The type is the enforcement — a builder
 *  cannot return a `height` without a compile error. */
export interface MotionTarget {
  /** Present only to satisfy `motion`'s `Target`, which is declared with
   *  a `--${string}` index signature for animating CSS custom properties.
   *  Nothing in this app animates one — a custom property on a parent
   *  recalculates styles for every descendant, which is exactly what a
   *  50-row list cannot afford. */
  readonly [cssVariable: `--${string}`]: string | number;
  readonly opacity?: number;
  readonly transform?: string;
  readonly transition?: MotionTransition;
}

/**
 * The two-state variant pair every builder returns. Named `hidden`/
 * `visible` so a parent's variant label propagates to children (which is
 * what makes the day-group stagger work without per-child wiring).
 *
 * The string index signature is not decoration: `motion`'s own `Variants`
 * type is an index-signature map, and an interface with only named
 * members is not assignable to one. Declaring it here is what lets these
 * builders hand their result straight to a `variants` prop with no cast
 * at the boundary — a cast would be the exact place a `height` could be
 * smuggled past `MotionTarget`.
 */
export interface MotionVariants {
  readonly [label: string]: MotionTarget;
  readonly hidden: MotionTarget;
  readonly visible: MotionTarget;
}

/** The final, at-rest state of anything that LIFTS. `translateY(0px)`,
 *  not `none`: see the file header on matching transform structure. */
const AT_REST: MotionTarget = { opacity: 1, transform: 'translateY(0px)' };

/**
 * The reduced-motion answer for every builder in this file: both ends are
 * the finished state, and the transition has no duration at all.
 *
 * NO `transform` KEY, not even `translateY(0px)`. Two reasons, and the
 * second is a real defect avoided rather than tidiness. A resting
 * transform makes the element a containing block, which un-sticks a
 * `position: sticky` descendant — the opens rail is one. And a viewer who
 * asked for reduced motion should end up with markup that carries no
 * evidence an animation was ever contemplated.
 */
function removedVariants(): MotionVariants {
  return {
    hidden: { opacity: 1 },
    visible: { opacity: 1, transition: { duration: 0 } },
  };
}

/**
 * Content arriving in the content column: a view swap (inbox <-> opens
 * <-> compose), or a freshly-fetched list replacing its skeleton.
 *
 * OPACITY ONLY, DELIBERATELY, when `withLift` is false. A `transform` on
 * an element establishes a containing block, and the Inbox's opens rail
 * is `position: sticky` — a transform left sitting on one of its
 * ancestors after the animation finishes silently un-sticks it. The view
 * swap therefore fades and does not move; the LIFT is applied one level
 * down, inside the message column, where nothing sticky lives beneath it.
 * That constraint is why this is a parameter rather than two hard-coded
 * builders that a future edit could mix up.
 */
export function settleVariantsFor(isReduced: boolean, withLift = true): MotionVariants {
  if (isReduced) return removedVariants();
  const transition = { duration: seconds(DURATION_MS.settle), ease: EASE.out };
  // The fade-only pair carries NO `transform` key at either end — not
  // even an identity one. `transform: translateY(0px)` left resting on
  // the view wrapper is still a containing block, and that is precisely
  // what un-sticks the opens rail beneath it.
  if (!withLift) return { hidden: { opacity: 0 }, visible: { opacity: 1, transition } };
  return {
    hidden: { opacity: 0, transform: `translateY(${LIFT_PX}px)` },
    visible: { ...AT_REST, transition },
  };
}

/**
 * The same settle, plus a cascade across DIRECT children that carry
 * `groupItemVariantsFor` — the inbox list's day groups, never its rows.
 *
 * `groupCount` clamps the cascade: `MAX_STAGGERED_GROUPS` groups of
 * `GROUP_STAGGER_MS` is the most delay this is allowed to add, so a
 * fifty-day list does not turn the arrival of mail into a wipe. Past the
 * cap the stagger is dropped entirely rather than compressed — a
 * two-millisecond stagger is just an expensive way to animate everything
 * at once.
 */
export function settleGroupVariantsFor(isReduced: boolean, groupCount: number): MotionVariants {
  if (isReduced) return removedVariants();
  const isStaggered = groupCount > 1 && groupCount <= MAX_STAGGERED_GROUPS;
  return {
    hidden: { opacity: 0, transform: `translateY(${LIFT_PX}px)` },
    visible: {
      ...AT_REST,
      transition: {
        duration: seconds(DURATION_MS.settle),
        ease: EASE.out,
        ...(isStaggered ? { staggerChildren: seconds(GROUP_STAGGER_MS) } : {}),
      },
    },
  };
}

/**
 * One day group inside a staggered list. Identical in shape to the
 * parent's own pair so `motion` can propagate the `visible` label down
 * without the child declaring `initial`/`animate` of its own.
 */
export function groupItemVariantsFor(isReduced: boolean): MotionVariants {
  if (isReduced) return removedVariants();
  return {
    hidden: { opacity: 0, transform: `translateY(${LIFT_PX}px)` },
    visible: {
      ...AT_REST,
      transition: { duration: seconds(DURATION_MS.settle), ease: EASE.out },
    },
  };
}

/**
 * A whole surface arriving: the reader replacing the list, the composer
 * replacing the view behind it.
 *
 * Same direction and same curve as `settleVariantsFor`, one step slower
 * and one step further, because the thing moving is the size of the
 * column. Deliberately NOT a scale-from-the-trigger: the reader is not
 * anchored to the row that opened it once it has replaced the entire
 * column, and scaling a screenful of body text is the one visual artefact
 * every reviewer notices.
 */
export function panelVariantsFor(isReduced: boolean): MotionVariants {
  if (isReduced) return removedVariants();
  return {
    hidden: { opacity: 0, transform: `translateY(${LIFT_PX}px)` },
    visible: {
      ...AT_REST,
      transition: { duration: seconds(DURATION_MS.panel), ease: EASE.out },
    },
  };
}

/**
 * One GENUINELY-NEW row landing in the opens rail. Enters from above
 * (`ROW_ENTER_PX` is negative) because new events are prepended to the
 * top of the feed — it arrives from the direction it came from.
 *
 * Which rows are "genuinely new" is ./newEntries.ts's job, and the two
 * are meant to be used together: this feed refreshes on a timer, so
 * applying this to every row on every response would re-animate the whole
 * list every poll.
 */
export function railRowVariantsFor(isReduced: boolean): MotionVariants {
  if (isReduced) return removedVariants();
  return {
    hidden: { opacity: 0, transform: `translateY(${ROW_ENTER_PX}px)` },
    visible: {
      ...AT_REST,
      transition: { duration: seconds(DURATION_MS.row), ease: EASE.out },
    },
  };
}

/**
 * The sidebar's selection pill — a `layoutId` shared element, so there
 * are no variants to return, only the transition that carries it from
 * the old nav item to the new one.
 *
 * Reduced motion gets `{ duration: 0 }`: the pill is simply already at
 * the newly-selected item on the next frame. Not a faster spring — no
 * spring.
 */
export function navPillTransitionFor(isReduced: boolean): MotionTransition {
  if (isReduced) return { duration: 0 };
  return { ...NAV_PILL_SPRING };
}

/**
 * The predicate the guard test holds every builder to: a target is
 * "removed" when it moves nothing and fades nothing.
 *
 * Exported rather than kept inside the test because it is the DEFINITION
 * of the project's reduced-motion contract, and a definition that lives
 * only in a test file is one that call sites cannot check against.
 */
export function isRemoved(variants: MotionVariants): boolean {
  const { hidden, visible } = variants;
  if (hidden.transform !== visible.transform) return false;
  if (hidden.opacity !== visible.opacity) return false;
  // A non-zero duration on an identical pair would still be a no-op
  // visually, but it would mean a builder had "shortened" rather than
  // removed — exactly the failure this contract exists to catch.
  return (visible.transition?.duration ?? 0) === 0;
}
