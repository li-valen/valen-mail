/**
 * Which mailboxes this service syncs, resolved from the server's own
 * special-use attributes rather than from folder names (Plan 5).
 *
 * Why names are not an option: Gmail LOCALISES its system folder names to
 * the account's language setting. The same mailbox is `[Gmail]/Sent Mail`
 * on an English account, `[Gmail]/Отправленные` on a Russian one and
 * `[Gmail]/Gesendet` on a German one — and the setting belongs to the
 * account owner, not to this service, so there is no configuration we
 * could ship that would cover them. Hardcoding `[Gmail]/…` names would
 * make Sent/Spam/Trash silently vanish for every account not set to
 * English, with no error anywhere: discovery would simply find nothing.
 *
 * The special-use attribute (RFC 6154 — `\Sent`, `\Junk`, `\Trash`) is the
 * one identifier that is identical across every localisation, and imapflow
 * surfaces it per mailbox as `ListResponse.specialUse`. INBOX is the sole
 * exception and the sole hardcoded name here: RFC 3501 makes `INBOX` a
 * reserved, case-insensitive name that every server must provide, so it is
 * never localised and never needs discovering.
 *
 * This module is deliberately free of any IMAP client type: it takes a
 * function that returns a listing and returns plain data. That is what
 * lets the localisation behaviour be tested against fixtures (see
 * tests/folders.test.ts) instead of against a live account whose language
 * we cannot set.
 */

/** The one folder name RFC 3501 lets us hardcode. */
export const INBOX_FOLDER = 'INBOX';

/** The three folders discovered from special-use attributes. */
export type OptionalFolderKind = 'sent' | 'spam' | 'trash';

/** Every folder a sync cycle visits, INBOX included. */
export type FolderKind = 'inbox' | OptionalFolderKind;

/**
 * Every folder this service can NAME, sync order or not.
 *
 * `archive` is the one member that is never synced: see
 * `DiscoveredFolders.archive` below for why All Mail must stay out of the
 * cycle, and ../api/move.ts for the only thing that reads it.
 */
export type AddressableFolderKind = FolderKind | 'archive';

/**
 * The subset of imapflow's `ListResponse` this module actually reads.
 *
 * Structural, not an import of imapflow's own type, for two reasons: this
 * module needs no IMAP client to be testable, and narrowing the surface to
 * the two fields that matter documents exactly what discovery depends on.
 * Both fields keep imapflow's real shape — `specialUse` is a SINGLE
 * backslash-prefixed string (`'\\Sent'`), not an array and not the
 * mailbox's whole flag set.
 */
export interface MailboxListing {
  readonly path: string;
  readonly specialUse?: string;
}

/** Supplies a mailbox listing — in production, one IMAP LIST round trip. */
export type ListMailboxesFn = () => Promise<readonly MailboxListing[]>;

/**
 * The mailboxes to sync for one account. `inbox` is always present;
 * anything the server did not flag is `null`, and the caller syncs the
 * rest rather than failing (see ConnectionPool's folder loop).
 */
export interface DiscoveredFolders {
  readonly inbox: string;
  readonly sent: string | null;
  readonly spam: string | null;
  readonly trash: string | null;
  /**
   * Where an archived message goes — NOT a folder this service syncs.
   *
   * `folderSyncOrder` deliberately omits it and `missingFolderKinds`
   * deliberately never reports it, because on Gmail this resolves to
   * `[Gmail]/All Mail`: every message in the account, which for these
   * mailboxes is 60,000+ rows. Syncing it would duplicate the entire
   * mailbox under a second folder name on every cycle and spend the daily
   * byte budget (spec L6) doing it.
   *
   * `null` when the server flags neither `\\Archive` nor `\\All`, which is
   * not an error: ../api/move.ts refuses the archive action for that
   * account and says which folder was missing, exactly as it does for a
   * disabled Trash.
   */
  readonly archive: string | null;
}

/** One folder to sync, paired with the slot it fills. */
export interface FolderSyncTarget {
  readonly kind: FolderKind;
  readonly path: string;
}

/**
 * Special-use attribute -> the slot it fills. Only these three are mapped:
 * `\All`, `\Archive`, `\Drafts` and `\Flagged` are real attributes that
 * must NOT land in any slot. `\Flagged` in particular is a live trap —
 * Starred is a virtual flag query across every synced folder in this
 * product (Plan 5), not a folder to sync, so claiming `[Gmail]/Starred`
 * here would sync the same messages a second time under a second folder
 * name.
 */
const SPECIAL_USE_TO_KIND: Readonly<Record<string, OptionalFolderKind>> = {
  '\\Sent': 'sent',
  '\\Junk': 'spam',
  '\\Trash': 'trash',
};

/**
 * Where an ARCHIVED message lands, in order of preference.
 *
 * `\\Archive` first because RFC 6154 gives it exactly this meaning
 * ("messages that are archived"). Gmail does not publish it: on Gmail,
 * archiving means removing the INBOX label, and the mailbox that then
 * holds the message is `[Gmail]/All Mail`, flagged `\\All`. So `\\All` is
 * the fallback, and on every account this service actually connects to it
 * is the one that fires.
 *
 * DELIBERATELY SEPARATE FROM SPECIAL_USE_TO_KIND. The comment on that map
 * says `\\All` and `\\Archive` must NOT land in any synced slot, and that
 * is still true — this is a destination to move INTO, never a folder to
 * enumerate. Merging the two maps is how All Mail ends up in
 * `folderSyncOrder` and every message in the account gets synced a second
 * time under a second folder name.
 */
const ARCHIVE_SPECIAL_USE_PREFERENCE: readonly string[] = ['\\Archive', '\\All'];

