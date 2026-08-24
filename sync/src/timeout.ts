/**
 * Rejects if `promise` has not settled within `ms`. Does not cancel the
 * underlying operation (imapflow has no cancellation primitive for an
 * in-flight command) — it only stops this caller from waiting on it
 * forever.
 *
 * Lives in its own module rather than inside imap/pool.ts because both the
 * pool (liveness probe) and imap/connection.ts (logout) need it, and
 * importing pool.ts from connection.ts would make the two modules
 * circular — pool.ts already imports connection.ts.
 *
 * The timer is cleared on both settle paths: an uncleared setTimeout keeps
 * the Node event loop alive for the full `ms` after this promise has
 * already settled, which under systemd is the difference between an
 * ordered shutdown and a SIGKILL once the stop grace period elapses.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
