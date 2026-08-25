import { describe, it, expect } from 'vitest';
import {
  INBOX_FOLDER,
  discoverFolders,
  folderSyncOrder,
  missingFolderKinds,
  type MailboxListing,
} from '../src/imap/folders';

/**
 * Folder discovery via IMAP special-use attributes (Plan 5, global
 * constraint: "never hardcoded '[Gmail]/…' names").
 *
 * Why that constraint is not stylistic: Gmail localises its system folder
 * NAMES. The same account reads as `[Gmail]/Sent Mail` in English,
 * `[Gmail]/Отправленные` in Russian and `[Gmail]/Gesendet` in German, and
 * the localisation follows the ACCOUNT's language setting, not ours. The
 * only stable identifier across all of them is the special-use attribute
 * (`\Sent`, `\Junk`, `\Trash`) the server reports in its LIST response —
 * which is exactly what these fixtures are built from.
 *
 * The fixtures deliberately mirror imapflow's real `ListResponse` shape
 * (see node_modules/imapflow/lib/imap-flow.d.ts): `path`, `flags` as a
 * `Set<string>`, and `specialUse` as a SINGLE backslash-prefixed string
 * (never an array, never a list of every flag). imapflow resolves
 * conflicts itself and sets `specialUse` on exactly one winning entry per
 * type, so a fixture that hands two entries the same flag is modelling
 * something the library does not actually produce.
 */

/** Builds a listing entry in imapflow's own ListResponse shape. */
function box(path: string, specialUse?: string): MailboxListing {
  return specialUse === undefined ? { path } : { path, specialUse };
}

/** An English-locale Gmail account, as imapflow's list() reports it. */
const ENGLISH_GMAIL: readonly MailboxListing[] = [
  box('INBOX', '\\Inbox'),
  box('[Gmail]/All Mail', '\\All'),
  box('[Gmail]/Drafts', '\\Drafts'),
  box('[Gmail]/Sent Mail', '\\Sent'),
  box('[Gmail]/Spam', '\\Junk'),
  box('[Gmail]/Starred', '\\Flagged'),
  box('[Gmail]/Trash', '\\Trash'),
  box('Receipts'),
];

/**
 * The SAME account with its language set to Russian. Not one path here
 * matches the English listing above, and `[Gmail]/Sent Mail` does not
 * appear anywhere — only the special-use attributes are common to both.
 */
const RUSSIAN_GMAIL: readonly MailboxListing[] = [
  box('INBOX', '\\Inbox'),
  box('[Gmail]/Вся почта', '\\All'),
  box('[Gmail]/Черновики', '\\Drafts'),
  box('[Gmail]/Отправленные', '\\Sent'),
  box('[Gmail]/Спам', '\\Junk'),
  box('[Gmail]/Помеченные', '\\Flagged'),
  box('[Gmail]/Корзина', '\\Trash'),
];

const listing = (boxes: readonly MailboxListing[]) => async () => boxes;

