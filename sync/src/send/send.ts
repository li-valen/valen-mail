import { randomUUID } from 'node:crypto';
import type { SendMailOptions, Transport } from 'nodemailer';
import { buildTrackedMessage, formatFrom, sanitizeAddress } from './build.ts';
import type { TrackedMessage } from './build';
import type { DecodedAttachment } from './attachments';
import { REQUEST_TIMEOUT_MS } from '../api/opens.ts';
import { errorCode } from './error-code.ts';

/**
 * Plan 4 Task 3 — the dispatch half of the send path: mint N tokens, then
 * send N copies.
 *
 * This module performs I/O but knows nothing about HTTP requests,
 * responses, status codes or validation — that is ../api/send.ts's job.
 * The split is the same one ./build.ts draws one level down, and it is
 * what lets every test below inject a fake transport and a fake fetch
 * instead of dialing Gmail or the tracking service.
 */

/**
 * Same 5 seconds, same tracking deployment, same reason as
 * ../api/opens.ts's own timeout — imported rather than re-declared so the
 * two cannot drift apart, and re-exported under a name that reads at this
 * module's call site. A hung mint must not hold a send request open.
 */
export const MINT_REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

/**
 * Bound on the Message-ID this module generates, matching the 256
 * characters tracking's POST /api/tokens accepts. A generated
 * `<uuid@domain>` is nowhere near it; the constant exists so the
 * relationship is visible rather than coincidental.
 */
const MAX_MESSAGE_ID_CHARS = 256;

/**
 * Domain used when a sending address carries no `@`. Unreachable through
 * loadConfig (which rejects an address without one), so this exists only
 * so a defensive path still produces a syntactically valid Message-ID
 * rather than `<uuid@>`.
 */
const FALLBACK_MESSAGE_ID_DOMAIN = 'postbox.local';

/**
 * What a token may contain before ./build.ts interpolates it into the
 * pixel's `src` attribute.
 *
 * The pixel markup is byte-binding (spec 5.1), so the builder does NOT
 * escape the token — which makes validating it here load-bearing rather
 * than decorative. Tracking mints 32 hex characters today; this accepts
 * any URL-safe opaque string so a future token format does not require a
 * lockstep deploy, and refuses anything that could close the attribute
 * and open an event handler in mail sent from the user's own address.
 */
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * One logical message's Message-ID: `<{uuid}@{sender domain}>`.
 *
 * ONE per compose action, not one per recipient. All N per-recipient
 * copies carry it, exactly as an ordinary group email does — the copies
 * differ only in their envelope recipient and their pixel token, and a
 * different Message-ID on each would make one message look like N
 * unrelated ones to every threading algorithm that sees more than one
 * copy (a recipient who is also cc'd on the group, a mailing list, the
 * sender's own Sent folder).
 *
 * Generated here rather than by nodemailer because tracking's mint route
 * stores it BEFORE the send: the value has to exist before either call.
 * `randomUUID` is node:crypto, not a new dependency.
 */
export function buildMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] || FALLBACK_MESSAGE_ID_DOMAIN;
  return `<${randomUUID()}@${domain}>`.slice(0, MAX_MESSAGE_ID_CHARS);
}

/** One element of the mint request — tracking's widened POST /api/tokens
 *  contract, all four fields required. */
export interface MintSend {
  readonly recipientEmail: string;
  readonly subject: string;
  readonly accountId: string;
  readonly messageId: string;
}

/** One recipient paired with the token minted for their copy. */
export interface MintedToken {
  readonly recipientEmail: string;
  readonly token: string;
}

/**
 * Mint outcome. There is deliberately no "partial" case: a send that
 * pretends to be tracked is the product lying, so anything short of a
 * complete, correctly-ordered, well-formed set of tokens is a failure the
 * caller must turn into a refusal (../api/send.ts answers 502). Never an
 * untracked fallback.
 */
export type MintResult =
  | { readonly ok: true; readonly tokens: readonly MintedToken[] }
  | { readonly ok: false; readonly reason: 'unreachable' | 'upstream_error' };

