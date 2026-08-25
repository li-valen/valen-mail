import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Ported verbatim from Plunk (AGPL-3.0), `packages/ui/src/lib/index.ts`.
 *
 * Every atom in this directory composes its variant classes with a
 * caller-supplied `className` through this, so a caller's `px-2` reliably
 * beats the atom's own `px-4` instead of losing to source order.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
