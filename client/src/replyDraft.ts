import type { ParsedAddress, ParsedMessage } from './api';
import { excludeRecipients, includesRecipient, mergeRecipients } from './components/composeRecipients';
import { hasDraftContent, textBodyBytes } from './components/composeValidation';
import type { ComposeDraft } from './components/composeValidation';

/**
 * Plan 9 Task 4 — everything a reply DECIDES, in one pure module.
 *
 * Who it is addressed to, what its subject becomes, which thread it joins
 * and what the server is given to quote. No React, no fetch, no DOM:
 * client/CLAUDE.md's standing constraint is that no test in this client
 * renders a component, so a judgement made inside a click handler is a
 * judgement the suite cannot see. components/Compose.tsx and
 * components/MessageView.tsx only wire what is decided here.
 *
 * **THE CLIENT DOES NOT BUILD THE QUOTE, AND STRUCTURALLY CANNOT.**
 * spec §5.6 requires the quoted original to have any Postbox tracking
 * pixel stripped out of it BEFORE the reply's own pixel is injected —
 * otherwise every reply in a thread re-fires the ORIGINAL recipient's
 * token forever, reporting opens nobody performed. That strip needs
 * `TRACKING_BASE_URL`, and this client deliberately never learns a second
 * origin (./composeApi.ts's header states the rule and why). So POST
 * /api/send takes the quote SOURCE — the original body, the sender's
 * label and the instant it was sent — and sync/src/send/quote.ts
 * assembles the `.gmail_quote` element server-side with the real base url
 * in hand. Nothing in this file emits markup, and nothing in this file
 * strips anything.
 *
 * THE FOUR DERIVATIONS, AND THE MISFIRE EACH ONE AVOIDS
 *
 *  1. **reply → the sender only.** Answering a group message and quietly
 *     copying everyone is the mistake people apologise for; it must not
 *     be the default.
 *  2. **replyAll → everyone EXCEPT me, matched CASE-INSENSITIVELY.**
 *     Gmail echoes recipient addresses in whatever case they were typed,
 *     and accounts.json is typed by a person. A case-sensitive filter
 *     passes every unit test written with matching case and then mails
 *     the user themselves on every real reply.
 *  3. **forward → `Fwd:` and NO pre-filled recipient.** Pre-filling the
 *     original sender is the classic misfire: the user means to pass a
 *     message to someone else and instead sends it back to the person it
 *     came from.
 *  4. **The prefix test is ANCHORED and case-insensitive** — see
 *     `REPLY_PREFIXED` below. An unanchored test reads "Agenda: Re-org"
 *     as already prefixed and sends an unprefixed reply; a
 *     case-sensitive one turns "RE: x" into "Re: RE: x".
 */

export type ReplyMode = 'reply' | 'replyAll' | 'forward';

/** What `buildReplyDraft` fills the composer's three recipient-and-subject
 *  fields with. Fresh arrays every call; the inputs are only read. */
export interface ReplyDraft {
  readonly to: string[];
  readonly cc: string[];
  readonly subject: string;
}

/** Everything a reply is derived FROM: the mode, the parsed original, and
 *  the account whose mailbox it arrived in (spec §7B — a reply sends from
 *  the account that received the message). */
export interface ReplySource {
  readonly mode: ReplyMode;
  /** `InboxMessage.account_id`, which is also the `Identity.id` the
   *  send-from picker uses — one id, two names for it, both from
   *  accounts.json. */
  readonly accountId: string;
  readonly parsed: ParsedMessage;
}

const REPLY_PREFIX = 'Re:';
const FORWARD_PREFIX = 'Fwd:';

/**
 * ANCHORED (`^`) and case-insensitive.
 *
 * The anchor is the whole point. The same expression WITHOUT the leading
 * caret matches the "re:" inside "Agenda: Re-org" and inside "question
 * re: numbers", so a reply to either would go out with no prefix at all
 * and would not read as a reply in any client that groups by subject.
 * The whitespace is optional rather than required, because "Re:numbers"
 * (no space) is a real thing clients emit.
 */
const REPLY_PREFIXED = /^re:\s*/i;

