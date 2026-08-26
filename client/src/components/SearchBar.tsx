import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import { DURATION_MS } from '../motion';
import { MAX_QUERY_LENGTH, isSearchHotkey } from '../searchQuery';
import { cn } from '../ui/cn';

/**
 * The search field in the top bar — the specific interaction the user
 * named: *"you want this to kinda look like Gmail… I'm gonna click the
 * search bar. There's an animation here… make it very smooth and
 * normal."*
 *
 * **WHAT THE ANIMATION IS.** The field GROWS on focus — 32rem at rest,
 * 48rem while focused — and brightens by one step against the bar it sits
 * in. Nothing else moves. That is Gmail's gesture: the box you are typing
 * in takes more of the bar, and takes it smoothly enough that the eye
 * follows the same box rather than re-finding a new one.
 *
 * **WHY `max-width` AND NOT A TRANSFORM,** given that the motion system's
 * own rule is transform-and-opacity-only. That rule exists to keep
 * per-frame work off the compositor's critical path on LISTS — Plan 7
 * states it as "never animate layout properties on a list of 50+ rows".
 * This is one 40px-tall box in a fixed-height bar, laid out once per
 * frame with no siblings to reflow and nothing below it that moves. The
 * transform alternative, `scaleX`, is genuinely worse rather than merely
 * different: it would stretch the magnifier glyph and the placeholder
 * text horizontally for the length of the transition, which is exactly
 * the resampling artefact src/motion/Panel.tsx refuses a scale for.
 *
 * **WHY CSS AND NOT `motion/react`.** This is a state the platform
 * already tracks — `:focus-within` — so React never has to hold it, never
 * re-renders to produce it, and the field cannot desync from where focus
 * actually is. Same call, and the same reasoning, as the mobile drawer in
 * AppShell.tsx. The duration and curve are the system's
 * (`DURATION_MS.panel`, `ease-out-strong`), so this is not a second
 * motion vocabulary; `motion-reduce:transition-none` removes it rather
 * than shortening it, above and beyond styles.css's global floor.
 *
 * **KEYS.** ⌘K / Ctrl-K focuses and selects, from anywhere in the app;
 * Esc clears and blurs, from inside the box only. The asymmetry is the
 * point and ../searchQuery.ts's `isSearchHotkey` documents it: a bare-key
 * shortcut would steal letters from the composer, and a window-level Esc
 * would fire alongside the composer's own.
 *
 * **XSS.** `value` is the user's own text and `scopeLabel` is built from
 * folder labels and an account id. Both reach the DOM only as an input
 * value and a `placeholder` attribute — never as markup, never through
 * `dangerouslySetInnerHTML`.
 */

/** A fixed id rather than `useId()`: the `<label>` needs it, and so does
 *  any future call site that wants to focus the box by selector. There is
 *  exactly one search field in this app — the top bar is rendered once,
 *  at every width — so a collision is not reachable. */
export const SEARCH_INPUT_ID = 'postbox-search';

/**
 * Which chord to DRAW in the hint. `isSearchHotkey` accepts both Meta and
 * Control on every platform, so a wrong answer here costs a cosmetic
 * glyph and never a working shortcut.
 *
 * A FUNCTION CALLED DURING RENDER, not a module-level constant — and
 * that is a bug fix, not a style choice. As a `const` it was evaluated
 * once, when the module was first imported, and a browser that reports a
 * different `navigator.userAgent` at that moment than it does later
 * (which is exactly what was observed here: the hint rendered "Ctrl K" on
 * a machine whose UA says "Macintosh") leaves the value wrong for the
 * rest of the session with nothing to recompute it. Reading it at render
 * time cannot go stale, and the cost is one regex test per render of one
 * element.
 */
function shortcutHint(): string {
  const isApple =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  return isApple ? '⌘K' : 'Ctrl K';
}

export interface SearchBarProps {
  /** The raw box contents. Owned by App.tsx, which also owns the
   *  debounced value the list actually fetches with — one source of
   *  truth, so the field can never show a query the list is not running. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** What a search would be scoped to right now — "Inbox", "Sent —
   *  harvard". Rendered into the placeholder so the scope is legible
   *  BEFORE the first keystroke, rather than only in the results banner
   *  after it. */
  readonly scopeLabel: string;
}

