import { DEFAULT_FOLDER } from './inboxFilters';
import type { FolderId } from './inboxFilters';
import type { InboxCursor } from './api';

/**
 * The wire half of the search bar (Plan 7 Task 3): what a query is
 * allowed to be, how a {query, folder, account, cursor} selection becomes
 * GET /api/search's query string, and the one keystroke that opens the
 * box.
 *
 * **Why this is not a flag on `buildInboxParams`.** The two routes are
 * deliberately near-identical — same envelope, same row shape, same
 * keyset cursor (sync/src/api/search.ts imports /api/inbox's own cursor
 * and folder helpers rather than reimplementing them) — and they disagree
 * about exactly ONE thing, in the direction that fails silently:
 *
 *   **An absent `folder` means EVERY folder to /api/search and INBOX to
 *   /api/inbox.**
 *
 * `buildInboxParams` OMITS `folder=inbox` because it is redundant there.
 * Reusing that habit here would turn "search Inbox" into "search the
 * whole mailbox", answered with an ordinary 200 that nothing would
 * report — the user would search from the Inbox and get Spam and Trash
 * back. So this function ALWAYS sends `folder`, including the default,
 * and it is a separate function so that neither call site can inherit the
 * other's rule by accident. See ./inboxFilters.ts for the two traps the
 * routes DO share (an empty `account` is a 400; a cursor carries no
 * filter identity), both of which apply here unchanged.
 */

/**
 * The server's cap on `q`, mirrored (sync/src/api/search.ts's
 * `MAX_QUERY_LENGTH`).
 *
 * Mirrored rather than discovered, because the server refuses an
 * over-long query with a **400 instead of truncating it** — deliberately,
 * so that a silently-narrowed search cannot look like a correct one. That
 * choice is right on the server and it means the client has to do the
 * clamping itself: a user pasting a paragraph into the box must get a
 * search, not an error banner. tests/search-query.test.ts pins the two
 * numbers together.
 */
export const MAX_QUERY_LENGTH = 200;

/**
 * How long the box waits after the last keystroke before it asks the
 * server anything.
 *
 * 220ms. The median inter-keystroke interval while touch-typing is
 * roughly 150–200ms, so 220 falls in the pause BETWEEN words rather than
 * between letters: a five-letter word costs one request, not five, across
 * four real mailboxes. It is also short enough that the result lands well
 * inside the ~400ms at which a person starts to experience a wait as
 * waiting.
 *
 * Not a motion token, despite living in the same numeric neighbourhood as
 * src/motion/tokens.ts's durations: nothing here animates, and filing it
 * with the curves would invite someone to "keep the system consistent"
 * by tying a network decision to a visual one.
 */
export const SEARCH_DEBOUNCE_MS = 220;

/**
 * Normalises what the user typed into what may go on the wire, and
 * answers `''` for "nothing worth sending".
 *
 * ORDER MATTERS: clamp first, trim second. sync/src/api/search.ts checks
 * `raw.length > MAX_QUERY_LENGTH` BEFORE it trims, so the length the
 * server measures is the length the caller sent — clamping the trimmed
 * value would let a padded 250-character paste through at 200 visible
 * characters and still be refused.
 *
 * A whitespace-only box answers `''` rather than `'   '` because that is
 * a 400 too, and because an ILIKE `%   %` would otherwise match most of
 * the mailbox — the exact failure a debounced search-as-you-type box
 * produces constantly, since a user pressing space is one keystroke away
 * from it.
 */
export function clampSearchQuery(raw: string): string {
  return raw.slice(0, MAX_QUERY_LENGTH).trim();
}

/** A query plus the request-shaped extras GET /api/search also takes.
 *  `q` is the only required field; everything else is a filter the search
 *  composes with. */
export interface SearchQuery {
  readonly q: string;
  readonly folder?: FolderId;
  /** `null`/omitted/`''` = all accounts merged. NEVER reaches the wire as
   *  an empty param — see ./inboxFilters.ts's trap 2, which /api/search
   *  inherits verbatim (it calls the same `parseAccountParam`). */
  readonly account?: string | null;
  readonly cursor?: InboxCursor | null;
  readonly limit?: number;
}

/**
 * Encodes one search request as a query string (no leading `?`).
 *
 * `q` is clamped here rather than trusted from the caller, so there is
 * exactly one place in the client that can produce an over-long query and
 * it is the place that cannot forget. A caller must still avoid calling
 * this with a blank box — an empty `q` is a 400 — which
 * components/InboxList.tsx enforces structurally by only fetching when
 * `clampSearchQuery` answered with something.
 *
 * Param order is fixed (q, limit, folder, account, then the three cursor
 * fields) purely so the output is a stable string a test can assert on
 * whole rather than by substring.
 */
export function buildSearchParams(query: SearchQuery): string {
  const params = new URLSearchParams();

  params.set('q', clampSearchQuery(query.q));

  if (query.limit !== undefined) params.set('limit', String(query.limit));

  // ALWAYS sent, default included. See this file's header: absent means
  // "every folder" on this route, which is a different search from the
  // one the sidebar is showing.
  params.set('folder', query.folder ?? DEFAULT_FOLDER);

  const account = query.account ?? null;
  if (account !== null && account !== '') params.set('account', account);

  const cursor = query.cursor ?? null;
  if (cursor !== null) {
    if (cursor.before !== null) params.set('before', cursor.before);
    if (cursor.beforeAccount !== null) params.set('beforeAccount', cursor.beforeAccount);
    if (cursor.beforeUid !== null) params.set('beforeUid', cursor.beforeUid);
  }

  return params.toString();
}

/** The three fields that decide the shortcut, and nothing else — a
 *  `KeyboardEvent` satisfies this structurally, so the predicate is
 *  testable without a DOM. */
export interface HotkeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/**
 * True for ⌘K (macOS) and Ctrl-K (everywhere else), the keystroke that
 * puts focus in the search box from anywhere in the app.
 *
 * **WHY ONLY THE MODIFIED FORM.** A bare-key shortcut — `/`, or a plain
 * `k` — is the one that steals typing from a focused composer body, and
 * this app has a composer. Requiring Meta or Control makes the chord
 * unreachable while typing prose, which means the window-level handler
 * needs no "is the user in a text field?" test. That test is the one that
 * always eventually misses a case (a contenteditable, a shadow root, a
 * native picker), and the failure mode is a user losing a sentence
 * mid-word.
 *
 * **Alt/Option is excluded** rather than ignored: ⌥⌘K and friends belong
 * to the platform and to the browser, and quietly swallowing them is how
 * an app breaks a shortcut it never knew about.
 *
 * **Esc is deliberately not here.** It is bound on the input itself, not
 * on the window: components/Compose.tsx already owns window-level Esc
 * (discard-draft confirmation), and a second global listener would clear
 * the search AND close the composer from one press. Esc only means
 * "leave the search box" while the search box has focus, which is both
 * the platform convention and the only scope that cannot collide.
 */
export function isSearchHotkey(event: HotkeyEvent): boolean {
  if (event.altKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return event.key.toLowerCase() === 'k';
}
