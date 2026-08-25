import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import { handleMessage, type ParsedMessage } from '../src/api/message.ts';
import {
  AUTH as auth,
  TOKEN,
  makeFakeConnection,
  makeFakeDb,
  makeFakePool,
  readJson,
} from './helpers/api-fakes.ts';

/**
 * GET /api/message/{accountId}/{folder}/{uid} — the PARSED message.
 *
 * The sibling `/body` route (tests/routes-fetch.test.ts) still returns raw
 * RFC822 and is deliberately untouched; this suite covers the JSON one a
 * reader UI can actually render.
 *
 * Every case is driven from a real `.eml` under tests/fixtures/messages/,
 * fed through the same fake IMAP connection the body/attachment suites use,
 * so what is asserted is what mailparser genuinely produces from real MIME
 * bytes rather than from a hand-built object shaped to suit the assertion.
 */

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixtures', 'messages');

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, `${name}.eml`));
}

/** Router whose one connected account serves `name.eml` for every fetch. */
function routerServing(name: string, db = makeFakeDb()) {
  const { pool } = makeFakePool({
    statuses: [['acct1', 'connected']],
    connections: { acct1: makeFakeConnection({ chunks: [fixture(name)] }) },
  });
  return createRouter(db, pool, TOKEN);
}

function get(router: (r: Request) => Promise<Response>, uid = '42') {
  return router(new Request(`http://x/api/message/acct1/INBOX/${uid}`, { headers: auth }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsed message route / html + text + attachment', () => {
  it('returns the full asserted shape', async () => {
    const response = await get(routerServing('html-text-attachment'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = await readJson<ParsedMessage>(response);

    expect(body.subject).toBe('Quarterly report 📈');
    expect(body.from).toEqual({ name: 'Ada Lovelace', address: 'ada@example.com' });
    expect(body.to).toEqual([
      { name: 'Grace', address: 'grace@example.com' },
      { name: null, address: 'hopper@example.com' },
    ]);
    expect(body.cc).toEqual([{ name: 'Alan T', address: 'alan@example.com' }]);
    expect(body.date).toBe(Date.parse('2026-08-25T09:30:00Z'));
    expect(body.text).toContain('Plain text version of the report.');
    expect(body.html).toContain('<b>report</b>');

    // The attachment's partId must be the IMAP part number the EXISTING
    // /api/attachment route takes as its 4th segment. In this fixture
    // (mixed[alternative[text, html], pdf]) that part is "2".
    expect(body.attachments).toEqual([
      {
        partId: '2',
        filename: 'q3-report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: '%PDF-1.4 fake report bytes'.length,
        isInline: false,
        contentId: null,
      },
    ]);
  });

  it('does not sanitise the html — the sandboxed iframe is the boundary', async () => {
    // If a future change adds server-side sanitising, this fails loudly.
    // See src/api/message.ts's doc comment for why that would be a
    // regression rather than an improvement.
    const body = await readJson<ParsedMessage>(await get(routerServing('html-text-attachment')));
    expect(body.html).toContain('<script>');
    expect(body.html).toContain('onclick="alert(1)"');
    expect(body.html).toContain('https://tracker.example/pixel.gif');
  });

  it('returns attachment METADATA only — never the attachment bytes', async () => {
    const response = await get(routerServing('html-text-attachment'));
    const raw = await response.text();
    expect(raw).not.toContain(Buffer.from('%PDF-1.4 fake report bytes').toString('base64'));

    const body = JSON.parse(raw) as { attachments: Record<string, unknown>[] };
    for (const attachment of body.attachments) {
      expect(attachment).not.toHaveProperty('content');
    }
  });

  it('leaves cid: references alone instead of inlining the image as base64', async () => {
    // This is what `keepCidLinks: true` buys, and it is NOT cosmetic:
    // mailparser's DEFAULT rewrites every cid: image in the html into a
    // base64 `data:` URI, i.e. it copies attachment CONTENT into the html
    // this route returns. Driven from the sibling-multipart fixture
    // because it is the one carrying an actual embedded image; flipping
    // keepCidLinks off fails exactly here.
    const body = await readJson<ParsedMessage>(await get(routerServing('sibling-multipart')));
    expect(body.html).toContain('src="cid:logo@example"');
    expect(body.html).not.toContain('data:image/png;base64');
    expect(body.html).not.toContain(Buffer.from('\x89PNG fake logo').toString('base64'));
  });

  it('forbids caching the parsed message', async () => {
    const response = await get(routerServing('html-text-attachment'));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('parsed message route / bodies that are missing', () => {
  it('returns html null for a text-only message', async () => {
    const body = await readJson<ParsedMessage>(await get(routerServing('text-only')));
    expect(body.html).toBeNull();
    expect(body.text).toContain('No HTML here at all.');
    expect(body.attachments).toEqual([]);
  });

  it('returns both bodies null for an attachment-only message, still listing the attachment', async () => {
    const body = await readJson<ParsedMessage>(await get(routerServing('attachment-only')));
    expect(body.html).toBeNull();
    expect(body.text).toBeNull();
    expect(body.attachments).toEqual([
      {
        partId: '1',
        filename: 'scan-0042.png',
        mimeType: 'image/png',
        sizeBytes: Buffer.from('\x89PNG fake scan bytes').length,
        isInline: false,
        contentId: null,
      },
    ]);
  });
});

describe('parsed message route / hostile and malformed MIME', () => {
  it('salvages a truncated, mislabelled multipart into a well-formed response', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await get(routerServing('malformed'));

    // mailparser is salvage-oriented and does NOT throw on this fixture:
    // an unclosed boundary, an invented charset and a part that declares
    // base64 while carrying characters that are not. Recovering what it can
    // is the right behaviour for a mail client, so the contract here is
    // that the route stays well-formed on top of it — the 502 path is
    // covered by the injected-failure test below. A future mailparser that
    // starts throwing here fails this line, which is worth knowing.
    expect(response.status).toBe(200);
    const body = await readJson<ParsedMessage>(response);
    expect(body.html).toBeNull();
    expect(body.text).toBe('SENTINEL-BODY-DO-NOT-LOG');
    expect(body.date).toBeNull();
    expect(body.attachments).toEqual([
      {
        partId: '2',
        filename: 'half.pdf',
        mimeType: 'application/pdf',
        sizeBytes: expect.any(Number),
        isInline: false,
        contentId: null,
      },
    ]);

    // The SAME string that legitimately reaches the client must never reach
    // the log.
    for (const call of errors.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SENTINEL-BODY-DO-NOT-LOG');
    }
  });

  it('502s with a fixed string when the parser itself throws, logging no message content', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: makeFakeConnection({ chunks: [fixture('malformed')] }) },
    });

    const response = await handleMessage(makeFakeDb(), pool, 'acct1', 'INBOX', '42', {
      parseImpl: async () => {
        throw new Error('boom: SENTINEL-BODY-DO-NOT-LOG leaked into the error');
      },
    });

    expect(response.status).toBe(502);
    expect(await readJson<{ error: string }>(response)).toEqual({
      error: 'failed to parse message',
    });

    expect(errors).toHaveBeenCalled();
    for (const call of errors.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SENTINEL-BODY-DO-NOT-LOG');
    }
  });

  it('502s when the IMAP fetch itself fails, same as the raw body route', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: {
        acct1: makeFakeConnection({ downloadError: new Error('connection reset') }),
      },
    });
    const response = await get(createRouter(makeFakeDb(), pool, TOKEN));
    expect(response.status).toBe(502);
  });
});

