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

/**
 * Walks an IMAP BODYSTRUCTURE and returns metadata for parts that are
 * attachments. Content is never read — `partId` is the IMAP part number
 * used to fetch the bytes on demand, which is what keeps a ten-mailbox
 * store near 1 GB instead of 100 GB.
 */
export function extractAttachments(bodyStructure: unknown): readonly AttachmentMeta[] {
  const found: AttachmentMeta[] = [];

  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const current = node as BodyNode;

    if (Array.isArray(current.childNodes)) {
      for (const child of current.childNodes) walk(child);
      return;
    }

    const filename = current.dispositionParameters?.filename;
    const isAttachment =
      current.disposition === 'attachment' ||
      (current.disposition === 'inline' && typeof filename === 'string');

    if (isAttachment && current.part) {
      found.push({
        partId: current.part,
        filename: typeof filename === 'string' ? filename : null,
        mimeType: current.type ?? 'application/octet-stream',
        sizeBytes: current.size ?? null,
      });
    }
  };

  walk(bodyStructure);
  return found;
}
