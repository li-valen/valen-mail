import * as SwitchPrimitives from '@radix-ui/react-switch';
import type * as React from 'react';

import { cn } from './cn';

/**
 * Ported verbatim from Plunk (AGPL-3.0),
 * `packages/ui/src/components/atoms/Switch.tsx`.
 *
 * VERIFIED BEFORE ADOPTION, because PushToggle depends on two properties
 * of this primitive that a visual port would not automatically give it
 * (@radix-ui/react-switch 1.3.7, `dist/index.mjs`):
 *
 *  1. **Semantics.** `SwitchPrimitives.Root` renders a real
 *     `<button type="button" role="switch" aria-checked={checked}>`, which
 *     is exactly the semantics Postbox's hand-rolled toggle carried before
 *     this port and which client/tests/push-toggle.test.ts's contract
 *     assumes.
 *
 *  2. **Gesture safety, IN CONTROLLED MODE ONLY.** `onCheckedChange` runs
 *     through `useControllableState`. When the `checked` prop is supplied
 *     (controlled), `setValue` invokes `onChange` SYNCHRONOUSLY inside the
 *     click handler, so `Notification.requestPermission()` downstream is
 *     still inside the user gesture. When `checked` is omitted
 *     (uncontrolled), the same callback is fired from a `React.useEffect`
 *     instead — a task later, after the gesture has expired, which Safari
 *     and Chrome refuse silently. Every `<Switch>` in this app therefore
 *     MUST pass `checked`; tests/push-toggle.test.ts pins that statically.
 */
export function Switch({ className, ref, ...props }: React.ComponentProps<typeof SwitchPrimitives.Root>) {
  return (
    <SwitchPrimitives.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-neutral-900 data-[state=unchecked]:bg-neutral-200',
        className,
      )}
      {...props}
      ref={ref}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitives.Root>
  );
}
Switch.displayName = SwitchPrimitives.Root.displayName;
