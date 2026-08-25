import type { ImapConnection } from './connection';
import {
  discoverFolders,
  missingFolderKinds,
  type DiscoveredFolders,
} from './folders.ts';

/**
 * Per-connection and per-account folder discovery, with its own caching,
 * invalidation and logging policy.
 *
 * Split out of ConnectionPool for the same reason ./backoff.ts,
 * ./keyed-mutex.ts and ./new-mail-marks.ts were: it is self-contained
 * state with a rule of its own that reads as an aside inside a class
 * otherwise concerned with connection lifecycle. Everything here — both
 * caches, the LIST, the missing-folder log — moved verbatim; the only
 * change is that `resolveFolders` is now a method on this object rather
 * than on the pool.
 *
 * The TWO caches are the substance, and they are deliberately keyed
 * differently — see each field below.
 */
export class FolderCache {
  // Folder discovery result per CONNECTION, not per account. Keying on
  // the connection object makes "re-discover after reconnect" automatic
  // rather than something to remember to invalidate: runAccount() builds a
  // fresh ImapConnection on every pass of its retry loop, so a reconnected
  // account simply misses this cache and LISTs again — which is what we
  // want, since a folder the user created (or a Trash re-enabled by
  // policy) between connections should be picked up rather than pinned to
  // whatever the process's first LIST saw. A WeakMap so a discarded
  // connection's entry is collectable with it, instead of a reconnect loop
  // accumulating one dead entry per attempt forever.
  private readonly byConnection = new WeakMap<ImapConnection, DiscoveredFolders>();

  // Plan 5 Task 2: the SAME discovery, keyed by account id rather than by
  // connection instance, so the API layer (./api/inbox.ts) can translate a
  // logical folder name ('sent') into the native path to query. A plain
  // Map, not a WeakMap: a caller here wants "whatever this account's
  // folders currently resolve to", surviving a reconnect between two API
  // requests, unlike byConnection's per-socket cache. Never cleared, same
  // as ConnectionPool's `statuses` — bounded by MAX_ACCOUNTS (10).
  private readonly byAccount = new Map<string, DiscoveredFolders>();

  /**
   * Resolves this connection's folders, LISTing once per connection and
   * reusing the answer for every later cycle on it (see byConnection above
   * for why the cache is keyed that way).
   *
   * The missing-folder log fires inside the cache miss, so it is one line
   * per connection rather than one per cycle — an account whose Trash is
   * disabled would otherwise log every three minutes forever. Only the
   * folder KIND is named, never a path or anything else from the listing.
   *
   * A LIST failure is not caught: imap/folders.ts documents why a
   * connection that cannot enumerate its own mailboxes is a
   * connection-health signal, which ConnectionPool.runAccount()'s catch
   * already handles.
   */
  async resolve(accountId: string, connection: ImapConnection): Promise<DiscoveredFolders> {
    const cached = this.byConnection.get(connection);
    if (cached) return cached;

    const folders = await discoverFolders(() => connection.listMailboxes());
    this.byConnection.set(connection, folders);
    this.byAccount.set(accountId, folders);

    const missing = missingFolderKinds(folders);
    if (missing.length > 0) {
      console.error(
        `account "${accountId}": server reported no special-use folder for ${missing.join(', ')} ` +
          '— those folders will not be synced; the rest continue normally',
      );
    }
    return folders;
  }

  /**
   * The most recently discovered folder mapping for one account, or
   * `undefined` if it has never completed a LIST since this process
   * started (never connected yet, every attempt so far failed first, or
   * the id is unknown to this pool).
   *
   * `undefined` here and "discovered, but this kind is absent" (a real
   * `null` field on DiscoveredFolders) are deliberately not distinguished
   * by the caller (./api/inbox.ts's resolveFolderFilter): both mean "no
   * native folder to query for this kind right now", and Plan 5 Task 2's
   * contract is that either one degrades to an empty result, never a 500.
   *
   * Nothing inside the sync loop needs this — like ConnectionPool's
   * getConnection, it exists for the API layer, so it can read the pool's
   * own discovery instead of issuing a second LIST.
   */
  forAccount(accountId: string): DiscoveredFolders | undefined {
    return this.byAccount.get(accountId);
  }
}
