import type * as React from 'react';

import { cn } from './cn';

/**
 * PROVENANCE. Class vocabulary taken from this directory's own
 * ./Input.tsx — itself ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Input.tsx` — rather than from Plunk's
 * Textarea directly: the reference clone (scratchpad/plunk-ref, see
 * client/CLAUDE.md's "Direction pivot 2") is no longer on disk, so this
 * is derived from the sibling atom that IS in the tree instead of being
 * copied from a file nobody can re-check. The two deviations from
 * ./Input.tsx are the ones a textarea requires:
 *
 *  - `min-h-32` and `py-2` instead of `h-9`/`py-1` — it is a multi-line
 *    field, and the caller may grow it further with `className`.
 *  - the `file:` pseudo-element classes are dropped; a textarea has no
 *    file button.
 *
 * `resize-y`, not `resize-none`: this is the field a whole email is
 * written in, and taking away the drag handle to keep a layout tidy is
 * the wrong trade.
 */
export function Textarea({ className, ref, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'flex min-h-32 w-full resize-y rounded-md border border-neutral-200 bg-transparent px-3 py-2 text-base transition-colors placeholder:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:border-border dark:placeholder:text-muted-foreground',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
}
Textarea.displayName = 'Textarea';
