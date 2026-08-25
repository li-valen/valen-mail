import { useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { Activity, Mailbox, Menu, SquarePen, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';

import AccountList from './components/AccountList';
import { DURATION_MS, navPillTransitionFor } from './motion';
import type { AccountSummary } from './accountRoster';
import { FOLDER_ICONS } from './folderIcons';
import { FOLDER_IDS, FOLDER_LABELS, headingFor } from './inboxFilters';
import type { FolderId } from './inboxFilters';
import { Button } from './ui/Button';
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
 *    Postbox has no router dependency, so nav items are `<button>`s
 *    carrying `aria-current="page"` for the active one.
 *  - **No project switcher, no `⌘K`, no user dropdown.** Postbox is a
 *    single-user, single-project client; none of those three has anything
 *    to switch between.
 *  - **`h-dvh`, not `h-screen`.** `100vh` is wrong on mobile Safari while
 *    the address bar is showing, which is the one browser this app is
 *    installed as a PWA on.
 *  - **The `<h1>` is visually hidden and names the SELECTION.** Plunk's
 *    brand wordmark is its `<h1>`. Here the wordmark is a plain `<span>`
 *    so the document outline has exactly one root heading and it says
 *    what the reader is actually looking at ("Sent — harvard", "Opens"),
 *    above the `<h2>` day rules the list renders.
 *
 * PLAN 5 TASK 3 — the sidebar became the control surface it was pretending
 * to be. Two things changed, and both used to be documented here as
 * deliberate non-features:
 *
 *  - **One nav list, five folders, not a duplicate "Inbox".** The old
 *    shell had a two-item view nav (Inbox / Opens) and no folders. Adding
 *    a folder list beside it would have shipped TWO buttons labelled
 *    "Inbox" doing subtly different things, so the folder list replaced
 *    the view nav: picking any folder means `view: 'inbox'` plus that
 *    folder. Opens keeps its own item, under its own section title,
 *    because it is a genuinely different destination rather than a
 *    fifth mailbox.
 *  - **Accounts are filters now.** This file used to state "Accounts are
 *    LABELS, never filters… the inbox merges all accounts by design",
 *    which was true only until GET /api/inbox learned `?account=`. See
 *    components/AccountList.tsx.
 *
 * Folder and account are ORTHOGONAL selections held by App.tsx; this
 * component renders them and reports clicks, and owns no selection state
 * of its own beyond whether the mobile drawer is open.
 */

/**
 * PLAN 4 TASK 4 added `compose`.
 *
 * Compose is a VIEW, not a boolean beside one, and that is what buys the
 * three things a separate `isComposing` flag would each have needed code
 * for: the shell's `<h1>` announces "New message" instead of lying about
 * a folder the user is not looking at, the mobile topbar's breadcrumb
 * says the same, and `aria-current="page"` comes off every folder,
 * because none of them IS the current page while the composer is open.
 *
 * It is still reached by an ACTION — the primary button below, not a nav
 * item — because "write a new message" is not a place in the mailbox.
 */
export type ViewId = 'inbox' | 'opens' | 'compose';

/** Re-exported so the existing
 *  `import type { AccountSummary } from './AppShell'` call sites keep
 *  working; ./accountRoster.ts is where it is declared and where the rule
 *  governing `count` is written down. */
export type { AccountSummary };

const VIEW_TITLES: Readonly<Record<ViewId, string>> = {
  inbox: 'Inbox',
  opens: 'Opens',
  compose: 'New message',
};

/** Plunk's own nav-item classes, lifted to a helper so the folder list,
 *  the Opens item, and the desktop and mobile copies of the whole sidebar
 *  cannot drift apart.
 *
 *  Active and hover share `accent`/`accent-foreground` in dark mode
 *  deliberately (light keeps them as two different literals, neutral-100
 *  vs neutral-50 — too close to tell apart anyway) so a hover preview
 *  matches what clicking actually produces.
 *
 *  PLAN 7 TASK 2 moved the ACTIVE background out of this string and into
 *  `<NavPill>` below. The active item's own `bg-*` is gone, not
 *  overridden: two backgrounds — one painted by the class and one by the
 *  travelling pill — would double up at the destination for the length of
 *  the transition and read as a flash. The active TEXT colour stays here,
 *  because text is not what travels.
 *
 *  `relative` is what lets the pill be `absolute inset-0` against this
 *  button; `isolate` keeps the pill's stacking to this row rather than
 *  letting it interleave with anything else in the sidebar. */
function navItemClass(isActive: boolean): string {
  return cn(
    'relative isolate w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    isActive
      ? 'text-neutral-900 dark:text-accent-foreground'
      : 'text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-accent-foreground',
  );
}

/**
 * The selection: one pill that TRAVELS from the old nav item to the new
 * one, rather than a background that blinks off here and on there.
 *
 * This is the direct answer to the user's report — "when I click the
 * sidebar, it's, like, almost instant. It's, like, weird". The complaint
 * is not that selection is fast; it is that nothing connects the item
 * that was selected to the item that now is, so the eye has to re-find
 * the highlight instead of following it. A shared-element transition
 * (`layoutId`) is the one technique that makes that connection literal:
 * `motion` measures the pill's box before the commit and after it, and
 * animates the difference — so the SAME element appears to slide from
 * Inbox down to Sent, or out of the folder list entirely and down into
 * Activity › Opens.
 *
 * A SPRING, NOT A CURVE, and for a mechanical reason rather than a
 * stylistic one: this is the only motion in the app the user can
 * interrupt mid-flight. Clicking a third folder while the pill is still
 * travelling to the second is Plan 7's named non-negotiable, and a
 * duration-based tween handles it badly — it restarts from zero and
 * visibly stutters. A spring carries its current velocity into the new
 * target and simply bends toward it. See `NAV_PILL_SPRING` in
 * src/motion/tokens.ts.
 *
 * `scope` NAMESPACES THE SHARED ELEMENT, and is not optional. This
 * sidebar is rendered TWICE — once in the `hidden lg:flex` desktop rail
 * and once in the mobile drawer, which stays mounted while closed. Two
 * live elements sharing one `layoutId` is undefined behaviour in
 * `motion`: it would try to animate a single pill between two copies of
 * the same nav that are 320px apart and in different stacking contexts.
 * Each copy therefore gets its own id and animates independently.
 *
 * `aria-hidden`, and no text of its own: `aria-current="page"` on the
 * button is what actually announces the selection. The pill is the
 * sighted user's channel for the same fact and must not become a second
 * announcement of it.
 */
function NavPill({ scope }: { readonly scope: SidebarScope }) {
  const isReduced = useReducedMotion() ?? false;
  return (
    <motion.span
      layoutId={`nav-pill-${scope}`}
      transition={navPillTransitionFor(isReduced)}
      aria-hidden="true"
      className="absolute inset-0 -z-10 rounded-lg bg-neutral-100 dark:bg-accent"
    />
  );
}

const SECTION_TITLE_CLASS =
  'px-3 mb-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider dark:text-muted-foreground';

function Wordmark({ size }: { readonly size: 'sm' | 'md' }) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          'rounded-md bg-neutral-900 text-white dark:bg-primary dark:text-primary-foreground flex items-center justify-center',
          size === 'md' ? 'h-7 w-7' : 'h-6 w-6',
        )}
      >
        <Mailbox className={size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden="true" />
      </div>
      <span
        className={cn('font-bold text-neutral-900 dark:text-foreground', size === 'md' ? 'text-xl' : 'text-lg')}
      >
        Postbox
      </span>
    </div>
  );
}

