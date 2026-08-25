import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Badge.tsx`.
 *
 * `success` is the one variant that carries meaning rather than decoration
 * in Postbox: it is reserved for the CONFIRMED read state and nothing else
 * (see components/ReadState.tsx). `neutral` carries the unconfirmable
 * states, so the two never differ by colour alone — the mark shape beside
 * the badge does the non-colour work.
 */
const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-neutral-100 text-neutral-900',
        secondary: 'border-transparent bg-neutral-100 text-neutral-900',
        outline: 'text-neutral-950',
        neutral: 'border-transparent bg-neutral-50 text-neutral-600',
        destructive: 'border-transparent bg-red-100 text-red-900',
        success: 'border-transparent bg-green-100 text-green-900',
        warning: 'border-transparent bg-amber-100 text-amber-900',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/** Plunk renders a `<div>`; this renders a `<span>` so a badge stays valid
 *  inline content inside the `<span>`-based list rows Postbox composes. */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
