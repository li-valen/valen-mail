export interface AttachmentMeta {
  readonly partId: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
}

interface BodyNode {
  readonly part?: string;
  readonly type?: string;
  readonly size?: number;
  readonly disposition?: string;
  readonly dispositionParameters?: Record<string, unknown>;
  readonly childNodes?: readonly BodyNode[];
}

/** Cap on BODYSTRUCTURE nesting depth. MIME typically nests just a few levels
 *  (multipart/alternative wrapping text and html, maybe one multipart/related
 *  for images). Nesting beyond ~20 levels is pathological; a hostile sender can
 *  craft a million-level structure in <1 MB. This is a defensive wall, not a
 *  consensus limit. Stacks at ~10k levels; cap at 100 to stay well clear. */
const MAX_DEPTH = 100;

/**
 * Walks an IMAP BODYSTRUCTURE and returns metadata for parts that are
 * attachments. Content is never read — `partId` is the IMAP part number
 * used to fetch the bytes on demand, which is what keeps a ten-mailbox
 * store near 1 GB instead of 100 GB.
 *
 * Never throws, even on hostile input: a cyclic or deeply-nested structure
 * from an untrusted sender is malformed, not exceptional. Returns whatever
 * was collected before hitting a limit, or an empty array if the input is
 * not parseable.
 */
export function extractAttachments(bodyStructure: unknown): readonly AttachmentMeta[] {
  const found: AttachmentMeta[] = [];

  try {
    const walk = (node: unknown, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      if (typeof node !== 'object' || node === null) return;
      const current = node as BodyNode;

      // Check this node's own disposition first (independent of children).
      // A node can have both childNodes (e.g., message/rfc822 forwarded as attachment)
      // and its own disposition. We evaluate the node itself, then conditionally recurse.
      const filename = current.dispositionParameters?.filename;
      const isAttachment =
        current.disposition === 'attachment' ||
        (current.disposition === 'inline' && typeof filename === 'string');

      if (isAttachment && typeof current.part === 'string') {
        found.push({
          partId: current.part,
          filename: typeof filename === 'string' ? filename : null,
          mimeType: current.type ?? 'application/octet-stream',
          sizeBytes: current.size ?? null,
        });
      }

      // Recurse into children, but not into message/rfc822 children.
      // An attached .eml is fetchable only as a whole; its embedded message's
      // parts are not separately accessible attachments of the outer message.
      if (Array.isArray(current.childNodes) && current.type !== 'message/rfc822') {
        for (const child of current.childNodes) walk(child, depth + 1);
      }
    };

    walk(bodyStructure, 0);
  } catch (err) {
    console.error('[sync/attachments] error walking BODYSTRUCTURE:', err);
  }

  return found;
}