export default function SearchBar({ value, onChange, scopeLabel }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function handleHotkey(event: globalThis.KeyboardEvent): void {
      if (!isSearchHotkey(event)) return;
      const input = inputRef.current;
      if (input === null) return;
      // Only once we know we can act on it: swallowing the browser's own
      // ⌘K without giving the user a focused field would be worse than
      // not binding it at all.
      event.preventDefault();
      input.focus();
      // Selects rather than appends, so a second ⌘K starts a new search
      // instead of extending the last one — and so the shortcut is not a
      // trap: everything a keyboard user needs (type over, Tab away, Esc
      // out) is available from this state.
      input.select();
    }
    window.addEventListener('keydown', handleHotkey);
    return () => window.removeEventListener('keydown', handleHotkey);
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Escape') return;
    // components/Compose.tsx binds Esc on its own subtree, not on the
    // window, so this could not reach it anyway — stopped explicitly all
    // the same, because "it cannot reach the other handler" is a fact
    // about today's tree rather than a property anything enforces.
    event.preventDefault();
    event.stopPropagation();
    onChange('');
    event.currentTarget.blur();
  }

  function clear(): void {
    onChange('');
    // Focus goes back to the field, not to the document: a keyboard user
    // who cleared the box is almost always about to type a new query, and
    // dropping focus to <body> would cost them a full Tab cycle to get
    // back.
    inputRef.current?.focus();
  }

  const hasQuery = value !== '';

  return (
    // A `search` landmark, so screen-reader landmark navigation has a
    // name for the top bar's one control. `<form>` rather than a bare div
    // because the platform gives a form the Enter key and iOS a "Search"
    // return key for free; submission itself is suppressed, since results
    // are already arriving on their own.
    <form
      role="search"
      className="min-w-0 flex-1"
      onSubmit={(event) => event.preventDefault()}
    >
      <label htmlFor={SEARCH_INPUT_ID} className="sr-only">
        Search mail in {scopeLabel}
      </label>
      <div
        className={cn(
          // A PILL, not a rounded rectangle. The user's Gmail-mobile
          // reference has exactly two rounded things on the screen — the
          // search field and the avatars — and both are fully round.
          'flex h-10 items-center gap-2 rounded-full bg-muted pr-2',
          // THE GESTURE. Both the growth and the brightening ride the same
          // curve and duration so they read as one movement.
          'max-w-lg focus-within:max-w-3xl',
          'focus-within:bg-card dark:focus-within:bg-accent',
          'focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring',
          'transition-[max-width,background-color,box-shadow] ease-out-strong motion-reduce:transition-none',
        )}
        style={{ transitionDuration: `${DURATION_MS.panel}ms` }}
      >
        <Search className="ml-3 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          id={SEARCH_INPUT_ID}
          ref={inputRef}
          /* `text`, not `search`: the native search type adds a
             browser-drawn clear affordance with its own Esc behaviour on
             top of the one below, and the two disagree about whether Esc
             also blurs. One clear control, one Esc, both ours. */
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          /* The server refuses anything longer with a 400 rather than
             truncating it. The clamp in buildSearchParams is what
             guarantees correctness; this is what stops the box from
             showing text that would never be searched. */
          maxLength={MAX_QUERY_LENGTH}
          autoComplete="off"
          spellCheck={false}
          aria-keyshortcuts="Meta+K Control+K"
          placeholder={`Search ${scopeLabel}`}
          /* The focus ring belongs to the whole field, not to the bare
             input inside it — see `focus-within:ring-2` above. Removing
             it here and not replacing it would be the accessibility
             defect; it is replaced one element out, on the box the user
             actually sees. */
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {hasQuery ? (
          <button
            type="button"
            onClick={clear}
            className="flex h-7 w-7 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Clear search</span>
          </button>
        ) : (
          /* The shortcut, taught where it is used. `aria-hidden` because
             `aria-keyshortcuts` on the input already announces it, and a
             second announcement of the same fact is noise. Hidden below
             `sm:` — a phone has no ⌘ and the space is better spent on the
             placeholder. */
          <kbd
            aria-hidden="true"
            className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground sm:block"
          >
            {shortcutHint()}
          </kbd>
        )}
      </div>
    </form>
  );
}
