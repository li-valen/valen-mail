import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Badge.tsx`.
 *
 * `success` is the one variant that carries meaning rather than decoration
 * in Valen Mail: it is reserved for the CONFIRMED read state and nothing else
 * (see components/ReadState.tsx). `neutral` carries the unconfirmable
 * states, so the two never differ by colour alone — the mark shape beside
 * the badge does the non-colour work.
 */
const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-neutral-100 text-neutral-900 dark:bg-secondary dark:text-secondary-foreground',
        secondary: 'border-transparent bg-neutral-100 text-neutral-900 dark:bg-secondary dark:text-secondary-foreground',
        outline: 'text-neutral-950 dark:text-foreground',
        neutral: 'border-transparent bg-neutral-50 text-neutral-600 dark:bg-muted dark:text-muted-foreground',
        // destructive/success/warning are unused anywhere in this app
        // today (only `neutral` — MessageRow's account chip — and
        // `secondary` — OpensFeed's count — are ever rendered) and are
        // not neutrals, so they are out of this task's audit scope; see
        // ui/Alert.tsx's comment on its own destructive variant for the
        // same reasoning applied to a variant that IS reachable.
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
 *  inline content inside the `<span>`-based list rows Valen Mail composes. */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
