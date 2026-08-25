import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../useTheme';
import type { ThemePreference } from '../resolveTheme';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';

/**
 * The System / Light / Dark control. Lives in the sidebar footer beside
 * PushToggle — App.tsx composes both into AppShell's `sidebarFooter` —
 * on the same `flex items-center justify-between gap-3 px-3 py-2` row
 * shape PushToggle already uses, so the two controls read as one family.
 *
 * Three always-visible toggle buttons rather than a single cycling
 * button or a `<select>`: the current choice is on screen without
 * hovering, opening a menu, or reading a dropdown's selected option —
 * matching AppShell's own Inbox/Opens nav, which is a row of buttons for
 * the same reason. `role="group"` plus one `aria-pressed` per button is
 * the same "plain semantics over a composite ARIA widget" call
 * client/CLAUDE.md makes for the rest of this app's controls; nothing
 * here needs roving-tabindex radiogroup behaviour to be usable.
 *
 * `resolved` (not `preference`) is what src/themeController.ts stamps
 * `.dark` from — this component only decides which of the three
 * PREFERENCE buttons looks pressed. Picking "System" while the OS is
 * dark shows System as active, not Dark: the button reflects the CHOICE,
 * the page reflects the RESULT of that choice, and those are allowed to
 * say different things.
 */

interface ThemeOption {
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: typeof Sun;
}

const OPTIONS: readonly ThemeOption[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

function labelFor(preference: ThemePreference): string {
  return OPTIONS.find((option) => option.value === preference)?.label ?? 'System';
}

export default function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="text-sm text-neutral-600 dark:text-muted-foreground">Theme</span>
      <div
        role="group"
        aria-label={`Theme: ${labelFor(preference)}, currently ${resolved}`}
        className="flex items-center gap-1 rounded-lg bg-neutral-50 p-1 dark:bg-muted"
      >
        {OPTIONS.map((option) => {
          const isActive = option.value === preference;
          const Icon = option.icon;
          return (
            <Button
              key={option.value}
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={isActive}
              onClick={() => setPreference(option.value)}
              className={cn(
                // Button's `ghost` variant already supplies
                // `hover:bg-neutral-100 hover:text-neutral-900` (light) and,
                // after this task's audit, its `dark:` pairing — so only the
                // resting icon colour needs stating here.
                'h-7 w-7 text-neutral-500 dark:text-muted-foreground',
                isActive &&
                  // Overrides ghost's own hover so the active segment stays
                  // visibly "elevated" on hover instead of flashing back to
                  // the inactive hover tint (tailwind-merge resolves this in
                  // this string's favour — it wins as the later declaration).
                  'bg-white text-neutral-900 shadow-sm hover:bg-white hover:text-neutral-900 dark:bg-accent dark:text-accent-foreground dark:hover:bg-accent dark:hover:text-accent-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">
                {option.label} theme{isActive ? ' (current)' : ''}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