/** Both spellings, because both are in the wild: Gmail and Apple Mail
 *  write `Fwd:`, Outlook writes `Fw:`. Recognising only one produces
 *  "Fwd: Fw: numbers". Same anchor, same reasoning. */
const FORWARD_PREFIXED = /^fwd?:\s*/i;

/** C0 controls and DEL — the set sync/src/api/send.ts refuses outright in
 *  `fromLabel`. See `senderLabel`. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/**
 * sync/src/api/send.ts `MAX_REFERENCES`. Mirrored rather than imported:
 * the two processes deploy independently, and a client that sent 51
 * references would get one opaque 400 that names nothing, on a reply the
 * user can see no fault in.
 */
export const MAX_REFERENCES = 50;

/** sync/src/api/send.ts `MAX_QUOTE_BODY_BYTES` — BYTES of quoted body,
 *  measured in UTF-8. Mirrored for the same reason as `MAX_REFERENCES`. */
export const MAX_QUOTE_BODY_BYTES = 100 * 1024;

/** sync/src/api/send.ts `MAX_FROM_LABEL_CHARS`. */
const MAX_FROM_LABEL_CHARS = 320;

/** What a message with no readable sender is attributed to. Never the
 *  empty string: the route refuses a blank `fromLabel` with a 400 that
 *  names nothing, so an unattributable quote would fail the whole send. */
const UNKNOWN_SENDER = 'Unknown sender';

/**
 * The subject a reply or forward opens with.
 *
 * Trimmed first, so "  numbers  " becomes "Re: numbers" rather than
 * "Re:   numbers  ", and so a whitespace-only subject is treated as no
 * subject. An absent subject yields the bare prefix with nothing dangling
 * after it.
 */
function subjectFor(subject: string | null, mode: ReplyMode): string {
  const trimmed = (subject ?? '').trim();
  const isForward = mode === 'forward';
  const alreadyPrefixed = isForward ? FORWARD_PREFIXED : REPLY_PREFIXED;
  const prefix = isForward ? FORWARD_PREFIX : REPLY_PREFIX;

  if (alreadyPrefixed.test(trimmed)) return trimmed;
  return trimmed === '' ? prefix : `${prefix} ${trimmed}`;
}

/** Addresses out of a parsed header list, blanks dropped. `parseAddress`
 *  in ./api.ts already refuses an empty address, so this only fires on a
 *  hand-constructed message — and a blank chip in the composer is worse
 *  than a missing one. */
function addressesOf(list: readonly ParsedAddress[]): string[] {
  return list.map((entry) => entry.address.trim()).filter((entry) => entry !== '');
}

/** The sender, as a zero- or one-element list so it composes with the
 *  recipient lists without a null check at every use. */
function senderOf(message: ParsedMessage): string[] {
  const from = message.from?.address.trim() ?? '';
  return from === '' ? [] : [from];
}

/**
 * "Ada Lovelace <ada@example.com>", or the bare address when there is no
 * display name — the shape sync/src/send/quote.ts's attribution line
 * expects.
 *
 * THREE THINGS THIS GUARANTEES, each because the route refuses the
 * opposite with one opaque 400 that names no field:
 *
 *  - **never empty.** A message with no readable From still has to be
 *    quotable.
 *  - **no control characters.** This value is interpolated toward a
 *    header; the route refuses the whole C0 range in it. A display name
 *    carrying a stray tab is odd but harmless mail, and it must not cost
 *    the user their send. Stripped rather than rejected — and note that
 *    the strip is a courtesy on top of the route's refusal, not a
 *    substitute for it: the server still validates.
 *  - **bounded.** A 1000-character display name (spam does this) would
 *    otherwise exceed `MAX_FROM_LABEL_CHARS` and 400 the send.
 */
export function senderLabel(from: ParsedAddress | null): string {
  const address = from?.address.trim() ?? '';
  const name = (from?.name ?? '').replace(CONTROL_CHARACTERS, '').trim();
  const label =
    address === '' ? name : name === '' ? address : `${name} <${address.replace(CONTROL_CHARACTERS, '')}>`;

  if (label === '') return UNKNOWN_SENDER;
  return label.length > MAX_FROM_LABEL_CHARS ? label.slice(0, MAX_FROM_LABEL_CHARS) : label;
}

