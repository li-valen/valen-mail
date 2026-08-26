import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { InboxMessage } from './api';
import {
  bulkFlagFailureFor,
  bulkMoveFailureFor,
  bulkMoveNoticeFor,
  bulkSelectionUnavailableHere,
  bulkUndoFailureFor,
  bulkUndoLabelFor,
  canBulkSelect,
  canUndoBulk,
  runBulkFlag,
  runBulkMove,
  runBulkUndo,
  type BulkMoveOutcome,
  type BulkTarget,
} from './bulkActions';
import {
  clearSelection,
  countLabel,
  deselectKeys,
  isEverythingSelected,
  NOTHING_SELECTED,
  pruneSelection,
  selectAll,
  selectableKeys,
  selectedMessages,
  selectionKeyFor,
  toggleGroupSelection,
} from './bulkSelection';
import { UNDO_WINDOW_MS, type MoveDestination } from './mailboxActions';

/**
 * THE WIRING FOR BULK SELECTION, AND DELIBERATELY NOTHING ELSE.
 *
 * Every decision this feature makes lives in three pure modules —
 * ./bulkSelection.ts (what a tick is), ./bulkRunner.ts (how many requests
 * at once) and ./bulkActions.ts (what a batch's outcome means and what
 * the user is told) — because client/CLAUDE.md's standing constraint is
 * that no test in this project renders a component, so anything decided
 * in a hook is decided somewhere no test can reach. This file holds
 * `useState`, `useEffect` and the calls between them. The same division
 * keyboard/useKeyboardShortcuts.ts already makes against
 * keyboard/shortcuts.ts, for the same reason.
 *
 * It lives OUTSIDE App.tsx for the reason every other `use*` in this
 * directory does: App.tsx is already the largest file in the client, and
 * a feature that needs six pieces of state, a timer and two async batches
 * would push it well past the point where anyone can read it.
 *
 * ---------------------------------------------------------------------
 * THE ONE ARCHITECTURAL DECISION IN THIS FILE: THE GENERATION GUARD
 * COVERS THE SUMMARY, AND NEVER THE ROLLBACK.
 * ---------------------------------------------------------------------
 * ./messagePrefetch.ts uses a generation counter to DROP a response the
 * view has moved past, entirely. Copying that wholesale here would be a
 * bug, because the two halves of a batch's result are not the same kind
 * of thing:
 *
 *   - **The bookkeeping is about the MAILBOX.** Which rows really left
 *     the inbox and which are still in it does not depend on what the
 *     user is looking at now. `revealKeys(restoredKeys)` is therefore
 *     applied UNCONDITIONALLY, however many batches or navigations
 *     happened while the requests were in flight. A guard that skipped it
 *     would leave a message hidden in the UI and sitting in the inbox —
 *     the exact lie ./mailboxActions.ts is shaped to prevent, arrived at
 *     by being too careful rather than too careless.
 *   - **The summary is about the SCREEN.** "Archived 12 messages. Undo"
 *     is a statement about the most recent thing the user did. A first
 *     batch landing after a second one must not replace the second's
 *     notice with its own, or offer an undo for a batch the user has
 *     moved past. That is what the generation guards, and all it guards.
 */

/** A batch the user can still take back, plus enough to say what it was. */
export interface PendingBulkUndo {
  /** Which batch this is. Only ever used as a React `key`, so a second
   *  batch replays the notice's entrance rather than swapping the text
   *  under an animation that already ran — the same reason App.tsx keys
   *  its single-message undo on the hidden row. */
  readonly id: number;
  readonly outcome: BulkMoveOutcome;
}

