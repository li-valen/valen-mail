import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import nodemailer from 'nodemailer';
import { sendTracked } from '../src/send/send';

/**
 * THE ONE THING A FAKE TRANSPORT CANNOT TELL YOU: what actually goes onto
 * the wire.
 *
 * Every other test of this module injects a fake transport and asserts on
 * the `SendMailOptions` handed to it. That is the right shape for testing
 * OUR decisions — which headers, which recipients, which token — but it
 * stops exactly where nodemailer begins, so the MIME assembly, the
 * transfer encodings and SMTP's own dot-stuffing were all unverified. The
 * gap was real enough that "send one message with an attachment" sat on a
 * human's to-do list as the last unproven path in the product.
 *
 * It does not need a human, and it does not need a real mailbox: a socket
 * that speaks enough SMTP to reach `DATA` records the bytes exactly as
 * Gmail would receive them. Nothing leaves the host.
 *
 * WHAT THIS DOES NOT COVER, stated so nobody reads it as more than it is:
 * delivery. Gmail's acceptance, its rate limits, and how it files the copy
 * into Sent are all beyond a sink. What is covered is everything between
 * `sendTracked` and the far end of the socket.
 */

/** Bytes chosen to break a naive encoder rather than to look like a file:
 *  a NUL, a full 8-bit sweep, and — the important one — a literal
 *  `CRLF.CRLF`, which is SMTP's end-of-DATA marker. An implementation that
 *  fails to dot-stuff truncates the message there, and the attachment
 *  arrives silently short. */
const HOSTILE_PAYLOAD = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ...Array.from({ length: 512 }, (_, i) => i % 256),
  0x0d, 0x0a, 0x2e, 0x0d, 0x0a,
  0xff, 0xfe, 0x00, 0x80,
]);

interface Sink {
  readonly port: number;
  readonly server: Server;
  received(): Buffer;
}

/** Speaks the minimum SMTP nodemailer needs, on an ephemeral port so two
 *  test files can never collide over one. */
