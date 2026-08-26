import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  TRACKED_SEND_BYTE_BUDGET,
  attachmentError,
  base64FromDataUrl,
  contentTypeFor,
  degradationNotice,
  formatFileSize,
  isSendableFilename,
  mergePicked,
  totalBytes,
  willDegradeTracking,
  withoutPickedAt,
} from '../src/attachmentPicker';

/**
 * Plan 11 Task 3 — the composer's attachment logic, as pure functions.
 *
 * client/CLAUDE.md's standing constraint is that no test in this client
 * renders a component, so a rule that lives inside JSX is a rule nothing
 * can assert. The size accounting, the §5.3.1 degrade predicate and every
 * word of the copy therefore live in src/attachmentPicker.ts and are
 * tested here; Compose.tsx is left with layout.
 */

const MB = 1024 * 1024;

function file(size: number, name = 'a.pdf', type = 'application/pdf') {
  return { id: name, name, size, type };
}

describe('totalBytes', () => {
  it('is zero for no files', () => {
    expect(totalBytes([])).toBe(0);
  });

  it('sums the sizes', () => {
    expect(totalBytes([file(300, 'a'), file(45, 'b')])).toBe(345);
  });

  it('counts DECODED bytes — File.size, never a base64 length', () => {
    // The wire carries base64, which is 4/3 the size. Summing that here
    // would make the budget below fire 33% early.
    expect(totalBytes([file(3 * MB)])).toBe(3 * MB);
  });
});

describe('willDegradeTracking — spec §5.3.1', () => {
  it('never degrades a message with nothing attached', () => {
    for (const recipientCount of [1, 5, 25]) {
      expect(willDegradeTracking([], recipientCount)).toBe(false);
    }
  });

  it('does not degrade under the budget', () => {
    // 2 MB x 5 = 10 MB, well under 25 MB.
    expect(willDegradeTracking([file(2 * MB)], 5)).toBe(false);
  });

  it('fires on the MULTIPLIED size, not the raw size', () => {
    // THE WHOLE POINT. 10 MB is an ordinary attachment and five people is
    // an ordinary group; together they are 50 MB. A notice driven by the
    // file size alone would stay silent on exactly this case.
    expect(willDegradeTracking([file(10 * MB)], 1)).toBe(false);
    expect(willDegradeTracking([file(10 * MB)], 5)).toBe(true);
  });

  it('is exclusive at the boundary, exactly as the server is', () => {
    expect(willDegradeTracking([file(5 * MB)], 5)).toBe(false); // == 25 MB
    expect(willDegradeTracking([file(5 * MB + 1)], 5)).toBe(true);
  });

  it('fires on the total across several files, not the largest one', () => {
    expect(willDegradeTracking([file(2 * MB, 'a'), file(2 * MB, 'b')], 5)).toBe(false);
    expect(willDegradeTracking([file(2 * MB, 'a'), file(4 * MB, 'b')], 5)).toBe(true);
  });

  it('degrades a modest attachment once the list is long enough', () => {
    expect(willDegradeTracking([file(2 * MB)], 12)).toBe(false);
    expect(willDegradeTracking([file(2 * MB)], 13)).toBe(true);
  });

  it('mirrors the server budget exactly', () => {
    // sync/src/send/attachments.ts TRACKED_SEND_BYTE_BUDGET. A drift here
    // makes the composer promise one thing and the route do another.
    expect(TRACKED_SEND_BYTE_BUDGET).toBe(25 * 1024 * 1024);
  });
});

describe('degradationNotice', () => {
  const notice = degradationNotice();

  it('says what the user will actually see: someone, never a name', () => {
    expect(notice.toLowerCase()).toContain('someone');
  });

  it('says they will not learn who', () => {
    expect(notice.toLowerCase()).toContain('not who');
  });

  it('carries no jargon', () => {
    // The user's standing direction: "i dont need any liek side notes".
    // Nothing here explains how the product works — only what changes.
    for (const jargon of ['token', 'pixel', 'smtp', 'quota']) {
      expect(notice.toLowerCase()).not.toContain(jargon);
    }
  });

  it('carries no other machinery words either', () => {
    for (const jargon of ['base64', 'mime', 'gmail', 'server', 'byte', 'tracking']) {
      expect(notice.toLowerCase()).not.toContain(jargon);
    }
  });

  it('is ONE short sentence', () => {
    expect(notice.split('. ').length).toBe(1);
    expect(notice.length).toBeLessThanOrEqual(120);
  });
});

describe('attachmentError — the caps, said in words', () => {
  it('is silent when there is nothing wrong', () => {
    expect(attachmentError([])).toBeUndefined();
    expect(attachmentError([file(1024)])).toBeUndefined();
  });

  it('names the count cap when there are too many files', () => {
    const many = Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) =>
      file(10, `a${index}`),
    );
    expect(attachmentError(many)).toContain(String(MAX_ATTACHMENT_COUNT));
  });

  it('allows exactly the count cap', () => {
    const exactly = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, index) => file(10, `a${index}`));
    expect(attachmentError(exactly)).toBeUndefined();
  });

  it('names the size cap when the files are too big, and allows the boundary', () => {
    expect(attachmentError([file(MAX_ATTACHMENT_TOTAL_BYTES)])).toBeUndefined();
    expect(attachmentError([file(MAX_ATTACHMENT_TOTAL_BYTES + 1)])).toContain('10 MB');
  });

  it('says MORE THAN the cap, because the running total rounds to the cap', () => {
    // Found in the browser: 10 MiB + 1.5 KB displays as "10 MB" beside a
    // message about a 10 MB limit. No rounding separates those on screen,
    // so the sentence has to.
    const justOver = [file(MAX_ATTACHMENT_TOTAL_BYTES, 'a'), file(1536, 'b')];
    expect(formatFileSize(totalBytes(justOver))).toBe('10 MB');
    expect(attachmentError(justOver)).toContain('more than');
  });

  it('refuses a filename the route would refuse, rather than sending it to be 400d', () => {
    expect(attachmentError([file(10, 'dir/a.pdf')])).toBeDefined();
  });

  it('carries no jargon either', () => {
    const messages = [
      attachmentError(Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, i) => file(10, `a${i}`))),
      attachmentError([file(MAX_ATTACHMENT_TOTAL_BYTES + 1)]),
      attachmentError([file(10, 'dir/a.pdf')]),
    ];
    for (const message of messages) {
      expect(message).toBeDefined();
      for (const jargon of ['token', 'pixel', 'smtp', 'quota', 'base64', '400']) {
        expect(message!.toLowerCase()).not.toContain(jargon);
      }
    }
  });
});

