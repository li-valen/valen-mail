import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported from Plunk (AGPL-3.0), `packages/ui/src/components/atoms/Button.tsx`.
 *
 * One deliberate deviation: Plunk's version supports `asChild` via
 * `@radix-ui/react-slot`, so a Button can render as a Next.js `<Link>`.
 * Postbox has no router and no link-shaped buttons, so the Slot branch —
 * and the dependency it needs — is dropped rather than vendored unused.
 * Everything else, including the focus-visible ring, is verbatim.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-neutral-900 text-neutral-50 hover:bg-neutral-900/90',
        destructive: 'bg-red-600 text-white hover:bg-red-600/90',
        outline: 'border border-neutral-200 bg-white hover:bg-neutral-100 hover:text-neutral-900',
        secondary: 'bg-neutral-100 text-neutral-900 hover:bg-neutral-100/80',
        ghost: 'hover:bg-neutral-100 hover:text-neutral-900',
        destructiveGhost: 'text-red-600 hover:text-red-700 hover:bg-red-50',
        link: 'text-neutral-900 underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ref, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
}
Button.displayName = 'Button';

export { buttonVariants };