describe('parsed message route / partId agreement with the attachment route', () => {
  /**
   * mailparser reconstructs `partId` from boundary ordering, which is only
   * equal to the IMAP part number while the MIME tree descends through one
   * multipart at a time. This fixture has TWO multiparts as siblings under
   * one parent — mailparser numbers the inline image "2.2.2" where IMAP
   * calls it "2.2" — so the route corrects against the BODYSTRUCTURE-derived
   * part numbers already stored in the attachments table.
   */
  const bodyStructureRows = [{ part_id: '2.2', filename: 'logo.png' }];

  it('corrects a diverging partId to the stored BODYSTRUCTURE part number', async () => {
    const db = makeFakeDb({ query: async () => bodyStructureRows });
    const body = await readJson<ParsedMessage>(await get(routerServing('sibling-multipart', db)));

    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.partId).toBe('2.2');
    expect(body.attachments[0]?.isInline).toBe(true);
    expect(body.attachments[0]?.contentId).toBe('logo@example');
  });

  it('keeps the parsed partId when the stored rows already agree', async () => {
    const db = makeFakeDb({ query: async () => [{ part_id: '2', filename: 'q3-report.pdf' }] });
    const body = await readJson<ParsedMessage>(
      await get(routerServing('html-text-attachment', db)),
    );
    expect(body.attachments[0]?.partId).toBe('2');
  });

  it('falls back to the parsed partId when no metadata row exists', async () => {
    // Attachment metadata predates the row, or was never recorded — the
    // same tolerance lookupAttachmentMeta already has in routes.ts.
    const body = await readJson<ParsedMessage>(await get(routerServing('sibling-multipart')));
    expect(body.attachments[0]?.partId).toBe('2.2.2');
  });

  it('reports an empty partId, not a guessed one, for a message that IS one attachment', async () => {
    // No multipart wrapper means no MIME boundary, and mailparser derives
    // its part number from the boundary — so there is nothing to derive.
    // The contract is an honest '' (see ParsedAttachment.partId), never a
    // plausible-looking "1" that would download the wrong bytes.
    const body = await readJson<ParsedMessage>(await get(routerServing('bare-attachment')));
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.partId).toBe('');
    expect(body.attachments[0]?.filename).toBe('bare.pdf');
  });

  it('recovers that empty partId from the stored BODYSTRUCTURE row when there is one', async () => {
    const db = makeFakeDb({ query: async () => [{ part_id: '1', filename: 'bare.pdf' }] });
    const body = await readJson<ParsedMessage>(await get(routerServing('bare-attachment', db)));
    expect(body.attachments[0]?.partId).toBe('1');
  });

  it('leaves an ambiguous duplicate filename alone rather than guessing between rows', async () => {
    const db = makeFakeDb({
      query: async () => [
        { part_id: '1', filename: 'bare.pdf' },
        { part_id: '3', filename: 'bare.pdf' },
      ],
    });
    const body = await readJson<ParsedMessage>(await get(routerServing('bare-attachment', db)));
    expect(body.attachments[0]?.partId).toBe('');
  });

  it('queries the attachments table with placeholders, never string-built SQL', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const db = makeFakeDb({
      query: async (text: string, values: readonly unknown[]) => {
        calls.push({ text, values });
        return bodyStructureRows;
      },
    });
    await get(routerServing('sibling-multipart', db), '77');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).not.toContain('acct1');
    expect(calls[0]!.values).toEqual(['acct1', 'INBOX', 77]);
  });

  it('does not touch the database at all when the message has no attachments', async () => {
    const query = vi.fn(async () => []);
    const body = await readJson<ParsedMessage>(
      await get(routerServing('text-only', makeFakeDb({ query }))),
    );
    expect(body.attachments).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('parsed message route / gate and validation', () => {
  it('401s without a credential', async () => {
    const router = routerServing('text-only');
    const response = await router(new Request('http://x/api/message/acct1/INBOX/42'));
    expect(response.status).toBe(401);
  });

  it.each(['notanumber', '-1', '0', '1.5'])('400s the invalid uid %s', async (uid) => {
    const response = await get(routerServing('text-only'), uid);
    expect(response.status).toBe(400);
    expect(await readJson<{ error: string }>(response)).toEqual({ error: 'invalid uid' });
  });

  it('404s an unknown account, exactly as the raw body route does', async () => {
    const router = routerServing('text-only');
    const response = await router(
      new Request('http://x/api/message/ghost/INBOX/1', { headers: auth }),
    );
    expect(response.status).toBe(404);
  });

  it('503s when the account is known but not connected', async () => {
    const { pool } = makeFakePool({
      statuses: [['acct1', 'reconnecting']],
      connections: { acct1: makeFakeConnection({ chunks: [fixture('text-only')] }) },
    });
    const response = await get(createRouter(makeFakeDb(), pool, TOKEN));
    expect(response.status).toBe(503);
  });

  it('leaves the raw /body route serving RFC822, not JSON', async () => {
    const router = routerServing('text-only');
    const response = await router(
      new Request('http://x/api/message/acct1/INBOX/42/body', { headers: auth }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('message/rfc822');
  });

  it('charges the byte budget and holds the account lock, same as every other fetch', async () => {
    const { pool, lockKeys, recorded } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: makeFakeConnection({ chunks: [fixture('text-only')] }) },
    });
    const response = await get(createRouter(makeFakeDb(), pool, TOKEN));
    expect(response.status).toBe(200);
    expect(lockKeys).toEqual(['acct1']);
    expect(recorded[0]?.bytes).toBe(fixture('text-only').length);
  });

  it('429s when the daily byte budget is exhausted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: { acct1: makeFakeConnection({ chunks: [fixture('text-only')] }) },
      budgetAllowed: false,
    });
    const response = await get(createRouter(makeFakeDb(), pool, TOKEN));
    expect(response.status).toBe(429);
  });
});
