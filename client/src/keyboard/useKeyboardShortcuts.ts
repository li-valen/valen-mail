import { useCallback, useEffect, useRef, useState } from 'react';

import type { FolderId } from '../inboxFilters';
import type { ReplyMode } from '../replyDraft';
import { CHORD_TIMEOUT_MS, resolveShortcut } from './shortcuts';
import type { ChordKey, PendingChord, ShortcutState } from './shortcuts';
import { describeEventTarget, isActivationElement, isTypingContext } from './typingTarget';
import { isRowTarget } from './revealRow';

/**
 * The wiring, and DELIBERATELY NOTHING ELSE.
 *
 * Read the event, ask ./shortcuts.ts what it means, run the answer. Every
 * decision — which key does what, when a chord expires, whether a
 * keystroke belongs to a text field — lives in the two pure modules this
 * imports, because client/CLAUDE.md's standing constraint is that no test
 * in this project renders a component, so anything decided HERE is
 * decided somewhere no test can reach. If a behaviour question ever needs
 * answering in this file, that is the signal it belongs in
 * ./shortcuts.ts instead.
 *
 * ONE WINDOW LISTENER, REGISTERED ONCE. State and handlers are read
 * through refs rather than closed over, so the listener is installed on
 * mount and removed on unmount and never in between. Re-registering per
 * keystroke would not merely be wasteful: a listener rebuilt between the
 * `g` and the `i` of a chord would read the chord buffer from a closure
 * captured before the `g` was pressed.
 *
 * IT IS THE LAST HANDLER, NOT THE FIRST. Bound on `window` in the BUBBLE
 * phase (no `capture: true`), so anything closer to the user gets the key
 * first and can stop it: components/SearchBar.tsx's Esc (which calls
 * `stopPropagation` precisely so this cannot also see it) and
 * components/Compose.tsx's Esc both sit on their own subtrees, below
 * this. A capturing listener would take the key out of their hands and
 * reintroduce the exact double-fire ../searchQuery.ts warns about.
 */

export interface ShortcutHandlers {
  readonly onSelect: (index: number) => void;
  readonly onOpen: (index: number) => void;
  readonly onCloseReader: () => void;
  readonly onToggleStar: () => void;
  /** Opens the composer on whichever message is in hand. Async on the
   *  App side (the parsed body has to be resolved before a quote can be
   *  built), which is why nothing here awaits it. */
  readonly onReply: (mode: ReplyMode) => void;
  readonly onGoFolder: (folder: FolderId) => void;
  readonly onOpenHelp: () => void;
  readonly onCloseHelp: () => void;
}

/** Everything the resolver needs that the app already knows. `chord` and
 *  `nowMs` are supplied by this hook — they are the two pieces of state
 *  the app has no reason to hold. */
export type ShortcutContext = Omit<ShortcutState, 'chord' | 'nowMs'>;

/**
 * How long after the window closes the on-screen `g…` hint is cleared.
 *
 * A SMALL MARGIN PAST THE WINDOW, so the hint never disappears while the
 * chord is still live — a user watching it vanish and then pressing `i`
 * anyway would be told, correctly, that nothing was pending, one frame
 * after it was. The timer is cosmetic ONLY: expiry is decided in
 * ./shortcuts.ts against the clock at the next keystroke, so a timer that
 * never fires (a backgrounded tab throttling timeouts, which browsers do
 * aggressively) cannot strand the app in a chord.
 */
const CHORD_HINT_GRACE_MS = 100;

export interface KeyboardShortcuts {
  /** The pending chord prefix, for the on-screen hint, or `null`. */
  readonly chordKey: ChordKey | null;
}

export function useKeyboardShortcuts(
  context: ShortcutContext,
  handlers: ShortcutHandlers,
): KeyboardShortcuts {
  // The AUTHORITATIVE chord buffer. A ref because the listener must read
  // the value as it is NOW, not as it was when the listener was created;
  // `chordKey` below is a render-only mirror, written in the same place
  // and never read for a decision.
  const chordRef = useRef<PendingChord | null>(null);
  const [chordKey, setChordKey] = useState<ChordKey | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refreshed on every render, read inside the listener. This is what
  // lets the listener stay registered across the whole session.
  const contextRef = useRef(context);
  contextRef.current = context;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const setChord = useCallback((next: PendingChord | null) => {
    chordRef.current = next;
    setChordKey(next?.key ?? null);

    if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = null;
    if (next === null) return;

    hintTimerRef.current = setTimeout(() => {
      hintTimerRef.current = null;
      // Guarded against a chord that was re-armed after this timer was
      // scheduled: only clear the buffer this timer was started for.
      if (chordRef.current !== next) return;
      chordRef.current = null;
      setChordKey(null);
    }, CHORD_TIMEOUT_MS + CHORD_HINT_GRACE_MS);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      const resolution = resolveShortcut(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          // The guard ../searchQuery.ts declined to write, computed at
          // the one place that has a real event to compute it from.
          isTyping: isTypingContext(event, typeof document === 'undefined' ? null : document),
          // "The platform will already do something ELSE with this
          // Enter." A message row is excluded on purpose: its platform
          // action and this app's action are the same open, and live
          // verification caught the platform not performing it at all.
          // ./revealRow.ts's `isRowTarget` carries the full case.
          isActivationTarget: isActivationElement(describeEventTarget(event)) && !isRowTarget(event),
        },
        { ...contextRef.current, chord: chordRef.current, nowMs: Date.now() },
      );

      // The buffer is written on EVERY keystroke, from the resolver's
      // complete answer — there is no "leave it alone" branch, so no
      // path through this function can leave a stale prefix behind.
      if (resolution.chord !== chordRef.current) setChord(resolution.chord);

      if (resolution.preventDefault) event.preventDefault();

      const { action } = resolution;
      const current = handlersRef.current;
      switch (action.kind) {
        case 'select':
          current.onSelect(action.index);
          return;
        case 'open':
          current.onOpen(action.index);
          return;
        case 'close-reader':
          current.onCloseReader();
          return;
        case 'toggle-star':
          current.onToggleStar();
          return;
        case 'reply':
          current.onReply(action.mode);
          return;
        case 'go-folder':
          current.onGoFolder(action.folder);
          return;
        case 'open-help':
          current.onOpenHelp();
          return;
        case 'close-help':
          current.onCloseHelp();
          return;
        case 'none':
          return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current);
    };
  }, [setChord]);

  return { chordKey };
}
