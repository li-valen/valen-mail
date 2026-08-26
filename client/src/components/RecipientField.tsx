import type { KeyboardEvent, Ref } from 'react';
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
  readonly hint?: string;
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
  hint,
  isDisabled = false,
  inputRef,
  placeholder,
}: RecipientFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
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
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>

      {/* The border and focus ring live on this wrapper rather than on
          the input, so chips and caret read as one field. */}
      <div
        className={cn(
          'flex w-full flex-wrap items-center gap-1.5 rounded-md border bg-transparent px-2 py-1.5 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
          error === undefined ? 'border-input' : 'border-red-400 dark:border-red-800',
          isDisabled && 'opacity-50',
        )}
      >
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
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </div>

      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}

      {error !== undefined && (
        <p id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
