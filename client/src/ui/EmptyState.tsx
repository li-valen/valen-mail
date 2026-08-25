import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/molecules/EmptyState.tsx`.
 *
 * Postbox renders TWO different EmptyStates in the opens view, and keeping
 * them distinguishable is a product requirement, not a style choice: "the
 * tracking service answered and nothing has come back" and "the tracking
 * service could not be reached" are different facts, so they get different
 * icons and different copy (see components/OpensView.tsx).
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
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-md border border-neutral-200 bg-neutral-50 mb-4">
        <Icon className="h-5 w-5 text-neutral-400" aria-hidden="true" />
      </div>
      <h3 className="text-sm font-semibold text-neutral-900 mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-neutral-500 max-w-xs mx-auto leading-relaxed mb-5">{description}</p>
      )}
      {action}
    </div>
  );
}
