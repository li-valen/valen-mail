import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Card.tsx`. `CardFooter` is omitted —
 * nothing in Valen Mail renders one, and the brief is "port only the atoms
 * you use".
 */
export function Card({ className, ref, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-neutral-200 bg-card text-neutral-950 dark:border-border dark:text-card-foreground shadow-sm overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}
Card.displayName = 'Card';

export function CardHeader({ className, ref, ...props }: React.ComponentProps<'div'>) {
  return <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />;
}
CardHeader.displayName = 'CardHeader';

export function CardTitle({ className, ref, ...props }: React.ComponentProps<'div'>) {
  return (
    <div ref={ref} className={cn('font-semibold leading-none tracking-tight', className)} {...props} />
  );
}
CardTitle.displayName = 'CardTitle';

export function CardDescription({ className, ref, ...props }: React.ComponentProps<'div'>) {
  return <div ref={ref} className={cn('text-sm text-neutral-500 dark:text-muted-foreground', className)} {...props} />;
}
CardDescription.displayName = 'CardDescription';

export function CardContent({ className, ref, ...props }: React.ComponentProps<'div'>) {
  return <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />;
}
CardContent.displayName = 'CardContent';
