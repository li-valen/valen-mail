import './ReadState.css';

/**
 * The three-tone read-state vocabulary — client/DESIGN.md §5, "the
 * centrepiece": Postbox typesets uncertainty at the same size, weight and
 * contrast as certainty, so `confirmed` is the ONLY tone that ever means
 * "a person read this." Everything else — a known machine fetch, or a
 * classification nobody has invented yet — degrades to `unknown`.
 *
 * There is no third tone exported from here. `unavailable` (DESIGN.md
 * §7.3, "the tracking service cannot be reached") describes the RAIL's
 * load state, not one event's classification, and is handled by
 * OpensRail/openEvents.ts's `deriveRailView`, not by this file.
 */
export type ReadStateTone = 'confirmed' | 'unknown';

/**
 * task-5-brief.md's literal interface: `readStateFor(classification:
 * string): { label, tone, title }`. `token` (the mono badge word —
 * DESIGN.md §5.2: "not decoration; it is the greyscale/screen-reader
 * path") and `permanent` (DESIGN.md §5.4's Apple/MPP "permanent ceiling"
 * mark variant) are additive fields nothing in the brief's test forbids.
 */
export interface ReadStateInfo {
  readonly label: string;
  readonly tone: ReadStateTone;
  readonly title: string;
  readonly token: string;
  readonly permanent: boolean;
}

const OPEN_STATE: ReadStateInfo = {
  label: 'opened',
  tone: 'confirmed',
  title:
    'A fetch that matches no known prefetcher, more than 60 seconds after send. This is the only signal Postbox treats as a person reading.',
  token: 'OPEN',
  permanent: false,
};

type UnconfirmableClassification = 'mpp' | 'prefetch' | 'scanner';

/**
 * mpp, prefetch and scanner share a label and a tone (DESIGN.md §5.1:
 * all three map to "Unconfirmable") but must carry DISTINCT explanatory
 * text — they are different causes (Apple's privacy proxy, Gmail's
 * delivery-time image proxy, a corporate scanner gateway), and the
 * tooltip/note is where that distinction belongs (task-5-brief.md,
 * "Binding on the copy"). Text is DESIGN.md §5.3's "Expanded note" copy,
 * verbatim.
 */
const UNCONFIRMABLE_TITLES: Record<UnconfirmableClassification, string> = {
  mpp: 'Apple Mail Privacy Protection downloads every image the moment mail arrives, whether or not anyone looks.',
  prefetch: "Gmail's image proxy fetched this at delivery. Any read after it is invisible to us.",
  scanner: 'A mail gateway scanned this message. Gateway traffic and human reads are indistinguishable here.',
};

/**
 * Anything the tracking service's classifier emits that this file does
 * not recognise — a future classification value, an empty string, or a
 * corrupted one. Honest about not knowing what it is (never claims to be
 * one of the three known causes), while still failing closed to the same
 * tone/label as a known machine fetch, never to `confirmed`.
 */
const GENERIC_UNCONFIRMABLE_TITLE =
  "Postbox doesn't recognize this signal and won't assume it was a person reading. Treated the same as a known machine fetch: unconfirmable, not confirmed.";

function isUnconfirmableClassification(value: string): value is UnconfirmableClassification {
  return value === 'mpp' || value === 'prefetch' || value === 'scanner';
}

/** The mono badge word for an unrecognised classification: the raw value
 *  itself, upper-cased, rather than a generic placeholder — showing what
 *  actually came back is more honest than hiding it behind "UNKNOWN", and
 *  it is what a future reader debugging a new classifier value will want
 *  to see. An empty string (never emitted by the real classifier, but not
 *  a value this function may crash on) still needs a non-empty badge. */
function tokenFor(classification: string): string {
  return classification === '' ? 'UNKNOWN' : classification.toUpperCase();
}

/** The mono badge's longest displayed length before it gets truncated —
 *  comfortably longer than every known token (OPEN/MPP/PREFETCH/SCANNER
 *  top out at 8 characters), but short enough that a pathological wire
 *  value can't distort the rail's layout. */
