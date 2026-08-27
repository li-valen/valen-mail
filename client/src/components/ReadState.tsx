/**
 * The three-tone read-state vocabulary — the centrepiece: Valen Mail typesets
 * uncertainty at the same size, weight and contrast as certainty, so
 * `confirmed` is the ONLY tone that ever means "a person read this."
 * Everything else — a known machine fetch, or a classification nobody has
 * invented yet — degrades to `unknown`.
 *
 * There is no third tone exported from here. `unavailable` ("the tracking
 * service cannot be reached") describes the FEED's load state, not one
 * event's classification, and is handled by useOpensFeed.ts/openEvents.ts's
 * `deriveRailView` (via `advanceOpensPoll`), not by this file.
 *
 * NOTHING BELOW THE PRESENTATION LAYER HAS EVER CHANGED, ACROSS EITHER
 * RESTYLE. `readStateFor`, `isDisplayable` and `boundedToken` keep the
 * exact contracts tests/read-state.test.ts pins; only `ReadState` (the
 * component) and `StateMark` (its silhouette) get reskinned. The Plunk
 * restyle reskinned both once already; task V1b (the Superhuman/
 * Mailspring convention — "don't show the MPP mail thing... do it like
 * superhuman or mailspring does it") reskinned `ReadState` a second time,
 * dropping the visible mono token (`Badge` + "OPEN"/"MPP"/...) down to
 * just the mark, coloured by tone, with the classification's explanation
 * as a hover `title` tooltip instead of badge text. `StateMark` itself —
 * the actual silhouette geometry — is untouched by V1b.
 */
export type ReadStateTone = 'confirmed' | 'unknown';

/**
 * `readStateFor(classification: string): { label, tone, title }`, plus
 * `token` (the mono badge word — not decoration; it is the
 * greyscale/screen-reader path) and `permanent` (the Apple/MPP "permanent
 * ceiling" mark variant).
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
    'A fetch that matches no known prefetcher, more than 60 seconds after send. This is the only signal Valen Mail treats as a person reading.',
  token: 'OPEN',
  permanent: false,
};

type UnconfirmableClassification = 'mpp' | 'prefetch' | 'scanner';

/**
 * mpp, prefetch and scanner share a label and a tone (all three map to
 * "Unconfirmable") but must carry DISTINCT explanatory text — they are
 * different causes (Apple's privacy proxy, Gmail's delivery-time image
 * proxy, a corporate scanner gateway), and the disclosure note is where
 * that distinction belongs.
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
  "Valen Mail doesn't recognize this signal and won't assume it was a person reading. Treated the same as a known machine fetch: unconfirmable, not confirmed.";

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
 *  value can't distort the layout. */
const MAX_TOKEN_DISPLAY_LENGTH = 16;

/**
 * Bounds a token string for rendering. `ReadStateInfo.token` itself is
 * never bounded — `readStateFor`'s default branch deliberately surfaces
 * the raw, unrecognised classification value verbatim, because showing
 * what actually came back is more honest and more debuggable than hiding
 * it. But a classification value is wire data this client does not
 * control, and rendering it unbounded could distort the layout. Bounding
 * happens only at the point of display, never on the canonical value.
 */
export function boundedToken(token: string): string {
  if (token.length <= MAX_TOKEN_DISPLAY_LENGTH) return token;
  return `${token.slice(0, MAX_TOKEN_DISPLAY_LENGTH)}…`;
}

/**
 * Maps a raw `classification` string — the tracking service emits
 * `'self' | 'prefetch' | 'mpp' | 'scanner' | 'open'`, but this function's
 * parameter is deliberately typed as plain `string` — to the tone, label
 * and explanatory text the opens view renders.
 *
 * The default branch — anything not `'open'`, `'mpp'`, `'prefetch'` or
 * `'scanner'` — returns tone `'unknown'` / label `'unconfirmable'`. This
 * is the fail-closed behaviour: an unrecognised classification must
 * degrade to "we can't tell", never to a false green `'confirmed'`.
 * `self` also falls through this branch — it is never actually rendered
 * (see `isDisplayable`), but a function that returns something coherent
 * for every string is safer than one that only handles the values it
 * happens to know about today.
 */