export interface MintDeps {
  readonly baseUrl: string;
  readonly token: string;
  /** Injected in tests; production always uses the real global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Validates the mint response against the sends it answers.
 *
 * Three checks, each guarding a distinct way this can go wrong at a
 * network boundary: the count (a partial mint must not become a partial
 * send), the per-index recipient echo (the contract is order-preserving —
 * if it ever stops being, pairing by index would attach one recipient's
 * token to another's copy and misattribute every open), and the token
 * charset (see SAFE_TOKEN_PATTERN). Addresses are compared
 * case-insensitively after trimming: SMTP local parts are technically
 * case-sensitive, but no real provider treats them so, and a mint that
 * normalises case must not fail every send.
 */
function parseMintedTokens(body: unknown, sends: readonly MintSend[]): readonly MintedToken[] | null {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  const raw = record?.tokens;
  if (!Array.isArray(raw) || raw.length !== sends.length) return null;

  const minted: MintedToken[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) return null;
    const element = item as Record<string, unknown>;
    const token = element.token;
    const recipientEmail = element.recipientEmail;

    if (typeof token !== 'string' || !SAFE_TOKEN_PATTERN.test(token)) return null;
    if (typeof recipientEmail !== 'string') return null;

    const requested = sends[index]!.recipientEmail;
    if (recipientEmail.trim().toLowerCase() !== requested.trim().toLowerCase()) return null;

    // The REQUESTED address is kept, not the echoed one: this service's
    // own record of who it is sending to must not be rewritten by the
    // response of another service.
    minted.push({ recipientEmail: requested, token });
  }
  return minted;
}

/**
 * Mints one opaque token per recipient via tracking's POST /api/tokens.
 *
 * Never throws — every failure mode becomes `{ok: false}` — and never logs
 * a subject, a recipient address or a token: only counts and the fixed
 * reason. Timeout, bearer header and never-in-the-URL handling are the
 * same shape ../api/opens.ts's fetchOpens already proved out.
 */
export async function mintTokens(deps: MintDeps, sends: readonly MintSend[]): Promise<MintResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    // Inside the try for the same reason fetchOpens does it: a malformed
    // TRACKING_BASE_URL throws synchronously from `new URL`, and that must
    // degrade like a network failure rather than escape as an exception.
    const url = new URL('/api/tokens', deps.baseUrl);
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sends }),
      signal: controller.signal,
    });
  } catch {
    // The error object is not logged: a fetch/URL error message can quote
    // the request it failed on, and this request body is a recipient list.
    console.error(`send: tracking unreachable while minting ${sends.length} token(s)`);
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    console.error(
      `send: tracking returned ${response.status} while minting ${sends.length} token(s)`,
    );
    return { ok: false, reason: 'upstream_error' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.error('send: tracking returned a mint body that was not valid JSON');
    return { ok: false, reason: 'upstream_error' };
  }

  const minted = parseMintedTokens(body, sends);
  if (!minted) {
    console.error(
      `send: tracking returned a mint body that did not match the ${sends.length} send(s) ` +
        'requested (count, order, or token shape)',
    );
    return { ok: false, reason: 'upstream_error' };
  }

  return { ok: true, tokens: minted };
}

/** One recipient's outcome. `ok: false` is a fact, not an error — the
 *  route answers 200 and lets these carry the truth per recipient. */
export interface SendResult {
  readonly recipientEmail: string;
  readonly ok: boolean;
}

/**
 * Everything one compose action needs to become N sent copies.
 *
 * `to`/`cc` are the FULL group and appear on every copy's headers;
 * `recipients` is what actually gets sent to, one envelope at a time, and
 * carries each address's own token. They are separate fields because they
 * are different things: `to`/`cc` are what recipients SEE, `recipients`
 * is who the mail GOES to.
 */
export interface SendTrackedRequest {
  readonly accountId: string;
  readonly fromName?: string;
  readonly fromEmail: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  /**
   * The quoted original as ../send/quote.ts built it, or undefined for a
   * plain compose. Already stripped of any Postbox pixel the original
   * carried (spec §5.6) — the strip runs at quote construction, BEFORE
   * ./build.ts injects this recipient's new pixel immediately in front of
   * it (spec §5.2).
   */
  readonly htmlQuote?: string;
  readonly messageId: string;
  /**
   * The message being replied to, angle brackets included, or undefined
   * for a new thread.
   *
   * Emitted verbatim as `In-Reply-To`, so ../api/send.ts refuses any value
   * carrying a CR or LF before it ever reaches this module — a newline
   * here would terminate the header and let the rest forge a `Bcc:`.
   */
  readonly inReplyTo?: string;
  /** The thread's `References` chain, oldest → newest. Emitted as one
   *  space-joined header; omitted entirely when empty rather than sent
   *  blank. */
  readonly references?: readonly string[];
  /**
   * The files riding on this message, already validated and DECODED
   * (./attachments.ts's `parseAttachments`), or absent for a message with
   * none — which is every message this product sent before Plan 11.
   *
   * The SAME list goes on every per-recipient copy. That is what spec
   * §5.3.1 is about: N copies means Gmail files N copies of every byte
   * here into Sent, so ../api/send.ts decides BEFORE calling this whether
   * the message can still afford per-recipient tokens.
   */
  readonly attachments?: readonly DecodedAttachment[];
  readonly pixelBase: string;
  readonly recipients: readonly MintedToken[];
}

