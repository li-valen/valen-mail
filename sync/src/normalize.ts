import type { MessageInput } from './db';

/** Long enough to judge a message from the list, short enough that 500k
 *  rows stay near 1 GB. Storing full bodies would be roughly 10x this.
 *
 *  NOT YET EXERCISED IN PRODUCTION. makeSnippet() reads `raw.bodyText`, and
 *  the only producer of RawImapMessage is fetchHeaders(), which correctly
 *  never fetches a body — so `bodyText` is always undefined, makeSnippet()
 *  always returns null, and the `snippet` column is always NULL. This limit
 *  therefore bounds nothing today; it is the contract a future
 *  fetch-a-body-prefix task must honour. Treat the storage arithmetic above
 *  as the design intent for that task, not as a description of what the
 *  service currently stores. */
export const SNIPPET_CHARS = 280;

interface Address { readonly name?: string; readonly address?: string }

export interface RawImapMessage {
  readonly uid: number;
  readonly size?: number;
  readonly flags?: ReadonlySet<string> | readonly string[];
  readonly labels?: ReadonlySet<string> | readonly string[];
  readonly threadId?: string;
  readonly bodyText?: string;
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

/** Always returns null in the shipped service: no caller supplies
 *  `bodyText`. See SNIPPET_CHARS above. */
function makeSnippet(bodyText: string | undefined): string | null {
  if (!bodyText) return null;
  const collapsed = bodyText.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, SNIPPET_CHARS);
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
    snippet: makeSnippet(raw.bodyText),
    flags: toSortedArray(raw.flags),
    labels: toSortedArray(raw.labels),
    hasAttach: false, // set by the caller from extractAttachments()
    sizeBytes: raw.size ?? null,
  };
}
