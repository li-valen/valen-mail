import { describe, expect, it } from 'vitest';

import {
  barVariantsFor,
  groupItemVariantsFor,
  isRemoved,
  navPillTransitionFor,
  panelVariantsFor,
  railRowVariantsFor,
  closingRowTransitionFor,
  settleGroupVariantsFor,
  settleVariantsFor,
  type MotionTarget,
  type MotionVariants,
} from '../src/motion/variants';
import {
  BAR_ENTER_PX,
  DURATION_MS,
  EASE,
  LIFT_PX,
  MAX_DURATION_MS,
  MAX_STAGGERED_GROUPS,
  MIN_DURATION_MS,
  ROW_ENTER_PX,
  seconds,
} from '../src/motion/tokens';
import { scanNewEntries } from '../src/motion/newEntries';

/**
 * The reduced-motion contract, and the "transform and opacity only" rule,
 * both as executable statements rather than as prose in a doc comment.
 *
 * THE CONTRACT: `prefers-reduced-motion: reduce` REMOVES the motion. It
 * does not shorten it, and a suite that only asserted "the reduced
 * duration is smaller" would pass a 20ms slide, which is still a slide.
 * The predicate every builder is held to is `isRemoved` — exported from
 * src/motion/variants.ts rather than defined here, because it is the
 * DEFINITION of the contract and a definition that lives only in a test
 * is one call sites cannot check themselves against.
 */

/** Every builder in the module, so a new one cannot be added without
 *  either appearing here or making this list obviously stale. */
const BUILDERS: ReadonlyArray<{
  readonly name: string;
  readonly build: (isReduced: boolean) => MotionVariants;
}> = [
  { name: 'settleVariantsFor (lift)', build: (r) => settleVariantsFor(r) },
  { name: 'settleVariantsFor (fade only)', build: (r) => settleVariantsFor(r, false) },
  { name: 'settleGroupVariantsFor', build: (r) => settleGroupVariantsFor(r, 3) },
  { name: 'groupItemVariantsFor', build: (r) => groupItemVariantsFor(r) },
  { name: 'panelVariantsFor', build: (r) => panelVariantsFor(r) },
  { name: 'railRowVariantsFor', build: (r) => railRowVariantsFor(r) },
  { name: 'barVariantsFor', build: (r) => barVariantsFor(r) },
];

/** The properties this project is allowed to animate, plus the
 *  `transition` bag. Anything else in a target is a defect: `height`,
 *  `width`, `top` and `margin` all force layout, and Plan 7 bans them on
 *  a list of 50+ rows. */
const ALLOWED_TARGET_KEYS = new Set(['opacity', 'transform', 'transition']);

function targetsOf(variants: MotionVariants): readonly MotionTarget[] {
  return [variants.hidden, variants.visible];
}

describe('reduced motion REMOVES the animation rather than shortening it', () => {
  it.each(BUILDERS)('$name: both ends are identical and the duration is zero', ({ build }) => {
    const reduced = build(true);
    expect(isRemoved(reduced)).toBe(true);
    expect(reduced.hidden).toEqual({ opacity: 1 });
    expect(reduced.visible.transition?.duration).toBe(0);
  });

  it.each(BUILDERS)('$name: the reduced pair carries no transform at all', ({ build }) => {
    // Not even an identity `translateY(0px)`. A resting transform makes
    // the element a containing block, which un-sticks a `position:
    // sticky` descendant — the opens rail is one — and it leaves markup
    // that claims an animation was contemplated for a viewer who asked
    // for none.
    for (const target of targetsOf(build(true))) {
      expect(target.transform).toBeUndefined();
    }
  });

  it.each(BUILDERS)('$name: the FULL-motion pair is genuinely not removed (the check can fail)', ({ build }) => {
    // Non-vacuity. Without this, a bug that made every builder return
    // the reduced pair unconditionally would leave the suite green.
    expect(isRemoved(build(false))).toBe(false);
  });

  it('isRemoved rejects a pair that merely got faster', () => {
    const shortened: MotionVariants = {
      hidden: { opacity: 0, transform: 'translateY(6px)' },
      visible: { opacity: 1, transform: 'translateY(0px)', transition: { duration: 0.02 } },
    };
    expect(isRemoved(shortened)).toBe(false);
  });

  it('isRemoved rejects a pair that stopped moving but kept fading', () => {
    // A 200ms opacity ramp is still an animation. The animation skills'
    // own guidance would permit it; Plan 7's Global Constraints do not,
    // and the project constraint wins.
    const stillFading: MotionVariants = {
      hidden: { opacity: 0 },
      visible: { opacity: 1, transition: { duration: 0.2 } },
    };
    expect(isRemoved(stillFading)).toBe(false);
  });

  it('the nav pill transition is a spring at full motion and nothing at all when reduced', () => {
    expect(navPillTransitionFor(false).type).toBe('spring');
    expect(navPillTransitionFor(true)).toEqual({ duration: 0 });
    expect(navPillTransitionFor(true).type).toBeUndefined();
  });
});