async function startSink(): Promise<Sink> {
  let captured = Buffer.alloc(0);
  const server = createServer((sock) => {
    let inData = false;
    let data = Buffer.alloc(0);
    let buf = '';
    sock.write('220 sink.local ESMTP ready\r\n');
    sock.on('error', () => {});
    sock.on('data', (chunk: Buffer) => {
      if (inData) {
        data = Buffer.concat([data, chunk]);
        const end = data.toString('latin1').indexOf('\r\n.\r\n');
        if (end !== -1) {
          captured = data.subarray(0, end);
          inData = false;
          data = Buffer.alloc(0);
          sock.write('250 2.0.0 Ok: queued\r\n');
        }
        return;
      }
      buf += chunk.toString('latin1');
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO') sock.write('250-sink.local\r\n250-8BITMIME\r\n250 SIZE 52428800\r\n');
        else if (verb === 'DATA') { inData = true; sock.write('354 Go ahead\r\n'); break; }
        else if (verb === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
        else sock.write('250 2.0.0 Ok\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('sink has no port');
  return { port: address.port, server, received: () => captured };
}

const sink = await startSink();
afterAll(() => { sink.server.close(); });

const transport = nodemailer.createTransport({
  host: '127.0.0.1', port: sink.port, secure: false, ignoreTLS: true,
});

const results = await sendTracked({ transport: transport as never }, {
  accountId: 'primary',
  fromName: 'Valen',
  fromEmail: 'valen@example.com',
  to: ['recipient@example.com'],
  cc: [],
  subject: 'Attachment wire check',
  textBody: 'Body text.',
  messageId: '<probe-1@example.com>',
  attachments: [
    { filename: 'payload.bin', contentType: 'application/octet-stream', content: HOSTILE_PAYLOAD },
  ],
  pixelBase: 'https://track.example',
  recipients: [{ recipientEmail: 'recipient@example.com', token: 'tok-abc' }],
});

const wire = sink.received().toString('latin1');

/** Undoes quoted-printable's soft line breaks. Needed because QP wraps at
 *  76 columns and WILL split a URL mid-domain — a plain substring search
 *  for the pixel host reports it missing when it is plainly there, which
 *  is a false negative this file should not hand anyone. */
function unfoldQuotedPrintable(text: string): string {
  return text.replace(/=\r\n/g, '');
}

// A reply, sent through the same real path, to prove the threading headers
// survive to the socket. The user asked for this in so many words — "Reply
// feature should be sent in the same email chain" — and a reply that lands
// as a new thread in the recipient's client looks completely normal from
// our side, which is exactly why it needs a wire assertion rather than a
// unit test on the options object.
const ROOT_ID = '<root-abc@example.com>';
const PARENT_ID = '<parent-def@example.com>';

const replySink = await startSink();
afterAll(() => { replySink.server.close(); });

const replyTransport = nodemailer.createTransport({
  host: '127.0.0.1', port: replySink.port, secure: false, ignoreTLS: true,
});

const replyResults = await sendTracked({ transport: replyTransport as never }, {
  accountId: 'primary',
  fromName: 'Valen',
  fromEmail: 'valen@example.com',
  to: ['recipient@example.com'],
  cc: [],
  subject: 'Re: the original',
  textBody: 'Replying.',
  messageId: '<reply-1@example.com>',
  inReplyTo: PARENT_ID,
  references: [ROOT_ID, PARENT_ID],
  pixelBase: 'https://track.example',
  recipients: [{ recipientEmail: 'recipient@example.com', token: 'tok-reply' }],
});

const replyWire = replySink.received().toString('latin1');

describe('a reply, so it lands in the chain it answers', () => {
  it('sends at all', () => {
    expect(replyResults).toEqual([{ recipientEmail: 'recipient@example.com', ok: true }]);
    expect(replySink.received().length).toBeGreaterThan(0);
  });

  it('emits In-Reply-To pointing at the parent', () => {
    expect(replyWire).toMatch(/^In-Reply-To: <parent-def@example\.com>$/m);
  });

  /**
   * WHAT THIS FILE DOES **NOT** GUARD, established by mutation rather than
   * by reading the code, and recorded because the codebase says otherwise.
   *
   * client/src/api.ts warns that the angle brackets are load-bearing and
   * that trimming them yields "a reply that sends, looks perfectly normal,
   * and lands as a brand-new thread". On THIS path that is not what
   * happens: nodemailer normalises the value. Stripping the brackets in
   * `sendTracked` and re-running the send put
   * `In-Reply-To: <parent-def@example.com>` on the wire anyway, brackets
   * restored, and every assertion above stayed green.
   *
   * So a bracket-stripping bug between the composer and the socket is
   * survivable, and no test here can fail on it — which is worth knowing
   * before someone adds one believing it does. Where the warning may still
   * bite is Valen Mail's OWN threading: `message_id` is stored and matched
   * with its brackets, so a value trimmed before it reaches the database
   * would fail to match its parent in the conversation view. That is a
   * different module and a different test's job.
   */
  it('threads on identity, which is the part that can actually break', () => {
    // The mutations that DO turn this file red: In-Reply-To dropped,
    // References truncated to the parent, References reversed.
    expect(replyWire).toContain(PARENT_ID);
    expect(replyWire).toContain(ROOT_ID);
  });

  it('emits the whole References chain, oldest first, space-joined', () => {
    // Gmail threads on References, not on subject. Dropping the root and
    // keeping only the parent still threads in some clients and not others,
    // so the ORDER and the completeness are both asserted.
    const line = /^References:[\s\S]*?(?=\r\n[A-Za-z-]+:)/m.exec(replyWire)?.[0] ?? '';
    const unfolded = line.replace(/\r\n\s+/g, ' ');
    expect(unfolded).toBe(`References: ${ROOT_ID} ${PARENT_ID}`);
  });

  it('still carries its own Message-ID, distinct from the ones it references', () => {
    // A reply that reuses the parent's id collapses the two into one node.
    expect(replyWire).toMatch(/^Message-ID: <reply-1@example\.com>$/m);
  });
});

describe('what sendTracked actually puts on the wire, with an attachment', () => {
  it('completes the SMTP transaction rather than reporting a send nobody received', () => {
    expect(results).toEqual([{ recipientEmail: 'recipient@example.com', ok: true }]);
    expect(sink.received().length).toBeGreaterThan(0);
  });

  it('wraps the body and the file in multipart/mixed, body first', () => {
    expect(wire).toMatch(/Content-Type: multipart\/mixed; boundary=/);
    // The readable message is an alternative pair INSIDE the mixed part, so
    // a client that cannot render html still shows the text.
    expect(wire).toMatch(/Content-Type: multipart\/alternative/);
    expect(wire.indexOf('multipart/alternative')).toBeLessThan(wire.indexOf('payload.bin'));
  });

  it('sends the file as base64 with its name and an attachment disposition', () => {
    expect(wire).toMatch(/Content-Type: application\/octet-stream; name=payload\.bin/);
    expect(wire).toMatch(/Content-Disposition: attachment; filename=payload\.bin/);
    expect(wire).toMatch(/Content-Transfer-Encoding: base64/);
  });

  it('delivers the file BYTE FOR BYTE, dot-stuffing and all', () => {
    // The assertion the whole file exists for. The payload contains a
    // literal CRLF.CRLF; if that reached the socket unstuffed, the capture
    // above would have ended early and this comparison would come up short.
    const boundary = /boundary="?([^"\r\n;]+)"?/.exec(wire)?.[1];
    expect(boundary).toBeDefined();
    const headerEnd = wire.indexOf('\r\n\r\n', wire.indexOf('payload.bin'));
    const partEnd = wire.indexOf(`--${boundary}`, headerEnd);
    const decoded = Buffer.from(wire.slice(headerEnd + 4, partEnd).trim(), 'base64');

    expect(decoded.length).toBe(HOSTILE_PAYLOAD.length);
    expect(decoded.equals(HOSTILE_PAYLOAD)).toBe(true);
  });

  it('still carries this recipient’s tracking pixel', () => {
    // Unfolded first: QP splits `https://track.example/...` across a line
    // and a raw search would report the pixel missing.
    expect(unfoldQuotedPrintable(wire)).toContain('https://track.example/o/tok-abc.png');
  });

  it('emits the Message-ID it was given, verbatim and with its brackets', () => {
    expect(wire).toMatch(/^Message-ID: <probe-1@example\.com>$/m);
  });
});