export interface SendTrackedDeps {
  readonly transport: Transport;
}

/**
 * Sends one copy per recipient, each carrying that recipient's own pixel.
 *
 * SEQUENTIAL, never `Promise.all`. All N copies go through ONE transport
 * to one Gmail account, and Gmail meters both concurrent connections and
 * send rate per account; a fan-out over 25 recipients would open 25
 * simultaneous SMTP conversations against a provider that answers that
 * with a temporary block on the user's real mailbox. Sends are also the
 * one operation here with a side effect that cannot be undone, so doing
 * them one at a time also means a failure is discovered with a known
 * number of copies already delivered.
 *
 * One recipient's failure never stops the loop: their result is
 * `ok: false` and the next recipient is attempted. The caller answers 200
 * with these results even when some failed — the alternative, a 500,
 * would tell the user nothing about which copies actually went out.
 */
export async function sendTracked(
  deps: SendTrackedDeps,
  request: SendTrackedRequest,
): Promise<readonly SendResult[]> {
  const from = formatFrom(request.fromName, request.fromEmail);
  // The envelope MAIL FROM is held to the same standard as the header the
  // line above builds — one sender address, sanitised once, used in both.
  const envelopeFrom = sanitizeAddress(request.fromEmail);
  const results: SendResult[] = [];
  let failures = 0;

  for (const recipient of request.recipients) {
    // ONE descriptor per copy, handed to both the builder and sendMail, so
    // the group headers and the body carrying this recipient's pixel
    // cannot drift apart (see TrackedMessage's own doc comment).
    const message: TrackedMessage = {
      fromName: request.fromName,
      fromEmail: request.fromEmail,
      to: request.to,
      cc: request.cc,
      subject: request.subject,
      textBody: request.textBody,
      htmlQuote: request.htmlQuote,
      token: recipient.token,
      pixelBase: request.pixelBase,
    };
    const { text, html } = buildTrackedMessage(message);

    const options: SendMailOptions = {
      from,
      // Headers: the whole group on every copy (spec 5.3).
      to: request.to,
      // Omitted rather than sent as [] — an empty array is truthy and
      // would have nodemailer compose an empty Cc header.
      ...(request.cc.length > 0 ? { cc: request.cc } : {}),
      subject: request.subject,
      text,
      html,
      messageId: request.messageId,
      // Threading, on EVERY per-recipient copy: a copy missing these
      // threads for some recipients and not others. Both omitted rather
      // than sent empty for a plain compose, so a new message is
      // byte-identical to what this module produced before Plan 9.
      ...(request.inReplyTo === undefined ? {} : { inReplyTo: request.inReplyTo }),
      ...(request.references === undefined || request.references.length === 0
        ? {}
        : { references: request.references }),
      // OMITTED rather than sent as [], exactly like `cc` above. A
      // message with no files must hand the transport the object it
      // always did — an `attachments: []` is a different object, and
      // whether nodemailer happens to compose it identically today is
      // that library's business, not a guarantee this service may lean
      // on. tests/send-dispatch.test.ts asserts the key is absent.
      ...(request.attachments === undefined || request.attachments.length === 0
        ? {}
        : { attachments: request.attachments }),
      // Envelope: exactly one RCPT TO. This is what makes the copy
      // private to this recipient despite the group headers above.
      envelope: { from: envelopeFrom, to: [recipient.recipientEmail] },
    };

    try {
      const info = await deps.transport.sendMail(options);
      // A resolved promise is not proof of delivery: nodemailer rejects
      // only when the whole send failed, and reports per-address refusals
      // in `rejected`. With exactly one envelope recipient, a non-empty
      // `rejected` means this copy did not go out.
      const ok = info.rejected.length === 0;
      if (!ok) failures += 1;
      results.push({ recipientEmail: recipient.recipientEmail, ok });
    } catch (error) {
      failures += 1;
      // Counts, account id and an error code only — never the address,
      // the subject, the body, or the token (Plan 4 Global Constraints).
      console.error(
        `send: a recipient copy failed for account ${request.accountId} (code=${errorCode(error)})`,
      );
      results.push({ recipientEmail: recipient.recipientEmail, ok: false });
    }
  }

  if (failures > 0) {
    console.error(
      `send: ${failures} of ${request.recipients.length} recipient copies failed for ` +
        `account ${request.accountId}`,
    );
  }

  return results;
}