export function readStateFor(classification: string): ReadStateInfo {
  if (classification === 'open') return OPEN_STATE;

  if (isUnconfirmableClassification(classification)) {
    return {
      label: 'unconfirmable',
      tone: 'unknown',
      title: UNCONFIRMABLE_TITLES[classification],
      token: tokenFor(classification),
      // Only Apple's MPP is a ceiling that will never move. Gmail's
      // prefetch and a scanner gateway get the plain Unconfirmable
      // treatment — nothing claims the same permanence for them.
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
 * quieter way of discarding real data.
 */
export function isDisplayable(classification: string): boolean {
  return classification !== 'self';
}

const MARK_STROKE_WIDTH = 1.5;
/** Gap between the terminal cap and the bar's own top cap: "a 9px cap rule
 *  3px above the top cap." */
const MARK_CAP_GAP = 3;
/** The error-bar mark's own height: "9px wide × 16px tall." */
const BAR_HEIGHT = 16;

interface StateMarkProps {
  readonly classification: string;
}

/**
 * The read-state silhouettes — FORM carries the state, not just colour,
 * because colour alone fails for colour-blind users and is the lazy
 * answer. This survived the Plunk restyle unchanged in geometry; only its
 * sizing classes are new. Three shapes:
 *
 *   - confirmed                           → filled disc
 *   - unconfirmable                       → error bar (two caps + a stem)
 *   - unconfirmable, permanent (mpp only) → error bar + a terminal cap
 *
 * `currentColor` fill/stroke: the enclosing element sets the text colour
 * (green for confirmed, neutral for unconfirmable — a `<span>` since task
 * V1b, previously Plunk's `Badge` atom), so this SVG never names a colour
 * of its own. Purely decorative — the enclosing `title` attribute is the
 * explanatory path now that the mono token text beside it is gone — so
 * this stays `aria-hidden`.
 */
function StateMark({ classification }: StateMarkProps) {
  const state = readStateFor(classification);
  const half = MARK_STROKE_WIDTH / 2;

  if (state.tone === 'confirmed') {
    return (
      <svg className="h-2 w-2 shrink-0" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
        <circle cx="4.5" cy="4.5" r="4.5" fill="currentColor" />
      </svg>
    );
  }

  if (!state.permanent) {
    const topY = half;
    const bottomY = BAR_HEIGHT - half;
    return (
      <svg
        className="h-3.5 w-2 shrink-0"
        viewBox={`0 0 9 ${BAR_HEIGHT}`}
        aria-hidden="true"
        focusable="false"
      >
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
    <svg
      className="h-4 w-2 shrink-0"
      viewBox={`0 0 9 ${totalHeight}`}
      aria-hidden="true"
      focusable="false"
    >
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
 * `<ReadState classification={...} />`. Task V1b (the Superhuman/
 * Mailspring restyle) reduced this from Plunk's `Badge` atom carrying a
 * visible mono token ("OPEN"/"MPP"/"PREFETCH"/"SCANNER") down to JUST the
 * mark — `StateMark`'s silhouette, wrapped in a `currentColor`-setting
 * `<span>` — green for confirmed, neutral (`text-neutral-500`) for every
 * unconfirmable state. The two never differ by colour alone: the mark
 * SHAPE differs too (see `StateMark` above — a filled disc vs an error
 * bar), which is what keeps this legible for colour-blind users once the
 * token word is gone.
 *
 * DARK MODE (task V2) repicks both tones rather than reusing the light
 * ones behind a bare `dark:` class-for-class swap, because neither light
 * value carries over with real contrast on `--background`'s dark ground
 * (`hsl(224 71% 4%)`, effectively `#030711`):
 *   - confirmed: `text-green-600` is a 3.2:1 contrast choice against
 *     WHITE (already the light mode's own floor, unchanged) — the same
 *     numeric colour against near-black would still read as a plausible
 *     6:1-ish, but a materially dimmer, less confident green than this
 *     mark is supposed to be, which is the one tone in this whole product
 *     that means "a person really read this." `dark:text-green-400`
 *     measures 11.4:1 against the dark ground — vivid on purpose.
 *   - unconfirmable: `text-neutral-500`. This was `text-neutral-400`,
 *     and the note here recorded 2.6:1 against WHITE as "acceptable for
 *     a small decorative mark". The interface audit overruled that, and
 *     the reason is that the premise was wrong rather than the number:
 *     this mark is not decorative. It is the one place in the product
 *     where "a person read this" and "a machine did" are distinguished
 *     visually, which makes it a user-interface component under WCAG
 *     1.4.11 and puts its floor at 3:1, not at whatever a decorative
 *     glyph could get away with. `text-neutral-500` measures 4.7:1
 *     against white and is still, unmistakably, the quiet one beside a
 *     saturated green. The distinction never rested on colour alone
 *     anyway — `StateMark`'s silhouette differs too — so nothing about
 *     the colour-blind story changes. Rather than pick another
 *     arbitrary neutral shade for dark, `dark:text-muted-foreground`
 *     routes it through the palette's own "secondary text" token — 6.0:1
 *     against the dark ground, and semantically the same "the machine
 *     read this, not you" quietness the light neutral carries.
 * Both ratios computed via the WCAG relative-luminance formula against
 * `--background`'s resolved hex in each mode; see
 * .superpowers/sdd/2026-08-24-web-client/task-v2-report.md for the
 * numbers on every candidate shade considered.
 *
 * The user's own directive drove the token's removal: "don't show the MPP
 * mail thing... Do it like superhuman or mailspring does it." The token
 * text, and the word "unconfirmable", no longer render anywhere in this
 * product — not hidden, not truncated, gone from the tree. `readStateFor`
 * itself is untouched; `boundedToken` still exists and is still tested,
 * simply no longer called from here (nothing here needs to bound a token
 * this component no longer displays).
 *
 * `readStateFor`'s `title` (the full per-cause explanation — "Apple Mail
 * Privacy Protection downloads every image the moment mail arrives...")
 * moves from the (now-deleted) row `<details>` disclosure to a native
 * `title` attribute on the mark itself: hover-only, not a second visible
 * text channel. This is what makes an `open` row and an `mpp` row's VISIBLE
 * text byte-identical in form (`formatOpenRowSentence`,
 * openEvents.ts) — the mark is the one place the distinction still lives.
 *
 * `data-tone` carries the same confirmed/unknown distinction as a plain DOM
 * attribute, independent of the Tailwind class string — the one thing
 * tests/opens-feed-presentation.test.ts's static source scan can assert on
 * without rendering a component (client/CLAUDE.md's standing constraint;
 * see that test file's own doc comment for why this is the only tool
 * available here).
 *
 * There is deliberately no tick, tickbox or verified-badge glyph anywhere
 * in this component set — that mark is the lie this product exists to
 * refuse. tests/opens-rail-static-guards.test.ts enforces it mechanically.
 */
export function ReadState({ classification }: ReadStateProps) {
  const state = readStateFor(classification);
  const toneClassName =
    state.tone === 'confirmed'
      ? 'text-green-600 dark:text-green-400'
      : 'text-neutral-500 dark:text-muted-foreground';
  return (
    <span
      className={`inline-flex shrink-0 items-center ${toneClassName}`}
      title={state.title}
      data-tone={state.tone}
    >
      <StateMark classification={classification} />
    </span>
  );
}
