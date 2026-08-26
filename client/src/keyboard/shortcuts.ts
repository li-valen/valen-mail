import type { FolderId } from '../inboxFilters';
import type { MoveDestination } from '../mailboxActions';
import type { ReplyMode } from '../replyDraft';

/**
 * Every keyboard decision this app makes, as ONE pure function.
 *
 * `resolveShortcut(event, state)` answers what should happen and what the
 * chord buffer should become. It touches no DOM, starts no timer, holds
 * no state and reads no clock — the caller supplies `nowMs` — so the
 * whole of the behaviour is reachable from client/CLAUDE.md's standing
 * "no test in this project renders a component" constraint. The component
 * half (./useKeyboardShortcuts.ts) is deliberately dumb: read the event,
 * call this, run the action.
 *
 * **THE CONVENTIONS ARE GMAIL'S, NOT OURS.** `j`/`k`, `o`, `u`, `s`,
 * `g` then a letter, `?`. The user asked for the app to replace Gmail;
 * inventing a better mnemonic would mean their fingers are wrong on day
 * one, which is the opposite of the goal.
 *
 * **WHY BARE KEYS ARE SAFE HERE, GIVEN ../searchQuery.ts.** That file
 * requires Meta or Control for ⌘K specifically so its handler needs no
 * "is the user typing?" test, and calls that test *"the one that always
 * eventually misses a case"*. It is right, and its reasoning is honoured
 * rather than overruled: the test now exists, in ./typingTarget.ts, and
 * it is written against the three misses searchQuery.ts named (a
 * contenteditable, a shadow root, a native picker) plus IME composition.
 * This function never re-derives it — `event.isTyping` arrives already
 * decided, and every ambiguous case resolves to "the user is typing".
 *
 * **NOTHING HERE EVER FIRES WITH A MODIFIER HELD.** ⌘J is the browser's,
 * ⌥S is the platform's, and Ctrl-K is this app's own search. A bare-key
 * table that quietly also answered to the modified forms would break
 * shortcuts it never knew about — the same objection searchQuery.ts
 * raises about swallowing ⌥⌘K.
 */

/**
 * How long a half-finished `g` waits for its second key.
 *
 * **1500ms, and the number is a judgement about intent, not about
 * typing speed.** ../searchQuery.ts sets its debounce at 220ms because
 * that lands in the pause between WORDS while touch-typing. A chord is
 * not typing: the user is answering "go to… which folder?", and that is a
 * decision, not a motor sequence. Measured typing intervals are the wrong
 * yardstick and would produce a window (~200ms) that a deliberate user
 * loses constantly.
 *
 * The ceiling is set by the opposite failure: while a chord is pending,
 * `i`/`s`/`t` mean something other than what they normally mean, so the
 * app is briefly modal. Anything long enough to still be pending when the
 * user's attention has moved on turns a forgotten `g` into a mystery
 * folder change. A second and a half is comfortably longer than a
 * decision and comfortably shorter than a distraction.
 *
 * **IT IS NOT LOAD-BEARING FOR CORRECTNESS, AND THAT IS THE POINT.**
 * Expiry is evaluated here, at the moment of the NEXT keystroke, against
 * `state.nowMs` — not by a timer whose failure to fire could strand the
 * app. A timer does exist in ./useKeyboardShortcuts.ts, but only so the
 * on-screen `g…` hint clears on its own; if it never ran, every
 * keystroke would still resolve correctly. See `expiredChord` below.
 */
export const CHORD_TIMEOUT_MS = 1500;

/** The only chord prefix. A union rather than `string` so adding a second
 *  one is a type error at every site that has to handle it. */
export type ChordKey = 'g';

export interface PendingChord {
  readonly key: ChordKey;
  /** `Date.now()` when the prefix was pressed. Compared against
   *  `state.nowMs`, never against a fresh clock read inside this file. */
  readonly startedAtMs: number;
}

/** The fields that decide a shortcut. A `KeyboardEvent` satisfies the
 *  first five structurally; the last two are computed at the DOM edge by
 *  ./typingTarget.ts. Same shape of contract as `HotkeyEvent` in
 *  ../searchQuery.ts, extended with what a bare key has to know. */
