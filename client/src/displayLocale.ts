/**
 * WHOSE CALENDAR THE DATES ARE WRITTEN IN, decided once.
 *
 * Every timestamp this client draws used to be formatted with a hardcoded
 * `'en-US'`. For the one person this mailbox belongs to that is the right
 * answer by coincidence rather than by design, and it is the wrong answer
 * for anyone whose phone says `17 Aug` and `14:32` - the Web Interface
 * Guidelines ask for the reader's own locale, not the author's.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: translate. Valen Mail's copy is
 * English - `Today`, `Yesterday`, `Inbox`, `Archived.` - and this module
 * does not pretend otherwise. It governs FORMAT (field order, clock
 * convention, month and weekday abbreviations) and nothing else, which is
 * the ordinary split: an app's language is the app's, a date's shape is
 * the reader's regional preference. A German reader therefore gets
 * `Do., 20. Aug.` under an English `Today`, and that mixture is the
 * honest consequence of a single-language product respecting a regional
 * format, not an oversight. See
 * .superpowers/sdd/2026-08-24-web-client/task-interface-audit-report.md
 * for the alternative that was weighed (keep `'en-US'` everywhere) and
 * why this was chosen instead.
 *
 * WHY A RESOLVED STRING RATHER THAN `undefined`. Passing `undefined` to
 * `Intl.DateTimeFormat` also means "the runtime's default locale", and is
 * shorter. It is rejected here because it makes the answer invisible: it
 * cannot be logged, cannot be pinned by a test, and cannot be validated,
 * so an unusable tag from a misconfigured browser becomes a `RangeError`
 * inside a formatter rather than something this module has already
 * rejected. Resolving to a concrete, validated tag once is what lets
 * every formatter take an explicit `locale` argument - which is in turn
 * what keeps the suite machine-independent (the tests pin `'en-US'` where
 * they assert exact strings) while the app still follows the browser.
 */

/** The locale used when the browser offers nothing usable, and the tag
 *  the whole suite pins, so a test asserting `Aug 17` is asserting about
 *  a locale rather than about the machine it happens to run on. */
export const FALLBACK_LOCALE = 'en-US';

/**
 * The first of `candidates` that `Intl` can actually format with, or
 * `FALLBACK_LOCALE`.
 *
 * Pure and total: `undefined`, an empty list, a list of nonsense, or a
 * list containing a structurally invalid tag (which makes
 * `supportedLocalesOf` THROW a RangeError rather than skip it) all return
 * the fallback rather than propagating. A browser that reports a locale
 * this runtime cannot use must degrade to readable dates, never to an
 * exception on the first row of the inbox.
 *
 * `supportedLocalesOf` rather than a bare `new Intl.DateTimeFormat(tag)`:
 * the constructor accepts any *structurally valid* tag and silently falls
 * back to the default for one it has no data for, so it cannot tell us
 * whether the answer would be meaningful. This can.
 */
export function resolveDisplayLocale(
  candidates: readonly string[] | undefined,
  fallback: string = FALLBACK_LOCALE,
): string {
  if (candidates === undefined) return fallback;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      const supported = Intl.DateTimeFormat.supportedLocalesOf([candidate]);
      const first = supported[0];
      if (first !== undefined) return first;
    } catch {
      // A structurally invalid tag ('en_US', 'not a tag'): skip it and
      // keep looking rather than letting one bad entry lose the rest.
      continue;
    }
  }
  return fallback;
}

/**
 * What the browser says, most-preferred first.
 *
 * `navigator.languages` before `navigator.language` because the first is
 * the ordered preference list and the second is only its head - a reader
 * whose first choice this runtime has no data for should get their
 * second, not the fallback. `Intl.DateTimeFormat().resolvedOptions()
 * .locale` is the last candidate rather than the first: it is the
 * runtime's own default, which is a reasonable answer but a less direct
 * statement of what the person asked for.
 *
 * Guarded for a `navigator`-less runtime (Node, the test environment)
 * rather than assuming a browser, because this module is imported by pure
 * formatters that are tested without a DOM.
 */
function browserLocaleCandidates(): readonly string[] {
  const candidates: string[] = [];
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  if (nav !== undefined) {
    if (Array.isArray(nav.languages)) candidates.push(...nav.languages);
    if (typeof nav.language === 'string') candidates.push(nav.language);
  }
  try {
    candidates.push(new Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    // Nothing to add; the fallback below covers it.
  }
  return candidates;
}

/**
 * THE app's display locale, resolved ONCE at module load.
 *
 * Once, not per call, because it cannot change without a page reload
 * anyway: `navigator.languages` updates fire a `languagechange` event
 * that this app has no reason to handle, since nothing else about the UI
 * is localised and re-rendering the whole mailbox to restyle timestamps
 * would be motion with no message.
 */
export const DISPLAY_LOCALE = resolveDisplayLocale(browserLocaleCandidates());

/**
 * A memo over `Intl.DateTimeFormat` construction, which is the expensive
 * part of formatting a date: it loads and compiles ICU pattern data.
 *
 * This matters concretely rather than theoretically. `toLocaleTimeString`
 * and friends build a fresh formatter on EVERY call, and this client
 * draws one timestamp per inbox row, re-running on every render of a
 * fifty-row list. Constructing fifty formatters to print fifty clock
 * times is the single hottest avoidable cost in the list.
 *
 * `key` is a caller-chosen NAME for the option set rather than a
 * serialisation of the options object: the option sets in this app are a
 * fixed, small, known list, and `JSON.stringify(options)` on every call
 * would trade one allocation for another. The contract is that one `key`
 * always describes one option set - see the `*_OPTIONS` constants in
 * components/inboxDates.ts, which is what makes that true by
 * construction.
 *
 * The `Map` is module-level mutable state, deliberately and narrowly: a
 * cache whose contents can only ever be recomputed from its key is not
 * state a caller can observe. Nothing here mutates an argument or a
 * returned value, and `Intl.DateTimeFormat` instances are immutable and
 * safe to share.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function cachedDateTimeFormat(
  key: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cacheKey = `${key} ${locale}`;
  const cached = formatterCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  formatterCache.set(cacheKey, formatter);
  return formatter;
}