describe('discoverFolders', () => {
  it('resolves sent, spam and trash from special-use attributes on an English account', async () => {
    const folders = await discoverFolders(listing(ENGLISH_GMAIL));

    expect(folders).toEqual({
      inbox: 'INBOX',
      sent: '[Gmail]/Sent Mail',
      spam: '[Gmail]/Spam',
      trash: '[Gmail]/Trash',
    });
  });

  /**
   * MUTATION TARGET (b): make discoverFolders return the hardcoded
   * '[Gmail]/Sent Mail' (or any other literal name) instead of reading
   * `specialUse`, and this test fails — none of these paths is the
   * English one. The English test above cannot catch that mutation on its
   * own, because a hardcoded English name happens to be right for an
   * English account. This fixture is what makes the constraint testable.
   */
  it('resolves the same three folders on a Russian-localised account, where no path matches the English names', async () => {
    const folders = await discoverFolders(listing(RUSSIAN_GMAIL));

    expect(folders).toEqual({
      inbox: 'INBOX',
      sent: '[Gmail]/Отправленные',
      spam: '[Gmail]/Спам',
      trash: '[Gmail]/Корзина',
    });
    // Stated as its own assertion so the failure message names the actual
    // regression rather than just "objects differ".
    expect(Object.values(folders)).not.toContain('[Gmail]/Sent Mail');
  });

  it('reports a folder as null when the server never flags it, and keeps the rest', async () => {
    // A real case: an account whose Trash is disabled by policy, or a
    // server that simply omits the \Trash attribute.
    const withoutTrash = ENGLISH_GMAIL.filter((entry) => entry.specialUse !== '\\Trash');

    const folders = await discoverFolders(listing(withoutTrash));

    expect(folders.trash).toBeNull();
    expect(folders.sent).toBe('[Gmail]/Sent Mail');
    expect(folders.spam).toBe('[Gmail]/Spam');
    expect(folders.inbox).toBe('INBOX');
  });

  it('never invents folders from names alone when the server flags nothing', async () => {
    // Every path here LOOKS like a system folder, and a name-matching
    // implementation would happily claim all three. Only the attributes
    // count.
    const unflagged: readonly MailboxListing[] = [
      box('INBOX'),
      box('[Gmail]/Sent Mail'),
      box('[Gmail]/Spam'),
      box('[Gmail]/Trash'),
    ];

    const folders = await discoverFolders(listing(unflagged));

    expect(folders).toEqual({ inbox: 'INBOX', sent: null, spam: null, trash: null });
  });

  it('ignores special-use attributes this service does not sync', async () => {
    // \All, \Drafts, \Archive and \Flagged are all real special-use values
    // that must not land in any of the three optional slots. Starred is a
    // virtual flag query in this product, not a synced folder (Plan 5).
    const onlyUnsynced: readonly MailboxListing[] = [
      box('[Gmail]/All Mail', '\\All'),
      box('[Gmail]/Drafts', '\\Drafts'),
      box('Archive', '\\Archive'),
      box('[Gmail]/Starred', '\\Flagged'),
    ];

    const folders = await discoverFolders(listing(onlyUnsynced));

    expect(folders).toEqual({ inbox: 'INBOX', sent: null, spam: null, trash: null });
  });

  it('always reports INBOX literally, never the entry carrying the \\Inbox attribute', async () => {
    // RFC 3501 makes INBOX the one mailbox name that is case-insensitive
    // and universally present, so it is the single name this service is
    // allowed to hardcode. A server that reports it in another case (or
    // decorates the listing) must not change what gets opened.
    const oddInbox: readonly MailboxListing[] = [box('Inbox', '\\Inbox'), box('[Gmail]/Sent Mail', '\\Sent')];

    const folders = await discoverFolders(listing(oddInbox));

    expect(folders.inbox).toBe(INBOX_FOLDER);
    expect(folders.inbox).toBe('INBOX');
  });

  it('tolerates an empty listing rather than throwing', async () => {
    const folders = await discoverFolders(listing([]));

    expect(folders).toEqual({ inbox: 'INBOX', sent: null, spam: null, trash: null });
  });

  it('ignores entries with a missing or empty path — the listing is remote input, not trusted data', async () => {
    const malformed = [
      { path: '', specialUse: '\\Sent' },
      { path: undefined as unknown as string, specialUse: '\\Junk' },
      box('[Gmail]/Trash', '\\Trash'),
    ] as readonly MailboxListing[];

    const folders = await discoverFolders(listing(malformed));

    expect(folders.sent).toBeNull();
    expect(folders.spam).toBeNull();
    expect(folders.trash).toBe('[Gmail]/Trash');
  });

  it('keeps the first entry when a server reports the same attribute twice', async () => {
    // imapflow resolves conflicts itself and sets `specialUse` on exactly
    // one winning entry per type, so this should be unreachable — the
    // point is that an unexpected listing produces a deterministic result
    // rather than depending on iteration luck.
    const duplicated: readonly MailboxListing[] = [
      box('[Gmail]/Sent Mail', '\\Sent'),
      box('[Gmail]/Sent Items', '\\Sent'),
    ];

    const folders = await discoverFolders(listing(duplicated));

    expect(folders.sent).toBe('[Gmail]/Sent Mail');
  });

  it('propagates a LIST failure rather than silently degrading to INBOX-only', async () => {
    // The pool treats this as a connection-health signal (same class as a
    // failed SELECT INBOX): a connection that cannot LIST is replaced,
    // not quietly run at reduced function for the rest of its life.
    const failing = async (): Promise<readonly MailboxListing[]> => {
      throw new Error('LIST failed');
    };

    await expect(discoverFolders(failing)).rejects.toThrow('LIST failed');
  });
});

describe('folderSyncOrder', () => {
  it('puts INBOX first, then sent, spam, trash', async () => {
    const folders = await discoverFolders(listing(ENGLISH_GMAIL));

    expect(folderSyncOrder(folders)).toEqual([
      { kind: 'inbox', path: 'INBOX' },
      { kind: 'sent', path: '[Gmail]/Sent Mail' },
      { kind: 'spam', path: '[Gmail]/Spam' },
      { kind: 'trash', path: '[Gmail]/Trash' },
    ]);
  });

  it('skips undiscovered folders without disturbing the order of the rest', async () => {
    const folders = { inbox: INBOX_FOLDER, sent: null, spam: '[Gmail]/Spam', trash: null };

    expect(folderSyncOrder(folders)).toEqual([
      { kind: 'inbox', path: 'INBOX' },
      { kind: 'spam', path: '[Gmail]/Spam' },
    ]);
  });

  it('always yields INBOX, even when nothing else was discovered', () => {
    const folders = { inbox: INBOX_FOLDER, sent: null, spam: null, trash: null };

    expect(folderSyncOrder(folders)).toEqual([{ kind: 'inbox', path: 'INBOX' }]);
  });
});

describe('missingFolderKinds', () => {
  it('names every folder the server did not flag', () => {
    const folders = { inbox: INBOX_FOLDER, sent: '[Gmail]/Sent Mail', spam: null, trash: null };

    expect(missingFolderKinds(folders)).toEqual(['spam', 'trash']);
  });

  it('is empty when all three were discovered', async () => {
    const folders = await discoverFolders(listing(ENGLISH_GMAIL));

    expect(missingFolderKinds(folders)).toEqual([]);
  });
});