describe('only transform and opacity are ever animated', () => {
  it.each(BUILDERS)('$name: no target names a layout-triggering property', ({ build }) => {
    for (const isReduced of [false, true]) {
      for (const target of targetsOf(build(isReduced))) {
        for (const key of Object.keys(target)) {
          expect(ALLOWED_TARGET_KEYS.has(key)).toBe(true);
        }
      }
    }
  });

  it.each(BUILDERS)('$name: every transform is a translate, never a scale', ({ build }) => {
    // Scale is not banned in principle; it is banned HERE. Every surface
    // this system animates is a rectangle of text, and a scale tween
    // resamples every glyph for the length of the animation.
    for (const target of targetsOf(build(false))) {
      if (target.transform === undefined) continue;
      expect(target.transform).toMatch(/^translateY\(-?\d+px\)$/);
    }
  });

  it.each(BUILDERS)('$name: both ends of a transform have the SAME structure', ({ build }) => {
    // `translateY(6px)` -> `none` does not interpolate. Either both ends
    // carry a translateY or neither does.
    const variants = build(false);
    expect(variants.hidden.transform === undefined).toBe(variants.visible.transform === undefined);
  });

  it('never animates a CSS custom property', () => {
    // A custom property set on a parent recalculates styles for every
    // descendant — the one thing a 50-row list cannot afford. The type
    // permits it (motion's own Target requires the index signature); the
    // builders must not use it.
    for (const { build } of BUILDERS) {
      for (const target of targetsOf(build(false))) {
        expect(Object.keys(target).some((key) => key.startsWith('--'))).toBe(false);
      }
    }
  });
});

describe('the settle builders', () => {
  it('lifts by LIFT_PX and lands at zero', () => {
    const variants = settleVariantsFor(false);
    expect(variants.hidden.transform).toBe(`translateY(${LIFT_PX}px)`);
    expect(variants.visible.transform).toBe('translateY(0px)');
    expect(variants.visible.transition?.duration).toBe(seconds(DURATION_MS.settle));
  });

  it('drops the transform entirely in fade-only mode, so it cannot un-stick the opens rail', () => {
    const variants = settleVariantsFor(false, false);
    expect(variants.hidden).toEqual({ opacity: 0 });
    expect(variants.visible.transform).toBeUndefined();
    expect(variants.visible.opacity).toBe(1);
  });

  it('a panel travels the same distance as a settle but takes longer, because it is bigger', () => {
    expect(panelVariantsFor(false).visible.transition?.duration).toBe(seconds(DURATION_MS.panel));
    expect(panelVariantsFor(false).hidden.transform).toBe(settleVariantsFor(false).hidden.transform);
    expect(DURATION_MS.panel).toBeGreaterThan(DURATION_MS.settle);
  });

  it('a new opens row enters from above', () => {
    expect(railRowVariantsFor(false).hidden.transform).toBe(`translateY(${ROW_ENTER_PX}px)`);
    expect(railRowVariantsFor(false).visible.transition?.duration).toBe(seconds(DURATION_MS.row));
  });
});

