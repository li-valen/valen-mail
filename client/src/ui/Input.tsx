import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Input.tsx`.
 */
export function Input({ className, type, ref, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-11 w-full rounded-md md:h-9 border border-neutral-200 bg-transparent px-3 py-1 text-base transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-neutral-950 placeholder:text-neutral-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:border-border dark:file:text-foreground dark:placeholder:text-muted-foreground',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
}
Input.displayName = 'Input';
