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

// ---------------------------------------------------------------------------
// Pre-header boilerplate
// ---------------------------------------------------------------------------

describe('previewTextFrom — pre-header boilerplate', () => {
  // Every fixture below asserts on collapsed() output. That is deliberate,
  // not laziness: what these tests are about is which WORDS survive, and
  // collapsed() is exactly the transform normalize.ts's makeSnippet()
  // applies before anything reaches a screen — asserting on it is asserting
  // on what a user actually sees, the same way the HTML-fragment tests
  // above already do.

  describe('the four real inbox failures this task exists to fix', () => {
    it('drops a trailing run of padding dots, keeping the teaser before it', () => {
      // Observed: "Wilman just messaged you — You have 6 new messages
      // ...................." The dot run is an ESP padding its OWN hidden
      // preheader past Gmail's inbox preview window; "Wilman just messaged
      // you — You have 6 new messages" is the real notification text and
      // is not chrome, so it is kept.
      const text = 'Wilman just messaged you — You have 6 new messages ' + '.'.repeat(20);
      expect(collapsed(preview(text))).toBe('Wilman just messaged you — You have 6 new messages');
    });

    it('drops a trailing "view this email in your browser" fallback link', () => {
      // Observed: "We're almost at the finish line! 🏁 — View this email
      // in your browser..."
      const text = "We're almost at the finish line! \u{1F3C1} — View this email in your browser";
      expect(collapsed(preview(text))).toBe("We're almost at the finish line! \u{1F3C1}");
    });

    it('drops a trailing tracking URL, keeping the teaser before it', () => {
      // Observed: "Catch up with the Conrad Challenge! ⏪ —
      // https://conrad.spacecenter.org/?..." — the mirror image of "a
      // leading URL followed by text": here text leads and the bare URL
      // trails, and it is exactly as much a link artifact as the other
      // order is.
      const text =
        'Catch up with the Conrad Challenge! ⏪ — ' +
        'https://conrad.spacecenter.org/subscribe?id=abc123';
      expect(collapsed(preview(text))).toBe('Catch up with the Conrad Challenge! ⏪');
    });

    it('drops a leading "view in browser" fallback link, keeping the personalized teaser', () => {
      // Observed: "Valen, have you claimed your free Double Protein? —
      // View in browser --..." The fallback link is what an ESP template
      // puts FIRST in the hidden preheader div, ahead of the marketer's
      // own custom teaser text; the personalized question is the real
      // content and survives.
      const text = 'View in browser — Valen, have you claimed your free Double Protein?';
      expect(collapsed(preview(text))).toBe('Valen, have you claimed your free Double Protein?');
    });
  });

  describe('edge-anchoring: what must NOT be touched', () => {
    it('keeps "view in browser" sitting in the middle of a real sentence', () => {
      // The task's own bar: real words on BOTH sides of the phrase, so no
      // edge-anchored rule — leading or trailing — ever reaches in this
      // far to find it.
      const text =
        "Let's hop on a call sometime — you can view in browser if that's " +
        'easier, just let me know what works for you.';
      expect(collapsed(preview(text))).toBe(text);
    });

    it('keeps a URL that IS the entire message', () => {
      const text = 'https://example.com/shared-doc/q3-plan';
      expect(preview(text)).toBe(text);
    });

    it('drops a leading URL, keeping the real text that follows it', () => {
      const text = 'https://tracking.example.com/open?id=99 Hey, just following up on Tuesday.';
      expect(collapsed(preview(text))).toBe('Hey, just following up on Tuesday.');
    });

    it('prefers the unstripped text over an empty preview when a strip would eat everything', () => {
      // The entire fetched fragment really is just the fallback link, with
      // nothing else in the first 512 bytes. A preview showing that beats
      // a blank row — the same "awkward but real beats nothing" call
      // makeSnippet already makes for whitespace, applied here to text.
      expect(preview('View in browser')).toBe('View in browser');
    });
  });

  describe('separator runs', () => {
    it('collapses a long dot-run used as a visual rule, without gluing the words on either side', () => {
      const text = `Loading${'.'.repeat(12)}please wait`;
      expect(collapsed(preview(text))).toBe('Loading please wait');
    });

    it('keeps a real ellipsis — exactly three dots — inside a sentence', () => {
      const text = 'Well... I suppose we could try that approach.';
      expect(collapsed(preview(text))).toBe(text);
    });

    it('still treats a bare "--" as the signature delimiter, unaffected by the new pass', () => {
      // "--" is 2 characters, one under the 4+ threshold the new
      // separator-run rule uses, so the two rules can never collide — this
      // pins that down with a fixture where BOTH could plausibly fire.
      // What follows the delimiter ("Unsubscribe here", prime material for
      // the new leading-boilerplate rule) is never even reached: quote and
      // signature stripping runs first and already dropped it, which is
      // also why boilerplate-stripping is placed after that step rather
      // than before it.
      expect(preview('Sale ends soon.\n--\nUnsubscribe here')).toBe('Sale ends soon.');
    });
  });

  describe('invisible padding characters', () => {
    it('strips a run of zero-width padding characters, in context', () => {
      const padding = '​‌‍⁠'.repeat(6); // 24 zero-width characters
      const text = `Your order shipped${padding}`;
      expect(collapsed(preview(text))).toBe('Your order shipped');
    });

    it('collapses to empty when the entire fragment is invisible padding', () => {
      // Alternating characters from the noise class, not one repeated —
      // the run-length rule counts any 4+ consecutive characters DRAWN
      // FROM the class, matching the alternating nbsp/zero-width trick
      // some ESPs use specifically to dodge a same-character filter.
      const padding = ' ​ ​'.repeat(8);
      expect(preview(padding)).toBe('');
    });
  });

  describe('near-variant pre-header phrases', () => {
    it('drops a trailing "having trouble viewing this email?" disclaimer', () => {
      // Also pins down that the kept sentence's OWN final period survives
      // the strip — see EDGE_GLUE_CHARS's doc comment for why "." is
      // deliberately not in the glue class.
      const text = 'Your invoice is attached. Having trouble viewing this email?';
      expect(collapsed(preview(text))).toBe('Your invoice is attached.');
    });

    it('drops a leading "Unsubscribe" / "Manage preferences" block', () => {
      const text = 'Unsubscribe — Manage preferences — Hey team, quick update on the roadmap.';
      expect(collapsed(preview(text))).toBe('Hey team, quick update on the roadmap.');
    });
  });

  describe('ReDoS: adversarial 512-byte inputs stay fast', () => {
    // Guards the measurement in the task report against a future regression
    // — not a tight bound (CI machines are noisy), just far enough above
    // observed worst case (~0.3ms) to fail only on a genuine blowup, and a
    // small enough N (512, the real PEEK fetch size) that a quadratic
    // regression would already show up here rather than needing a larger
    // adversarial input to surface.
    const ADVERSARIAL_INPUTS: readonly string[] = [
      '|'.repeat(512),
      '-'.repeat(512),
      '.'.repeat(512),
      'view '.repeat(102),
      'viewx'.repeat(102),
      'unsubscribe'.repeat(46),
      ' '.repeat(500) + 'view in browser',
      'view in browser' + ' '.repeat(500),
      'https://' + 'a'.repeat(500),
      'Unsubscribe | Manage preferences | View in browser | '.repeat(10) + 'Real content.',
    ];

    it.each(ADVERSARIAL_INPUTS)('resolves input %#  in well under 20ms', (text) => {
      const start = performance.now();
      preview(text);
      expect(performance.now() - start).toBeLessThan(20);
    });
  });
});
