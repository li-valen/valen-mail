import { describe, it, expect } from 'vitest';
import { searchEmptyStateFor } from '../src/emptyState';
import { FOLDER_IDS, FOLDER_LABELS } from '../src/inboxFilters';

/**
 * Plan 7 Task 3. A search that returns nothing has TWO causes and they
 * are byte-identical on the wire, exactly like the folder-emptiness case
 * ../src/emptyState.ts's header already argues at length:
 *
 *  - the folder is full of mail and none of it matches — a fact about the
 *    QUERY, and the only case where "no matches" is a true sentence;
 *  - the folder has never produced a row in this session, so there was
 *    nothing to match against — a fact about POSTBOX, and a case where
 *    "no matches for grant" sends the user off believing their mail does
 *    not contain a word it certainly does.
 *
 * `everSynced` is the same session-scoped proxy the folder copy uses
 * (components/InboxList.tsx tracks it), and the copy is written so that
 * being wrong about it is survivable either way.
 *
 * THE THIRD HONESTY OBLIGATION, particular to this feature: the server
 * searches `subject`, `from_name`, `from_email` AND `snippet`, but
 * snippets exist only on mail synced since Plan 7 Task 1 — every one of
 * the 461 rows already in the database has `snippet: null` permanently.
 * A body-text search over old mail therefore cannot match, and the copy
 * says so rather than letting the user conclude the phrase is not there.
 */

describe('searchEmptyStateFor — no matches vs nothing synced', () => {
  it('says "no matches" only when the folder has actually produced mail', () => {
    const copy = searchEmptyStateFor('grant', { folder: 'inbox', everSynced: true });
    expect(copy.title).toContain('No matches');
    expect(copy.title).toContain('grant');
  });

  it('never claims "no matches" for a folder that has never produced a row', () => {
    const copy = searchEmptyStateFor('grant', { folder: 'trash', everSynced: false });
    expect(copy.title).not.toContain('No matches');
    expect(copy.title).toContain('yet');
  });

  it('gives the two causes different titles AND different descriptions', () => {
    const settled = searchEmptyStateFor('grant', { folder: 'sent', everSynced: true });
    const hedged = searchEmptyStateFor('grant', { folder: 'sent', everSynced: false });
    expect(settled.title).not.toBe(hedged.title);
    expect(settled.description).not.toBe(hedged.description);
  });

  it('names the folder that was searched, so the scope is never implied', () => {
    for (const folder of FOLDER_IDS) {
      const settled = searchEmptyStateFor('q', { folder, everSynced: true });
      const hedged = searchEmptyStateFor('q', { folder, everSynced: false });
      expect(settled.title + settled.description).toContain(FOLDER_LABELS[folder]);
      expect(hedged.title + hedged.description).toContain(FOLDER_LABELS[folder]);
    }
  });

  it('discloses that previews are missing on older mail, in the settled copy', () => {
    // The settled case is the one where the user is entitled to conclude
    // "my mail does not contain this word". It is also the case where
    // that conclusion is wrong for message BODIES, so the limit is
    // stated where the wrong conclusion would be drawn.
    const copy = searchEmptyStateFor('quarterly', { folder: 'inbox', everSynced: true });
    expect(copy.description.toLowerCase()).toContain('preview');
  });

  it('names the way back to the unfiltered list', () => {
    const settled = searchEmptyStateFor('grant', { folder: 'inbox', everSynced: true });
    const hedged = searchEmptyStateFor('grant', { folder: 'inbox', everSynced: false });
    expect(settled.description.toLowerCase()).toContain('clear');
    expect(hedged.description.toLowerCase()).toContain('clear');
  });
});

describe('searchEmptyStateFor — the query is echoed as data, never as anything else', () => {
  /**
   * The query is user-controlled and is echoed straight back into copy
   * the app renders. It leaves here as a PLAIN STRING, verbatim, so the
   * only thing a component can do with it is interpolate it as a JSX text
   * child — which React escapes. Nothing here builds markup, and nothing
   * downstream is given the chance to.
   */
  it('carries a hostile query through untouched rather than sanitising it into markup', () => {
    const hostile = '<script>alert(1)</script>';
    const copy = searchEmptyStateFor(hostile, { folder: 'inbox', everSynced: true });
    expect(copy.title).toContain(hostile);
    expect(copy.title).not.toContain('&lt;');
  });

  it('handles a query at the wire cap without truncating it a second time', () => {
    const long = 'x'.repeat(200);
    const copy = searchEmptyStateFor(long, { folder: 'inbox', everSynced: true });
    expect(copy.title).toContain(long);
  });

  it('returns plain strings, both fields, for every folder and both states', () => {
    for (const folder of FOLDER_IDS) {
      for (const everSynced of [true, false]) {
        const copy = searchEmptyStateFor('q', { folder, everSynced });
        expect(typeof copy.title).toBe('string');
        expect(typeof copy.description).toBe('string');
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.description.length).toBeGreaterThan(0);
      }
    }
  });
});
