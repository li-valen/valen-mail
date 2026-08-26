/**
 * "Is this address one of MINE?" — the one rule, in one place.
 *
 * Two subsystems now depend on getting this identical, and they suppress
 * different things with it:
 *
 *  - push/dispatch.ts stays SILENT for an open attributed to one of the
 *    user's own addresses (a self-open must never buzz a phone).
 *  - followup/query.ts refuses to count that same open, and refuses to
 *    treat a later message from the user themselves as a reply.
 *
 * Those are different decisions made from the same fact, and the moment
 * the fact is computed two different ways they drift: a follow-up queue
 * that folds `+tags` while the push path does not would clear items the
 * notifications still fire for. Hence one module rather than a copied
 * three-line helper.
 *
 * DELIBERATELY NOT full RFC 5322 equivalence, and deliberately NOT
 * Gmail's dots-and-plus-tags folding. Matching here means SUPPRESSING
 * something — a notification, an open, a queue item — so a looser rule
 * swallows a genuine signal from a stranger whose address merely
 * normalises onto one of ours. Case and surrounding whitespace are the
 * only two differences that are never semantic; everything else stays a
 * distinction.
 */

/** Compares two addresses as identities: case-insensitively, with
 *  surrounding whitespace ignored. Neither side is assumed to arrive
 *  normalised — one comes from the tracking service (external data) and
 *  one from accounts.json. */
export function isSameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** True when `address` is one of the user's own configured accounts. */
export function isOwnAddress(address: string, ownAddresses: readonly string[]): boolean {
  return ownAddresses.some((own) => isSameAddress(own, address));
}
