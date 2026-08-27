import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/molecules/EmptyState.tsx`.
 *
 * Valen Mail renders TWO different EmptyStates in the opens feed, and keeping
 * them distinguishable is a product requirement, not a style choice: "the
 * tracking service answered and nothing has come back" and "the tracking
 * service could not be reached" are different facts, so they get different
 * icons and different copy (see components/OpensFeed.tsx, shared since
 * task V1 by components/OpensView.tsx and components/OpensRail.tsx).
 */
export interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('text-center py-14', className)}>
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-md border border-neutral-200 bg-neutral-50 dark:border-border dark:bg-muted mb-4">
        <Icon className="h-5 w-5 text-neutral-500 dark:text-muted-foreground" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-semibold text-neutral-900 dark:text-foreground mb-1">{title}</h3>
      {/* `mb-5` ONLY when something follows. Ported from Plunk with the
          margin unconditional, which left 20px of dead space under the
          last line of every empty state in this app — and all of them
          (every inbox folder, every search miss, both follow-up scopes)
          are description-only. Inside a `py-14` block that read as a
          panel that had lost its button rather than as one that never
          had one. */}
      {description && (
        <p
          className={cn(
            'text-sm text-neutral-500 dark:text-muted-foreground max-w-xs mx-auto leading-relaxed',
            action !== undefined && 'mb-5',
          )}
        >
          {description}
        </p>
      )}
      {action}
    </div>
  );
}
