/**
 * A per-key async mutex. Extracted from imap/pool.ts in Plan 5: it is a
 * general-purpose utility with no dependency on connections, folders or
 * the pool's own state, and pool.ts had reached this project's 800-line
 * ceiling once multi-folder sync landed.
 */

/**
 * Serialises async work by key while leaving different keys fully
 * concurrent. Amendment 2: `ByteBudget.reserve()`/`record()` are
 * check-then-act with no transaction, so two concurrent fetch cycles for
 * the same account could both reserve against the same stale snapshot and
 * both proceed — overspending the daily budget and eating the safety
 * margin between our 2 GB target and Gmail's ~2.5 GB suspension ceiling.
 * Keying by account id (rather than a single pool-wide lock) is what keeps
 * ten accounts running fully concurrently with each other; only calls that
 * share a key ever queue behind one another.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Wait for the previous task regardless of whether it succeeded or
    // failed — a failed task must not permanently wedge the queue for
    // every later caller sharing this key.
    const previousSettled = previous.catch(() => undefined);
    const result = previousSettled.then(fn);
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
