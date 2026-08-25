import { describe, it, expect } from 'vitest';
import { firstTextPart, previewTextFrom, type TextPart } from '../src/preview';

/**
 * Pure coverage for src/preview.ts — the half of message previews that
 * turns ~512 raw bytes into readable text. No IMAP, no network: the fetch
 * itself is tests/fetch-unit.test.ts's job, and the two are separate
 * modules precisely so this can be tested against fixtures.
 */

const PLAIN: TextPart = { partId: '1', mimeType: 'text/plain', encoding: null };
const HTML: TextPart = { partId: '1', mimeType: 'text/html', encoding: null };

function preview(text: string, part: TextPart = PLAIN): string {
  return previewTextFrom(Buffer.from(text, 'utf8'), part);
}

/** What a row actually shows. previewTextFrom deliberately leaves runs of
 *  whitespace and real line breaks behind — the quoting and signature rules
 *  need the line structure, so collapsing is normalize.ts's makeSnippet's
 *  job, one step later. Assertions where the exact spacing is incidental
 *  collapse it the same way makeSnippet will. */
function collapsed(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Which part a preview comes from
// ---------------------------------------------------------------------------

describe('firstTextPart', () => {
  it('resolves a singlepart message to part 1, which RFC 3501 says is its only part', () => {
    // imapflow reports a singlepart root with NO `part` field, because part
    // numbers are built from the path down from the root. Getting this
    // wrong means fetching BODY[undefined].
    expect(firstTextPart({ type: 'text/plain', encoding: '7bit', size: 120 })).toEqual({
      partId: '1',
      mimeType: 'text/plain',
      encoding: '7bit',
    });
  });

  it('picks the nested text/plain, NOT part 1, for the multipart/mixed shape Gmail actually sends', () => {
    // This is the case that makes hardcoding BODY[1] wrong: part 1 here is
    // the multipart/alternative NODE, and fetching it returns MIME
    // boundaries and per-part headers, so the "preview" would read
    // "--000000000000abc Content-Type: text/plain; charset=UTF-8".
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', encoding: 'quoted-printable' },
            { part: '1.2', type: 'text/html', encoding: 'quoted-printable' },
          ],
        },
        { part: '2', type: 'application/pdf', disposition: 'attachment' },
      ],
    };

    expect(firstTextPart(structure)?.partId).toBe('1.1');
  });

  it('prefers text/plain over text/html even when the html part comes first', () => {
    const structure = {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/html', encoding: 'base64' },
        { part: '2', type: 'text/plain', encoding: '7bit' },
      ],
    };

    expect(firstTextPart(structure)?.partId).toBe('2');
  });

  it('falls back to text/html for HTML-only mail rather than giving up', () => {
    const structure = { type: 'text/html', encoding: 'base64' };
    expect(firstTextPart(structure)).toEqual({
      partId: '1',
      mimeType: 'text/html',
      encoding: 'base64',
    });
  });

  it('skips a text part the sender ATTACHED as a file', () => {
    // readme.txt's first line is not the message. The real body here is the
    // html part, so that is what the preview must come from.
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', disposition: 'attachment' },
        { part: '2', type: 'text/html', encoding: '7bit' },
      ],
    };

    expect(firstTextPart(structure)?.partId).toBe('2');
  });

  it('returns null for a message with no text part at all', () => {
    // A bare image. The caller skips the fetch entirely rather than paying
    // 512 bytes for something it cannot render.
    expect(firstTextPart({ type: 'image/jpeg', encoding: 'base64' })).toBeNull();
  });

  it('returns null rather than throwing on absent or unusable structure', () => {
    expect(firstTextPart(undefined)).toBeNull();
    expect(firstTextPart(null)).toBeNull();
    expect(firstTextPart('not a structure')).toBeNull();
  });

  it('terminates on a cyclic structure instead of looping forever', () => {
    // Same hostile-input posture as extractAttachments: a cycle is
    // malformed input, not an exceptional condition.
    const node: Record<string, unknown> = { type: 'multipart/mixed' };
    node.childNodes = [node];
    expect(() => firstTextPart(node)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Quoted text and signatures
// ---------------------------------------------------------------------------

describe('previewTextFrom — quoted text and signatures', () => {
  it('strips BOTH a quoted block and a signature from one real-shaped reply', () => {
    // The fixture the task asks for: new content, an attribution line, a
    // quoted block, and a signature, in the order a real reply carries them.
    const reply = [
      'Sounds good — Thursday works for me.',
      '',
      'On Mon, 3 Aug 2026 at 16:12, Sarah Chen <sarah@example.com> wrote:',
      '> Can we move the review to Thursday?',
      '> I have a conflict Wednesday afternoon.',
      '',
      '-- ',
      'Valen Li',
      'Sent from my phone',
    ].join('\n');

    expect(preview(reply)).toBe('Sounds good — Thursday works for me.');
  });

  it('drops every leading-">" line, including nested ">>" quotes', () => {
    const text = ['Agreed.', '> first level', '>> second level', '  > indented quote'].join('\n');
    expect(preview(text)).toBe('Agreed.');
  });

  it('treats a bare "--" as a signature delimiter, not just the RFC\'s "-- "', () => {
    // Enough clients (and transports, which strip trailing whitespace) emit
    // the bare form that matching only "-- " misses real mail.
    expect(preview('Body text.\n--\nValen')).toBe('Body text.');
  });

  it('keeps a sentence that merely ENDS in "wrote:" when no quote follows it', () => {
    // Unconditionally dropping every "On … wrote:" line would eat this.
    const text = 'On the topic of what the reviewer wrote:\nthe second point is the important one.';
    expect(preview(text)).toContain('the second point is the important one');
    expect(preview(text)).toContain('wrote:');
  });

  it('keeps a line containing "--" that is not a delimiter line', () => {
    expect(preview('Budget is 10--12k this quarter.\nMore soon.')).toContain('10--12k');
  });

  it('returns empty for a bottom-posted reply whose first bytes are all quoted', () => {
    // Honest rather than clever: the first 512 bytes really are all quoted
    // text, so there is no new content to preview. The caller stores no
    // snippet, which is what Gmail shows for the same message.
    expect(preview('> everything here\n> is quoted\n')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// HTML fragments
// ---------------------------------------------------------------------------

describe('previewTextFrom — HTML fragments', () => {
  it('strips tags and decodes entities rather than showing markup', () => {
    const html = '<div><p>Hi <b>there</b> &amp; welcome</p><p>Second line</p></div>';
    expect(preview(html, HTML)).not.toMatch(/<[^>]*>/);
    expect(collapsed(preview(html, HTML))).toBe('Hi there & welcome Second line');
  });

  it('drops a <style> block\'s CONTENT, not just its tags', () => {
    // An HTML newsletter's first 512 bytes are very often nothing but a
    // stylesheet; stripping only the tags would make the CSS the preview.
    const html = '<style>.a{color:#fff;font-size:12px}</style><p>Your order shipped</p>';
    const result = preview(html, HTML);
    expect(result).toBe('Your order shipped');
    expect(result).not.toContain('color');
  });

  it('drops an UNTERMINATED <style> block, which is what a 512-byte cut produces', () => {
    const html = '<html><head><style type="text/css">.wrapper{max-width:600px;margin:0 au';
    expect(preview(html, HTML)).toBe('');
  });

  it('drops a tag the byte cut left unterminated instead of showing half of it', () => {
    const html = '<p>Read the update</p><a href="https://example.com/very-long-tracking-ur';
    expect(preview(html, HTML)).toBe('Read the update');
  });

  it('does not re-strip text that was ENCODED as a tag', () => {
    // Entities are decoded after tags are gone, so a body literally
    // containing "<b>" survives as text.
    expect(preview('<p>Use &lt;b&gt; for bold</p>', HTML)).toBe('Use <b> for bold');
  });

  it('never resolves a named entity through Object.prototype', () => {
    // Fix round 1. `NAMED_ENTITIES[name]` on an object literal inherits
    // from Object.prototype, so `&constructor;` in an attacker-authored
    // HTML body resolved to "function Object() { [native code] }" and was
    // written into the stored, searchable snippet. Not XSS — the client
    // renders text — but attacker-controlled garbage in a column the user
    // reads.
    expect(preview('<p>&constructor; hello</p>', HTML)).toBe('&constructor; hello');
  });

  it('covers the whole prototype class, not just the one key that happened to land', () => {
    // `&toString;` and `&hasOwnProperty;` were saved before the fix only
    // because `.toLowerCase()` mangles them into keys that are not on the
    // prototype — an accident of casing, not a guard. If the regex or the
    // lowercasing ever changed they would land too, so the guard is
    // asserted against the class rather than the single instance that was
    // observably broken.
    for (const key of ['toString', 'hasOwnProperty', 'valueOf', '__proto__', 'constructor']) {
      expect(preview(`<p>&${key}; x</p>`, HTML)).toBe(`&${key}; x`);
    }
  });

  it('still decodes the real named entities it does know', () => {
    // The guard must not have been implemented by disabling the table.
    expect(preview('<p>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;&nbsp;f</p>', HTML))
      .toBe(`a & b <c> "d" 'e' f`);
  });

  it('leaves an out-of-range numeric entity as literal text instead of throwing', () => {
    // String.fromCodePoint throws above U+10FFFF, and the body is authored
    // by whoever sent the mail.
    expect(() => preview('<p>&#9999999; ok</p>', HTML)).not.toThrow();
    expect(preview('<p>&#9999999; ok</p>', HTML)).toContain('ok');
  });

  it('strips quoted text out of an HTML reply too, after the tags are gone', () => {
    const html = '<div>New content.</div><br>&gt; quoted reply line';
    expect(preview(html, HTML)).toBe('New content.');
  });

  it('does not strip tags out of a text/plain part that happens to mention them', () => {
    // The mime type decides, not a sniff: a plain-text message about HTML
    // must keep its angle brackets.
    expect(preview('Use <div> to wrap it.')).toBe('Use <div> to wrap it.');
  });
});

// ---------------------------------------------------------------------------
// Content-Transfer-Encoding
// ---------------------------------------------------------------------------

describe('previewTextFrom — transfer encodings', () => {
  it('decodes base64, which Gmail uses for most html parts', () => {
    const encoded = Buffer.from('Hello from base64').toString('base64');
    const part: TextPart = { partId: '1', mimeType: 'text/plain', encoding: 'base64' };
    expect(previewTextFrom(Buffer.from(encoded, 'ascii'), part)).toBe('Hello from base64');
  });

  it('drops the trailing partial base64 group a 512-byte cut leaves behind', () => {
    // Decoding a non-multiple of 4 invents a byte that was never sent.
    const full = Buffer.from('Quarterly numbers are attached').toString('base64');
    const part: TextPart = { partId: '1', mimeType: 'text/plain', encoding: 'base64' };
    const cut = full.slice(0, full.length - 3);
    const result = previewTextFrom(Buffer.from(cut, 'ascii'), part);
    expect('Quarterly numbers are attached').toContain(result);
    expect(result.length).toBeGreaterThan(10);
  });

  it('ignores the CRLFs base64 bodies are wrapped at', () => {
    const raw = Buffer.from('Wrapped base64 body text here');
    const wrapped = raw.toString('base64').replace(/(.{8})/g, '$1\r\n');
    const part: TextPart = { partId: '1', mimeType: 'text/plain', encoding: 'base64' };
    expect(previewTextFrom(Buffer.from(wrapped, 'ascii'), part)).toBe('Wrapped base64 body text here');
  });

  it('decodes quoted-printable multi-byte sequences as ONE character, not three', () => {
    // =E2=80=99 is a single three-byte UTF-8 curly apostrophe. Turning each
    // =XX straight into a character produces mojibake instead.
    const part: TextPart = { partId: '1', mimeType: 'text/plain', encoding: 'quoted-printable' };
    const raw = Buffer.from('It=E2=80=99s ready', 'ascii');
    expect(previewTextFrom(raw, part)).toBe('It’s ready');
  });

  it('joins quoted-printable soft line breaks', () => {
    const part: TextPart = { partId: '1', mimeType: 'text/plain', encoding: 'quoted-printable' };
    const raw = Buffer.from('This line was wrapped by the=\r\n transport agent', 'ascii');
    expect(previewTextFrom(raw, part)).toBe('This line was wrapped by the transport agent');
  });

  it('leaves 7bit/8bit/unstated bytes alone', () => {
    const part: TextPart = { partId: '1', mimeType: 'text/plain', encoding: '7bit' };
    expect(previewTextFrom(Buffer.from('Plain and unencoded'), part)).toBe('Plain and unencoded');
  });

  it('trims the replacement character a mid-sequence byte cut produces', () => {
    // Cutting a 3-byte character after 2 bytes renders as U+FFFD; a stray
    // black diamond at the end of every other preview is worse than a
    // slightly shorter one.
    const full = Buffer.from('Rendez-vous à Paris', 'utf8');
    const cut = full.subarray(0, full.length - 6);
    const result = previewTextFrom(cut, PLAIN);
    expect(result).not.toContain('�');
    expect(result.startsWith('Rendez-vous')).toBe(true);
  });
});