/** The order a sync cycle visits folders in: INBOX first, then the rest. */
const OPTIONAL_FOLDER_ORDER: readonly OptionalFolderKind[] = ['sent', 'spam', 'trash'];

/**
 * A LIST response is remote input, so entries are validated before use
 * rather than trusted: an entry with a missing or empty path cannot be
 * opened, and letting one through would turn a malformed listing into a
 * `SELECT ""` on a live connection.
 */
function isUsableEntry(entry: MailboxListing): boolean {
  return typeof entry.path === 'string' && entry.path.length > 0;
}

/**
 * Resolves the mailboxes to sync for one account from a single LIST.
 *
 * A LIST failure propagates rather than degrading to INBOX-only: a
 * connection that cannot enumerate its own mailboxes is failing at the
 * protocol level, which the pool already handles as a connection-health
 * signal (replace the connection, back off) rather than something to run
 * at permanently reduced function for the rest of that connection's life.
 *
 * A folder the server never flags is simply `null` — that is NOT an error
 * and never throws, because a Trash disabled by policy must not stop Sent
 * and Spam from syncing.
 */
export async function discoverFolders(listMailboxes: ListMailboxesFn): Promise<DiscoveredFolders> {
  const listing = await listMailboxes();

  const byKind = new Map<OptionalFolderKind, string>();
  // Kept separate from `byKind` and keyed by ATTRIBUTE rather than by
  // slot, because the archive slot is resolved by preference across two
  // attributes rather than by first-entry-wins — see
  // ARCHIVE_SPECIAL_USE_PREFERENCE.
  const byArchiveUse = new Map<string, string>();
  for (const entry of listing) {
    if (!isUsableEntry(entry)) continue;
    if (entry.specialUse && ARCHIVE_SPECIAL_USE_PREFERENCE.includes(entry.specialUse)) {
      if (!byArchiveUse.has(entry.specialUse)) byArchiveUse.set(entry.specialUse, entry.path);
      continue;
    }
    const kind = entry.specialUse ? SPECIAL_USE_TO_KIND[entry.specialUse] : undefined;
    if (!kind) continue;
    // First entry wins. imapflow resolves special-use conflicts itself and
    // sets `specialUse` on exactly one winning entry per type, so a
    // duplicate should be unreachable; keeping the first makes an
    // unexpected listing deterministic instead of order-dependent.
    if (byKind.has(kind)) continue;
    byKind.set(kind, entry.path);
  }

  return {
    inbox: INBOX_FOLDER,
    sent: byKind.get('sent') ?? null,
    spam: byKind.get('spam') ?? null,
    trash: byKind.get('trash') ?? null,
    // Preference order, not first-entry-wins: a server publishing both
    // attributes means the more specific one. See
    // ARCHIVE_SPECIAL_USE_PREFERENCE.
    archive: ARCHIVE_SPECIAL_USE_PREFERENCE.map((use) => byArchiveUse.get(use)).find(
      (path): path is string => path !== undefined,
    ) ?? null,
  };
}

/**
 * The reverse of discovery: which logical kind does this native path
 * name, if any?
 *
 * This exists so ../api/move.ts can tell a client where a message CAME
 * from as a logical kind ('inbox') rather than as a path, which is what
 * lets undo move it back without the client ever naming a destination
 * folder of its own. An unconstrained destination string on that route
 * would be an arbitrary-folder-move primitive against the user's real
 * mailbox.
 *
 * `null` for anything undiscovered — a user label, a folder from another
 * account, an empty string. The caller must treat that as "not undoable"
 * rather than defaulting to INBOX: putting a message into a folder it was
 * never in is a worse outcome than offering no undo at all.
 *
 * INBOX is matched case-insensitively because RFC 3501 makes that name
 * case-insensitive; every other path is compared verbatim, since a
 * localised Gmail folder name has no case rule we are entitled to assume.
 */
export function folderKindForPath(
  folders: DiscoveredFolders,
  path: string,
): AddressableFolderKind | null {
  if (path.toUpperCase() === INBOX_FOLDER) return 'inbox';
  if (path.length === 0) return null;

  const candidates: readonly (readonly [AddressableFolderKind, string | null])[] = [
    ['sent', folders.sent],
    ['spam', folders.spam],
    ['trash', folders.trash],
    ['archive', folders.archive],
  ];
  // `native !== null` is load-bearing rather than defensive: without it an
  // undiscovered slot would match a caller passing the empty string, and
  // "we could not discover your Trash" would silently become "this
  // message came from Trash".
  const match = candidates.find(([, native]) => native !== null && native === path);
  return match ? match[0] : null;
}

/**
 * The folders to sync, in cycle order: INBOX first (it is the one that
 * feeds notifications and the one whose failure signals connection
 * health), then sent, spam, trash. Undiscovered folders are absent
 * entirely rather than present with a null path, so the caller's loop
 * never has to re-check.
 */
export function folderSyncOrder(folders: DiscoveredFolders): readonly FolderSyncTarget[] {
  const optional = OPTIONAL_FOLDER_ORDER.flatMap((kind): readonly FolderSyncTarget[] => {
    const path = folders[kind];
    return path === null ? [] : [{ kind, path }];
  });
  return [{ kind: 'inbox', path: folders.inbox }, ...optional];
}

/**
 * The folders the server did not flag, for the caller's one-line-per-
 * connection log. Returned as kinds ('sent'), not paths — there IS no path
 * to report for a folder that was never discovered, and the account id is
 * the caller's to add.
 */
export function missingFolderKinds(folders: DiscoveredFolders): readonly OptionalFolderKind[] {
  return OPTIONAL_FOLDER_ORDER.filter((kind) => folders[kind] === null);
}
