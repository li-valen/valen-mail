import { Undo2 } from 'lucide-react';
import { moveNoticeFor, undoLabelFor, type PendingUndo } from '../mailboxActions';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';

/**
 * "Archived. — Undo."
 *
 * **THIS IS THE REASON ARCHIVE IS SAFE TO USE WITHOUT THINKING.** An
 * archive you cannot take back is frightening enough that people stop
 * using it and go back to letting the inbox grow, which is the exact
 * problem this feature exists to solve. Gmail's undo bar is why its
 * archive feels weightless; the mechanism (move it back to where it came
 * from) is second to the fact that the offer is visibly there.
 *
 * IT IS A RECEIPT, NOT A CONFIRMATION PROMPT. The move has already
 * happened by the time this renders — the row is already gone from the
 * list and the message is already out of the inbox. Nothing here is
 * pending on the user, so it is announced politely (`role="status"`,
 * overriding ui/Alert.tsx's `role="alert"`, which spreads caller props
 * last) rather than interrupting them.
 *
 * IN PLACE, NEVER A TOAST. Same dismissible banner shape as SentNotice
 * and App.tsx's SessionError — a floating overlay that covers the list
 * would sit on top of the very rows the user is about to act on next, and
 * a keyboard user working down the inbox with `e` would be archiving
 * underneath it.
 *
 * BORDERLESS AND FLUID BELOW `lg:` comes for free: this reuses the same
 * `Alert` every other banner in the app does, so it inherits whatever
 * that component's responsive treatment is rather than inventing a second
 * one that drifts.
 */
interface UndoNoticeProps {
  readonly undo: PendingUndo;
  readonly onUndo: (undo: PendingUndo) => void;
  readonly onDismiss: () => void;
}

export default function UndoNotice({ undo, onUndo, onDismiss }: UndoNoticeProps) {
  return (
    <Alert role="status" className="mb-6">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        {/* `min-w-0`, NOT the `min-w-[12rem]` the other banners use.
            Those carry a sentence and one button; this carries a
            three-word receipt and TWO controls, and at 375px a 12rem
            floor pushed "Dismiss" onto a line of its own. The text here
            is never long enough to need a floor. */}
        <span className="min-w-0 flex-1">{moveNoticeFor(undo.destination)}</span>
        {/* `outline`, not `ghost`: this is the one control on the banner
            the user is meant to find in a hurry, and a ghost button
            beside a "Dismiss" ghost button reads as two equal options
            rather than an action and a way out. The accessible name says
            what will be undone — "Undo" alone is fine beside a notice
            that names the action, and is not fine when read on its own by
            a screen reader that has moved past the text. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onUndo(undo)}
          aria-label={undoLabelFor(undo.destination)}
        >
          <Undo2 aria-hidden="true" />
          Undo
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );
}
