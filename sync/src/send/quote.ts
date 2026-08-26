import { escapeHtml } from './build.ts';
import { stripOwnTrackingPixels } from '../api/strip-pixel.ts';

/**
 * Plan 9 Task 2 — the quoted original a reply or forward carries.
 *
 * Pure. No I/O, no config, no knowledge of transports — the same split
 * ./build.ts draws, and for the same reason: two of this file's rules are
 * BINDING in the spec, and a binding rule has to be assertable as a
 * literal string rather than as a side effect buried in an SMTP call.
 *
 * THE TWO RULES THIS FILE EXISTS FOR
 *
 * §5.6 — STRIP OUR OWN PIXEL BEFORE THE NEW ONE IS INJECTED.
 * The quote is built from the ORIGINAL body. For mail this user sent, that
 * body carries the ORIGINAL recipient's live token, because Gmail files a
 * byte-identical copy of every send into Sent (see ../api/strip-pixel.ts's
 * header for the measurement). Quote it unstripped and every reply in the
 * thread re-fires that token forever, reporting opens for a recipient who
 * did nothing.
 *
 * This is a DIFFERENT code path from ../api/strip-pixel.ts's strip-at-
 * render and does not come for free from it. Strip-at-render protects what
 * the READER sees; this protects what the SENDER emits. A future change
 * that removed the strip here would still pass every strip-at-render test.
 *
 * The strip runs on `originalHtml` — the SOURCE — and never on the
 * assembled quote. Both orderings happen to produce identical output from
 * THIS function, because assembly only wraps non-`<img>` markup around the
 * source; the ordering becomes observable one level up, where ./build.ts
 * injects the new pixel. Move the strip to after injection and the strip
 * eats the NEW pixel too — the reply goes out untracked and looks fine.
 * tests/send-route.test.ts pins exactly that.
 *
 * §5.2 — THE PIXEL GOES BEFORE THE QUOTE, NEVER INSIDE IT.
 * This module's contribution is to emit ONE `.gmail_quote` element that
 * ./build.ts can place the pixel before. The attribution line lives INSIDE
 * that element, exactly as Gmail nests it, so "immediately before the
 * .gmail_quote element" means before the whole quoted region rather than
 * between the attribution and the blockquote. Gmail collapses that region
 * behind a toggle; a pixel inside it never loads, so a tracked reply would
 * silently always report "unopened".
 *
 * No new dependency: escaping is ./build.ts's, stripping is
 * ../api/strip-pixel.ts's, and the date formatting is four constants and
 * arithmetic rather than a formatting library.
 */

/** Gmail's abbreviations, in `Date.getUTCDay()` order. Hand-written rather
 *  than taken from `Intl`: this string goes into mail that leaves the
 *  machine, and it must not depend on which ICU data the host Node was
 *  built with. */
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** In `Date.getUTCMonth()` order. */
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const HOURS_PER_HALF_DAY = 12;

/** `9` → `"09"`. Only ever applied to a minute, which is always 0-59. */
function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * "On Tue, Nov 14, 2023 at 10:13 PM Ada <ada@example.com> wrote:" —
 * Gmail's own attribution shape, so a reply from Postbox is
 * indistinguishable from a reply from Gmail in every client that renders
 * one.
 *
 * FIXED TO UTC DELIBERATELY. This string is written into mail that leaves
 * the machine; rendering it in the server's local zone would make the same
 * reply read differently depending on where the box happens to be
 * deployed, and would make this function's own tests depend on the
 * developer's TZ.
 *
 * `sentAtMs` is epoch MILLISECONDS, this codebase's wire convention for a
 * timestamp, and is typed `number | null` to match ../api/message.ts's
 * `ParsedMessage.date` exactly — never an ISO string, and never widened at
 * this hop. A message with no usable Date header is ordinary mail, so a
 * null or otherwise non-finite instant degrades to a dateless attribution
 * rather than emitting "On Invalid Date, NaN ... wrote:" into mail that
 * leaves the machine.
 *
 * Returns the RAW line. The caller escapes it: `fromLabel` is built from a
 * From header the sender controls.
 */
export function attributionLine(fromLabel: string, sentAtMs: number | null): string {
  if (sentAtMs === null || !Number.isFinite(sentAtMs)) return `${fromLabel} wrote:`;

  const at = new Date(sentAtMs);
  const weekday = WEEKDAY_NAMES[at.getUTCDay()];
  const month = MONTH_NAMES[at.getUTCMonth()];
  const hours24 = at.getUTCHours();
  const meridiem = hours24 < HOURS_PER_HALF_DAY ? 'AM' : 'PM';
  // 0 and 12 both read as 12 on a 12-hour clock: midnight is 12 AM, noon
  // is 12 PM. A bare `% 12` would print both as "0:00".
  const hours12 = hours24 % HOURS_PER_HALF_DAY || HOURS_PER_HALF_DAY;
  const date = `${weekday}, ${month} ${at.getUTCDate()}, ${at.getUTCFullYear()}`;

  return `On ${date} at ${hours12}:${twoDigits(at.getUTCMinutes())} ${meridiem} ${fromLabel} wrote:`;
}

export interface QuoteInput {
  /** The original message's html alternative, or null when it had none. */
  readonly originalHtml: string | null;
  /** The original message's plaintext alternative. Used only when there is
   *  no html, and ESCAPED when it is — a plaintext body is text, and
   *  interpolating it as markup would let a plain-text mail author inject
   *  html into the user's own outgoing message. */
  readonly originalText: string | null;
  /** "Ada Lovelace <ada@example.com>" — display form of the original
   *  sender, exactly as it should read in the attribution. */
  readonly fromLabel: string;
  /** Epoch milliseconds, mirroring `ParsedMessage.date`. Null or
   *  non-finite ⇒ the attribution omits the date. */
  readonly sentAtMs: number | null;
  /** TRACKING_BASE_URL, or null when tracking was not configured — in
   *  which case there is no origin to compare against and nothing is
   *  stripped (../api/strip-pixel.ts). */
  readonly trackingBaseUrl: string | null;
}

/**
 * The quoted original, as one `.gmail_quote` element.
 *
 * Returns markup only — never the new pixel, which ./build.ts emits and
 * places immediately before whatever this returns (§5.2).
 */
export function buildQuotedHtml(input: QuoteInput): string {
  // §5.6 FIRST, on the SOURCE, before anything is wrapped around it. See
  // this file's header for why the ordering matters and where it is
  // pinned.
  const source =
    input.originalHtml !== null
      ? (stripOwnTrackingPixels(input.originalHtml, input.trackingBaseUrl) ?? '')
      : `<pre>${escapeHtml(input.originalText ?? '')}</pre>`;

  return [
    // ONE container holding both halves, which is Gmail's own nesting.
    '<div class="gmail_quote">',
    `<div class="gmail_attr">${escapeHtml(attributionLine(input.fromLabel, input.sentAtMs))}</div>`,
    `<blockquote class="gmail_quote">${source}</blockquote>`,
    '</div>',
  ].join('');
}
