import { resolveTheme } from './resolveTheme';
import type { ResolvedTheme, ThemePreference } from './resolveTheme';

/**
 * THE ONLY MODULE IN THIS APP THAT STAMPS `.dark` ON `document.documentElement`.
 *
 * tests/theme-tokens.test.ts enforces this mechanically: it scans every
 * OTHER file under src/**\/*.{ts,tsx} for the same class-list mutation
 * this file performs, and fails if it finds one outside this file. That
 * is not a style preference — Plunk's atoms hardcode `bg-white` /
 * `bg-neutral-900` / etc (src/styles.css's header has the full audit), so
 * two places independently deciding whether `.dark` is stamped is exactly
 * how a stray "helpful" `classList.add('dark')` added to a component
 * later would silently fight this controller and produce a half-rendered
 * page — the same failure mode task V2 exists to close.
 *
 * index.html carries a small INLINE script that duplicates the
 * `resolveTheme` decision and the class/meta-tag application below, in
 * plain un-bundled JS. That is not a mistake: an inline script runs
 * before the module graph loads, which is the only way to stamp the
 * class before first paint. See index.html's own comment for why the
 * duplication is deliberate and how the two are kept in sync.
 */

const STORAGE_KEY = 'postbox:theme';

/** `--background`'s light/dark HSL values (src/styles.css), as hex —
 *  matches index.html's inline script and is the single source of truth
 *  for every call site after that first paint. */
const THEME_COLOR: Readonly<Record<ResolvedTheme, string>> = {
  light: '#ffffff',
  dark: '#030711',
};

function getStoredPreference(): ThemePreference | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    // A browser with storage disabled (private-mode Safari, a locked-down
    // profile) throws on ACCESS, not just on write. Treated the same as a
    // first visit: resolveTheme falls through to the OS either way.
    return null;
  }
}

function setStoredPreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Same storage-disabled case as above. The preference still applies
    // for the rest of this tab's lifetime (applyResolvedTheme runs
    // regardless of whether the write above succeeded) — it just will
    // not survive a reload, which is the best a browser that refuses
    // storage allows.
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The one place `document.documentElement.classList` is touched for
 *  `.dark`, and the one place the `theme-color` meta tag is written. */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark');

  // Dynamic, not a static `media="(prefers-color-scheme: ...)"` pair of
  // meta tags: an explicit Light/Dark choice overrides the OS, and a
  // prefers-color-scheme media query has no way to know that — it would
  // keep reporting the OS's own scheme even while this app deliberately
  // renders the opposite one. Writing the one tag's `content` here keeps
  // the browser chrome (address bar / status bar tint) in lockstep with
  // whatever actually rendered, including an explicit override.
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', THEME_COLOR[resolved]);
}

export interface ThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
}

/**
 * Every mounted `useTheme()` consumer's `setSnapshot`, so an explicit
 * choice made through ONE of them reaches every other one immediately.
 *
 * This exists because AppShell.tsx renders `sidebarFooter` — and so
 * ThemeToggle — TWICE: once in the desktop sidebar, once in the mobile
 * drawer, CSS-hidden rather than conditionally unmounted, so both stay
 * mounted with independent hook state across a resize. Without this
 * registry, picking Dark in the mobile drawer would correctly re-theme
 * the whole page (`applyResolvedTheme` below is a DOM-wide effect,
 * unaffected by this) but leave the desktop copy's OWN buttons showing
 * stale `aria-pressed` state until the OS scheme changed or the page
 * reloaded — verified live in the browser while building this feature,
 * not a hypothetical.
 */
const listeners = new Set<(snapshot: ThemeSnapshot) => void>();

function notifyAll(snapshot: ThemeSnapshot): void {
  for (const listener of listeners) listener(snapshot);
}

/** Reads storage + the OS, applies the result, and returns it. Every
 *  entry point below (mount, an explicit choice, an OS change) funnels
 *  through this so the class and the meta tag can never disagree with
 *  what `useTheme.ts` reports to React. */
function readAndApply(): ThemeSnapshot {
  const preference = getStoredPreference() ?? 'system';
  const resolved = resolveTheme(preference, systemPrefersDark());
  applyResolvedTheme(resolved);
  return { preference, resolved };
}

/** Called once per mount by useTheme.ts's lazy initializer, and again by
 *  its effect (covering an OS or storage change in the gap between that
 *  initializer running and the effect subscribing). */
export function getSnapshot(): ThemeSnapshot {
  return readAndApply();
}

/** Persists an explicit choice, applies it immediately, and broadcasts it
 *  to every other subscribed `useTheme()` instance (see `listeners`
 *  above) so two mounted copies of ThemeToggle never disagree. */
export function setPreference(preference: ThemePreference): ThemeSnapshot {
  setStoredPreference(preference);
  const resolved = resolveTheme(preference, systemPrefersDark());
  applyResolvedTheme(resolved);
  const snapshot: ThemeSnapshot = { preference, resolved };
  notifyAll(snapshot);
  return snapshot;
}

/**
 * Subscribes to every change this module knows about — an OS scheme
 * flip AND another instance's explicit choice (see `listeners` above) —
 * and returns the cleanup function useTheme.ts's effect unsubscribes
 * with on unmount.
 *
 * The OS listener fires regardless of the stored preference, not only
 * while it is `'system'` — `readAndApply` re-reads storage each time
 * rather than assuming, so an explicit Light/Dark choice re-resolves to
 * itself (a no-op in practice) instead of needing this subscription torn
 * down and re-added the moment someone switches away from System.
 */
export function subscribeToChanges(onChange: (snapshot: ThemeSnapshot) => void): () => void {
  listeners.add(onChange);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const mediaListener = (): void => notifyAll(readAndApply());
  media.addEventListener('change', mediaListener);
  return () => {
    listeners.delete(onChange);
    media.removeEventListener('change', mediaListener);
  };
}