const MAX_TOKEN_DISPLAY_LENGTH = 16;

/**
 * Bounds a token string for rendering (fix round 1). `ReadStateInfo.token`
 * itself is never bounded — `readStateFor`'s default branch deliberately
 * surfaces the raw, unrecognised classification value verbatim, because
 * showing what actually came back is more honest and more debuggable than
 * hiding it, and it is the value a future reader would want in code, in a
 * test failure, or in the DOM via `title`. But a classification value is
 * wire data this client does not control, and rendering it unbounded — in
 * the badge, or inline in a meta line (see openEvents.ts's
 * `describeEvent`) — could distort the rail's layout. Bounding happens
 * only at the point of display, never on the canonical value.
 */
export function boundedToken(token: string): string {
  if (token.length <= MAX_TOKEN_DISPLAY_LENGTH) return token;
  return `${token.slice(0, MAX_TOKEN_DISPLAY_LENGTH)}…`;
}

/**
 * Maps a raw `classification` string — sync/../tracking's `classify.ts`
 * emits `'self' | 'prefetch' | 'mpp' | 'scanner' | 'open'`, but this
 * function's parameter is deliberately typed as plain `string`, mirroring
 * `classificationIsConfirmed()`'s own reasoning (DESIGN.md §5.1) — to the
 * tone, label and explanatory text the rail renders.
 *
 * The default branch — anything not `'open'`, `'mpp'`, `'prefetch'` or
 * `'scanner'` — returns tone `'unknown'` / label `'unconfirmable'`. This
 * is the fail-closed behaviour task-5-brief.md's amendment requires: an
 * unrecognised classification must degrade to "we can't tell", never to a
 * false green `'confirmed'`. `self` also falls through this branch — it
 * is never actually rendered by the rail (see `isDisplayable`), but a
 * function that returns something coherent for every string is safer
 * than one that only handles the values it happens to know about today.
 */
export function readStateFor(classification: string): ReadStateInfo {
  if (classification === 'open') return OPEN_STATE;

  if (isUnconfirmableClassification(classification)) {
    return {
      label: 'unconfirmable',
      tone: 'unknown',
      title: UNCONFIRMABLE_TITLES[classification],
      token: tokenFor(classification),
      // DESIGN.md §5.4: only Apple's MPP is a ceiling that will never
      // move. Gmail's prefetch and a scanner gateway get the plain
      // Unconfirmable treatment — nothing in DESIGN.md claims the same
      // permanence for them.
      permanent: classification === 'mpp',
    };
  }

  return {
    label: 'unconfirmable',
    tone: 'unknown',
    title: GENERIC_UNCONFIRMABLE_TITLE,
    token: tokenFor(classification),
    permanent: false,
  };
}

/**
 * `self` events are the user viewing their own Sent folder — showing them
 * as a "recipient opened this" row would be exactly the overclaim this
 * product exists to refuse. Every OTHER classification, known or not, is
 * shown: hiding an unrecognised future classification would be a second,
 * quieter way of discarding real data, which is the same dishonesty
 * task-5-brief.md's Amendment 2 argues against for `self` — just applied
 * one level up, to values nobody has invented yet.
 */
export function isDisplayable(classification: string): boolean {
  return classification !== 'self';
}

const MARK_STROKE_WIDTH = 1.5;
/** Gap between the terminal cap and the bar's own top cap, DESIGN.md
 *  §5.2: "a 9px cap rule 3px above the top cap." */
const MARK_CAP_GAP = 3;
/** The error-bar mark's own height, DESIGN.md §5.2: "9px wide × 16px
 *  tall." */
const BAR_HEIGHT = 16;

interface StateMarkProps {
  readonly classification: string;
}

