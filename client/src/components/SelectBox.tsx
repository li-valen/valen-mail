import { Check } from 'lucide-react';
import { cn } from '../ui/cn';

/**
 * THE TICK BOX — one control, used by a list row's leading column and by
 * the bulk bar's select-all.
 *
 * **A `<button role="checkbox">`, NOT AN `<input type="checkbox">`, and
 * the reason is the row it sits in.** A native checkbox brings the
 * platform's own box, which cannot be restyled consistently across
 * engines without `appearance: none` — at which point every affordance it
 * was chosen for (the tick, the focus ring, the hit area) is being
 * hand-drawn anyway. A `<button>` with `role="checkbox"` and
 * `aria-checked` gives assistive technology the identical semantics
 * ("checkbox, checked") and activation on both Enter and Space, which is
 * everything the native control was going to contribute. This is the same
 * trade ui/Switch.tsx makes and the same one MessageRow makes in choosing
 * real `<button>` rows over a `role="listbox"`.
 *
 * **IT STOPS ITS OWN CLICK.** In a list row the box sits INSIDE a `<li>`
 * whose sibling is the row button; without `stopPropagation`, ticking a
 * row would also open it, because the click bubbles into the row's
 * handler. Exactly MessageRow's `RowAction` problem, and exactly its
 * answer.
 *
 * **THE NAME SAYS WHICH ROW.** A fifty-row list produces fifty
 * checkboxes, and a screen reader does not read the row's own text as
 * part of a nested control's name — so callers pass the subject in.
 */
export interface SelectBoxProps {
  readonly checked: boolean;
  /** The accessible name AND the tooltip. One string, so the two cannot
   *  drift. */
  readonly label: string;
  readonly onToggle: () => void;
  readonly className?: string;
  /**
   * `-1` inside the message list, which uses a roving tab order (see
   * MessageRow's header) — fifty boxes must not become fifty tab stops.
   * Left undefined on the bar, where the box is a genuine, single tab
   * stop.
   */
  readonly tabIndex?: number;
}

/**
 * VISIBILITY RECIPES, exported so a row and the bar cannot drift on when
 * a box is on screen.
 *
 * `onHover` is the desktop row's: the column is always REserved (so
 * nothing shifts sideways when a pointer arrives) and the box inside it
 * is invisible until the row is hovered, the box is focused, or the row
 * is ticked. `opacity`, never `display`, for exactly that reason —
 * `hidden` would collapse the column and move every sender name.
 */
export const SELECT_BOX = {
  always: '',
  onHover:
    'opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 data-[checked=true]:opacity-100',
} as const;

export function SelectBox({ checked, label, onToggle, className, tabIndex }: SelectBoxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-checked={checked}
      tabIndex={tabIndex}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border',
        'transition-colors duration-150',
        // `neutral-500` and not `neutral-400`: a 1px box outline is
        // non-text content, so WCAG 1.4.11 wants 3:1 against the ground
        // it sits on. neutral-400 on white is 2.3:1 and fails; neutral-500
        // is 4.5:1. The dark half sits at neutral-400 against the near
        // black `--card`, which is 7.6:1.
        checked
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-neutral-500 bg-transparent dark:border-neutral-400',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
    >
      {/* The tick is drawn only when checked; the box's own `aria-checked`
          is what conveys the state, so this is `aria-hidden` and the
          unchecked state needs no placeholder glyph at all. */}
      {checked && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
    </button>
  );
}
