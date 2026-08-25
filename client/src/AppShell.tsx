import { useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, Inbox, Mailbox, Menu, X } from 'lucide-react';

import { cn } from './ui/cn';

/**
 * The application shell.
 *
 * PROVENANCE. Structure, spacing and class vocabulary ported from Plunk
 * (AGPL-3.0), `apps/web/src/components/DashboardLayout.tsx`: the
 * `flex h-dvh bg-neutral-50` frame, the `hidden lg:flex w-64 bg-white
 * border-r` desktop sidebar, its `h-16 … px-6 border-b` brand header, the
 * `flex-1 px-3 py-4 overflow-y-auto` nav with `px-3 py-2 rounded-lg`
 * items and uppercase section titles, the `border-t p-3` sidebar footer,
 * the translate-x mobile drawer with its `bg-black/50` scrim, and the
 * `lg:hidden h-16` mobile topbar.
 *
 * Postbox-specific deviations, each deliberate:
 *
 *  - **Buttons, not `<Link>`s.** Plunk navigates with Next.js routing.
 *    Postbox has two views and no router dependency, so nav items are
 *    `<button>`s carrying `aria-current="page"` for the active one.
 *  - **No project switcher, no `⌘K`, no user dropdown.** Postbox is a
 *    single-user, single-project client; none of those three has anything
 *    to switch between. The block under the brand header is instead the
 *    ACCOUNT LIST — the accounts actually present in the loaded inbox.
 *  - **`h-dvh`, not `h-screen`.** `100vh` is wrong on mobile Safari while
 *    the address bar is showing, which is the one browser this app is
 *    installed as a PWA on.
 *  - **The `<h1>` is visually hidden and names the VIEW.** Plunk's brand
 *    wordmark is its `<h1>`. Here the wordmark is a plain `<span>` so the
 *    document outline has exactly one root heading and it says what the
 *    reader is actually looking at ("Inbox" / "Opens"), above the `<h2>`
 *    day rules the inbox renders.
 *
 * Accounts are LABELS, never filters — same ruling as the per-row account
 * chip in components/MessageRow.tsx. There is no click handler on them
 * because there is nothing for one to do; the inbox merges all accounts
 * by design.
 */

export type ViewId = 'inbox' | 'opens';

export interface AccountSummary {
  readonly id: string;
  readonly count: number;
}

interface NavItem {
  readonly id: ViewId;
  readonly name: string;
  readonly icon: typeof Inbox;
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'inbox', name: 'Inbox', icon: Inbox },
  { id: 'opens', name: 'Opens', icon: Activity },
];

const VIEW_TITLES: Readonly<Record<ViewId, string>> = {
  inbox: 'Inbox',
  opens: 'Opens',
};

/** Plunk's own nav-item classes, lifted to a helper so the desktop and
 *  mobile copies of the sidebar cannot drift apart. */
function navItemClass(isActive: boolean): string {
  return cn(
    'w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
    isActive
      ? 'bg-neutral-100 text-neutral-900'
      : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900',
  );
}

function Wordmark({ size }: { readonly size: 'sm' | 'md' }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          'rounded-md bg-neutral-900 text-white flex items-center justify-center',
          size === 'md' ? 'h-7 w-7' : 'h-6 w-6',
        )}
      >
        <Mailbox className={size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
      </div>
      <span className={cn('font-bold text-neutral-900', size === 'md' ? 'text-xl' : 'text-lg')}>
        Postbox
      </span>
    </div>
  );
}

interface AccountListProps {
  readonly accounts: readonly AccountSummary[];
}

function AccountList({ accounts }: AccountListProps) {
  if (accounts.length === 0) return null;
  return (
    <div className="mt-6">
      <p className="px-3 mb-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider">
        Accounts
      </p>
      <ul className="space-y-1">
        {accounts.map((account) => (
          <li key={account.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
            <span
              className="h-6 w-6 rounded-md bg-neutral-100 text-neutral-700 flex items-center justify-center text-[10px] font-semibold shrink-0"
              aria-hidden="true"
            >
              {account.id.charAt(0).toUpperCase()}
            </span>
            {/* Text child, never markup: an account id comes from the sync
                service's config, and every string this app renders goes
                through JSX escaping. */}
            <span className="flex-1 min-w-0 truncate text-neutral-700">{account.id}</span>
            <span className="text-xs text-neutral-400 tabular-nums font-mono">{account.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface AppShellProps {
  readonly view: ViewId;
  readonly onViewChange: (view: ViewId) => void;
  readonly accounts: readonly AccountSummary[];
  /** Rendered in the sidebar's bottom block, where Plunk puts Settings and
   *  the account menu. Postbox puts the notifications control there. */
  readonly sidebarFooter?: ReactNode;
  /** Marks the content column busy while the session is still being
   *  established, so assistive tech knows the emptiness is temporary. */
  readonly isBusy?: boolean;
  readonly children: ReactNode;
}

export default function AppShell({
  view,
  onViewChange,
  accounts,
  sidebarFooter,
  isBusy = false,
  children,
}: AppShellProps) {
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);

  function select(next: ViewId): void {
    onViewChange(next);
    setMobileMenuOpen(false);
  }

  const sidebarContent = (
    <>
      <div className="h-16 flex items-center justify-between px-6 border-b border-neutral-200 shrink-0">
        <Wordmark size="md" />
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden p-1 rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <X className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">Close menu</span>
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 overflow-y-auto" aria-label="Views">
        <div className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = item.id === view;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => select(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={navItemClass(isActive)}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {item.name}
              </button>
            );
          })}
        </div>

        <AccountList accounts={accounts} />
      </nav>

      {sidebarFooter !== undefined && (
        <div className="border-t border-neutral-200 p-3 shrink-0">{sidebarFooter}</div>
      )}
    </>
  );

  return (
    <div className="flex h-dvh bg-neutral-50">
      <div className="hidden lg:flex w-64 bg-white border-r border-neutral-200 flex-col">
        {sidebarContent}
      </div>

      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileMenuOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
        </div>
      )}

      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 bg-white transform transition-transform duration-300 ease-in-out lg:hidden',
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        /* Plunk leaves the closed drawer in the tab order (it is only
           translated off-screen). `inert` takes it out of the tab order
           and the accessibility tree entirely while it is closed, so a
           desktop or mobile keyboard user never tabs into an invisible
           duplicate of the nav. */
        inert={!isMobileMenuOpen}
      >
        <div className="flex flex-col h-full">{sidebarContent}</div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="lg:hidden h-16 bg-white border-b border-neutral-200 flex items-center px-4 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="p-2 rounded-lg hover:bg-neutral-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Menu className="h-6 w-6 text-neutral-900" aria-hidden="true" />
            <span className="sr-only">Open menu</span>
          </button>
          <div className="ml-4">
            <Wordmark size="sm" />
          </div>
        </div>

        <main className="flex-1 overflow-y-auto" aria-busy={isBusy}>
          <div className="max-w-5xl mx-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            {/* Visually hidden, not absent: the inbox's day rules are
                `<h2>`s and the opens feed's section heading is an `<h2>`,
                so without this a screen reader's outline would start at
                level 2. Plunk's shell has no visible page title in the
                content column either. */}
            <h1 className="sr-only">{VIEW_TITLES[view]}</h1>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
