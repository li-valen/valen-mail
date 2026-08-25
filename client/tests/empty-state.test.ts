import { describe, it, expect } from 'vitest';
import { emptyStateFor } from '../src/emptyState';
import { FOLDER_IDS } from '../src/inboxFilters';

/**
 * Plan 5 Task 3, TRAP 3: on a cold start GET /api/inbox answers
 * `200 []` for sent/spam/trash — not an error, not a distinguishable
 * state — until each account's first sync cycle discovers those folders
 * by IMAP special-use (sync/src/api/inbox.ts's `resolveFolderFilter`
 * documents that "no pairs" and "genuinely empty" are deliberately
 * collapsed on the server side).
 *
 * The client cannot un-collapse them, so the empty-state copy is the ONLY
 * thing standing between the user and a confident lie. These tests hold
 * that copy honest in BOTH directions: never "Trash is empty" before
 * Trash has ever produced a row, and never a permanent "still syncing…"
 * hedge once it has.
 */
describe('emptyStateFor', () => {
  it('gives every folder a title and a description in both sync states', () => {
    for (const folder of FOLDER_IDS) {
      for (const everSynced of [true, false]) {
        const copy = emptyStateFor(folder, null, { everSynced });
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.description.length).toBeGreaterThan(0);
      }
    }
  });

  // TRAP 3, the named assertion.
  it('says something DIFFERENT for a Trash that has never synced than for a genuinely empty one', () => {
    const notSynced = emptyStateFor('trash', null, { everSynced: false });
    const genuinelyEmpty = emptyStateFor('trash', null, { everSynced: true });

    expect(notSynced).not.toEqual(genuinelyEmpty);
    expect(notSynced.title).not.toBe(genuinelyEmpty.title);
    expect(notSynced.description).not.toBe(genuinelyEmpty.description);
  });

  // TRAP 3: the specific sentence the brief forbids.
  it('never claims "Trash is empty" before Trash has ever produced a row', () => {
    const notSynced = emptyStateFor('trash', null, { everSynced: false });
    expect(`${notSynced.title} ${notSynced.description}`).not.toMatch(/trash is empty/i);
    expect(notSynced.title).toMatch(/yet/i);

    // …and the honest claim IS made once the folder has been seen, so
    // this is not just a blanket hedge that never resolves.
    expect(emptyStateFor('trash', null, { everSynced: true }).title).toBe('Trash is empty');
  });

  it('hedges every server-synced folder that has never produced a row', () => {
    for (const folder of ['sent', 'spam', 'trash'] as const) {
      const copy = emptyStateFor(folder, null, { everSynced: false });
      expect(copy.title).toMatch(/yet$/);
      // Names the real mechanism — first sync cycle discovers the folder —
      // and says what a still-empty folder afterwards would mean.
      expect(copy.description).toMatch(/first sync cycle/i);
    }
  });

  it('does not hedge a folder that has produced rows before', () => {
    for (const folder of FOLDER_IDS) {
      const copy = emptyStateFor(folder, null, { everSynced: true });
      expect(copy.description).not.toMatch(/first sync cycle/i);
    }
  });

  it('treats Starred as the virtual cross-folder view it is, not a synced folder', () => {
    const synced = emptyStateFor('starred', null, { everSynced: true });
    // A starred SENT message belongs here too — the copy has to say so,
    // or Starred reads as "starred inbox mail".
    expect(synced.description).toMatch(/any folder/i);
    expect(synced.description).not.toMatch(/first sync cycle/i);
  });

  it('scopes both title and description to the selected account', () => {
    const all = emptyStateFor('sent', null, { everSynced: true });
    const one = emptyStateFor('sent', 'harvard', { everSynced: true });

    expect(one.title).toBe(`${all.title} for harvard`);
    expect(one.description).toContain('harvard');
    // The way back out is part of the copy: an empty view whose emptiness
    // is caused by a filter must say which control widens it.
    expect(one.description).toMatch(/all accounts/i);
  });

  it('keeps the account scope on the not-yet-synced copy too', () => {
    const one = emptyStateFor('trash', 'harvard', { everSynced: false });
    expect(one.title).toBe('No Trash mail synced yet for harvard');
    expect(one.description).toMatch(/first sync cycle/i);
    expect(one.description).toMatch(/all accounts/i);
  });
});