export interface ShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** ./typingTarget.ts's `isTypingContext`. */
  readonly isTyping: boolean;
  /**
   * True when the platform will already do something ELSE with this
   * Enter — focus is on a button, link or summary that is not one of the
   * list's own message rows ("Load more", "Clear search", a sidebar
   * item).
   *
   * A ROW IS DELIBERATELY EXCLUDED. Its platform action and this app's
   * action are the same open, so acting on both is a no-op rather than a
   * conflict — and live verification found the platform not firing the
   * row's click at all, which would have left Enter, one of the two
   * documented ways to open a message, silently dead.
   * ./revealRow.ts's `isRowTarget` owns that call and its full case.
   */
  readonly isActivationTarget: boolean;
}

export interface ShortcutState {
  /** `view === 'compose'`. A blanket suppression on top of `isTyping`:
   *  the composer has a subject field, a body, and recipient chips, and
   *  "which of those has focus right now" must not be the thing standing
   *  between a user and their draft. */
  readonly isComposerOpen: boolean;
  readonly isHelpOpen: boolean;
  /** The reader is showing a message (App.tsx's `selected !== null`). */
  readonly isReaderOpen: boolean;
  /** How many rows the list currently holds. */
  readonly listLength: number;
  /** The cursor. `-1` means "no cursor yet", which is the state a session
   *  starts in — see `moveTo`. */
  readonly selectedIndex: number;
  readonly chord: PendingChord | null;
  readonly nowMs: number;
}

export type ShortcutAction =
  | { readonly kind: 'none' }
  /** Move the cursor. The list stays on screen. */
  | { readonly kind: 'select'; readonly index: number }
  /** Move the cursor AND open that row in the reader. */
  | { readonly kind: 'open'; readonly index: number }
  | { readonly kind: 'close-reader' }
  /** Star or unstar whichever message is currently in hand — the open one
   *  if the reader is showing, otherwise the row under the cursor. The
   *  resolver guarantees at least one of those exists before emitting
   *  this. */
  | { readonly kind: 'toggle-star' }
  /**
   * Open the composer on whichever message is in hand — the open one if
   * the reader is showing, otherwise the row under the cursor. Same
   * "something to act on" guarantee `toggle-star` carries.
   *
   * The MODE is carried rather than three separate action kinds because
   * the three keys differ in exactly one value, and App.tsx's handler is
   * one function either way. ../replyDraft.ts owns what each mode means.
   */
  | { readonly kind: 'reply'; readonly mode: ReplyMode }
  /**
   * Get whichever message is in hand OUT of the inbox — the same
   * "something to act on" guarantee `toggle-star` and `reply` carry.
   *
   * The DESTINATION is carried rather than two separate action kinds, for
   * the same reason `reply` carries its mode: the keys differ in exactly
   * one value and App.tsx's handler is one function either way.
   * ../mailboxActions.ts owns what each destination means.
   */
  | { readonly kind: 'mailbox-move'; readonly destination: MoveDestination }
  | { readonly kind: 'go-folder'; readonly folder: FolderId }
  | { readonly kind: 'open-help' }
  | { readonly kind: 'close-help' };

export interface ShortcutResolution {
  readonly action: ShortcutAction;
  /** What the chord buffer must become. ALWAYS the complete next value,
   *  never a delta — a caller cannot forget to clear it, because there is
   *  no "leave it alone" to express. */
  readonly chord: PendingChord | null;
  /** True only when this app is genuinely handling the key. A `none` is
   *  never accompanied by a `preventDefault`: swallowing a key without
   *  acting on it is how an app breaks browser find, native scrolling and
   *  every shortcut it has not heard of. */
  readonly preventDefault: boolean;
}

/**
 * `#` — Gmail's own binding for "move to Trash", and the one letter-less
 * shortcut in this app.
 *
 * IT IS MATCHED ON THE PRODUCED CHARACTER, NOT ON "3 WITH SHIFT". On a US
 * layout `#` is Shift-3; on a UK layout Shift-3 is `£` and `#` is
 * somewhere else entirely; on a German layout it needs no modifier at
 * all. `event.key` already accounts for every one of those, which is the
 * same reason `?` is matched this way — see `resolveBareKey`, where both
 * are deliberately resolved BEFORE the Shift guard that would otherwise
 * throw them away.
 */