describe('isSendableFilename — the same refusals the route makes', () => {
  it('accepts ordinary names', () => {
    for (const name of ['report.pdf', 'Q3 deck.key', 'résumé.docx', '.gitignore']) {
      expect(isSendableFilename(name)).toBe(true);
    }
  });

  it('refuses path separators and line breaks', () => {
    for (const name of ['dir/a.pdf', 'dir\\a.pdf', '../../etc/passwd', 'a\r\nX: 1', 'a\nb']) {
      expect(isSendableFilename(name)).toBe(false);
    }
  });

  it('refuses the traversal tokens themselves', () => {
    expect(isSendableFilename('.')).toBe(false);
    expect(isSendableFilename('..')).toBe(false);
  });

  it('refuses an empty or blank name', () => {
    expect(isSendableFilename('')).toBe(false);
    expect(isSendableFilename('   ')).toBe(false);
  });
});

describe('contentTypeFor', () => {
  it('keeps a type the browser recognised', () => {
    expect(contentTypeFor('application/pdf')).toBe('application/pdf');
    expect(contentTypeFor('image/png')).toBe('image/png');
  });

  it('falls back when the browser reported nothing', () => {
    // A file with an unknown extension arrives with type === ''. The route
    // requires a real type/subtype, so sending the empty string would 400
    // a perfectly ordinary file.
    expect(contentTypeFor('')).toBe('application/octet-stream');
  });

  it('drops parameters the route will not accept', () => {
    expect(contentTypeFor('text/plain; charset=utf-8')).toBe('text/plain');
  });

  it('falls back for anything that is still not a bare type/subtype', () => {
    for (const nasty of ['text', 'te xt/plain', '/plain', 'text/']) {
      expect(contentTypeFor(nasty)).toBe('application/octet-stream');
    }
  });
});

describe('base64FromDataUrl', () => {
  it('returns the payload after the base64 marker', () => {
    expect(base64FromDataUrl('data:application/pdf;base64,aGk=')).toBe('aGk=');
  });

  it('handles an empty file, which is a marker and nothing after it', () => {
    expect(base64FromDataUrl('data:application/octet-stream;base64,')).toBe('');
  });

  it('returns null for a data URL that is not base64 encoded', () => {
    // FileReader.readAsDataURL always produces base64, but a null here is
    // an honest "cannot read this" rather than a corrupt attachment.
    expect(base64FromDataUrl('data:text/plain,hello')).toBeNull();
    expect(base64FromDataUrl('')).toBeNull();
    expect(base64FromDataUrl('aGk=')).toBeNull();
  });
});

describe('formatFileSize', () => {
  it('reads as a person would say it', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(10 * MB)).toBe('10 MB');
    expect(formatFileSize(1.25 * MB)).toBe('1.3 MB');
  });

  it('never prints a trailing .0', () => {
    expect(formatFileSize(2 * MB)).toBe('2 MB');
    expect(formatFileSize(2 * 1024)).toBe('2 KB');
  });

  it('degrades rather than throwing on a nonsense size', () => {
    expect(formatFileSize(Number.NaN)).toBe('0 B');
    expect(formatFileSize(-1)).toBe('0 B');
  });
});

describe('mergePicked / withoutPickedAt — immutable list edits', () => {
  it('appends the new files', () => {
    const existing = [file(10, 'a')];
    expect(mergePicked(existing, [file(20, 'b')]).map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('does not add the same file twice', () => {
    // Picking a file, then opening the picker and picking it again, is an
    // ordinary slip — and two copies of one attachment is never what was
    // meant.
    const existing = [file(10, 'a')];
    expect(mergePicked(existing, [file(10, 'a')])).toHaveLength(1);
  });

  it('treats a same-named file of a different size as a different file', () => {
    const existing = [file(10, 'a')];
    expect(mergePicked(existing, [file(20, 'a')])).toHaveLength(2);
  });

  it('never mutates the list it was given', () => {
    const existing = [file(10, 'a')];
    mergePicked(existing, [file(20, 'b')]);
    expect(existing).toHaveLength(1);

    withoutPickedAt(existing, 0);
    expect(existing).toHaveLength(1);
  });

  it('removes by index and leaves the rest in order', () => {
    const three = [file(10, 'a'), file(10, 'b'), file(10, 'c')];
    expect(withoutPickedAt(three, 1).map((f) => f.name)).toEqual(['a', 'c']);
  });

  it('is a no-op for an index that is not there', () => {
    const three = [file(10, 'a'), file(10, 'b')];
    expect(withoutPickedAt(three, 9)).toHaveLength(2);
    expect(withoutPickedAt(three, -1)).toHaveLength(2);
  });
});