/**
 * Who the reply is addressed to, and who is copied.
 *
 * `mergeRecipients` and `excludeRecipients` are components/
 * composeRecipients.ts's, deliberately: they carry the one definition of
 * "these two strings are the same mailbox" that the composer's own chips
 * already use. A second copy here is how the derivation and the chips
 * eventually disagree about `Me@Example.com`.
 */
export function buildReplyDraft(
  message: ParsedMessage,
  mode: ReplyMode,
  ownAddresses: readonly string[],
): ReplyDraft {
  const subject = subjectFor(message.subject, mode);

  // A forward is a NEW message that happens to quote an old one. It gets
  // no recipient at all — see decision 3 in the file header.
  if (mode === 'forward') return { to: [], cc: [], subject };

  const sender = senderOf(message);
  const listed = addressesOf(message.to);
  const copied = addressesOf(message.cc);

  if (mode === 'reply') {
    /**
     * REPLYING TO A MESSAGE I SENT ANSWERS THE PEOPLE I WROTE TO.
     *
     * Reachable from the Sent folder, which is a first-class destination
     * in this app's nav (`g t`). Without this branch the sender is me, so
     * the reply would be addressed to myself — the same failure reply-all
     * has to avoid, arriving by a different route and just as visible.
     * Gmail does exactly this.
     */
    const from = sender[0];
    const isFromMe = from !== undefined && includesRecipient(ownAddresses, from);
    const audience = isFromMe ? listed : sender;
    return { to: excludeRecipients(mergeRecipients([], audience), ownAddresses), cc: [], subject };
  }

  // Reply-all needs NO self-sent branch: the sender is me, and the filter
  // below removes me, which leaves exactly the original recipients.
  const to = excludeRecipients(mergeRecipients(sender, listed), ownAddresses);
  // Excluded from Cc as well as from To: one person in both fields is two
  // SMTP copies, two tracking pixels and two arrivals in one inbox, because
  // this product sends per recipient (sync/src/send/send.ts).
  const cc = excludeRecipients(mergeRecipients([], copied), [...ownAddresses, ...to]);
  return { to, cc, subject };
}

/** The `In-Reply-To` and `References` a reply carries. `references` is
 *  always an array — `[]` when there is nothing to thread to — because
 *  ./composeApi.ts omits an empty one from the wire rather than sending a
 *  blank header. */
export interface ReplyThreading {
  readonly inReplyTo?: string;
  readonly references: string[];
}

/**
 * Trims an over-long chain to what the route accepts, keeping the ROOT
 * and the newest entries.
 *
 * The root is what every mail client groups a conversation by, so it is
 * the one entry that must survive; the middle is what a long thread has
 * too much of. Dropping from the front instead would detach the reply
 * from the conversation it belongs to — which is the exact failure this
 * whole task exists to prevent.
 */
function capReferences(chain: readonly string[]): string[] {
  if (chain.length <= MAX_REFERENCES) return [...chain];
  const root = chain.slice(0, 1);
  return [...root, ...chain.slice(chain.length - (MAX_REFERENCES - 1))];
}

/**
 * The threading headers, which are the entire reason a reply lands inside
 * an existing conversation rather than beside it.
 *
 * NO UNIT TEST IN THIS FILE'S SUITE CAN PROVE THIS WORKS. Every one of
 * them passes with these headers dropped on the floor between here and
 * the SMTP transaction. Only sending a real reply and looking at the real
 * thread in Gmail proves it; the task report records that check.
 *
 * A FORWARD CARRIES NEITHER, deliberately. It is addressed to someone
 * outside the conversation, and threading it would file the user's own
 * copy inside a thread the new recipient was never part of — and would
 * hand that recipient a `References` chain pointing at messages they
 * never received, which their client can silently thread into something
 * unrelated.
 */