const TRASH_KEY = '#';

/** Keydowns for the modifier keys THEMSELVES. Pressing Shift halfway
 *  through `g` then `i` must not cancel the chord — on a layout where the
 *  second key needs a modifier, cancelling here would make the chord
 *  unreachable rather than merely awkward. Ignored entirely: no action,
 *  and the chord passes through untouched. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** `g <key>` → folder. Gmail's own three, and no more: Spam and Trash
 *  have no established chord (Gmail has none for them either), and
 *  inventing `g p` would be a shortcut only this app knows. */
const CHORD_FOLDERS: Readonly<Record<string, FolderId>> = {
  i: 'inbox',
  s: 'starred',
  t: 'sent',
};

const IGNORED: ShortcutResolution = { action: { kind: 'none' }, chord: null, preventDefault: false };

function act(action: ShortcutAction, chord: PendingChord | null = null): ShortcutResolution {
  return { action, chord, preventDefault: action.kind !== 'none' };
}

/**
 * True when a pending chord has outlived its window and must be treated
 * as though it were never pressed.
 *
 * Evaluated on READ rather than cleared by a timer, which is what makes a
 * stray `g` incapable of swallowing anything: the very next keystroke
 * re-examines the clock, finds the prefix stale, and resolves itself as
 * an ordinary key. There is no arrangement of timers, tab-backgrounding
 * or dropped frames that can leave the app waiting for a second key
 * forever, because nothing is ever *waiting* — the buffer is just a value
 * with a timestamp on it.
 */
function isExpired(chord: PendingChord, nowMs: number): boolean {
  return nowMs - chord.startedAtMs > CHORD_TIMEOUT_MS;
}

/**
 * Where the cursor lands, given a delta.
 *
 * **NO WRAPPING.** `j` at the bottom stays at the bottom. Wrapping a
 * 50-row page round to the top would be disorienting on its own, and here
 * it is also a lie: the list is paged, so the bottom of what is loaded is
 * not the bottom of the mailbox — there is a "Load more" below it. A
 * cursor that jumped to the newest message at exactly the point the user
 * reached the oldest loaded one would read as the list having reset.
 *
 * **NO CURSOR YET (`-1`) LANDS ON THE TOP ROW, from either direction.**
 * A session does not start with a selection (see ./selection.ts on why
 * inventing one would put a ring on screen for a mouse user who never
 * asked for it), so the first `j` OR `k` has to mean "give me a cursor",
 * and the only non-arbitrary place to put it is the newest message. `k`
 * jumping to the OLDEST loaded message instead would be defensible in a
 * fixed list and is indefensible in a paged one.
 */
function moveTo(state: ShortcutState, delta: number): ShortcutAction {
  if (state.listLength === 0) return { kind: 'none' };
  if (state.selectedIndex < 0) return { kind: 'select', index: 0 };

  const next = Math.min(Math.max(state.selectedIndex + delta, 0), state.listLength - 1);
  return { kind: 'select', index: next };
}

/**
 * `j`/`k` while the reader is open.
 *
 * **THEY OPEN, THEY DO NOT JUST MOVE.** The list is `hidden` behind the
 * reader (App.tsx keeps it mounted so Back is instant), so a `j` that
 * only moved the cursor would change nothing the user can see — the dead
 * interaction this codebase refuses everywhere else, and the reason
 * App.tsx has an `OpenNotFoundNotice` at all. Superhuman and Gmail both
 * step to the adjacent message from inside the reader, and MessageView
 * already prefetches its neighbours (`prefetchAround`), so the message
 * this lands on is usually already in the cache and renders on the first
 * frame.
 */
function moveFrom(state: ShortcutState, delta: number): ShortcutAction {
  const moved = moveTo(state, delta);
  if (moved.kind !== 'select') return moved;
  if (!state.isReaderOpen) return moved;
  return { kind: 'open', index: moved.index };
}

