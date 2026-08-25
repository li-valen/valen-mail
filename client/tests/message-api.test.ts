import { describe, expect, it, vi } from 'vitest';
import { ApiError, getMessage, getThread } from '../src/api';

/**
 * The two endpoints the reader adds to src/api.ts, held to the same
 * boundary discipline as getInbox/getOpens: the path shape has to match
 * what sync/src/api/routes.ts matches, a non-2xx has to surface as an
 * ApiError so the reader can name what went wrong, and a malformed 200
 * must degrade field-wise instead of blanking a message the user asked
 * for.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getMessage', () => {
  it('requests /api/message/{accountId}/{folder}/{uid} — no /body suffix', () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ html: null, text: null }));
    void getMessage('primary', 'INBOX', '33097', fetchImpl);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/message/primary/INBOX/33097');
  });

  it('encodes a folder containing a slash so it stays one path segment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ html: null, text: null }));
    await getMessage('primary', '[Gmail]/Sent Mail', '12', fetchImpl);
    const path = String(fetchImpl.mock.calls[0]?.[0]);
    expect(path).toBe('/api/message/primary/%5BGmail%5D%2FSent%20Mail/12');
    // Three segments after /api/message, matching the server's pattern.
    expect(path.replace('/api/message/', '').split('/')).toHaveLength(3);
  });

  it('sends no bearer token and rides the same-origin session cookie', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ html: null, text: null }));
    await getMessage('primary', 'INBOX', '1', fetchImpl);
    const init = fetchImpl.mock.calls[0]?.[1] ?? {};
    expect(new Headers(init.headers ?? {}).get('authorization')).toBeNull();
    expect(init.credentials).toBe('same-origin');
  });

  it('throws ApiError carrying the status on a non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 502 }));
    await expect(getMessage('primary', 'INBOX', '1', fetchImpl)).rejects.toBeInstanceOf(ApiError);
    await expect(getMessage('primary', 'INBOX', '1', fetchImpl)).rejects.toMatchObject({ status: 502 });
  });

  it('keeps the html byte for byte — this client never sanitises either', async () => {
    const html = '<p>hi</p><script>alert(1)</script>';
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ html, text: null, attachments: [] }));
    const parsed = await getMessage('primary', 'INBOX', '1', fetchImpl);
    expect(parsed.html).toBe(html);
  });

  it('normalises the parsed shape, addresses and attachments included', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        html: '<p>hi</p>',
        text: 'hi',
        subject: 'Re: lunch',
        from: { name: 'Ada', address: 'ada@example.com' },
        to: [{ name: null, address: 'you@example.com' }],
        cc: [],
        date: 1756042320000,
        attachments: [
          { partId: '2', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1024, isInline: false, contentId: null },
        ],
      }),
    );
    const parsed = await getMessage('primary', 'INBOX', '1', fetchImpl);
    expect(parsed.from).toEqual({ name: 'Ada', address: 'ada@example.com' });
    expect(parsed.to).toEqual([{ name: null, address: 'you@example.com' }]);
    expect(parsed.date).toBe(1756042320000);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.sizeBytes).toBe(1024);
  });

  it('drops an address with no usable mailbox rather than rendering a blank recipient', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ html: null, text: 'x', to: [{ name: 'Nobody', address: '' }, { address: 'real@example.com' }] }),
    );
    const parsed = await getMessage('primary', 'INBOX', '1', fetchImpl);
    expect(parsed.to).toEqual([{ name: null, address: 'real@example.com' }]);
  });

  it('turns a missing or non-string partId into the "not addressable" sentinel', async () => {
    // Never `undefined` interpolated into a URL: '' is what
    // isDownloadable refuses, which is the honest outcome for a part the
    // server could not number.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ html: null, text: 'x', attachments: [{ filename: 'a.pdf' }, { partId: 7 }] }),
    );
    const parsed = await getMessage('primary', 'INBOX', '1', fetchImpl);
    expect(parsed.attachments.map((attachment) => attachment.partId)).toEqual(['', '']);
    expect(parsed.attachments[0]?.mimeType).toBe('application/octet-stream');
    expect(parsed.attachments[0]?.sizeBytes).toBeNull();
  });

  it('degrades a wrong-typed field to absence instead of refusing the whole message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ html: '<p>body</p>', text: 42, subject: {}, cc: 'nope', date: 'yesterday' }),
    );
    const parsed = await getMessage('primary', 'INBOX', '1', fetchImpl);
    expect(parsed.html).toBe('<p>body</p>');
    expect(parsed.text).toBeNull();
    expect(parsed.subject).toBeNull();
    expect(parsed.cc).toEqual([]);
    expect(parsed.date).toBeNull();
  });

  it('answers an empty message, not a rejection, when the body is not an object at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('not a message'));
    const parsed = await getMessage('primary', 'INBOX', '1', fetchImpl);
    expect(parsed.html).toBeNull();
    expect(parsed.text).toBeNull();
    expect(parsed.attachments).toEqual([]);
  });
});

describe('getThread', () => {
  const ROW = {
    account_id: 'primary',
    uid: '33098',
    folder: 'INBOX',
    date: '2026-08-24T10:00:00Z',
  };

  it('requests /api/thread/{threadId}, encoded', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    await getThread('a/b c', fetchImpl);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/thread/a%2Fb%20c');
  });

  it('returns the rows, which carry the same shape as an inbox row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ messages: [ROW] }));
    const messages = await getThread('t1', fetchImpl);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.uid).toBe('33098');
  });

  it('drops a row missing the identity every reader URL is built from', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ messages: [ROW, { uid: '1' }, { account_id: 'x', uid: '2' }] }),
    );
    expect(await getThread('t1', fetchImpl)).toHaveLength(1);
  });

  it('reads an unknown thread id as no context, never as an error', async () => {
    // The server answers 200 with an empty array for both an unknown and
    // an empty thread, on purpose (it refuses to leak which ids exist).
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    expect(await getThread('nope', fetchImpl)).toEqual([]);
  });

  it('throws ApiError on a non-2xx so the caller can decide to stay quiet', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(getThread('t1', fetchImpl)).rejects.toBeInstanceOf(ApiError);
  });
});