export function buildThreading(message: ParsedMessage, mode: ReplyMode): ReplyThreading {
  if (mode === 'forward') return { references: [] };

  const parent = message.messageId;
  // Legal, if unusual. Emitting `In-Reply-To: ` with nothing after it
  // would be worse than emitting nothing: the route refuses an empty
  // message-id, so the whole send would 400.
  if (parent === null || parent.trim() === '') return { references: [] };

  return { inReplyTo: parent, references: capReferences([...message.references, parent]) };
}

/**
 * The original body, handed to the server to quote. NOT a quote — see the
 * file header for why the client cannot build one.
 *
 * Mirrors sync/src/api/send.ts's `ValidQuote` field for field.
 */
export interface QuoteSource {
  readonly originalHtml: string | null;
  readonly originalText: string | null;
  readonly fromLabel: string;
  /** Epoch MILLISECONDS, matching `ParsedMessage.date` exactly. Never an
   *  ISO string — the route refuses one rather than coercing it, and
   *  three separate defects in this project came from a timestamp that
   *  was a string at one hop and a number at the next. */
  readonly sentAtMs: number | null;
}

/**
 * What to quote, or null when there is nothing quotable.
 *
 * TWO REASONS TO RETURN NULL, and neither is an error:
 *
 *  - **The message has no body at all.** An empty quote block under the
 *    user's reply is noise.
 *  - **The body is over the route's cap.** Bodies in this reader are
 *    routinely 60–90 KB (components/MessageView.tsx measured it), so this
 *    is reachable, not theoretical. Sending it anyway 400s the entire
 *    send and takes the user's own writing down with it; dropping the
 *    quote loses the quoted text and keeps the message. The composer says
 *    so on screen rather than dropping it silently.
 *
 * ONLY ONE ALTERNATIVE IS SENT. sync/src/send/quote.ts reads
 * `originalText` only when `originalHtml` is null, so sending both spends
 * the byte budget on a field that will never be read — and a 100 KB
 * newsletter carries both.
 */
export function buildQuoteSource(message: ParsedMessage): QuoteSource | null {
  const originalHtml = message.html;
  const originalText = originalHtml === null ? message.text : null;
  if (originalHtml === null && originalText === null) return null;

  // BYTES, not characters: one emoji is four UTF-8 bytes, so a character
  // count would let four times the limit through and 400 the send.
  const bytes = textBodyBytes(originalHtml ?? '') + textBodyBytes(originalText ?? '');
  if (bytes > MAX_QUOTE_BODY_BYTES) return null;

  return {
    originalHtml,
    originalText,
    fromLabel: senderLabel(message.from),
    sentAtMs: message.date,
  };
}

/** The three optional fields a reply adds to POST /api/send. Absent for a
 *  plain compose, which must stay byte-identical on the wire. */
export interface ReplyWireFields {
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly quote?: QuoteSource;
}

/** Threading and the quote source together, so components/Compose.tsx
 *  spreads ONE object into the send call and cannot forget half of it. */
export function replyWireFields(reply: ReplySource): ReplyWireFields {
  const threading = buildThreading(reply.parsed, reply.mode);
  const quote = buildQuoteSource(reply.parsed);
  return {
    ...threading,
    ...(quote === null ? {} : { quote }),
  };
}

/** The composer's opening state for a reply. `isCcShown` is here rather
 *  than derived at the call site because "does this reply have a Cc?" is
 *  the same question `buildReplyDraft` just answered. */
export interface SeededDraft extends ReplyDraft {
  readonly isCcShown: boolean;
}

export function seedReplyDraft(
  reply: ReplySource,
  ownAddresses: readonly string[],
): SeededDraft {
  const draft = buildReplyDraft(reply.parsed, reply.mode, ownAddresses);
  // Revealed only when there is something in it. An empty Cc field opened
  // for no reason is one more thing to look past on a 400px screen.
  return { ...draft, isCcShown: draft.cc.length > 0 };
}

