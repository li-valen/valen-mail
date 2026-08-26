import { Users } from 'lucide-react';
import type { AccountSummary } from '../accountRoster';
import { totalOf } from '../accountRoster';
import { cn } from '../ui/cn';

/**
 * The sidebar's ACCOUNT SWITCHER (Plan 5 Task 3).
 *
 * **This block used to be inert**, and its own comment in AppShell.tsx
 * said so: "Accounts are LABELS, never filters… there is no click handler
 * on them because there is nothing for one to do". GET /api/inbox gained
 * an `account` param in Plan 5 Task 2, so there now is, and the user's
 * complaint ("right now they just have the name and it's not working")
 * was exactly this.
 *
 * Each row is a TOGGLE, not a link: clicking an unselected account
 * narrows the list to it, and clicking the selected one clears the filter
 * again — so `aria-pressed` is the honest ARIA, where the folder nav's
 * one-of-five choice takes `aria-current="page"`. "All accounts" is the
 * same toggle from the other side: it is pressed exactly when no account
 * filter is set, and pressing it clears one.
 *
 * The account filter is ORTHOGONAL to the folder: selecting `harvard`
 * keeps whichever folder is showing, and switching to Trash keeps
 * `harvard`. Neither selection resets the other.
 *
 * Counts are "how many of the LOADED messages are yours", which is why an
 * account can legitimately read 0 while another is selected — see
 * ../accountRoster.ts for the single rule that keeps that number from
 * meaning two different things in two places.
 */

/** Plunk's nav-item geometry, narrowed for a row that carries an avatar,
 *  a name and a count. Kept beside the account rows rather than shared
 *  with the folder nav's `navItemClass`: these rows are a different
 *  shape (three columns, tighter vertical rhythm) and pretending
 *  otherwise would mean one class string with two sets of overrides. */
function accountRowClass(isSelected: boolean): string {
  return cn(
    'w-full flex items-center gap-3 px-3 py-1.5 text-sm rounded-lg transition-colors cursor-pointer touch-manipulation text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    isSelected
      ? 'bg-neutral-100 dark:bg-accent'
      : 'hover:bg-neutral-50 dark:hover:bg-accent',
  );
}

/** The selected row's name goes semibold as well as tinted: the tint
 *  alone is a ~4% luminance step in light mode, which is not a
 *  distinction a user with low vision, a dim screen, or a colour
 *  deficiency can be expected to see. `aria-pressed` carries it for
 *  assistive tech; this carries it visually. */
function accountNameClass(isSelected: boolean): string {
  return cn(
    'flex-1 min-w-0 truncate',
    isSelected
      ? 'font-semibold text-neutral-900 dark:text-accent-foreground'
      : 'text-neutral-700 dark:text-muted-foreground',
  );
}

const AVATAR_CLASS =
  'h-6 w-6 rounded-md bg-neutral-100 text-neutral-700 dark:bg-secondary dark:text-secondary-foreground flex items-center justify-center text-[10px] font-semibold shrink-0';

/**
 * The unread count beside an account name, and it is a FUNCTION of the
 * selection for the same reason `accountNameClass` is: the selected row
 * paints a different ground under it.
 *
 * This was one constant, `text-neutral-400 dark:text-muted-foreground`,
 * measured from rendered pixels during the interface audit at 2.58:1 on
 * the unselected row's white and 2.37:1 on the selected row's
 * `bg-neutral-100` — both far under WCAG 1.4.3's 4.5:1 for text this
 * size. The dark half missed too, at 4.45:1 on `bg-accent`, which is the
 * kind of near-miss no amount of looking at hex values would have found.
 *
 * The selected branch reuses the row's OWN selected-state tokens rather
 * than inventing a shade: `neutral-600` is what the name beside it moves
 * toward in light, and `accent-foreground` is the token the palette
 * already defines as "text on `bg-accent`". A count that gets slightly
 * louder on the row the user has chosen is the correct direction anyway
 * — the name above it does exactly the same thing.
 *
 * Measured after the change: 4.7:1 / 7.2:1 light (unselected /
 * selected), 5.9:1 / 15.9:1 dark.
 */
function accountCountClass(isSelected: boolean): string {
  return cn(
    'text-xs tabular-nums font-mono',
    isSelected
      ? 'text-neutral-600 dark:text-accent-foreground'
      : 'text-neutral-500 dark:text-muted-foreground',
  );
}

export interface AccountListProps {
  readonly accounts: readonly AccountSummary[];
  /** `null` = every account merged, the default. */
  readonly selected: string | null;
  /** Called with an account id to narrow to it, or `null` to clear. The
   *  parent decides nothing: this component already resolves a click on
   *  the ACTIVE row into `null`, so "click the selected one to clear" is
   *  guaranteed rather than reimplemented per call site. */
  readonly onSelect: (accountId: string | null) => void;
}

export default function AccountList({ accounts, selected, onSelect }: AccountListProps) {
  // No accounts loaded yet means nothing to switch between — an
  // "All accounts" row on its own would be a control with one option.
  if (accounts.length === 0) return null;

  const isAllSelected = selected === null;

  return (
    <div className="mt-6">
      <p
        id="account-switcher-label"
        className="px-3 mb-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider dark:text-muted-foreground"
      >
        Accounts
      </p>
      <ul className="space-y-1" aria-labelledby="account-switcher-label">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-pressed={isAllSelected}
            className={accountRowClass(isAllSelected)}
          >
            <span className={AVATAR_CLASS} aria-hidden="true">
              <Users className="h-3.5 w-3.5" />
            </span>
            <span className={accountNameClass(isAllSelected)}>All accounts</span>
            <span className={accountCountClass(isAllSelected)}>{totalOf(accounts)}</span>
          </button>
        </li>

        {accounts.map((account) => {
          const isSelected = account.id === selected;
          return (
            <li key={account.id}>
              <button
                type="button"
                // Clicking the active row clears the filter rather than
                // reselecting it, which is what makes this a toggle and
                // gives "all accounts" a second, in-place way back.
                onClick={() => onSelect(isSelected ? null : account.id)}
                aria-pressed={isSelected}
                className={accountRowClass(isSelected)}
              >
                <span className={AVATAR_CLASS} aria-hidden="true">
                  {account.id.charAt(0).toUpperCase()}
                </span>
                {/* Text child, never markup: an account id comes from the
                    sync service's config, and every string this app
                    renders goes through JSX escaping. */}
                <span className={accountNameClass(isSelected)}>{account.id}</span>
                <span className={accountCountClass(isSelected)}>{account.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