/** Which of the two copies of the sidebar a nav item belongs to. Exists
 *  only to namespace `NavPill`'s `layoutId` — see that component. */
type SidebarScope = 'desktop' | 'drawer';

interface FolderNavProps {
  readonly folder: FolderId;
  /** False while the Opens view is showing: no folder is the current page
   *  then, and marking one anyway would make `aria-current` a lie. */
  readonly isActive: boolean;
  readonly onSelect: (folder: FolderId) => void;
  readonly scope: SidebarScope;
}

/** A real list of real buttons — `<ul>` of `<li><button>` — so assistive
 *  tech announces "5 items" and the arrow-key/Tab behaviour is the
 *  platform's, not a re-implementation of it. */
function FolderNav({ folder, isActive, onSelect, scope }: FolderNavProps) {
  return (
    <ul className="space-y-1">
      {FOLDER_IDS.map((id) => {
        const isCurrent = isActive && id === folder;
        const Icon = FOLDER_ICONS[id];
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => onSelect(id)}
              aria-current={isCurrent ? 'page' : undefined}
              className={navItemClass(isCurrent)}
            >
              {isCurrent && <NavPill scope={scope} />}
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              {FOLDER_LABELS[id]}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface AppShellProps {
  readonly view: ViewId;
  readonly onViewChange: (view: ViewId) => void;
  /** The selected folder. Rendered here, owned by App.tsx — the list and
   *  the sidebar are two views of one selection. */
  readonly folder: FolderId;
  readonly onFolderChange: (folder: FolderId) => void;
  /** `null` = all accounts merged. */
  readonly account: string | null;
  readonly onAccountChange: (account: string | null) => void;
  readonly accounts: readonly AccountSummary[];
  /** Rendered in the sidebar's bottom block, where Plunk puts Settings and
   *  the account menu. Postbox puts the theme control and the
   *  notifications control there (App.tsx). */
  readonly sidebarFooter?: ReactNode;
  /** Marks the content column busy while the session is still being
   *  established, so assistive tech knows the emptiness is temporary. */
  readonly isBusy?: boolean;
  /**
   * A ref onto the ONE scrolling element in this layout — the `<main>`
   * below. `<main>` scrolls, not the document (`h-dvh` + `flex-1
   * overflow-y-auto`), so `window.scrollY` is always 0 here and any
   * caller wanting to save or restore where the reader was in the list
   * has to reach this element specifically.
   *
   * Exposed rather than managed here because the SHELL has no idea what
   * a scroll position means — App.tsx owns the list/reader transition
   * that gives it meaning, and the shell stays a layout.
   */
  readonly contentRef?: Ref<HTMLElement>;
  /**
   * A ref onto the DESKTOP copy of the Compose button, so the composer
   * can return focus to what opened it.
   *
   * The desktop copy specifically, because `sidebarContent` is rendered
   * TWICE — once in the `hidden lg:flex` desktop rail and once in the
   * mobile drawer — and a single ref handed to both would keep whichever
   * mounted last. Below `lg:` the desktop copy is `display:none` and the
   * drawer copy is `inert` the moment it closes, so NEITHER is focusable
   * there and `focus()` is a harmless no-op: focus falls to the document,
   * whose first stop is the drawer's own menu button. That is the honest
   * degradation, not an oversight — a mobile drawer cannot hold focus for
   * a view that replaced the thing behind it.
   */
  readonly composeRef?: Ref<HTMLButtonElement>;
  readonly children: ReactNode;
}

export default function AppShell({
  view,
  onViewChange,
  folder,
  onFolderChange,
  account,
  onAccountChange,
  accounts,
  sidebarFooter,
  isBusy = false,
  contentRef,
  composeRef,
  children,
}: AppShellProps) {
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Every sidebar control closes the drawer after acting: below `lg:` the
  // sidebar covers the content it just changed, so leaving it open would
  // hide the result of the click that opened it.
  function selectView(next: ViewId): void {
    onViewChange(next);
    setMobileMenuOpen(false);
  }

  function selectFolder(next: FolderId): void {
    onFolderChange(next);
    setMobileMenuOpen(false);
  }

  function selectAccount(next: string | null): void {
    onAccountChange(next);
    setMobileMenuOpen(false);
  }

  const isInbox = view === 'inbox';
  const heading = isInbox ? headingFor(folder, account) : VIEW_TITLES[view];

  /**
   * A function rather than a single JSX value because the sidebar is
   * rendered twice (desktop rail and mobile drawer) and exactly one of
   * those two copies may carry `composeRef` — see the prop's own note.
   *
   * `scope` is the second consequence of that double render: it
   * namespaces the selection pill's `layoutId` so the two copies animate
   * independently rather than fighting over one shared element. See
   * `NavPill`.
   */
  const renderSidebar = (scope: SidebarScope, composeButtonRef?: Ref<HTMLButtonElement>): ReactNode => (
    <>
      <div className="h-16 flex items-center justify-between px-6 border-b border-neutral-200 dark:border-border shrink-0">
        <Wordmark size="md" />
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden p-1 rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-accent-foreground transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <X className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">Close menu</span>
        </button>
      </div>

      {/* The primary action, above the folder nav and deliberately
          OUTSIDE the `<nav>` landmark below: writing a message is not a
          place in the mailbox, so listing it among the folders would make
          landmark navigation announce an action as a destination. Plunk's
          button idiom, full-bleed to the nav's own `px-3` gutter. */}
      <div className="px-3 pt-4 shrink-0">
        <Button
          ref={composeButtonRef}
          type="button"
          onClick={() => selectView('compose')}
          aria-current={view === 'compose' ? 'page' : undefined}
          className="w-full justify-start gap-3"
        >
          <SquarePen aria-hidden="true" />
          Compose
        </Button>
      </div>

      {/* ONE navigation landmark for the whole sidebar. Folders, the Opens
          destination and the account switcher are three groups inside it
          rather than three landmarks, which keeps landmark navigation
          short — the groups are already announced by their own headings
          and list semantics. */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto" aria-label="Mailboxes">
        <FolderNav folder={folder} isActive={isInbox} onSelect={selectFolder} scope={scope} />

        <div className="mt-6">
          <p className={SECTION_TITLE_CLASS}>Activity</p>
          <ul className="space-y-1">
            <li>
              <button
                type="button"
                onClick={() => selectView('opens')}
                aria-current={view === 'opens' ? 'page' : undefined}
                className={navItemClass(view === 'opens')}
              >
                {view === 'opens' && <NavPill scope={scope} />}
                <Activity className="h-5 w-5 shrink-0" aria-hidden="true" />
                {VIEW_TITLES.opens}
              </button>
            </li>
          </ul>
        </div>

        <AccountList accounts={accounts} selected={account} onSelect={selectAccount} />
      </nav>

      {sidebarFooter !== undefined && (
        <div className="border-t border-neutral-200 dark:border-border p-3 shrink-0">{sidebarFooter}</div>
      )}
    </>
  );

  return (
    <div className="flex h-dvh bg-neutral-50 dark:bg-background">
      <div className="hidden lg:flex w-64 bg-card border-r border-neutral-200 dark:border-border flex-col">
        {renderSidebar('desktop', composeRef)}
      </div>

      {/* PLAN 7 TASK 2 — the scrim now FADES, and is always mounted.
          Plunk's version is conditionally rendered, which means it can
          only ever appear and disappear as a hard cut: there is no
          element left to animate on the way out. Keeping it mounted and
          driving `opacity` gives the drawer a matched pair (the panel
          slides, the ground behind it dims) at the cost of one
          permanently-present, `pointer-events-none`, fully transparent
          div below `lg:`.

          A CSS transition rather than `motion`, deliberately: this is a
          class toggle on a single opacity, which is the cheapest tool
          that does the job — reaching for the JS layer here would buy
          nothing and cost a component. `motion-reduce:transition-none`
          is the removal (not a shortening) for anyone who asked for it;
          styles.css's global floor would already collapse it, but stating
          it at the call site is what makes the intent auditable.

          `aria-hidden` and no label: the drawer's own Close button is the
          announced way out. This is the sighted-user shortcut for the
          same action, and a second announcement of it would be noise. */}
      <div
        onClick={() => setMobileMenuOpen(false)}
        aria-hidden="true"
        className={cn(
          'fixed inset-0 z-40 bg-black/50 transition-opacity ease-drawer motion-reduce:transition-none lg:hidden',
          isMobileMenuOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        style={{ transitionDuration: `${DURATION_MS.drawer}ms` }}
      />

      <div
        className={cn(
          // `ease-drawer` is the iOS/Ionic curve published by
          // src/styles.css's `@theme` and mirrored in
          // src/motion/tokens.ts. It replaces Plunk's `ease-in-out`,
          // which is the wrong family for a panel that enters and exits:
          // an ease-IN withholds movement for the first frames, which is
          // exactly when the thumb has just left the screen and the user
          // is looking hardest. 260ms replaces 300ms for the same reason
          // every other duration in this system sits where it does — see
          // DURATION_MS.
          'fixed inset-y-0 left-0 z-50 w-64 bg-card transform transition-transform ease-drawer motion-reduce:transition-none lg:hidden',
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        style={{ transitionDuration: `${DURATION_MS.drawer}ms` }}
        /* Plunk leaves the closed drawer in the tab order (it is only
           translated off-screen). `inert` takes it out of the tab order
           and the accessibility tree entirely while it is closed, so a
           desktop or mobile keyboard user never tabs into an invisible
           duplicate of the nav. */
        inert={!isMobileMenuOpen}
      >
        <div className="flex flex-col h-full">{renderSidebar('drawer')}</div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="lg:hidden h-16 bg-card border-b border-neutral-200 dark:border-border flex items-center px-4 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-accent transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Menu className="h-6 w-6 text-neutral-900 dark:text-foreground" aria-hidden="true" />
            <span className="sr-only">Open menu</span>
          </button>
          {/* Below `lg:` the sidebar is a CLOSED DRAWER, so the active
              folder and account are invisible — the one place a filtered
              view could look identical to an unfiltered empty one. This
              is the visible answer to "which folder am I in?" at phone
              width. `aria-hidden` because the `<h1>` below already
              announces the very same string. */}
          <div className="ml-4 flex min-w-0 items-center gap-2" aria-hidden="true">
            <Wordmark size="sm" />
            <span className="text-neutral-300 dark:text-muted-foreground shrink-0">/</span>
            <span className="truncate text-sm font-semibold text-neutral-900 dark:text-foreground">
              {heading}
            </span>
          </div>
        </div>

        <main ref={contentRef} className="flex-1 overflow-y-auto" aria-busy={isBusy}>
          <div className="max-w-5xl mx-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
            {/* Visually hidden, not absent: the list's day rules are
                `<h2>`s and the opens feed's section heading is an `<h2>`,
                so without this a screen reader's outline would start at
                level 2. Plunk's shell has no visible page title in the
                content column either. It names the SELECTION, not just
                the view, so changing folder or account changes what this
                announces. */}
            <h1 className="sr-only">{heading}</h1>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
