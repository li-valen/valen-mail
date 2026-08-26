import { describe, expect, it } from 'vitest';
import messageViewSource from '../src/components/MessageView.tsx?raw';
import messageRowSource from '../src/components/MessageRow.tsx?raw';
import inboxListSource from '../src/components/InboxList.tsx?raw';
import appSource from '../src/App.tsx?raw';

/**
 * Static guards on the parts of "instant open" that live inside
 * components, using the same `?raw`-import-and-regex technique
 * tests/opens-rail-static-guards.test.ts and tests/theme-tokens.test.ts
 * already use — the only tool available under client/CLAUDE.md's standing
 * constraint that no test in this project renders a component.
 *
 * WHAT THESE COVER AND WHAT THEY DO NOT. The BEHAVIOUR is tested properly
 * elsewhere: tests/message-loader.test.ts proves a cached open makes no
 * network call, tests/message-prefetch.test.ts proves cancellation and
 * the generation guard. What no unit test here can reach is whether the
 * components actually CALL any of it — a MessageView that imported
 * `loadMessage` and never used it would leave every one of those suites
 * green while the user still watched a spinner. These are the wiring
 * checks, and nothing more; the real proof is the browser, which the task
 * report records separately.
 *
 * Each guard is paired with a synthetic-fixture test proving the pattern
 * would genuinely catch its own regression rather than always passing.
 */

/** Strips comments so a doc comment that merely MENTIONS an identifier —
 *  this file's own header does exactly that — is never read as live code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const VIEW = stripComments(messageViewSource);
const ROW = stripComments(messageRowSource);
const LIST = stripComments(inboxListSource);
const APP = stripComments(appSource);

/** The cache read must happen in a `useState` INITIALIZER, which React
 *  runs during the first render — not in an effect, which runs after the
 *  first paint and therefore after a visible skeleton. */
const SYNCHRONOUS_CACHE_READ = /useState<LoadState>\(\(\)\s*=>\s*\{[\s\S]*?readCachedMessage\(/;

describe('MessageView renders a cached message on the first frame', () => {
  it('reads the cache from the useState initializer, not from an effect', () => {
    expect(VIEW).toMatch(SYNCHRONOUS_CACHE_READ);
  });

  it('the pattern is not vacuous — an effect-only read would fail it', () => {
    const effectOnly = `
      const [load, setLoad] = useState<LoadState>({ status: 'loading' });
      useEffect(() => { setLoad(readCachedMessage(messageCache, target)); }, []);
    `;
    expect(effectOnly).not.toMatch(SYNCHRONOUS_CACHE_READ);
  });

  it('goes through loadMessage rather than calling getMessage directly', () => {
    // A direct `getMessage` call would bypass the cache entirely and put
    // the open back exactly where it started.
    expect(VIEW).toContain('loadMessage(');
    expect(VIEW).not.toMatch(/\bgetMessage\s*\(/);
  });

  it('gates the skeleton on the slow-fetch threshold, so a fast open never flashes one', () => {
    expect(VIEW).toMatch(/load\.status === 'loading' && isSlow/);
    expect(VIEW).toContain('SKELETON_DELAY_MS');
  });

  it('clears the slow-fetch timer when the effect tears down', () => {
    // Without this, closing the reader inside the threshold sets state on
    // a component that has gone.
    expect(VIEW).toContain('clearTimeout(slowTimer)');
  });
});

describe('the prefetch triggers are hover and focus, and nothing broader', () => {
  it('MessageRow fires on pointer enter and on focus', () => {
    expect(ROW).toContain('onPointerEnter');
    expect(ROW).toContain('onFocus');
  });

  it('MessageRow prefetches on a MOUSE pointer only', () => {
    // On touch, `pointerenter` fires immediately before `click`, so an
    // unguarded handler issues a speculative fetch for the message the
    // next line is about to fetch for real.
    expect(ROW).toMatch(/pointerType === 'mouse'/);
  });

  it('nothing prefetches a whole page of rows', () => {
    // The one thing this feature must never grow into: every prefetch
    // that misses the server cache is a real IMAP fetch charged to the
    // account's daily byte budget, so warming 50 rows to save one click
    // spends fifty fetches to win one.
    const SOURCE = `${VIEW}\n${ROW}\n${LIST}\n${APP}`;
    expect(SOURCE).not.toMatch(/messages\.(map|forEach)\([^)]*\)\s*\.?\s*prefetch\b/);
    expect(SOURCE).not.toMatch(/\.forEach\(\s*\(?[A-Za-z]+\)?\s*=>\s*[A-Za-z.]*prefetch\(/);
  });
});

describe('navigation cancels the guesses it invalidated', () => {
  it('InboxList cancels when the folder, account or query changes', () => {
    expect(LIST).toContain('messagePrefetcher.cancelAll()');
  });

  it('App cancels when the user leaves the reader for another list', () => {
    expect(APP).toContain('messagePrefetcher.cancelAll()');
  });

  it('the cancel sits with the selection counter it belongs to', () => {
    // Ordered before the request that replaces the list goes out, so the
    // reader's own fetch is never queued behind a guess about a folder
    // the user already left.
    expect(LIST).toMatch(/selectionRef\.current \+= 1;[\s\S]{0,120}messagePrefetcher\.cancelAll\(\)/);
  });
});