/**
 * True when there is a message for `s`, `r`, `a`, `f`, `e` or `#` to act
 * on.
 *
 * The reader always has one. The list needs a cursor, and a session that
 * has not pressed `j` yet has none — `-1` is a real state (see `moveTo`),
 * not an impossible one.
 *
 * ONE PREDICATE FOR ALL SIX KEYS, deliberately. They ask the same
 * question, and six copies of it is how one of them eventually answers
 * differently and fires on an empty list.
 */
function hasMessageInHand(state: ShortcutState): boolean {
  if (state.isReaderOpen) return true;
  return state.selectedIndex >= 0 && state.selectedIndex < state.listLength;
}

/** Resolves one keystroke, ignoring any chord — the second half of
 *  `resolveShortcut`, split out so an unrecognised chord continuation can
 *  fall through to it rather than being swallowed. */
function resolveBareKey(event: ShortcutEvent, state: ShortcutState): ShortcutResolution {
  const { key } = event;

  // `?` is the one shortcut that legitimately arrives with Shift held on
  // most layouts, and `event.key` already accounts for that — matching on
  // the produced character rather than on "slash plus shift" is also what
  // makes it work on layouts where `?` is somewhere else entirely.
  if (key === '?') {
    return act(state.isHelpOpen ? { kind: 'close-help' } : { kind: 'open-help' });
  }

  // The second key that legitimately arrives with Shift held on the most
  // common layouts, and therefore the second one resolved before the
  // Shift guard below. Gated on the help overlay explicitly, because
  // that guard is also below: trashing a message from behind an overlay
  // that covers the list is worse than invisible.
  if (key === TRASH_KEY) {
    if (state.isHelpOpen) return IGNORED;
    return hasMessageInHand(state) ? act({ kind: 'mailbox-move', destination: 'trash' }) : IGNORED;
  }

  // Escape is handled even while the help overlay is open — it is the
  // overlay's own dismissal — and is the ONE key here that may resolve to
  // `none` without that being a bug: a stray Escape on the list must stay
  // the browser's (it stops a load, cancels a native picker, leaves
  // full-screen). ../searchQuery.ts's Esc lives on the input itself and
  // stops propagation, so it never reaches this.
  if (key === 'Escape') {
    if (state.isHelpOpen) return act({ kind: 'close-help' });
    if (state.isReaderOpen) return act({ kind: 'close-reader' });
    return IGNORED;
  }

  // Below here nothing may fire while the help overlay is up: it covers
  // the list, so moving a cursor under it is invisible, and starring from
  // behind it is worse than invisible.
  if (state.isHelpOpen) return IGNORED;

  // Shift is not part of any letter or arrow shortcut. Refused rather
  // than ignored, for ../searchQuery.ts's reason about Alt: Shift-J
  // belongs to whatever binds it, and quietly answering to it is how an
  // app breaks a shortcut it never knew about.
  if (event.shiftKey) return IGNORED;

  switch (key) {
    case 'j':
    case 'ArrowDown':
      return act(moveFrom(state, 1));

    case 'k':
    case 'ArrowUp':
      return act(moveFrom(state, -1));

    case 'o':
    case 'Enter': {
      // Enter belongs to whatever the user has focused when that is a
      // control of its own — "Load more", "Clear search", a sidebar
      // item. A message ROW does not count (see `isActivationTarget`):
      // there, this app's open and the platform's are the same open, so
      // Enter is handled here and works whether or not the browser fires
      // the click. `o` never defers, which keeps "open the thing under
      // the cursor" reachable from anywhere.
      if (key === 'Enter' && event.isActivationTarget) return IGNORED;
      if (state.isReaderOpen) return IGNORED;
      if (state.selectedIndex < 0 || state.selectedIndex >= state.listLength) return IGNORED;
      return act({ kind: 'open', index: state.selectedIndex });
    }

    // Gmail's "return to the list". Distinct from Escape only in that it
    // is meaningless outside the reader, where Escape still belongs to
    // the browser.
    case 'u':
      return state.isReaderOpen ? act({ kind: 'close-reader' }) : IGNORED;

    case 's':
      // Needs something to star. See `hasMessageInHand`.
      return hasMessageInHand(state) ? act({ kind: 'toggle-star' }) : IGNORED;

    // Gmail's reply trio, and the reason Plan 9 exists: until these
    // worked the user still had to open Gmail to answer anything.
    //
    // THEY ARE LIVE FROM THE LIST AS WELL AS FROM THE READER, which is
    // both what Gmail does and what this codebase's own rule about dead
    // interactions requires — a bare key that visibly does nothing is
    // worse than no key. App.tsx resolves the parsed message (it needs
    // the body to quote and the Message-ID to thread), from cache when it
    // is there and from the network when it is not.
    case 'r':
      return hasMessageInHand(state) ? act({ kind: 'reply', mode: 'reply' }) : IGNORED;

    case 'a':
      return hasMessageInHand(state) ? act({ kind: 'reply', mode: 'replyAll' }) : IGNORED;

    case 'f':
      return hasMessageInHand(state) ? act({ kind: 'reply', mode: 'forward' }) : IGNORED;

    // Gmail's archive, and the reason this task exists: until it worked
    // the inbox only ever grew. `e` and `#` are Gmail's own bindings —
    // inventing better mnemonics would mean the user's fingers are wrong
    // on day one, which is the opposite of the goal (see this file's
    // header). Live from the list as well as from the reader, same as
    // `s` and the reply trio.
    case 'e':
      return hasMessageInHand(state)
        ? act({ kind: 'mailbox-move', destination: 'archive' })
        : IGNORED;

    // Opens a chord. The ONE resolution in this file that pairs a `none`
    // action with `preventDefault: true`, and the pairing is deliberate:
    // nothing has HAPPENED yet, so there is no action to report, but the
    // key is unambiguously consumed — `g` must not reach the browser
    // while it is standing for "go to".
    case 'g':
      return {
        action: { kind: 'none' },
        chord: { key: 'g', startedAtMs: state.nowMs },
        preventDefault: true,
      };

    default:
      return IGNORED;
  }
}

