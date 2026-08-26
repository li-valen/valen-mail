/**
 * The motion vocabulary: every duration, curve and distance this app is
 * allowed to animate with, in one file.
 *
 * WHY A TOKEN FILE AT ALL. Motion values drift the way colour literals
 * drift — a 200ms here, a 240ms there, three slightly different ease-outs
 * — and the result reads as several apps stitched together rather than
 * one. The rule this file enforces is the same one src/styles.css
 * enforces for colour: components name a ROLE, never a number.
 *
 * NAMED BY ROLE, NOT BY NUMBER. `DURATION_MS.settle`, not
 * `DURATION_MS.d180`. Retuning "content arriving in the column" is then
 * one edit here rather than a grep for `0.18` across the tree, and a
 * reviewer can tell from the call site what a value is FOR.
 *
 * THE BAND. Plan 7's Global Constraints put UI feedback in 120–260ms and
 * cap everything at 400ms. Every value below is inside 120–260, and
 * `MAX_DURATION_MS` is set to 260 rather than 400 — a deliberately
 * stricter ceiling than the brief's, because the user's complaint was
 * "make it very smooth", not "make it slow", and 400ms of chrome between
 * a click and the mail is its own kind of broken. tests/motion-tokens.
 * test.ts fails if any value here escapes the band.
 *
 * SECONDS AND MILLISECONDS BOTH. `motion` takes seconds; CSS and the
 * Tailwind `duration-[…]` utilities take milliseconds. Milliseconds are
 * the source of truth here and `seconds()` derives the other, so the two
 * halves of the app cannot disagree by a rounding error.
 *
 * THE CURVES ARE MIRRORED IN CSS. `EASE_CSS` below and the `--ease-*`
 * custom properties in src/styles.css's `@theme` block are the same three
 * curves; tests/motion-tokens.test.ts parses the stylesheet and fails if
 * they ever diverge. That is what lets the mobile drawer (a CSS
 * transition, because a class toggle is the cheapest tool that works) and
 * the reader panel (a `motion` animation, because it needs an entrance on
 * mount) share one motion identity instead of being two systems that
 * happen to look similar.
 */

/**
 * A cubic-bezier control-point tuple in `motion`'s own shape.
 *
 * Deliberately NOT `readonly`: `motion`'s `Transition['ease']` is a
 * mutable `[number, number, number, number]`, and a `readonly` tuple does
 * not assign to it. Nothing mutates these — every consumer goes through
 * the `*VariantsFor()` builders in ./variants.ts, which construct a fresh
 * object per call rather than handing out a shared one.
 */
export type Bezier = [number, number, number, number];

/**
 * Three curves, and only three.
 *
 *  - `out` — the strong ease-out. Everything that ENTERS or LEAVES uses
 *    this: it starts fast, so the movement is already well underway in
 *    the frames the user is watching most closely. Never `ease-in` on UI;
 *    it withholds motion at exactly the wrong moment and reads as lag
 *    even at an identical duration.
 *  - `inOut` — the strong ease-in-out, for something already on screen
 *    MOVING to a new place. Nothing uses it today (the one on-screen
 *    move, the sidebar's selection pill, is a spring instead — see
 *    `NAV_PILL_SPRING`); it is here because the next such surface should
 *    reach for this rather than inventing a fourth curve.
 *  - `drawer` — the iOS/Ionic drawer curve, for the one panel that slides
 *    in from an edge. Its very flat tail is what makes a drawer feel like
 *    it settles into a detent rather than stopping.
 */
export const EASE: Readonly<Record<'out' | 'inOut' | 'drawer', Bezier>> = {
  out: [0.23, 1, 0.32, 1],
  inOut: [0.77, 0, 0.175, 1],
  drawer: [0.32, 0.72, 0, 1],
};

/** The same three curves as CSS `cubic-bezier()` strings, for the half of
 *  the system that is a class toggle rather than a `motion` component.
 *  Kept in lockstep with src/styles.css's `@theme` by
 *  tests/motion-tokens.test.ts. */
export const EASE_CSS: Readonly<Record<keyof typeof EASE, string>> = {
  out: 'cubic-bezier(0.23, 1, 0.32, 1)',
  inOut: 'cubic-bezier(0.77, 0, 0.175, 1)',
  drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
};

/** The `--ease-*` custom property each curve is published under in
 *  src/styles.css. Tailwind v4's `--ease-*` theme namespace turns each
 *  one into an `ease-<name>` utility, which is how a className reaches
 *  these curves without repeating the control points. */
export const EASE_CSS_VARIABLE: Readonly<Record<keyof typeof EASE, string>> = {
  out: '--ease-out-strong',
  inOut: '--ease-in-out-strong',
  drawer: '--ease-drawer',
};

