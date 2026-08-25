import * as LabelPrimitive from '@radix-ui/react-label';
import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Label.tsx`, minus the single-variant
 * `cva()` wrapper (a `cva` with no variants is just a string).
 */
export function Label({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  );
}
Label.displayName = LabelPrimitive.Root.displayName;