/**
 * True when closing the composer would throw away something the USER
 * wrote — as opposed to something this module put there for them.
 *
 * WHY THIS EXISTS, AND IT IS NOT HYPOTHETICAL: it was found by opening a
 * forward in the running app and pressing Escape. A reply arrives with
 * its recipients and subject already filled in, so
 * components/composeValidation.ts's `hasDraftContent` — which answers
 * "is there anything in these fields?" — reports a brand-new, untouched
 * reply as dirty. The composer then puts a native `window.confirm`
 * ("Discard this draft?") in front of a user who has typed nothing and
 * asked for nothing. Gmail closes an untouched reply without a word, and
 * so should this.
 *
 * The seed is the BASELINE, not the floor: removing a recipient the seed
 * added is the user's work too, so any difference in either direction
 * counts. Only an exact match with what was seeded is "untouched".
 *
 * `seed` is null for a plain compose, where every field started empty and
 * `hasDraftContent` is already exactly right.
 */
export function isDraftDirty(draft: ComposeDraft, seed: SeededDraft | null): boolean {
  if (seed === null) return hasDraftContent(draft);
  if (draft.textBody.trim() !== '') return true;
  if (draft.subject !== seed.subject) return true;
  return !sameAddresses(draft.to, seed.to) || !sameAddresses(draft.cc, seed.cc);
}

/** Order-sensitive, and compared under the same case-insensitive key the
 *  composer's chips use — so re-typing an address in different case is
 *  not mistaken for an edit. */
function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((address, index) => includesRecipient([right[index] ?? ''], address));
}

/**
 * A React `key` for the composer, so that switching from a reply to a
 * forward — or replying to a second message without closing in between —
 * REMOUNTS it.
 *
 * The seeding effect in components/Compose.tsx runs once per mount by
 * design (it must never overwrite a draft in progress), so without a key
 * that changes, the second reply would open showing the first one's
 * recipients and subject.
 *
 * The mode is part of the key because `r` then `a` on the SAME message
 * must re-derive: those two differ in exactly the recipient list.
 */
export function replyKey(reply: ReplySource | null): string {
  if (reply === null) return 'compose';
  const { parsed } = reply;
  // The Message-ID identifies the message; the subject-and-instant pair
  // is the fallback for mail that carries none, which is legal. Two
  // distinct such messages sharing both would fail to remount — the
  // narrowest possible consequence, and unreachable in practice.
  const identity = parsed.messageId ?? `${parsed.subject ?? ''}@${parsed.date ?? 0}`;
  return `${reply.mode}|${reply.accountId}|${identity}`;
}

/**
 * What the composer calls itself.
 *
 * Not decoration: `r` and `a` differ only in the recipient list, so the
 * title is how a user who pressed one and meant the other finds out
 * before they send. It is also the acknowledgement that a bare keystroke
 * did anything at all.
 */
export function composerTitleFor(mode: ReplyMode | null): string {
  if (mode === 'reply') return 'Reply';
  if (mode === 'replyAll') return 'Reply all';
  if (mode === 'forward') return 'Forward';
  return 'New message';
}

/**
 * What the composer says about the quoted original, or null when there is
 * nothing worth saying.
 *
 * THE SECOND CASE IS THE ONE THAT MATTERS. `buildQuoteSource` returns
 * null for a body over the route's cap, and a quote that silently
 * vanished would have the user send a reply they believe carries the
 * conversation and does not. Saying so costs one line and is the same
 * honest-failure rule the rest of this client follows.
 */
export function quoteNoticeFor(reply: ReplySource | undefined): string | null {
  if (reply === undefined) return null;
  if (buildQuoteSource(reply.parsed) !== null) {
    return 'The original message is quoted below what you write.';
  }
  if (reply.parsed.html === null && reply.parsed.text === null) return null;
  return 'The original message is too large to quote, so this will send without it.';
}

/**
 * Where the cursor lands when the composer opens.
 *
 * A reply already has its recipients and its subject, so the only thing
 * left to do is write — landing in To would make the user tab past two
 * filled fields to reach the empty one. A forward is the opposite: the
 * body is quoted and the recipient is the one thing missing, which is
 * exactly why it is missing (see decision 3). `null` is a plain compose,
 * which opens in To exactly as it does today.
 */
export function initialFocusFor(mode: ReplyMode | null): 'to' | 'body' {
  return mode === 'reply' || mode === 'replyAll' ? 'body' : 'to';
}
