import { simpleParser } from 'mailparser';
import type { AddressObject, Attachment, EmailAddress, ParsedMail } from 'mailparser';
import type { Db } from '../db';
import type { ConnectionPool } from '../imap/pool';
import { json, PRIVATE_NO_STORE } from './http.ts';
import { fetchBudgetedPart, parsePositiveInt, resolveConnection } from './fetch-part.ts';
import { stripOwnTrackingPixels } from './strip-pixel.ts';
import type { MessageCache } from './message-cache';

/**
 * GET /api/message/{accountId}/{folder}/{uid} (Plan 6 Task 1) — the PARSED
 * message, as JSON a reader UI can render.
 *
 * The sibling `/api/message/.../body` route is untouched and still returns
 * raw RFC822: this one adds a shape, it does not replace raw access. Both
 * pull their bytes through the same ./fetch-part.ts call path, so the size
 * cap, the per-account lock and the daily byte budget (spec L6) apply here
 * exactly as they always did — this route adds a parse, not a new way to
 * reach IMAP.
 *
 * Kept out of ./routes.ts on purpose, mirroring ./push.ts and
 * ./identities.ts: that file is already near this project's 800-line
 * ceiling, and every route added since Task 8 lands as a thin dispatch
 * branch delegating to its own module. This route sits behind the router's
 * own auth gate, so by the time handleMessage runs the caller has already
 * proven a valid credential.
 *
 * ---------------------------------------------------------------------
 * THE HTML IS RETURNED UNSANITISED, DELIBERATELY. DO NOT ADD A SANITISER.
 * ---------------------------------------------------------------------
 * The client renders this html inside an `<iframe sandbox>` with NO
 * `allow-scripts` and a CSP `<meta>` blocking remote loads. THAT is the
 * security boundary, and it is a boundary precisely because it holds
 * against html nobody inspected.
 *
 * Sanitising here would not add a second boundary; it would erode the
 * first. A future reader who finds DOMPurify on the server concludes the
 * html reaching the iframe is already safe, and the next person to touch
 * the render layer relaxes the sandbox — at which point the ONLY real
 * defence is gone and what remains is a sanitiser's blocklist against an
 * attacker who writes the input. One boundary that everyone can see is
 * worth more than two that invite each other's removal.
 *
 * tests/message-route.test.ts asserts that a `<script>` tag and an
 * `onclick` attribute survive this route verbatim, so adding a sanitiser
 * fails the suite rather than passing quietly.
 */

/** One mailbox from an address header. `address` is always present — group
 *  entries, which carry only a name, are flattened into their members. */
export interface ParsedAddress {
  readonly name: string | null;
  readonly address: string;
}

/**
 * Attachment METADATA. Never content: `partId` addresses the existing
 * `/api/attachment/{accountId}/{folder}/{uid}/{partId}` route, which
 * fetches the bytes on demand. That split is the same one that keeps a
 * ten-mailbox store near 1 GB instead of 100 GB, and it is why this
 * response stays a few KB for a message carrying a 20 MB video.
 */
export interface ParsedAttachment {
  /**
   * The IMAP part number, i.e. the 4th path segment of
   * `/api/attachment/{accountId}/{folder}/{uid}/{partId}`.
   *
   * EMPTY STRING means no part number could be established — mailparser
   * derives one from the enclosing MIME boundary, and a message that IS a
   * single attachment (no multipart wrapper) has none. A caller must treat
   * `''` as "not addressable" and offer no download link, rather than
   * building a URL that cannot resolve. Deliberately not defaulted to a
   * plausible-looking `"1"`: a guessed part number produces a download
   * that silently returns the wrong bytes, which is worse than a link that
   * is honestly absent.
   */
  readonly partId: string;
  readonly filename: string | null;
  readonly mimeType: string;
  /** DECODED byte length — what a human should be shown. Deliberately not
   *  the `size_bytes` column, which holds BODYSTRUCTURE's ENCODED size
   *  (~4/3 larger for base64). */
  readonly sizeBytes: number | null;
  /** An embedded resource of the body (a `cid:` image) rather than a
   *  separate download. */
  readonly isInline: boolean;
  /** The Content-ID with its angle brackets stripped, i.e. exactly what a
   *  `src="cid:..."` in `html` references — not the raw header value. */
  readonly contentId: string | null;
}

