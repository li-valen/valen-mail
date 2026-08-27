import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { X } from 'lucide-react';

import {
  includesRecipient,
  isValidRecipient,
  mergeRecipients,
  parseRecipients,
  splitPendingInput,
} from './composeRecipients';
import { Label } from '../ui/Label';
import { cn } from '../ui/cn';
import { CHIP_BASE, CHIP_BAD, CHIP_NEUTRAL, CHIP_REMOVE } from './chip';
import { TOUCH_INPUT_TEXT, TOUCH_MIN_HEIGHT } from '../ui/touchTarget';

/**
 * One recipient field — To or Cc — as a row of removable chips followed
 * by the input that makes them.
 *
 * CONTROLLED, entirely. It holds no state of its own; the composer owns
 * both the committed addresses and the half-typed tail, because the
 * composer is what has to flush that tail when Send is pressed. A field
 * that kept its own pending string would silently drop the address a user
 * typed and then clicked Send without pressing Enter first — the single
 * most likely way to send a message to nobody.
 *
 * All four editing rules live in ./composeRecipients.ts, so the suite can
 * see them (client/CLAUDE.md: no test in this client renders a
 * component). This file is the markup and the event plumbing.
 *
 * XSS: every address is user input and is rendered as a text child, never
 * as markup, and never interpolated into a `dangerouslySetInnerHTML`, an
 * `href` or a `style`. The remove button's `aria-label` is likewise a
 * plain string React escapes.
 *
 * KEYBOARD, in full:
 *  - Enter or comma commits what is typed (and never submits the form —
 *    a stray Enter in a recipient box must not send the message).
 *  - Backspace on an empty input removes the last chip.
 *  - Every chip's remove control is a real `<button>`, so Tab reaches it
 *    and Space/Enter activate it, with no key handling of our own.
 *  - Blur commits, which covers Tab-away and clicking straight on Send.
 */

interface RecipientFieldProps {
  /** Id for the input; the label, hint and error are wired to it. */
  readonly id: string;
  readonly label: string;
  readonly addresses: readonly string[];
  /** The half-typed tail still in the input. */
  readonly pending: string;
  /** Reports the WHOLE next state of the field — committed list and tail
   *  together — because a keystroke can change both at once. */
  readonly onChange: (addresses: readonly string[], pending: string) => void;
  /** Recipients whose copy did not go out on the last send. Marked so a
   *  partial failure is legible per address, not just as a count. */
  readonly failed?: readonly string[];
  readonly error?: string;
  /** Rendered at the right end of the row — the To row uses it for the
   *  Cc/Bcc disclosure, the way Gmail does. */
  readonly trailing?: ReactNode;
  readonly isDisabled?: boolean;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly placeholder?: string;
}

export default function RecipientField({
  id,
  label,
  addresses,
  pending,
  onChange,
  failed = [],
  error,
  trailing,
  isDisabled = false,
  inputRef,
  placeholder,
}: RecipientFieldProps) {
  const errorId = `${id}-error`;
  const describedBy = [error === undefined ? null : errorId]
    .filter((value): value is string => value !== null)
    .join(' ');

  /** Turns whatever is in the tail into chips and empties it. */
  function commitPending(): void {
    const additions = parseRecipients(pending);
    if (additions.length === 0) {
      if (pending !== '') onChange(addresses, '');
      return;
    }
    onChange(mergeRecipients(addresses, additions), '');
  }

  function handleInput(value: string): void {
    const { committed, pending: tail } = splitPendingInput(value);
    // Passing `addresses` through untouched when nothing was committed
    // keeps the chip list referentially stable across ordinary typing.
    if (committed.length === 0) {
      onChange(addresses, tail);
      return;
    }
    onChange(mergeRecipients(addresses, committed), tail);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter must never reach the form: in a recipient box it means
      // "finish this address", not "send the message".
      event.preventDefault();
      commitPending();
      return;
    }
    if (event.key === 'Backspace' && pending === '' && addresses.length > 0) {
      event.preventDefault();
      onChange(addresses.slice(0, -1), pending);
    }
  }

  function removeAddress(address: string): void {
    onChange(
      addresses.filter((candidate) => candidate !== address),
      pending,
    );
  }

  return (
    /* A ROW, NOT A LABELLED BOX. The composer used to stack a label above a
       bordered field for every address line; four of those plus their hints
       filled most of a phone screen before the body. The user, beside
       Gmail's compose: "too much space taken up. clean simple efficient."
       Gmail's answer is a label sitting inline at the left of a borderless
       row, with one hairline between rows doing the separating — so the
       field's edges cost nothing and the body gets the space back. */
    <div
      className={cn(
        'border-b border-neutral-200 transition-colors focus-within:bg-neutral-50 dark:border-border dark:focus-within:bg-accent/30',
        isDisabled && 'opacity-50',
      )}
    >
      <div className="flex items-start gap-3 px-4">
        <Label
          htmlFor={id}
          /* Fixed width so To / Cc / From / Subject share one left edge and
             their values share another — the alignment is what makes a
             borderless form still read as a form. */
          className="w-14 shrink-0 py-3 text-sm font-normal text-neutral-500 dark:text-muted-foreground"
        >
          {label}
        </Label>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1.5">
        {addresses.length > 0 && (
          <ul className="flex flex-wrap items-center gap-1.5">
            {addresses.map((address) => {
              const isBad = !isValidRecipient(address) || includesRecipient(failed, address);
              return (
                <li key={address}>
                  <span className={cn(CHIP_BASE, isBad ? CHIP_BAD : CHIP_NEUTRAL)}>
                    <span className="truncate">{address}</span>
                    <button
                      type="button"
                      onClick={() => removeAddress(address)}
                      disabled={isDisabled}
                      className={CHIP_REMOVE}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                      <span className="sr-only">Remove {address}</span>
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <input
          id={id}
          ref={inputRef}
          type="text"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={isDisabled}
          value={pending}
          placeholder={addresses.length === 0 ? placeholder : undefined}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          onChange={(event) => handleInput(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitPending}
          className={`min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed ${TOUCH_INPUT_TEXT} ${TOUCH_MIN_HEIGHT}`}
        />
        </div>

        {trailing !== undefined && <div className="shrink-0 self-center">{trailing}</div>}
      </div>

      {error !== undefined && (
        <p id={errorId} role="alert" className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