/**
 * THE LIST CLOSING over an archived row, which is a `layout` slide rather
 * than an exit — and the reason it is a slide is a finding from the
 * browser, not a preference.
 *
 * An inbox row sits inside `<SettleGroup>`, itself a `motion` component,
 * which makes the row a variant CHILD; `motion` leaves a variant child's
 * exit to the root of its tree, and that root (the day group) is not the
 * thing being removed. An `<AnimatePresence>` exit on the rows therefore
 * never completed, and because `AnimatePresence` unmounts on completion,
 * every archived row stayed in the DOM leaving a one-row hole in the
 * card. The whole suite was green throughout.
 *
 * What survives is the half that works and is the half the eye follows:
 * the rows BENEATH the archived one gliding up into the gap.
 */
describe('the list closes over an archived row instead of snapping shut', () => {
  it('slides at the content-arriving speed', () => {
    // The list closing is content arriving, seen from the other side.
    expect(closingRowTransitionFor(false).duration).toBe(seconds(DURATION_MS.settle));
    expect(closingRowTransitionFor(false).ease).toEqual(EASE.out);
  });

  it('reduced motion removes the slide rather than shortening it', () => {
    // Same contract as every builder above: the rows are simply already
    // in their new places on the next frame.
    expect(closingRowTransitionFor(true)).toEqual({ duration: 0 });
    expect(closingRowTransitionFor(true).ease).toBeUndefined();
  });

  it('is genuinely not removed at full motion (the check above can fail)', () => {
    expect(closingRowTransitionFor(false).duration).toBeGreaterThan(0);
  });
});

describe('the bulk action bar arrives from the top of its own column', () => {
  it('enters from above, like the drawer and the rail rows', () => {
    expect(BAR_ENTER_PX).toBeLessThan(0);
    expect(barVariantsFor(false).hidden.transform).toBe(`translateY(${BAR_ENTER_PX}px)`);
    expect(barVariantsFor(false).visible.transform).toBe('translateY(0px)');
  });

  it('has no exit half, and that is deliberate rather than missing', () => {
    // `AnimatePresence` under React's <StrictMode> left the CLEARED bar
    // on screen, opaque and interactive, still reading "1 selected" —
    // see src/motion/ClosingRow.tsx. The bar appears because the user ticked
    // something and needs to see it registered; it goes because the user
    // cleared the selection, which needs no slow confirmation back.
    // `hidden` is therefore an entrance's starting point only.
    expect(Object.keys(barVariantsFor(false)).sort()).toEqual(['hidden', 'visible']);
  });

  it('travels the same distance as a new opens row, because it is the same idea', () => {
    // Two unsolicited surfaces entering from the top of their column.
    // Stated as an agreement rather than derived, so retuning one is a
    // visible decision about the other.
    expect(BAR_ENTER_PX).toBe(ROW_ENTER_PX);
  });

  it('settles at the content-arriving speed, inside the band', () => {
    const duration = barVariantsFor(false).visible.transition?.duration;
    expect(duration).toBe(seconds(DURATION_MS.settle));
    expect(DURATION_MS.settle).toBeGreaterThanOrEqual(MIN_DURATION_MS);
    expect(DURATION_MS.settle).toBeLessThanOrEqual(MAX_DURATION_MS);
  });
});

describe('the day-group stagger is capped rather than compressed', () => {
  it('staggers a handful of groups', () => {
    const variants = settleGroupVariantsFor(false, 3);
    expect(variants.visible.transition?.staggerChildren).toBe(0.035);
  });

  it('does not stagger a single group — there is nothing to cascade', () => {
    expect(settleGroupVariantsFor(false, 1).visible.transition?.staggerChildren).toBeUndefined();
    expect(settleGroupVariantsFor(false, 0).visible.transition?.staggerChildren).toBeUndefined();
  });

  it('drops the stagger past the cap instead of shrinking it to nothing', () => {
    // A two-millisecond stagger is an expensive way to animate
    // everything at once. Past the cap the whole list arrives together.
    expect(settleGroupVariantsFor(false, MAX_STAGGERED_GROUPS).visible.transition?.staggerChildren).toBe(
      0.035,
    );
    expect(
      settleGroupVariantsFor(false, MAX_STAGGERED_GROUPS + 1).visible.transition?.staggerChildren,
    ).toBeUndefined();
    expect(settleGroupVariantsFor(false, 50).visible.transition?.staggerChildren).toBeUndefined();
  });

  it('never staggers under reduced motion, at any group count', () => {
    for (const count of [1, 3, MAX_STAGGERED_GROUPS, 50]) {
      expect(settleGroupVariantsFor(true, count).visible.transition?.staggerChildren).toBeUndefined();
    }
  });
});

