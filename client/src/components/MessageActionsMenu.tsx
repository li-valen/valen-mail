import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Archive, MoreHorizontal, Star, Trash2 } from 'lucide-react';

import { cn } from '../ui/cn';
import { TOUCH_HEIGHT } from '../ui/touchTarget';
import { isMenuKey, nextFocusIndex } from './actionMenuFocus';

/**
 * THE READER'S OVERFLOW MENU — Archive, Trash and Star behind one control.
 *
 * **WHY IT EXISTS.** The reader used to spend a whole row on these three,
 * under another whole row holding "Back to inbox". At 393px those two rows
 * cannot share a line — Back (125px) plus Archive (92) plus Trash (80) plus
 * Star (71) is 368px before gaps — so `flex-wrap` stacked them and the
 * message started 88px further down than it needed to. The user, comparing
 * with Gmail: *"Lets at a ... at the top right on the same level as back to
 * inbox and have that contain archive trash and star instead of having that
 * there."*
 *
 * **WHY A HAND-ROLLED MENU AND NOT A LIBRARY.** This project carries two
 * Radix packages and no menu primitive, and adding one for three items is a
 * dependency plus a bundle plus a second set of behaviours to learn. What a
 * menu actually owes the user is small and well specified, and all of it is
 * here: a labelled trigger that says it opens a menu, `role="menu"` with
 * `role="menuitem"` children, arrow-key movement that WRAPS, Escape that
 * closes and gives focus back, and a press outside that dismisses. The
 * movement arithmetic lives in ./actionMenuFocus.ts because no test in
 * this project may render a component, and the ends of a wrap are exactly
 * where this sort of thing is wrong.
 *
 * **TAB CLOSES IT, deliberately.** A menu is not a list of tab stops:
 * WAI-ARIA says Tab dismisses and moves on. Leaving it open while focus
 * walks away produces a floating panel attached to nothing, which is worse
 * than either trapping focus or closing.
 *
 * **THE ITEMS ARE THE SAME HANDLERS THE KEYBOARD DRIVES** (`e`, `#`, `s`),
 * and each is announced with its shortcut. One behaviour with three ways in
 * — keyboard, menu, and the list row — rather than three implementations
 * that agree today.
 */

interface MessageActionsMenuProps {
  /** Archive / move to Trash, or absent for a view where moving is not
   *  offered. Both arrive together or not at all, exactly as in the reader
   *  chrome this replaces. */
  readonly onMailboxMove?: (destination: 'archive' | 'trash') => void;
  readonly onToggleStar?: () => void;
  readonly isStarred?: boolean;
}

interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly shortcut: string;
  readonly onSelect: () => void;
  /** Only the star is a toggle; `undefined` leaves the attribute off
   *  entirely rather than announcing a false pressed state on an action. */
  readonly isPressed?: boolean;
}

export default function MessageActionsMenu({
  onMailboxMove,
  onToggleStar,
  isStarred = false,
}: MessageActionsMenuProps) {
  const menuId = useId();
  const [isOpen, setOpen] = useState(false);
  /** -1 is "open, but nothing focused yet" — how a pointer-opened menu
   *  starts. ./actionMenuFocus.ts turns that into a sensible first
   *  arrow press rather than a special case here. */
  const [focusIndex, setFocusIndex] = useState(-1);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const items: readonly MenuItem[] = [
    ...(onMailboxMove === undefined
      ? []
      : [
          // ARCHIVE BEFORE TRASH, the same order and for the same reason as
          // the row this replaces: archive is the safe, common, reversible
          // one, and putting the destructive control where a thumb aiming
          // for the safe one lands is how a list of actions becomes a hazard.
          {
            key: 'archive',
            label: 'Archive',
            icon: <Archive className="size-4" aria-hidden="true" />,
            shortcut: 'e',
            onSelect: () => onMailboxMove('archive'),
          },
          {
            key: 'trash',
            label: 'Trash',
            icon: <Trash2 className="size-4" aria-hidden="true" />,
            shortcut: '#',
            onSelect: () => onMailboxMove('trash'),
          },
        ]),
    ...(onToggleStar === undefined
      ? []
      : [
          {
            key: 'star',
            label: isStarred ? 'Unstar' : 'Star',
            icon: <Star className="size-4" aria-hidden="true" />,
            shortcut: 's',
            onSelect: onToggleStar,
            isPressed: isStarred,
          },
        ]),
  ];

  function close(returnFocus: boolean): void {
    setOpen(false);
    setFocusIndex(-1);
    if (returnFocus) triggerRef.current?.focus();
  }

  // Move real DOM focus to whatever the arithmetic chose. Runs after the
  // items render, which is why it is an effect and not part of the handler.
  useEffect(() => {
    if (!isOpen || focusIndex < 0) return;
    itemRefs.current[focusIndex]?.focus();
  }, [isOpen, focusIndex]);

  // A press anywhere outside dismisses. `pointerdown` rather than `click`
  // so the menu is gone before the press lands on whatever is underneath —
  // with `click`, tapping a message row would both close the menu and open
  // the row, which is one action too many for one tap.
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
      setFocusIndex(-1);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen]);

  if (items.length === 0) return null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={() => {
          setFocusIndex(-1);
          setOpen((open) => !open);
        }}
        onKeyDown={(event) => {
          // Opening with Down or Up lands on the first or last item, which
          // is what makes the menu usable without a pointer at all.
          if (!isOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
            setFocusIndex(nextFocusIndex(-1, event.key, items.length));
          }
        }}
        className={cn(
          TOUCH_HEIGHT,
          'inline-flex w-11 items-center justify-center rounded-md text-neutral-600 transition-colors lg:w-8',
          'cursor-pointer touch-manipulation hover:bg-neutral-100 hover:text-neutral-900',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-accent-foreground',
        )}
      >
        <MoreHorizontal className="size-5" aria-hidden="true" />
        {/* The trigger is an icon, so its name has to come from somewhere. */}
        <span className="sr-only">More actions</span>
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Message actions"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close(true);
              return;
            }
            // Tab dismisses and lets focus move on, per the ARIA menu
            // pattern. Not prevented — the browser's own move is correct.
            if (event.key === 'Tab') {
              setOpen(false);
              setFocusIndex(-1);
              return;
            }
            if (!isMenuKey(event.key)) return;
            event.preventDefault();
            const key = event.key;
            setFocusIndex((current) => nextFocusIndex(current, key, items.length));
          }}
          className={cn(
            'absolute right-0 z-20 mt-1 min-w-44 overflow-hidden rounded-lg border border-neutral-200 bg-card p-1 shadow-lg',
            'dark:border-border',
          )}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              aria-keyshortcuts={item.shortcut}
              aria-pressed={item.isPressed}
              tabIndex={-1}
              onClick={() => {
                // Closed BEFORE the action runs: archiving unmounts this
                // reader, and a menu that called `setOpen` afterwards would
                // be setting state on a component that is going away.
                setOpen(false);
                setFocusIndex(-1);
                item.onSelect();
              }}
              className={cn(
                TOUCH_HEIGHT,
                'flex w-full cursor-pointer touch-manipulation items-center gap-3 rounded-md px-3 text-left text-sm',
                'text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900',
                'focus-visible:bg-neutral-100 focus-visible:outline-none',
                'dark:text-foreground dark:hover:bg-accent dark:focus-visible:bg-accent',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
