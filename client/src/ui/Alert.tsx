import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Alert.tsx`. `AlertTitle` is omitted —
 * every alert Postbox renders is a single sentence plus a recovery
 * control, with no separate heading line.
 */
const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-neutral-950 dark:[&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-card text-neutral-950 dark:text-foreground',
        // NOT routed through --destructive: that token is one saturated
        // red meant for a SOLID button (bg-destructive
        // text-destructive-foreground), not this subtle pale-bg/dark-text
        // alert style — applying it here would change the LIGHT rendering
        // too, which task V2 must not do. No semantic token fits a
        // "subtle destructive" role, so this variant (and warning/success
        // below) is left exactly as shipped: out of the neutral audit's
        // scope (client/tests/theme-tokens.test.ts's guard only checks
        // bg-white/bg-neutral-*/text-neutral-*/border-neutral-*), and
        // `destructive` is the only one of the three actually reachable
        // today (InboxList.tsx, App.tsx's SessionError) — see the task
        // report for the full reasoning.
        //
        // THE DARK HALVES ARE NOT DECORATION — THEY CLOSE THAT GAP. The
        // note above says these three were left "exactly as shipped" and
        // out of that audit's scope. What that deferred, in practice, was
        // a pale-red panel glowing in a dark app with DARK red text on it,
        // and — once an outline button was placed inside — a near-black
        // button carrying that same dark red. Measured, not guessed: the
        // reader's failed-body alert rendered bg oklch(0.971 …) against an
        // app ground of rgb(3, 7, 17). Deferred is not decided; the light
        // rendering the note was protecting is untouched.
        destructive:
          'border-red-200 bg-red-50 text-red-900 [&>svg]:text-red-600 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-100 dark:[&>svg]:text-red-400',
        warning:
          'border-amber-200 bg-amber-50 text-amber-900 [&>svg]:text-amber-600 dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-100 dark:[&>svg]:text-amber-400',
        success:
          'border-green-200 bg-green-50 text-green-900 [&>svg]:text-green-600 dark:border-green-900/60 dark:bg-green-950/50 dark:text-green-100 dark:[&>svg]:text-green-400',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export function Alert({
  className,
  variant,
  ref,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
Alert.displayName = 'Alert';

export function AlertDescription({ className, ref, ...props }: React.ComponentProps<'div'>) {
  return <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />;
}
AlertDescription.displayName = 'AlertDescription';
