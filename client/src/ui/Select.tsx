import type * as React from 'react';

import { cn } from './cn';

/**
 * A NATIVE `<select>`, styled with this directory's own field vocabulary.
 *
 * PROVENANCE, and the one deliberate departure from it. Plunk's own
 * Select atom wraps `@radix-ui/react-select`, which is a new dependency —
 * and Plan 4 Task 4 allows no new dependencies. Rather than vendoring a
 * combobox by hand (roughly 200 lines of listbox roles, typeahead,
 * pointer-vs-keyboard focus and portal positioning, none of which this
 * client's tests could verify because no test here renders a component),
 * this wraps the platform control and takes ./Input.tsx's classes —
 * itself ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Input.tsx`.
 *
 * That is not a consolation prize for a picker of four email addresses.
 * The native control brings correct keyboard and screen-reader behaviour
 * for free, and at 400px it opens the OS picker — a far better target on
 * a phone than any rendered dropdown.
 *
 * `[color-scheme:light] dark:[color-scheme:dark]` is what keeps the
 * UA-painted OPTION LIST in the same theme as the page. `:root` declares
 * `color-scheme: light dark` (src/styles.css), which lets the UA choose
 * from `prefers-color-scheme` — but Valen Mail's palette is chosen by the
 * `.dark` CLASS, from a stored System/Light/Dark preference, and those
 * two disagree exactly when someone on a dark OS picks Light. Without
 * these classes that person gets a black dropdown over a white form.
 * Scoped to this atom rather than fixed in the stylesheet because this is
 * the only native form control in the app.
 *
 * `bg-card` rather than ./Input.tsx's `bg-transparent`: an unopened
 * select needs a solid ground of its own to sit on inside a card, and
 * `bg-card` is the semantic token whose light value is the same white.
 */
export function Select({ className, children, ref, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-11 w-full rounded-md md:h-9 border border-neutral-200 bg-card px-3 py-1 text-base transition-colors [color-scheme:light] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:border-border dark:[color-scheme:dark]',
        className,
      )}
      ref={ref}
      {...props}
    >
      {children}
    </select>
  );
}
Select.displayName = 'Select';