describe('scanNewEntries: only genuinely-new rows may animate', () => {
  it('reports nothing as new on the first scan, and records everything', () => {
    // The initial response is fifty rows arriving at once. Fifty
    // individual entrances is the opposite of "only new rows animate",
    // so the first scan animates none of them and the panel gets one
    // entrance instead.
    const scan = scanNewEntries(null, ['a', 'b', 'c']);
    expect([...scan.newKeys]).toEqual([]);
    expect([...scan.seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports only the keys it has never seen', () => {
    const first = scanNewEntries(null, ['a', 'b']);
    const second = scanNewEntries(first.seen, ['c', 'a', 'b']);
    expect([...second.newKeys]).toEqual(['c']);
    expect([...second.seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('re-delivering the identical list marks nothing new — the poll must not re-animate', () => {
    const first = scanNewEntries(null, ['a', 'b']);
    const second = scanNewEntries(first.seen, ['a', 'b']);
    expect(second.newKeys.size).toBe(0);
    // Same SET back, not a copy: a call site memoising on the scan's
    // identity must not be re-run by a poll that changed nothing.
    expect(second.seen).toBe(first.seen);
  });

  it('never re-animates an event that fell out of the window and came back', () => {
    const first = scanNewEntries(null, ['a', 'b', 'c']);
    const narrowed = scanNewEntries(first.seen, ['a', 'b']);
    const widened = scanNewEntries(narrowed.seen, ['a', 'b', 'c']);
    expect(widened.newKeys.size).toBe(0);
  });

  it('treats a prepended event as new no matter where the others moved', () => {
    // The index-key defect, stated as a test: every key here shifts
    // position between the two scans, and exactly one of them is new.
    const first = scanNewEntries(null, ['e2', 'e1']);
    const second = scanNewEntries(first.seen, ['e3', 'e2', 'e1']);
    expect([...second.newKeys]).toEqual(['e3']);
  });

  it('handles an empty feed without inventing a new row', () => {
    const first = scanNewEntries(null, []);
    expect(first.newKeys.size).toBe(0);
    expect(first.seen.size).toBe(0);
    const second = scanNewEntries(first.seen, []);
    expect(second.newKeys.size).toBe(0);
  });

  it('does not mutate the set it was handed', () => {
    const seen: ReadonlySet<string> = new Set(['a']);
    scanNewEntries(seen, ['a', 'b']);
    expect([...seen]).toEqual(['a']);
  });
});

/**
 * TRANSFORMS COMPOSE; the tokens must therefore be read as a TOTAL.
 *
 * `<Settle groupCount>` renders a `motion.div` whose direct
 * `<SettleGroup>` children are also `motion.div`s, and a `translateY` on
 * both puts the child at the SUM of the two — 12px of travel from a
 * system that says 6. Caught in the motion review of Plan 7 Task 2 and
 * fixed by giving the orchestrating parent no transform at all, which is
 * what these two assertions hold in place.
 */
describe('a staggered group entrance travels LIFT_PX in total, not twice it', () => {
  it('the orchestrating parent contributes no transform of its own', () => {
    const parent = settleGroupVariantsFor(false, 3);
    expect(parent.hidden.transform).toBeUndefined();
    expect(parent.visible.transform).toBeUndefined();
  });

  it('the group itself carries the whole lift', () => {
    expect(groupItemVariantsFor(false).hidden.transform).toBe(`translateY(${LIFT_PX}px)`);
    expect(groupItemVariantsFor(false).visible.transform).toBe('translateY(0px)');
  });
});