export interface ParsedMessage {
  readonly html: string | null;
  readonly text: string | null;
  readonly subject: string | null;
  readonly from: ParsedAddress | null;
  readonly to: readonly ParsedAddress[];
  readonly cc: readonly ParsedAddress[];
  /** Epoch milliseconds — this codebase's wire convention for a timestamp
   *  (see ./opens.ts's OpenEvent), not an ISO string. */
  readonly date: number | null;
  readonly attachments: readonly ParsedAttachment[];
}

/** Empty and whitespace-only header values are absence, not content. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Flattens one address header into plain mailboxes.
 *
 * Two shapes have to survive this: mailparser hands back a single
 * AddressObject for one header occurrence and an ARRAY of them when the
 * message carries the header twice (a perfectly legal `To:` split across
 * two lines), and an entry inside one is either a mailbox or an RFC 5322
 * GROUP (`Managers: a@x, b@x;`) that has members and no address of its
 * own. Anything without a usable address is dropped rather than emitted
 * with an empty string, so a client never has to render a mailto: to
 * nowhere.
 */
export function flattenAddresses(
  field: AddressObject | readonly AddressObject[] | undefined,
): readonly ParsedAddress[] {
  if (!field) return [];
  const objects = Array.isArray(field) ? field : [field as AddressObject];

  const flattenEntry = (entry: EmailAddress): readonly ParsedAddress[] => {
    if (entry.group) return entry.group.flatMap(flattenEntry);
    const address = textOrNull(entry.address);
    if (address === null) return [];
    return [{ name: textOrNull(entry.name), address }];
  };

  return objects.flatMap((object) => (object?.value ?? []).flatMap(flattenEntry));
}

/**
 * Metadata for one attachment, with `content` deliberately never read.
 *
 * mailparser has already buffered those bytes by the time this runs (its
 * simpleParser concatenates each attachment into a Buffer), so this is not
 * what bounds memory — ./fetch-part.ts's size cap is. What this DOES avoid
 * is the far larger cost of putting those bytes on the wire again, base64
 * expanded, inside a JSON body, for every attachment of every message a
 * user opens.
 */
function toParsedAttachment(attachment: Attachment): ParsedAttachment {
  return {
    partId: attachment.partId ?? '',
    filename: textOrNull(attachment.filename),
    mimeType: textOrNull(attachment.contentType) ?? 'application/octet-stream',
    sizeBytes: typeof attachment.size === 'number' ? attachment.size : null,
    isInline: attachment.contentDisposition === 'inline' || attachment.related === true,
    contentId: textOrNull(attachment.cid) ?? textOrNull(attachment.contentId),
  };
}

/** One row of already-stored attachment metadata, keyed by the IMAP part
 *  number extractAttachments() read off the BODYSTRUCTURE. */
interface BodyStructurePartRow {
  readonly part_id: string;
  readonly filename: string | null;
}

/**
 * Reconciles mailparser's `partId` against the IMAP part numbers already
 * stored for this message, and is the reason this route takes a `Db` at all.
 *
 * mailparser does not read part numbers off the wire — it RECONSTRUCTS
 * them by counting nodes per MIME boundary in arrival order. That equals
 * the real IMAP part number while the tree descends through one multipart
 * at a time, which covers essentially every message anyone sends. It stops
 * being equal when two multiparts are SIBLINGS under one parent: the
 * boundary list is flat and ordered by first appearance, so the second
 * sibling's children inherit the first sibling's counter as an extra level
 * (`mixed[alternative[…], related[…]]` numbers the related part's image
 * "2.2.2" where IMAP calls it "2.2"). Verified against
 * tests/fixtures/messages/sibling-multipart.eml, not inferred.
 *
 * A wrong part number is not a cosmetic bug: it is the 4th path segment of
 * the attachment route, so it downloads the wrong part or nothing at all.
 * The `attachments` table already holds the authoritative numbers, so:
 *
 *  1. the parsed number is kept when the stored rows contain it (they agree);
 *  2. otherwise a UNIQUE filename match adopts the stored number;
 *  3. otherwise the parsed number stands — the part may legitimately have
 *     no row (extractAttachments skips an inline part with no filename),
 *     and a best-effort number beats an empty one.
 *
 * Pure and exported so the rule itself is testable without an IMAP fetch.
 */
