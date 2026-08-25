import type { ViewId } from './AppShell';

/**
 * Query param a confirmed-open push notification's click target uses to
 * request the Opens view on load. sync/src/push/dispatch.ts's OPENS_URL
 * ('/?rail=opens') is the only writer of this value, and client/public/
 * sw.js's notificationclick handler (sameOriginPath) preserves the query
 * string verbatim when it navigates or opens a window — so whatever
 * dispatch.ts emits arrives here unchanged.
 */
const RAIL_PARAM = 'rail';
const OPENS_RAIL_VALUE = 'opens';

/**
 * Picks the view App.tsx should mount with, from the URL's query string.
 *
 * This is the client's half of the deep link a confirmed-open push
 * notification promises: dispatch.ts sets `?rail=opens` as that
 * notification's click target specifically so tapping "X opened your
 * mail" lands on the Opens view rather than the Inbox the user would
 * otherwise have to find in the sidebar by hand. Before this function
 * existed that promise was inert — App.tsx seeded `view` with the literal
 * `'inbox'` regardless of the URL, so the two notification kinds' click
 * targets were textually different but behaviourally identical (see
 * dispatch.ts's corrected comment for that history).
 *
 * Any value other than exactly `'opens'` — absent, misspelled, or some
 * future param this function does not recognise — falls back to
 * `'inbox'`. That is deliberately an allowlist of the one good value to
 * accept, not a blocklist of bad ones to reject, so a typo or an
 * unrelated query param can never select a view that does not exist.
 *
 * A pure function of the search string (rather than reading
 * `location.search` inline) specifically so it is unit-testable:
 * client/CLAUDE.md's standing constraint is that no test in this codebase
 * renders a component, and logic computed inline in a `useState`
 * initializer has no seam a test can call directly.
 */
export function initialViewFromSearch(search: string): ViewId {
  const params = new URLSearchParams(search);
  return params.get(RAIL_PARAM) === OPENS_RAIL_VALUE ? 'opens' : 'inbox';
}
