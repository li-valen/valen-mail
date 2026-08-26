import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

import { DURATION_MS, Settle } from '../motion';
import { SHORTCUT_HELP } from '../keyboard/shortcutTable';
import type { ShortcutHelpEntry } from '../keyboard/shortcutTable';
import { cn } from '../ui/cn';

/**
 * The `?` overlay: every shortcut this app answers to, on one card.
 *
 * **IT RENDERS ../keyboard/shortcutTable.ts AND NOTHING ELSE.** No key is
 * spelled in this file, so the help and the behaviour cannot drift apart
 * without a test noticing — tests/keyboard-help.test.ts checks the table
 * against ../keyboard/shortcuts.ts in both directions. A help screen that
 * advertises a shortcut the app does not have costs the user a keystroke
 * and then their trust in every other line of it.
 *
 * **DESKTOP ONLY (`hidden lg:flex`).** A phone has no keyboard and no way
 * to press `?`, so on mobile this is a card explaining controls that
 * cannot be reached. The user was explicit that the mobile layout stays
 * borderless and fluid; adding an unreachable modal to it would be a
 * regression in the exact direction they asked us not to go.
 *
 * **ESC AND `?` BOTH CLOSE IT, and neither is bound here** — both live in
 * ../keyboard/shortcuts.ts with every other key, so there is one table of
 * what the keyboard does rather than one table plus a component that also
 * has opinions. This file binds exactly one key, Tab, and only to keep
 * focus inside the dialog.
 */

/** A single key cap. `<kbd>` because that is what it is — the element
 *  exists for exactly this and screen readers announce it as keyboard
 *  input. */
function Key({ children }: { readonly children: string }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground">
      {children}
    </kbd>
  );
}

/**
 * One row of the table.
 *
 * THE JOINER CARRIES MEANING. `g` `then` `i` is a sequence — press one,
 * then the other. `Enter` `or` `o` is a choice. Rendered from
 * `isSequence` rather than inferred from the key count, because both
 * shapes have two keys and getting it backwards teaches the user a
 * shortcut that does not exist.
 */
function HelpRow({ entry }: { readonly entry: ShortcutHelpEntry }) {
  const joiner = entry.isSequence === true ? 'then' : 'or';
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-neutral-700 dark:text-muted-foreground">{entry.description}</span>
      <span className="flex shrink-0 items-center gap-1">
        {entry.keys.map((key, index) => (
          <span key={key} className="flex items-center gap-1">
            {index > 0 && (
              <span className="text-[11px] text-neutral-400 dark:text-muted-foreground">{joiner}</span>
            )}
            <Key>{key}</Key>
          </span>
        ))}
      </span>
    </div>
  );
}

export interface ShortcutHelpProps {
  readonly onClose: () => void;
}

export default function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Where focus was before the overlay opened, so closing returns it
  // rather than dropping it on <body> — the same discipline App.tsx's
  // `composeTriggerRef` applies to the composer.
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      const previous = restoreRef.current;
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      // `hidden lg:flex` — see the header. The scrim is fixed and covers
      // the shell, so the overlay is not affected by the content column's
      // own scroll position.
      className="fixed inset-0 z-50 hidden items-center justify-center bg-black/50 p-6 lg:flex"
      onClick={onClose}
    >
      <Settle className="w-full max-w-lg">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcut-help-title"
          // Stops a click INSIDE the card from reaching the scrim's
          // dismiss handler above. Clicking the backdrop closes; clicking
          // the card does not.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // A one-element focus trap. The card holds exactly one
            // focusable control, so "keep Tab inside" is literally "send
            // Tab back to it" — no ordering, no first/last bookkeeping to
            // get wrong. `aria-modal` tells assistive tech the rest of
            // the page is inert; this makes it true for the Tab key too.
            if (event.key !== 'Tab') return;
            event.preventDefault();
            closeRef.current?.focus();
          }}
          className={cn(
            'max-h-full overflow-y-auto rounded-lg border border-neutral-200 bg-card p-6 shadow-lg',
            'dark:border-border dark:text-card-foreground',
          )}
          style={{ transitionDuration: `${DURATION_MS.panel}ms` }}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id="shortcut-help-title" className="text-base font-semibold text-foreground">
              Keyboard shortcuts
            </h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Close shortcuts</span>
            </button>
          </div>

          <div className="space-y-5">
            {SHORTCUT_HELP.map((group) => (
              <section key={group.title}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-muted-foreground">
                  {group.title}
                </h3>
                <div className="divide-y divide-neutral-100 dark:divide-border">
                  {group.entries.map((entry) => (
                    <HelpRow key={entry.description} entry={entry} />
                  ))}
                </div>
              </section>
            ))}
          </div>

          <p className="mt-5 text-xs text-neutral-500 dark:text-muted-foreground">
            Shortcuts never fire while you are typing in a field or writing a message.
          </p>
        </div>
      </Settle>
    </div>
  );
}