export function withCorrectedPartIds(
  attachments: readonly ParsedAttachment[],
  storedRows: readonly BodyStructurePartRow[],
): readonly ParsedAttachment[] {
  if (storedRows.length === 0) return attachments;

  const knownPartIds = new Set(storedRows.map((row) => row.part_id));
  const byFilename = new Map<string, string | null>();
  for (const row of storedRows) {
    if (row.filename === null) continue;
    // A duplicated filename is ambiguous, so it stops being a usable key
    // rather than resolving to whichever row happened to come first.
    byFilename.set(row.filename, byFilename.has(row.filename) ? null : row.part_id);
  }

  return attachments.map((attachment) => {
    if (knownPartIds.has(attachment.partId)) return attachment;
    const matched = attachment.filename === null ? null : byFilename.get(attachment.filename);
    if (!matched) return attachment;
    return { ...attachment, partId: matched };
  });
}

/**
 * The stored part numbers for one message. Uses `Db.query` with
 * placeholders — never string-built SQL from route parameters (Resolution
 * 4) — and tolerates a miss the same way lookupAttachmentMeta in
 * ./routes.ts does: metadata predating the row, or never recorded, must
 * degrade the answer rather than fail the request.
 *
 * Kept outside the account lock: a Postgres round trip, not an IMAP one.
 */
async function lookupStoredParts(
  db: Db,
  accountId: string,
  folder: string,
  uid: number,
): Promise<readonly BodyStructurePartRow[]> {
  const rows = await db.query(
    'select part_id, filename from attachments where account_id = $1 and folder = $2 and uid = $3',
    [accountId, folder, uid],
  );
  return rows as BodyStructurePartRow[];
}

/** Shape-normalises one mailparser result. Pure, and exported so the
 *  null-vs-missing rules can be tested without an IMAP fetch. */
export function toParsedMessage(parsed: ParsedMail): ParsedMessage {
  const date = parsed.date instanceof Date ? parsed.date.getTime() : NaN;
  return {
    html: textOrNull(parsed.html),
    text: textOrNull(parsed.text),
    subject: textOrNull(parsed.subject),
    from: flattenAddresses(parsed.from)[0] ?? null,
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    date: Number.isFinite(date) ? date : null,
    attachments: (parsed.attachments ?? []).map(toParsedAttachment),
  };
}

/**
 * Injection point for the parse, mirroring the `fetchImpl` seam ./opens.ts
 * and ./send.ts already use. Production always gets the real parser; a test
 * needs it to make a parse FAIL deterministically, because mailparser is
 * salvage-oriented and does not throw on malformed MIME — it returns
 * whatever it could recover, which is the right behaviour for a mail
 * client and the wrong one for proving the failure path exists.
 */
export interface MessageHandlerDeps {
  readonly parseImpl?: (source: Buffer) => Promise<ParsedMail>;
}

/** `keepCidLinks: true` is load-bearing, not a preference. mailparser's
 *  default rewrites every `cid:` image in the html into a base64 `data:`
 *  URI, which would inline attachment CONTENT into this response — the
 *  exact thing ParsedAttachment exists to avoid. */
function parseWithMailparser(source: Buffer): Promise<ParsedMail> {
  return simpleParser(source, { keepCidLinks: true });
}

/**
 * Describes a failure for the log WITHOUT quoting it.
 *
 * The input to the parser is attacker-authored, and a parser's error
 * message is a place where a fragment of that input plausibly ends up. The
 * log line therefore carries the error's TYPE, the account, the uid and the
 * byte count — enough to find the message again and reproduce — and never
 * the error's own text. tests/message-route.test.ts asserts a sentinel
 * planted in the failure never reaches console.error.
 */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Caches the FINAL response body and returns it.
 *
 * "Final" is the point: what goes in is post-pixel-strip and
 * post-partId-correction, so a cache HIT is byte-identical to the miss
 * that produced it. Caching `shaped` instead — the value one line before
 * ./strip-pixel.ts runs — would mean the first open of a message strips
 * our own tracking pixel and every later open serves it back, firing a
 * pixel this installation minted and manufacturing an open attributed to
 * a recipient who did nothing. That is spec 5.6 defeated by a cache, and
 * it is exactly the kind of regression a cache introduces quietly, so it
 * has its own test (tests/message-cache.test.ts) rather than only this
 * comment.
 *
 * Caching the corrected attachments also means a hit skips the Postgres
 * round trip lookupStoredParts would otherwise do, which is the second
 * cost this route pays per open.
 */