export interface BulkSelectionOptions {
  /**
   * EVERY LOADED MESSAGE, in list order — not one per row.
   *
   * The list draws one row per conversation, but the selection, the
   * prune, "select all" and every batch are per MESSAGE, because a move
   * is one request per message. So this is the flattened set: forty
   * entries for a forty-message conversation, all of which are ticked and
   * archived together. `expand` below is what ties the two together.
   */
  readonly messages: readonly InboxMessage[];
  /** The row under the keyboard cursor, or null — what `x` acts on. The
   *  conversation's REPRESENTATIVE; `expand` turns it back into the whole
   *  conversation. */
  readonly cursorMessage: InboxMessage | null;
  /**
   * Every message the row `message` stands for — its conversation's
   * members, including itself.
   *
   * Defaults to `[message]`, which is the ungrouped behaviour this hook
   * had before conversations existed and is still what a list of
   * single-message rows produces. Must be referentially STABLE (the
   * caller wraps it in `useCallback`): it is a dependency of `toggle`,
   * which every row holds.
   */
  readonly expand?: (message: InboxMessage) => readonly InboxMessage[];
  /** Hide rows optimistically. App.tsx owns the hidden set because
   *  InboxList and the reader both draw from it. */
  readonly hideKeys: (keys: readonly string[]) => void;
  /** Put rows back. THE LOAD-BEARING ONE — see the header. */
  readonly revealKeys: (keys: readonly string[]) => void;
  /** Draw rows as read/unread before the mailbox has agreed. */
  readonly setSeen: (keys: readonly string[], seen: boolean) => void;
  /** Drop those overrides again — revert, never invert. */
  readonly revertSeen: (keys: readonly string[]) => void;
  /** Clears App.tsx's SINGLE-message undo. One undo bar at a time: a
   *  batch and a single move both offer one, and two stacked bars would
   *  leave the user pressing "Undo" without knowing which it applies to.
   *  The single path clears this hook's undo through `dismissUndo` for
   *  the same reason. */
  readonly clearSingleUndo: () => void;
}

export interface BulkSelection {
  readonly selectedKeys: ReadonlySet<string>;
  readonly count: number;
  readonly countLabel: string;
  readonly isEverythingSelected: boolean;
  /** The selected rows, in list order — what a caller hands
   *  `moveTargetsFor`. */
  readonly selection: readonly InboxMessage[];
  readonly toggle: (message: InboxMessage) => void;
  /** `x`. A no-op without a cursor; the resolver already refuses that
   *  case, and this is the belt on top of it. */
  readonly toggleCursorRow: () => void;
  /**
   * Archive / trash / report an ARBITRARY set of messages through the
   * same batch machinery the selection uses.
   *
   * Exists because a collapsed row stands for N messages even when
   * NOTHING is ticked: `e` on a forty-message conversation has to archive
   * forty, and routing that through the single-message path would archive
   * one and leave a row that silently reports thirty-nine. Everything the
   * selection path gets — the bounded runner, the partial-failure
   * accounting, the rollback, the one undo bar — comes with it, because
   * this IS that path with the targets named directly.
   */
  readonly moveMessages: (
    messages: readonly InboxMessage[],
    destination: MoveDestination,
  ) => void;
  readonly selectAllVisible: () => void;
  readonly clear: () => void;
  readonly move: (destination: MoveDestination) => void;
  readonly markSeen: (seen: boolean) => void;
  readonly undo: PendingBulkUndo | null;
  readonly undoNotice: string | null;
  readonly undoLabel: string | null;
  readonly isUndoable: boolean;
  readonly runUndo: () => void;
  readonly dismissUndo: () => void;
  /** A partial (or total) failure, held until dismissed. Never a toast,
   *  never silent. */
  readonly error: string | null;
  readonly dismissError: () => void;
}

function targetsFrom(messages: readonly InboxMessage[]): readonly BulkTarget[] {
  return messages.map((message) => ({ key: selectionKeyFor(message), message }));
}

/** The ungrouped default: one row stands for one message. A module-level
 *  constant so a caller that does not group hands down a STABLE identity
 *  rather than a fresh closure per render. */
const NO_EXPANSION = (message: InboxMessage): readonly InboxMessage[] => [message];

