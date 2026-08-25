import type { AccountConfig } from '../config';
import { json, PRIVATE_NO_STORE } from './http.ts';

/**
 * GET /api/identities (Plan 4 Task 2) — the sending identities Plan 4's
 * composer can choose from, one per configured account.
 *
 * Kept out of ./routes.ts on purpose, mirroring ./push.ts (Task 6): that
 * file is already 700+ lines, and every route added since Task 8 lands as
 * a thin branch delegating to its own module rather than growing it
 * further. This route sits behind the router's own auth gate, so by the
 * time either function below runs, the caller has already proven a valid
 * credential — see createRouter in ./routes.ts.
 */

/** The one shape this route ever serialises. Never `appPassword` — see
 *  orderIdentities' own doc comment for why that is structural, not a
 *  reviewer's promise. */
export interface Identity {
  readonly id: string;
  readonly email: string;
  readonly isPrimary: boolean;
}

/**
 * Primary first, then every other account in loadConfig's own order
 * (accounts.json's array order) — spec 7B.1's send-from default has to be
 * the first thing a composer offers, and not incidentally wherever it
 * happens to sit in the config file. loadConfig has already enforced
 * exactly one `isPrimary: true` account (Plan 2), but this function does
 * not lean on that count: it partitions into two groups and concatenates,
 * which puts every primary account first (there is always exactly one)
 * and is correct regardless.
 *
 * Builds a new `Identity` per account by naming exactly three fields
 * rather than spreading (`{...account}`) — the one thing this function
 * must never do is let `appPassword` ride along because a future field
 * added to `AccountConfig` happened to come after it in the object.
 */
export function orderIdentities(accounts: readonly AccountConfig[]): readonly Identity[] {
  const primary = accounts.filter((account) => account.isPrimary);
  const rest = accounts.filter((account) => !account.isPrimary);
  return [...primary, ...rest].map((account) => ({
    id: account.id,
    email: account.email,
    isPrimary: account.isPrimary,
  }));
}

/** Private/no-store, matching every other route that returns account or
 *  mailbox data (see ./http.ts's own doc comment on PRIVATE_NO_STORE). */
export function handleIdentities(accounts: readonly AccountConfig[]): Response {
  return json({ identities: orderIdentities(accounts) }, 200, PRIVATE_NO_STORE);
}