function cachedJson(
  cache: MessageCache,
  accountId: string,
  folder: string,
  uid: number,
  message: ParsedMessage,
  uidValidity: bigint | null,
): Response {
  cache.set(accountId, folder, uid, message, uidValidity);
  return json(message, 200, PRIVATE_NO_STORE);
}

export async function handleMessage(
  db: Db,
  pool: ConnectionPool,
  accountId: string,
  folder: string,
  uidRaw: string,
  /**
   * TRACKING_BASE_URL, or null when tracking was not configured.
   *
   * A positional parameter rather than a field on `deps` on purpose,
   * following ../push/opens-poll.ts's `ownAddresses`: `deps` is the
   * test-injection bag that production never passes, and this is the
   * opposite — real configuration production must always supply.
   */
  pixelBase: string | null,
  /**
   * The process-wide parsed-message cache (./message-cache.ts). Positional
   * and required for the same reason `pixelBase` is: it is real production
   * state the router owns and always supplies, not a test seam. Giving it
   * a default would make a caller that forgot it silently lose the whole
   * feature — every request would build a private cache, hit it never, and
   * look exactly like the uncached route this replaced.
   */
  cache: MessageCache,
  deps: MessageHandlerDeps = {},
): Promise<Response> {
  const uid = parsePositiveInt(uidRaw);
  if (uid === null) return json({ error: 'invalid uid' }, 400);

  const resolved = resolveConnection(pool, accountId);
  if (resolved instanceof Response) return resolved;

  // AFTER the account and connection checks, deliberately. A cache hit
  // needs no IMAP at all, so serving one for a reconnecting account would
  // be defensible — but it would also change what 404 and 503 mean on this
  // route depending on what somebody happened to read earlier, and a
  // status code whose meaning depends on cache state is worse than a
  // slightly-less-available cache. The four routes that share
  // ./fetch-part.ts still fail identically for identical reasons.
  //
  // The UIDVALIDITY the pool last observed for this mailbox rides along:
  // on a renumbered mailbox every cached uid addresses a different message
  // now, and MessageCache.get drops the folder rather than answering. Read
  // from the pool's own observation — the sync loop already pays for it
  // once per cycle — never by SELECTing the mailbox again here, which
  // would be the IMAP round trip this whole file exists to avoid.
  const uidValidity = pool.getUidValidity(accountId, folder);
  const cached = cache.get(accountId, folder, uid, uidValidity);
  if (cached !== undefined) return json(cached, 200, PRIVATE_NO_STORE);

  let bytes: Buffer;
  try {
    // No partId: the whole raw message, exactly as the /body route fetches
    // it. Same cap, same lock, same budget charge.
    const fetched = await fetchBudgetedPart(pool, resolved, accountId, folder, uid);
    if (fetched instanceof Response) return fetched;
    bytes = fetched;
  } catch (error) {
    console.error(`api: failed to fetch message for account "${accountId}" uid ${uid}`, error);
    return json({ error: 'failed to fetch message body' }, 502);
  }

  let parsed: ParsedMail;
  try {
    parsed = await (deps.parseImpl ?? parseWithMailparser)(bytes);
  } catch (error) {
    console.error(
      `api: failed to parse message for account "${accountId}" uid ${uid} ` +
        `(${bytes.length} bytes): ${describeFailure(error)}`,
    );
    return json({ error: 'failed to parse message' }, 502);
  }

  const shaped = toParsedMessage(parsed);
  // Spec 5.6 — strip OUR OWN pixel from EVERY rendered body, so reading any
  // of this user's mail in Postbox never fires a pixel this installation
  // minted and never manufactures an open attributed to a recipient.
  // Unconditional on purpose: the Sent copy is the loudest case but not the
  // only one (a reply quoting the original carries the original's pixel),
  // and there is exactly one Postbox user, so no folder can hold a pixel of
  // ours whose firing would report a true fact. See ./strip-pixel.ts for
  // why the rule is this narrow and what it deliberately leaves alone.
  const message = { ...shaped, html: stripOwnTrackingPixels(shaped.html, pixelBase) };
  if (message.attachments.length === 0) {
    return cachedJson(cache, accountId, folder, uid, message, uidValidity);
  }

  const stored = await lookupStoredParts(db, accountId, folder, uid);
  return cachedJson(
    cache,
    accountId,
    folder,
    uid,
    { ...message, attachments: withCorrectedPartIds(message.attachments, stored) },
    uidValidity,
  );
}
