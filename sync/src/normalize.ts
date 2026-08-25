import type { MessageInput } from './db';

/** Long enough to judge a message from the list, short enough that 500k
 *  rows stay near 1 GB. Storing full bodies would be roughly 10x this.
 *
 *  LIVE as of Plan 7 Task 1. normalizeMessage() still produces a null
 *  snippet for every message — the sync path it runs inside is
 *  header-only. ConnectionPool follows that with a separate,
 *  separately-budgeted partial PEEK fetch of the first text part and
 *  applies the result through applySnippet() below, which is the single
 *  path that can set this field and therefore the single place this cap
 *  is applied. */
export const SNIPPET_CHARS = 280;

interface Address { readonly name?: string; readonly address?: string }

export interface RawImapMessage {
  readonly uid: number;
  readonly size?: number;
  readonly flags?: ReadonlySet<string> | readonly string[];
  readonly labels?: ReadonlySet<string> | readonly string[];
  readonly threadId?: string;
  readonly envelope?: {
    readonly messageId?: string;
    readonly date?: Date;
    readonly subject?: string;
    readonly from?: readonly Address[];
    readonly to?: readonly Address[];
    readonly cc?: readonly Address[];
  };
}

function toSortedArray(value: ReadonlySet<string> | readonly string[] | undefined): string[] {
  if (!value) return [];
  const arr = [...value];
  // Sort system labels (starting with \) before custom labels, then alphabetically within
  // each group. This is not a plain lexicographic sort: 'Work' (W=0x57) < '\' (0x5C) in ASCII,
  // but IMAP semantics distinguish system labels; custom labels after system ones is correct.
  arr.sort((a, b) => {
    const aIsSystem = a.startsWith('\\');
    const bIsSystem = b.startsWith('\\');
    if (aIsSystem !== bIsSystem) {
      return aIsSystem ? -1 : 1;
    }
    return a.localeCompare(b);
  });
  return arr;
}

function addresses(list: readonly Address[] | undefined): string[] {
  return (list ?? []).map((a) => a.address).filter((a): a is string => Boolean(a));
}

/**
 * The one place a snippet's shape is decided: whitespace collapsed to
 * single spaces (a preview is one line in a list row, not a rendered
 * body) and capped at SNIPPET_CHARS.
 *
 * Returns null — not '' — for input that collapses to nothing, which is
 * what a preview of an entirely-quoted reply or an all-stylesheet HTML
 * fragment does. The client has to be able to tell "no preview" from
 * "empty preview": one means render no second line, the other would
 * reserve a blank one.
 *
 * Callers reaching this via applySnippet() have ALREADY had quoted text
 * and signatures stripped by preview.ts, which needs the line structure
 * this function destroys — hence the split.
 */
function makeSnippet(bodyText: string | undefined | null): string | null {
  if (!bodyText) return null;
  const collapsed = bodyText.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed.slice(0, SNIPPET_CHARS) : null;
}

/**
 * Overlays a preview onto an already-normalized message, exactly the way
 * applyAttachmentFlag() overlays the BODYSTRUCTURE walk's result.
 *
 * A separate step for the same reason that one is: normalizeMessage() runs
 * inside fetchHeaders(), which is header-only by design and has no body
 * bytes to work from. The preview arrives later, from the separate
 * partial PEEK fetch, so the only code that holds both is the caller.
 *
 * `null` (the fetch failed, the message has no text part, or the preview
 * stripped down to nothing) yields a null snippet rather than throwing or
 * inventing one — see upsertMessage's ON CONFLICT for why writing that
 * null cannot erase a snippet a previous cycle already stored.
 */
export function applySnippet(message: MessageInput, bodyText: string | null): MessageInput {
  return { ...message, snippet: makeSnippet(bodyText) };
}

export function normalizeMessage(
  raw: RawImapMessage,
  accountId: string,
  folder: string,
): MessageInput {
  const envelope = raw.envelope ?? {};
  const sender = envelope.from?.[0];
  const messageId = envelope.messageId ?? null;

  return {
    accountId,
    folder,
    uid: raw.uid,
    messageId,
    // Gmail supplies X-GM-THRID; without it, a message is its own thread.
    threadId: raw.threadId ?? messageId,
    subject: envelope.subject ?? null,
    fromName: sender?.name || null,
    fromEmail: sender?.address ?? null,
    toEmails: addresses(envelope.to),
    ccEmails: addresses(envelope.cc),
    date: envelope.date ?? null,
    // Always null here, by construction: the only producer of
    // RawImapMessage is fetchHeaders(), which is header-only. The preview
    // arrives later, from the separate partial PEEK fetch, and is applied
    // by applySnippet() above — the one path that can actually set this.
    snippet: null,
    flags: toSortedArray(raw.flags),
    labels: toSortedArray(raw.labels),
    hasAttach: false, // set by the caller from extractAttachments()
    sizeBytes: raw.size ?? null,
  };
}