/**
 * The DESIGN.md §5.2 read-state silhouettes — form carries the state, not
 * just colour, because "colour alone fails for colour-blind users and is
 * the lazy answer." Three shapes only, because the rail never needs the
 * other two DESIGN.md defines (the open ring for "awaiting" and the bare
 * spine for "unavailable" are states this file's data — individual
 * OpenEvents that already happened — cannot produce):
 *
 *   - confirmed             → filled disc
 *   - unconfirmable          → error bar (two caps + a stem)
 *   - unconfirmable, permanent (mpp only) → error bar + a terminal cap
 *
 * `currentColor` fill/stroke: the wrapping `.read-state--<tone>` class
 * sets `color` to the matching `--state-*` token, so this SVG never reads
 * a colour token directly. Purely decorative next to the mono token text
 * beside it (the real screen-reader path — DESIGN.md §5.2), so it is
 * `aria-hidden`.
 */
function StateMark({ classification }: StateMarkProps) {
  const state = readStateFor(classification);
  const half = MARK_STROKE_WIDTH / 2;

  if (state.tone === 'confirmed') {
    return (
      <svg className="state-mark" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
        <circle cx="4.5" cy="4.5" r="4.5" fill="currentColor" />
      </svg>
    );
  }

  if (!state.permanent) {
    const topY = half;
    const bottomY = BAR_HEIGHT - half;
    return (
      <svg className="state-mark" viewBox={`0 0 9 ${BAR_HEIGHT}`} aria-hidden="true" focusable="false">
        <line x1="0" y1={topY} x2="9" y2={topY} stroke="currentColor" strokeWidth={MARK_STROKE_WIDTH} />
        <line x1="0" y1={bottomY} x2="9" y2={bottomY} stroke="currentColor" strokeWidth={MARK_STROKE_WIDTH} />
        <line x1="4.5" y1={topY} x2="4.5" y2={bottomY} stroke="currentColor" strokeWidth={MARK_STROKE_WIDTH} />
      </svg>
    );
  }

  const capY = half;
  const topY = capY + MARK_CAP_GAP + MARK_STROKE_WIDTH;
  const bottomY = topY + BAR_HEIGHT - MARK_STROKE_WIDTH;
  const totalHeight = bottomY + half;
  return (
    <svg className="state-mark" viewBox={`0 0 9 ${totalHeight}`} aria-hidden="true" focusable="false">
      <line x1="0" y1={capY} x2="9" y2={capY} stroke="currentColor" strokeWidth={MARK_STROKE_WIDTH} />
      <line x1="0" y1={topY} x2="9" y2={topY} stroke="currentColor" strokeWidth={MARK_STROKE_WIDTH} />
      <line x1="0" y1={bottomY} x2="9" y2={bottomY} stroke="currentColor" strokeWidth={MARK_STROKE_WIDTH} />
      <line x1="4.5" y1={topY} x2="4.5" y2={bottomY} stroke="currentColor" strokeWidth={MARK_STROKE_WIDTH} />
    </svg>
  );
}

export interface ReadStateProps {
  readonly classification: string;
}

/**
 * task-5-brief.md's produced interface: `<ReadState classification={...}
 * />`. Renders the mark plus the mono `--t-2xs` token — the compact piece
 * OpensRail's row places on the spine. `readStateFor`'s `title` (the full
 * explanatory sentence) is NOT rendered here as visible text: DESIGN.md's
 * component inventory (#11 OpenEvent) keeps the row itself terse — mark,
 * headline, meta, token — and treats the longer note as progressive
 * disclosure the row's own `<details>` reveals on demand. Rendering it
 * here too would either duplicate it (announced twice to a screen reader)
 * or force every row to carry a paragraph. See OpensRail.tsx's row markup
 * for where `title` actually surfaces.
 */
export function ReadState({ classification }: ReadStateProps) {
  const state = readStateFor(classification);
  const displayToken = boundedToken(state.token);
  // Only set `title` when it would tell the inspector something the
  // visible text does not already say — a redundant native tooltip on
  // every ordinary "OPEN"/"MPP" badge would be noise, not a feature.
  const fullTokenTitle = displayToken === state.token ? undefined : state.token;
  return (
    <span className={`read-state read-state--${state.tone}`}>
      <StateMark classification={classification} />
      <span className="read-state__token" title={fullTokenTitle}>
        {displayToken}
      </span>
    </span>
  );
}
