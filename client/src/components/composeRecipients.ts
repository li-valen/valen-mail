/**
 * Recipient entry for the composer: how a typed or pasted string becomes
 * a list of chips, and what makes one of those chips wrong.
 *
 * Pure, and separate from Compose.tsx for the reason every other
 * `*.ts`-beside-a-`*.tsx` file in this directory is (see ./messageBody.ts):
 * no test in this client renders a component, so behaviour that lives
 * inside a handler is behaviour the suite cannot see. Everything the To
 * and Cc fields do to a keystroke happens here.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not parse `Name
 * <a@x.com>` — splitting on whitespace would shred that into two chips.
 * Compose v1 sends new plain-text mail to bare addresses (Plan 4 Global
 * Constraints); display-name pasting is a real want, and the moment it
 * arrives it belongs here as a different splitter, not as a special case
 * bolted onto `parseRecipients`.
 */

/**
 * RFC 5321's maximum forward-path length, matching
 * `MAX_RECIPIENT_CHARS` in sync/src/api/send.ts. The server measures the
 * TRIMMED address; so does `isValidRecipient` below.
 */
export const MAX_RECIPIENT_CHARS = 254;

/** Commas and whitespace, in any mix, in any run length. */
const SEPARATORS = /[\s,]+/;

/** The last separator in a string, plus whatever follows it. */
const TRAILING_SEGMENT = /[\s,][^\s,]*$/;

/**
 * C0 controls and DEL — the same set sync/src/api/send.ts refuses. CR/LF
 * inside an address is the classic SMTP header-injection vector, and a
 * boundary check must not depend on the library behind it.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** The key two addresses are considered "the same" under. Domains are
 *  case-insensitive by spec and every mail provider in practice treats
 *  the local part that way too, so `A@X.com` and `a@x.com` are one
 *  mailbox — sending to both would mint two tokens, deliver two pixels
 *  and put two copies in one inbox. */
function dedupeKey(address: string): string {
  return address.toLowerCase();
}

/**
 * Splits a typed or pasted string into a normalized, unique recipient
 * list.
 *
 * Splits on commas AND whitespace, trims each part, drops empties, and
 * de-duplicates case-insensitively while KEEPING the casing of the first
 * appearance — the user's own typing survives; only the repeat is
 * dropped. Order is order of first appearance throughout.
 *
 * Deliberately does no validity checking: a typo has to become a visible
 * chip before it can be marked wrong, and silently swallowing it would
 * leave the user looking at a recipient list missing someone they know
 * they typed. `isValidRecipient` is the separate question.
 */
export function parseRecipients(input: string): readonly string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const part of input.split(SEPARATORS)) {
    const address = part.trim();
    if (address === '') continue;
    const key = dedupeKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(address);
  }
  return recipients;
}

/**
 * The same four conditions sync/src/api/send.ts's `isUsableRecipient`
 * applies, checked here so the user gets a chip they can see and fix
 * instead of an opaque 400 that names nothing (the route answers one
 * fixed string for every malformed body, on purpose — it must never echo
 * a recipient list back into a log).
 *
 * NOT an RFC 5322 parser and not trying to be. An `@`, a length bound and
 * no control characters is what the wire actually requires; anything
 * stricter would refuse addresses that deliver.
 */
export function isValidRecipient(address: string): boolean {
  const trimmed = address.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_RECIPIENT_CHARS &&
    trimmed.includes('@') &&
    !CONTROL_CHARACTERS.test(trimmed)
  );
}

export interface PendingSplit {
  /** Complete addresses, ready to become chips. */
  readonly committed: readonly string[];
  /** What is still being typed, which must stay in the input. */
  readonly pending: string;
}

/**
 * Decides, on every keystroke, how much of the input has become a
 * finished address.
 *
 * The rule is one line: everything before the LAST separator is finished,
 * everything after it is still being typed. That single rule covers
 * typing (`a@x.com,` chips immediately), pasting a full list
 * (`a@x.com, b@y.com, c@z.com` chips the first two and leaves the third
 * to be confirmed), and pasting a list that ends in a separator (chips
 * all of them).
 *
 * The tail is never chipped here, only on Enter, blur or Send —
 * committing mid-word would make backspacing over a typo impossible.
 */
export function splitPendingInput(value: string): PendingSplit {
  const match = TRAILING_SEGMENT.exec(value);
  if (match === null) return { committed: [], pending: value };
  return {
    committed: parseRecipients(value.slice(0, match.index)),
    pending: value.slice(match.index + 1),
  };
}

/**
 * Adds `additions` to `existing`, skipping anything already there under
 * the same case-insensitive key, and de-duplicating within the additions
 * themselves.
 *
 * Returns a NEW array; `existing` is only read. (`parseRecipients` alone
 * cannot do this job — it de-duplicates within one input string and knows
 * nothing about the chips already on screen.)
 */
export function mergeRecipients(
  existing: readonly string[],
  additions: readonly string[],
): readonly string[] {
  const seen = new Set(existing.map(dedupeKey));
  const merged = [...existing];
  for (const addition of additions) {
    const key = dedupeKey(addition);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(addition);
  }
  return merged;
}

/** True when `address` is in `addresses`, compared the way this module
 *  compares everywhere else. Used to mark the recipients a partial send
 *  failed to reach. */
export function includesRecipient(addresses: readonly string[], address: string): boolean {
  const key = dedupeKey(address);
  return addresses.some((candidate) => dedupeKey(candidate) === key);
}

/**
 * `addresses` with everything in `excluded` removed, compared under the
 * same case-insensitive key as everything else here.
 *
 * The reply derivation's one destructive operation (../replyDraft.ts):
 * reply-all must drop every address of the user's OWN, or every reply
 * they send copies themselves. It lives HERE rather than there because
 * "are these two strings the same mailbox?" already has one answer in
 * this client, and a second copy of `dedupeKey` is how the composer's
 * chips and the reply's derivation eventually disagree about whether
 * `Me@Example.com` and `me@example.com` are one person.
 *
 * Returns a NEW array; both inputs are only read.
 */
export function excludeRecipients(
  addresses: readonly string[],
  excluded: readonly string[],
): string[] {
  const keys = new Set(excluded.map(dedupeKey));
  return addresses.filter((address) => !keys.has(dedupeKey(address)));
}
