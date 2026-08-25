import { describe, it, expect } from 'vitest';
import { readStateFor, isDisplayable } from '../src/components/ReadState';

/**
 * task-5-brief.md Step 1's literal test file, plus the amendments it
 * links to. Every `it` here is written to fail if the behaviour it names
 * were deleted or inverted — see task-5-report.md for the explicit check
 * on the three the task called out by name (unrecognised classification,
 * `self` suppression, unavailable-vs-empty — the last one lives in
 * opens-rail.test.ts, next to the `deriveRailView` it actually tests).
 */

describe('readStateFor', () => {
  it('reports only `open` as confirmed', () => {
    expect(readStateFor('open').tone).toBe('confirmed');
  });

  it('reports mpp, prefetch and scanner as unconfirmable, never confirmed', () => {
    for (const c of ['mpp', 'prefetch', 'scanner']) {
      expect(readStateFor(c).tone).toBe('unknown');
      expect(readStateFor(c).label).toBe('unconfirmable');
    }
  });

  it('explains itself on hover for the unconfirmable states', () => {
    expect(readStateFor('mpp').title.toLowerCase()).toContain('apple');
  });

  it('treats an unrecognised classification as unconfirmable, not confirmed', () => {
    expect(readStateFor('something-new').tone).toBe('unknown');
  });

  // --- Amendment: mpp/prefetch/scanner share a LABEL but must carry
  // DISTINCT explanatory text — Apple's privacy proxy, Gmail's
  // delivery-time fetch, and a corporate scanner gateway are different
  // causes, and the tooltip/note is where that distinction has to live.
  // A test that only checked "mpp mentions apple" (the brief's Step 1
  // test above) would still pass if prefetch and scanner's `title` were
  // byte-identical to mpp's — this test would fail in that case, because
  // it checks the three titles are pairwise distinct AND each names its
  // own cause.
  it('gives mpp, prefetch and scanner the same label but distinct titles naming their own cause', () => {
    const mpp = readStateFor('mpp');
    const prefetch = readStateFor('prefetch');
    const scanner = readStateFor('scanner');

    expect(mpp.label).toBe('unconfirmable');
    expect(prefetch.label).toBe('unconfirmable');
    expect(scanner.label).toBe('unconfirmable');

    expect(mpp.title).not.toBe(prefetch.title);
    expect(mpp.title).not.toBe(scanner.title);
    expect(prefetch.title).not.toBe(scanner.title);

    expect(mpp.title.toLowerCase()).toContain('apple');
    expect(prefetch.title.toLowerCase()).toContain('gmail');
    expect(scanner.title.toLowerCase()).toMatch(/gateway|scanner/);
  });

  // --- Amendment 3 territory / DESIGN.md §5.4: only Apple's mpp is a
  // PERMANENT ceiling. If `permanent` defaulted to `true`, or leaked
  // `true` onto prefetch/scanner, this fails.
  it('marks only mpp as a permanent ceiling', () => {
    expect(readStateFor('mpp').permanent).toBe(true);
    expect(readStateFor('prefetch').permanent).toBe(false);
    expect(readStateFor('scanner').permanent).toBe(false);
    expect(readStateFor('open').permanent).toBe(false);
  });

  // Proves the unrecognised-classification probe is genuinely OUTSIDE the
  // five values classify.ts emits ('self' | 'prefetch' | 'mpp' | 'scanner'
  // | 'open') and that readStateFor does not just echo a hardcoded
  // placeholder token regardless of input — the token traces back to the
  // literal probe value.
  it('carries the raw, unrecognised classification through as the mono token', () => {
    expect(['self', 'prefetch', 'mpp', 'scanner', 'open']).not.toContain('something-new');
    expect(readStateFor('something-new').token).toBe('SOMETHING-NEW');
  });
});

describe('isDisplayable', () => {
  it('hides self events — the user viewing their own Sent folder', () => {
    expect(isDisplayable('self')).toBe(false);
  });

  it('shows every other classification', () => {
    for (const c of ['open', 'mpp', 'prefetch', 'scanner']) expect(isDisplayable(c)).toBe(true);
  });

  // The rail must not silently drop a classification value nobody has
  // invented yet — hiding an unknown value would be a quieter version of
  // the same overclaim `self`-hiding exists to prevent (task-5-brief.md
  // Amendment 2's reasoning, applied one level up).
  it('shows a classification it has never seen before rather than hiding it', () => {
    expect(isDisplayable('a-future-classifier-value')).toBe(true);
  });
});
