import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported from Plunk (AGPL-3.0), `packages/ui/src/components/atoms/Button.tsx`.
 *
 * One deliberate deviation: Plunk's version supports `asChild` via
 * `@radix-ui/react-slot`, so a Button can render as a Next.js `<Link>`.
 * Valen Mail has no router and no link-shaped buttons, so the Slot branch —
 * and the dependency it needs — is dropped rather than vendored unused.
 * Everything else, including the focus-visible ring, is verbatim.
 *
 * PLAN 7 TASK 2 changed two things in the base string, both motion.
 *
 * **`transition-all` -> a named property list.** `all` transitions every
 * animatable property a variant happens to set, including ones that
 * trigger layout, and it is the single most common way an interface picks
 * up motion nobody designed. The list names exactly the five properties
 * these variants actually change.
 *
 * **`motion-safe:active:scale-[0.97]`.** A button with no pressed state
 * gives the user nothing between the click and whatever it causes; 3% is
 * enough to read as "heard you" and small enough that nobody would
 * describe it as an animation. `duration-150` is DURATION_MS.hover /
 * DURATION_MS.press's band (src/motion/tokens.ts), and Tailwind's
 * default, so `transition-colors` elsewhere already agrees with it.
 *
 * **`touch-manipulation`.** Every tap on a phone otherwise carries the
 * browser's ~300ms wait to see whether a second tap is coming (double-tap
 * to zoom). `touch-action: manipulation` opts this element out of that
 * one gesture - pan and pinch-zoom still work, so nothing about scrolling
 * or accessibility zoom changes - and the tap fires on touchend instead.
 * It is stated on the CONTROLS rather than on `html`/`body`, because a
 * document-wide `touch-action` would also disable double-tap zoom on the
 * message body, which is the one place a reader may genuinely want it.
 * tests/mobile-viewport-guards.test.ts pairs it with `cursor-pointer` so
 * a new control cannot be added without it.
 *
 * `motion-safe:` rather than relying on styles.css's global reduced-motion
 * floor: the floor would leave the scale in place and merely make it
 * instant, and this project's contract is that reduced motion REMOVES
 * motion. Under `prefers-reduced-motion: reduce` there is no scale at all.
 * (Tailwind v4's `hover:` variant is already gated behind
 * `@media (hover: hover)`, so the hover tints need no equivalent.)
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out-strong motion-safe:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer touch-manipulation',
  {
    variants: {
      variant: {
        default: 'bg-neutral-900 text-neutral-50 hover:bg-neutral-900/90 dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90',
        // Not routed through --destructive: it is a saturated, fully
        // opaque red button colour in both modes already (unlike Alert's
        // subtle destructive variant), and reads fine as-is against a
        // dark page. Left unchanged deliberately, not an oversight.
        destructive: 'bg-red-600 text-white hover:bg-red-600/90',
        // `bg-transparent`, NOT `bg-card`. An outline button has to sit on
        // whatever surface it is placed on, and `bg-card` is a PAGE-GROUND
        // colour that never blends with a tinted one. Inside a destructive
        // Alert it read as a solid white block in light mode — *"The retry
        // buttons backgrounds ... is solid white and not transparent"* —
        // and in dark it painted the button near-black (#030711) while
        // inheriting the alert's dark-red text, which is a contrast
        // failure on top of a cosmetic one.
        //
        // Nothing else moves: `--card` and `--background` are the same
        // value in BOTH themes (styles.css), so on the app's own ground
        // transparent and `bg-card` render identically. The only places
        // this changes anything are the tinted surfaces where it was
        // already wrong.
        outline:
          'border border-neutral-200 bg-transparent hover:bg-neutral-100 hover:text-neutral-900 dark:border-border dark:hover:bg-accent dark:hover:text-accent-foreground',
        secondary: 'bg-neutral-100 text-neutral-900 hover:bg-neutral-100/80 dark:bg-secondary dark:text-secondary-foreground dark:hover:bg-secondary/80',
        ghost: 'hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-accent dark:hover:text-accent-foreground',
        destructiveGhost: 'text-red-600 hover:text-red-700 hover:bg-red-50',
        link: 'text-neutral-900 underline-offset-4 hover:underline dark:text-foreground',
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