/**
 * Six durations, each tied to a surface rather than to a size.
 *
 *  - `press`   120 — a control acknowledging a press. Must be under the
 *                    threshold where feedback stops feeling simultaneous
 *                    with the finger.
 *  - `hover`   150 — a tint fading under the pointer. Tailwind's own
 *                    default, kept so `transition-colors` with no
 *                    duration utility is already on-system.
 *  - `settle`  180 — content arriving in the content column: a view swap,
 *                    a freshly-fetched list. The most-repeated transition
 *                    in the app, so the shortest one that still reads as
 *                    movement rather than a cut.
 *  - `panel`   200 — a whole surface arriving: the reader, the composer.
 *                    Slightly longer than `settle` because the thing
 *                    moving is larger, and large things that move at
 *                    small-thing speed read as flicked rather than
 *                    placed.
 *  - `row`     220 — one genuinely-new row landing in the opens rail.
 *                    Longest of the entrances because it is unsolicited:
 *                    it arrives from a poll, not from a click, so it has
 *                    to be noticeable enough to catch the eye without a
 *                    click having already directed it there.
 *  - `drawer`  260 — the mobile drawer and its scrim. The ceiling.
 */
export const DURATION_MS = {
  press: 120,
  hover: 150,
  settle: 180,
  panel: 200,
  row: 220,
  drawer: 260,
} as const;

export type DurationName = keyof typeof DURATION_MS;

/**
 * The hard ceiling this file holds itself to — 260ms, the longest value
 * above. Stricter than Plan 7's stated 400ms cap on purpose (see the file
 * header). tests/motion-tokens.test.ts asserts every duration is inside
 * [`MIN_DURATION_MS`, `MAX_DURATION_MS`], so raising one past the ceiling
 * is a deliberate, visible edit rather than a slow slide.
 */
export const MIN_DURATION_MS = 120;
export const MAX_DURATION_MS = 260;

/**
 * How long a fetch may take before the reader admits it is loading.
 *
 * NOT AN ANIMATION, which is why it is its own constant rather than a
 * seventh entry in DURATION_MS — nothing moves for this long, and nothing
 * is eased. It is a THRESHOLD, and it lives in this file because it is
 * the same perceptual question every value here answers, and because the
 * alternative is a bare `120` sitting in a component with nothing to
 * relate it to.
 *
 * Tied to MIN_DURATION_MS rather than stated independently: the band's
 * floor already means "the shortest interval a user reads as a change of
 * state", and a skeleton that appears and disappears inside that window
 * is not information, it is a flash. With the message cache in front of
 * this (src/messageCache.ts), a re-open resolves in well under a
 * millisecond — showing a skeleton for it would be the app announcing
 * work it did not do.
 *
 * A genuine fetch takes far longer than this, so nothing that is actually
 * slow becomes silent: the skeleton still appears, just never for a
 * request that was already finished.
 */
export const SKELETON_DELAY_MS = MIN_DURATION_MS;

/** Milliseconds to `motion`'s seconds. The one conversion in the system,
 *  so no component ever writes `0.18` and hopes it matches a `180ms`
 *  somewhere else. */
export function seconds(ms: number): number {
  return ms / 1000;
}

/**
 * How far content travels while settling in, in pixels.
 *
 * Small on purpose. The job is to say "this arrived", not to stage an
 * entrance — anything past ~8px starts reading as a slide and draws
 * attention to the chrome instead of the mail.
 */
export const LIFT_PX = 6;

/**
 * How far a new opens-rail row travels, and from WHICH direction —
 * negative, i.e. down from above.
 *
 * Spatial consistency: a new open event is prepended to the top of the
 * feed, so it enters from the direction it came from. A row that slid UP
 * into the top of the list would be claiming it came from below, where
 * the older events are.
 */
export const ROW_ENTER_PX = -8;

/**
 * Delay between adjacent day groups in the inbox list, in milliseconds.
 *
 * PER GROUP, NEVER PER ROW. A list holds 50+ rows; at any stagger worth
 * seeing that is seconds of animation and 50 simultaneously-animating
 * elements. Day groups number two to six, so the cascade is visible, the
 * total added time is under 200ms even at six groups, and the browser
 * composites a handful of layers rather than dozens. `MAX_STAGGERED`
 * is the cap the builder applies so a pathological 30-group list cannot
 * turn into a 1-second wipe.
 */
export const GROUP_STAGGER_MS = 35;
export const MAX_STAGGERED_GROUPS = 6;

/**
 * The sidebar's selection pill, and the one place this system uses a
 * spring instead of a curve.
 *
 * WHY A SPRING HERE SPECIFICALLY: this is the only motion in the app a
 * user can interrupt mid-flight — clicking a second nav item while the
 * pill is still travelling is exactly the "it's, like, weird" case the
 * user reported. A duration-based tween restarts from zero on
 * interruption and visibly stutters; a spring carries its current
 * velocity into the new target and simply bends toward it. That property,
 * not the look, is why it is a spring.
 *
 * Apple's `duration`/`bounce` parameterisation rather than
 * mass/stiffness/damping: it is the one that can be reasoned about. 0.14
 * of bounce is barely perceptible — enough that the pill lands rather
 * than stops, not enough to wobble under a cursor that is already moving
 * on. `duration` here is the spring's settling time, not a tween length,
 * and is therefore outside the DURATION_MS band by construction.
 */
export const NAV_PILL_SPRING = { type: 'spring', duration: 0.34, bounce: 0.14 } as const;
