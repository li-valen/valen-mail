import type { ReactNode } from 'react';
import { Archive, MailOpen, Mails, Trash2, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import type { MoveDestination } from '../mailboxActions';
import { SELECT_BOX, SelectBox } from './SelectBox';

/**
 * THE BULK ACTION BAR — what forty ticked rows can be done with.
 *
 * **IT EXISTS ONLY WHEN SOMETHING IS SELECTED.** Not disabled, not
 * greyed: absent. A row of inert Archive/Trash buttons sitting over an
 * inbox nobody has ticked anything in is permanent chrome the user has to
 * read past on every visit, and this app's list is deliberately quiet.
 * Its arrival IS the feedback that the first tick registered.
 *
 * **STICKY, WHICH IS THE ONE PLACE THIS DEPARTS FROM "IN PLACE, NEVER A
 * TOAST".** Every other banner in this app sits in the flow and scrolls
 * away, and it should: a receipt about something that already happened
 * does not need to follow you. This bar is different in kind — it is a
 * CONTROL for rows the user is still choosing, and choosing forty of them
 * means scrolling. A bar that scrolled out of reach at row twelve would
 * make "select several, then act" require scrolling back to the top,
 * which is the entire interaction. So it stays in the flow (it pushes the
 * list down; nothing is ever covered by it) and sticks to the top of the
 * scrolling column while the selection lasts. It is opaque, because a
 * translucent bar with mail rows sliding under it is unreadable in either
 * theme.
 *
 * **ONE ROW AT EVERY WIDTH.** At 375px the count, four actions and the
 * clear control do not fit as labelled buttons, so below `sm:` the
 * actions are icon-only with `aria-label`s carrying the full name — the
 * same treatment MessageRow's hover actions use, for the same reason. The
 * labels come back at `sm:` and above, where there is room.
 *
 * Wiring only: which rows are selected, what a batch does, and what the
 * user is told all live in ../bulkSelection.ts, ../bulkRunner.ts and
 * ../bulkActions.ts, tested there without a renderer.
 */
export interface BulkActionBarProps {
  readonly count: number;
  /** Already formatted by ../bulkSelection.ts's `countLabel`, so the bar
   *  and any announcement of it cannot disagree about plurals. */
  readonly countLabel: string;
  readonly isEverythingSelected: boolean;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
  readonly onMove: (destination: MoveDestination) => void;
  readonly onMarkSeen: (seen: boolean) => void;
}

interface BarActionProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly icon: ReactNode;
}

/** One action: icon-only below `sm:`, icon plus label above it. The
 *  accessible name is the full label at BOTH widths — `aria-label` wins
 *  over the text content, so a screen reader hears "Archive 12 messages"
 *  rather than an icon with no name. */
function BarAction({ label, onClick, children, icon }: BarActionProps) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} aria-label={label} title={label}>
      {icon}
      <span className="hidden sm:inline">{children}</span>
    </Button>
  );
}

export default function BulkActionBar({
  count,
  countLabel,
  isEverythingSelected,
  onSelectAll,
  onClear,
  onMove,
  onMarkSeen,
}: BulkActionBarProps) {
  return (
    // `role="toolbar"` and not a landmark: this is a set of controls
    // acting on one thing, which is exactly what a toolbar is, and it
    // keeps the bar out of landmark navigation where it would appear and
    // disappear as the user ticks rows.
    <div
      role="toolbar"
      aria-label={`Actions for ${countLabel}`}
      className={cn(
        // `pl-4 pr-2`, not a symmetric `px-`: the leading padding is the
        // desktop ROW's own `px-4`, so the select-all box lands on the
        // exact pixel every row checkbox lands on (measured: 305px at
        // 1280 wide, both). The trailing side is tighter because the last
        // thing on it is a ghost button with its own padding.
        'sticky top-0 z-20 mb-4 flex items-center gap-1 rounded-lg py-2 pl-4 pr-2',
        // Opaque in both themes: mail rows scroll underneath this.
        'border border-neutral-200 bg-white dark:border-border dark:bg-card',
        'shadow-sm',
      )}
    >
      {/* The select-all box sits where each row's own box sits — the same
          leading column — so the header reads as the column's heading
          rather than as another action. */}
      <SelectBox
        checked={isEverythingSelected}
        label={isEverythingSelected ? 'Deselect all messages' : 'Select all messages'}
        onToggle={isEverythingSelected ? onClear : onSelectAll}
        // `mr-2` (8px) plus this row's own `gap-1` (4px) = the desktop
        // row's `gap-3`, so the count sits on the same vertical line as
        // every sender name beneath it. Measured, not derived: forgetting
        // the flex gap is exactly how the two end up 4px apart.
        className={cn(SELECT_BOX.always, 'mr-2')}
      />

      {/* THE LIVE COUNT, and it is `aria-live` because it changes without
          the user's focus moving: ticking a row with `x` from the
          keyboard produces no announcement of its own, so this is where a
          screen-reader user learns the selection grew. `polite`, never
          `assertive` — it must not interrupt the row the user is on. */}
      <span
        aria-live="polite"
        className="shrink-0 whitespace-nowrap text-sm font-medium text-neutral-900 dark:text-foreground"
      >
        {countLabel}
      </span>

      <span className="ml-auto flex items-center gap-0.5">
        <BarAction
          label={`Archive ${count} selected messages`}
          onClick={() => onMove('archive')}
          icon={<Archive aria-hidden="true" />}
        >
          Archive
        </BarAction>
        <BarAction
          label={`Move ${count} selected messages to Trash`}
          onClick={() => onMove('trash')}
          icon={<Trash2 aria-hidden="true" />}
        >
          Trash
        </BarAction>
        <BarAction
          label={`Mark ${count} selected messages as read`}
          onClick={() => onMarkSeen(true)}
          icon={<MailOpen aria-hidden="true" />}
        >
          Read
        </BarAction>
        <BarAction
          label={`Mark ${count} selected messages as unread`}
          onClick={() => onMarkSeen(false)}
          icon={<Mails aria-hidden="true" />}
        >
          Unread
        </BarAction>
        {/* The way out, and it is deliberately the last thing on the bar
            rather than the first: everything to its left is what the user
            came here to do. */}
        <BarAction
          label="Clear selection"
          onClick={onClear}
          icon={<X aria-hidden="true" />}
        >
          Clear
        </BarAction>
      </span>
    </div>
  );
}