export function useBulkSelection(options: BulkSelectionOptions): BulkSelection {
  const {
    messages,
    cursorMessage,
    expand = NO_EXPANSION,
    hideKeys,
    revealKeys,
    setSeen,
    revertSeen,
    clearSingleUndo,
  } = options;

  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(NOTHING_SELECTED);
  const [undo, setUndo] = useState<PendingBulkUndo | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Bumped by every batch. A batch captures the value current when it
   * started and compares on the way back — see the header for why this
   * gates the SUMMARY and never the rollback.
   */
  const generationRef = useRef(0);
  /**
   * The controllers of every batch currently in flight, aborted on
   * unmount and only on unmount.
   *
   * ./bulkRunner.ts uses a signal as a GATE before each request rather
   * than as a cancellation of one already sent, so this stops the queue
   * issuing requests into a torn-down app without ever producing an
   * `AbortError` indistinguishable from a genuine failure. Navigation
   * deliberately does NOT abort: the user asked for forty messages to be
   * archived, and clicking another folder does not retract that.
   *
   * **ONE CONTROLLER PER BATCH, NEVER ONE PER HOOK — AND THAT IS A BUG
   * FIX, NOT A STYLE CHOICE.** The first version of this held a single
   * controller created lazily during render and aborted in this effect's
   * cleanup. Under `<StrictMode>` (src/main.tsx) React mounts, unmounts
   * and remounts every component on purpose, so that cleanup ran while
   * the app was very much alive — permanently aborting the one controller
   * every future batch would be gated on. Every bulk action then reported
   * all forty rows as `skipped`, restored all forty, and told the user
   * "None of the 40 messages could be archived", having sent no requests
   * at all. The whole test suite passed; only driving the real app in a
   * real browser showed it.
   *
   * A `Set` of per-batch controllers is immune by construction: the
   * cleanup aborts whatever is in flight AT THAT MOMENT and empties the
   * set, and every later batch makes its own fresh controller.
   */
  const controllersRef = useRef<Set<AbortController>>(new Set());
  useEffect(() => {
    const live = controllersRef.current;
    return () => {
      for (const controller of live) controller.abort();
      live.clear();
    };
  }, []);

  /** A controller for one batch, registered so unmount can reach it. */
  function beginBatch(): AbortController {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return controller;
  }

  /** …and unregistered when the batch settles, so a long session does not
   *  accumulate one dead controller per action. */
  function endBatch(controller: AbortController): void {
    controllersRef.current.delete(controller);
  }

  const keys = useMemo(() => messages.map(selectionKeyFor), [messages]);

  /**
   * Drop ticks whose row has left the list.
   *
   * A folder switch, an account switch or a search replaces the list
   * wholesale, and a tick on a row nobody can see is an action waiting to
   * happen invisibly — the same reasoning keyboard/selection.ts applies
   * to the cursor. `pruneSelection` returns the SAME set when nothing had
   * to go, so this is a no-op update React bails out of on every ordinary
   * list report.
   */
  useEffect(() => {
    setSelectedKeys((current) => pruneSelection(current, keys));
  }, [keys]);

  /** The undo OFFER expires; the moves do not. A cosmetic timer, exactly
   *  like App.tsx's own — if it never fired, the bar would simply stay on
   *  screen and still work. */
  useEffect(() => {
    if (undo === null) return;
    const timer = setTimeout(() => setUndo(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const selection = useMemo(
    () => selectedMessages(messages, selectedKeys, selectionKeyFor),
    [messages, selectedKeys],
  );

  const toggle = useCallback(
    (message: InboxMessage) => {
      // THE WHOLE CONVERSATION, and `every` rather than the row's own
      // message: a group in which one member cannot be moved would arm an
      // Archive that acts on part of what the row stands for. Refused OUT
      // LOUD rather than silently, the rule this codebase applies to every
      // interaction that is not offered where it was attempted. See
      // bulkActions.ts's `canBulkSelect` and conversations.ts's
      // `isConversationSelectable`, which is this same predicate named
      // from the row's side.
      const group = expand(message);
      if (!group.every(canBulkSelect)) {
        setError(bulkSelectionUnavailableHere());
        return;
      }
      setError(null);
      setSelectedKeys((current) => toggleGroupSelection(current, group.map(selectionKeyFor)));
    },
    [expand],
  );

  const toggleCursorRow = useCallback(() => {
    if (cursorMessage === null) return;
    toggle(cursorMessage);
  }, [cursorMessage, toggle]);

  const selectAllVisible = useCallback(() => {
    // Only the rows that can actually be acted on, so "select all" never
    // produces a selection the Archive button is partly inert against —
    // and only WHOLE conversations, so it never produces a half-ticked
    // one either (bulkSelection.ts's `selectableKeys`).
    setSelectedKeys(selectAll(selectableKeys(messages, canBulkSelect, expand)));
  }, [messages, expand]);

  const clear = useCallback(() => setSelectedKeys(clearSelection()), []);

  /**
   * Archive / trash / report a named set of messages.
   *
   * THE ORDER OF THE FIRST FOUR LINES IS THE FEATURE. The rows are hidden
   * and the ticks cleared in the same frame as the click, because a bulk
   * action that waited for forty IMAP round trips would feel broken; the
   * batch then decides, per row, which of those hides stands.
   *
   * Takes the messages rather than reading the selection, so the SAME
   * machinery serves the bar's buttons, `e`/`#` over a ticked selection,
   * and `e`/`#` over a collapsed conversation nobody has ticked. It
   * deselects the batch's keys unconditionally, which is a no-op for the
   * third case and the point of the first two.
   */
  const moveMessages = useCallback(
    (batch: readonly InboxMessage[], destination: MoveDestination) => {
      const targets = targetsFrom(batch);
      if (targets.length === 0) return;

      const batchKeys = targets.map((target) => target.key);
      setError(null);
      setUndo(null);
      clearSingleUndo();
      hideKeys(batchKeys);
      // Cleared IMMEDIATELY, not when the batch settles. The bar is a
      // statement about rows on screen, and these rows are already gone;
      // leaving forty ticks up for the length of forty round trips would
      // let a second Archive fire against a selection that is mid-flight.
      setSelectedKeys((current) => deselectKeys(current, batchKeys));

      generationRef.current += 1;
      const issuedAt = generationRef.current;
      const controller = beginBatch();

      void runBulkMove(targets, destination, { signal: controller.signal }).then(
        (outcome) => {
          endBatch(controller);
          // UNCONDITIONAL. See the header: which rows are still in the
          // inbox is a fact about the mailbox, not about the screen.
          revealKeys(outcome.restoredKeys);

          if (issuedAt !== generationRef.current) return;
          setError(bulkMoveFailureFor(destination, outcome));
          if (outcome.movedKeys.length === 0) return;
          setUndo({ id: issuedAt, outcome });
        },
        (error: unknown) => {
          // `runBulkMove` is built not to reject — every request's failure
          // is a per-item status. Reaching here means the batching itself
          // broke, which would leave every row hidden and no report to
          // put them back from, so the rows come back wholesale.
          endBatch(controller);
          console.error('useBulkSelection: bulk move batch failed', error);
          revealKeys(batchKeys);
          if (issuedAt !== generationRef.current) return;
          setError(bulkMoveFailureFor(destination, {
            destination,
            movedKeys: [],
            restoredKeys: batchKeys,
            undos: [],
            attempted: batchKeys.length,
          }));
        },
      );
    },
    [hideKeys, revealKeys, clearSingleUndo],
  );

  /**
   * Archive / trash / report the whole SELECTION.
   *
   * Resolves the ticked keys against the loaded list and hands them to
   * `moveMessages` — one path, so the bar's button and a keystroke on an
   * unticked conversation cannot behave differently.
   */
  const move = useCallback(
    (destination: MoveDestination) => {
      moveMessages(selectedMessages(messages, selectedKeys, selectionKeyFor), destination);
    },
    [messages, selectedKeys, moveMessages],
  );

  const runUndo = useCallback(() => {
    if (undo === null) return;
    const entries = undo.outcome.undos;
    setUndo(null);
    setError(null);
    if (entries.length === 0) return;

    generationRef.current += 1;
    const issuedAt = generationRef.current;
    const destination = undo.outcome.destination;
    const controller = beginBatch();

    void runBulkUndo(entries, { signal: controller.signal }).then(
      (outcome) => {
        endBatch(controller);
        // Unconditional again, and in the other direction: a row that
        // came back must appear, whatever else has happened since.
        revealKeys(outcome.restoredKeys);
        if (issuedAt !== generationRef.current) return;
        setError(bulkUndoFailureFor(destination, outcome));
      },
      (error: unknown) => {
        endBatch(controller);
        console.error('useBulkSelection: bulk undo batch failed', error);
        if (issuedAt !== generationRef.current) return;
        setError(
          bulkUndoFailureFor(destination, {
            restoredKeys: [],
            stuckKeys: entries.map((entry) => entry.key),
            attempted: entries.length,
          }),
        );
      },
    );
  }, [undo, revealKeys]);

  /**
   * Mark the selection read or unread.
   *
   * No success notice, deliberately: the rows stop (or start) being bold
   * where the user is already looking. A FAILURE is the invisible half —
   * the override is dropped and the row quietly returns to what it was —
   * which is the only case that gets a sentence.
   */
  const markSeen = useCallback(
    (seen: boolean) => {
      const targets = targetsFrom(selectedMessages(messages, selectedKeys, selectionKeyFor));
      if (targets.length === 0) return;

      const batchKeys = targets.map((target) => target.key);
      setError(null);
      setSeen(batchKeys, seen);
      setSelectedKeys((current) => deselectKeys(current, batchKeys));

      generationRef.current += 1;
      const issuedAt = generationRef.current;
      const controller = beginBatch();

      void runBulkFlag(targets, seen, { signal: controller.signal }).then(
        (outcome) => {
          endBatch(controller);
          revertSeen(outcome.revertedKeys);
          if (issuedAt !== generationRef.current) return;
          setError(bulkFlagFailureFor(outcome));
        },
        (error: unknown) => {
          endBatch(controller);
          console.error('useBulkSelection: bulk flag batch failed', error);
          revertSeen(batchKeys);
          if (issuedAt !== generationRef.current) return;
          setError(
            bulkFlagFailureFor({
              seen,
              changedKeys: [],
              revertedKeys: batchKeys,
              attempted: batchKeys.length,
            }),
          );
        },
      );
    },
    [messages, selectedKeys, setSeen, revertSeen],
  );

  const movedCount = undo?.outcome.movedKeys.length ?? 0;

  return {
    selectedKeys,
    count: selectedKeys.size,
    countLabel: countLabel(selectedKeys.size),
    isEverythingSelected: isEverythingSelected(
      selectedKeys,
      selectableKeys(messages, canBulkSelect, expand),
    ),
    selection,
    toggle,
    toggleCursorRow,
    moveMessages,
    selectAllVisible,
    clear,
    move,
    markSeen,
    undo,
    undoNotice: undo === null ? null : bulkMoveNoticeFor(undo.outcome.destination, movedCount),
    // Counts the TICKETS, not the moved rows, and the two can differ: a
    // message that was already gone moved without leaving anything to put
    // back. Saying "Undo archive of 10 messages" under "Archived 12
    // messages." is the honest pairing.
    undoLabel:
      undo === null
        ? null
        : bulkUndoLabelFor(undo.outcome.destination, undo.outcome.undos.length),
    isUndoable: undo !== null && canUndoBulk(undo.outcome),
    runUndo,
    dismissUndo: useCallback(() => setUndo(null), []),
    error,
    dismissError: useCallback(() => setError(null), []),
  };
}
