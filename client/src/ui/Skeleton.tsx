import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Skeleton.tsx`. `animate-pulse` is core
 * Tailwind, and styles.css's `prefers-reduced-motion` floor stills it for
 * anyone who asked for that.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-neutral-100 dark:bg-muted', className)} {...props} />;
}