/**
 * The whole keyboard, as one call.
 *
 * Guard order is the order of severity: a key that belongs to the OS or
 * the browser is refused before a key that belongs to a text field, which
 * is refused before a key that belongs to the composer. Only what
 * survives all three is this app's to interpret.
 */
export function resolveShortcut(event: ShortcutEvent, state: ShortcutState): ShortcutResolution {
  // Pressing Shift, Control, Alt or Meta on its own is not a keystroke
  // this app has an opinion about, and — crucially — must not disturb a
  // chord in progress. The ONLY branch that returns the incoming chord
  // rather than a decision about it.
  if (MODIFIER_KEYS.has(event.key)) {
    return { action: { kind: 'none' }, chord: state.chord, preventDefault: false };
  }

  // ⌘/Ctrl/Alt belong to the platform, the browser, or — for Ctrl-K —
  // to ../searchQuery.ts's `isSearchHotkey`, which is bound separately
  // in components/SearchBar.tsx and must keep working while this is
  // installed.
  if (event.metaKey || event.ctrlKey || event.altKey) return IGNORED;

  // ./typingTarget.ts's verdict, and the reason this feature is allowed
  // to use bare keys at all. Clears any pending chord: focus has moved
  // into a field, so a `g` from before is stale by definition.
  if (event.isTyping) return IGNORED;

  // The composer is suppressed WHOLESALE, not field-by-field. `isTyping`
  // already covers its inputs; this covers everything between them — the
  // attachment button, the identity select, whatever it gains next — so
  // a draft can never be interrupted by a folder change because focus
  // happened to be resting on a control rather than in a box.
  if (state.isComposerOpen) return IGNORED;

  const chord = state.chord !== null && !isExpired(state.chord, state.nowMs) ? state.chord : null;

  if (chord !== null) {
    const folder = CHORD_FOLDERS[event.key];
    if (folder !== undefined) return act({ kind: 'go-folder', folder });

    // AN UNRECOGNISED SECOND KEY FALLS THROUGH RATHER THAN BEING EATEN.
    // The chord is cancelled — that much is obvious — but the key is then
    // resolved as if it had been pressed on its own, so `g` followed by
    // `j` moves the cursor instead of doing nothing at all. Dropping it
    // would be exactly the failure mode a chord must not have: one stray
    // prefix costing the user their next keystroke with no feedback that
    // anything was swallowed.
    return resolveBareKey(event, state);
  }

  return resolveBareKey(event, state);
}
