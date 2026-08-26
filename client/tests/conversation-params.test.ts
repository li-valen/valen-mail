import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildConversationParams } from '../src/conversationParams';
import { MAX_QUERY_LENGTH } from '../src/searchQuery';
import { getConversationsPage } from '../src/api';

/**
 * The query string GET /api/conversations actually receives, and the one
 * way it can go silently wrong.
 *
 * That route stands in for /api/inbox AND /api/search, and those two
 * disagree about exactly one thing in the direction nothing reports: an
 * absent `folder` means INBOX to one and EVERY FOLDER to the other. A
 * request that omitted `folder` and gained a `q` would widen itself from
 * the Inbox to Spam and Trash with an ordinary 200. Most of this file is
 * about that.
 */

describe('buildConversationParams', () => {
  it('ALWAYS sends folder, default included', () => {
    // The one line between "search the Inbox" and "search the whole
    // mailbox". buildInboxParams omits the default because it is
    // redundant on its own route; inheriting that habit here is the bug.
    expect(buildConversationParams()).toBe('folder=inbox');
    expect(buildConversationParams({ folder: 'inbox' })).toBe('folder=inbox');
  });

  it('still sends folder when a query is present', () => {
    expect(buildConversationParams({ q: 'numbers', folder: 'inbox' })).toBe(
      'q=numbers&folder=inbox',
    );
  });

  it('omits q entirely when the box is empty or blank', () => {
    // The route reads a blank query as "not a search"; leaving the param
    // off says the same thing without depending on that leniency.
    expect(buildConversationParams({ q: '' })).toBe('folder=inbox');
    expect(buildConversationParams({ q: '   ' })).toBe('folder=inbox');
  });

  it('clamps an over-long query the same way the search route’s builder does', () => {
    // The server refuses an over-long q with a 400 rather than truncating
    // it, so a paste has to be narrowed here or the list shows an error
    // banner instead of results.
    const params = new URLSearchParams(buildConversationParams({ q: 'x'.repeat(400) }));
    expect(params.get('q')).toBe('x'.repeat(MAX_QUERY_LENGTH));
  });

  it('carries limit, folder, account and the whole cursor in a stable order', () => {
    expect(
      buildConversationParams({
        limit: 50,
        folder: 'sent',
        account: 'harvard',
        cursor: {
          before: '2026-08-01T00:00:00.000Z',
          beforeAccount: 'harvard',
          beforeUid: '42',
        },
      }),
    ).toBe(
      'limit=50&folder=sent&account=harvard&before=2026-08-01T00%3A00%3A00.000Z' +
        '&beforeAccount=harvard&beforeUid=42',
    );
  });

  it('never sends an empty account, which is a 400', () => {
    expect(buildConversationParams({ account: '' })).toBe('folder=inbox');
    expect(buildConversationParams({ account: null })).toBe('folder=inbox');
  });

  it('forwards a NULL-date cursor rather than dropping its two other fields', () => {
    // Rows with no Date header sort last and are addressed by a cursor
    // with no `before` at all. Dropping the pair would make them
    // permanently unreachable by paging.
    expect(
      buildConversationParams({
        cursor: { before: null, beforeAccount: 'harvard', beforeUid: '42' },
      }),
    ).toBe('folder=inbox&beforeAccount=harvard&beforeUid=42');
  });
});

describe('getConversationsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const VALID_MESSAGE = {
    account_id: 'masterman',
    uid: '11269',
    folder: 'INBOX',
    date: '2025-10-26T06:26:00.000Z',
    subject: 'annoying shyt',
  };

  it('asks the conversations route, not the inbox one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    await getConversationsPage({ limit: 50 }, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/conversations?limit=50&folder=inbox');
  });

  it('returns the same envelope getInbox does', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        messages: [VALID_MESSAGE],
        nextCursor: { before: '2025-10-01T00:00:00.000Z', beforeAccount: 'masterman', beforeUid: '9596' },
      }),
    );
    await expect(getConversationsPage({ limit: 50 }, fetchImpl)).resolves.toEqual({
      messages: [VALID_MESSAGE],
      nextCursor: {
        before: '2025-10-01T00:00:00.000Z',
        beforeAccount: 'masterman',
        beforeUid: '9596',
      },
    });
  });

  it('applies the same row validation, so a malformed member cannot reach a row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ messages: [VALID_MESSAGE, { subject: 'no identity at all' }, null] }),
    );
    await expect(getConversationsPage({ limit: 50 }, fetchImpl)).resolves.toEqual({
      messages: [VALID_MESSAGE],
      nextCursor: null,
    });
  });

  it('degrades a malformed cursor to "no next page" rather than sending it back', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ messages: [], nextCursor: { before: 7 } }),
    );
    await expect(getConversationsPage({ limit: 50 }, fetchImpl)).resolves.toEqual({
      messages: [],
      nextCursor: null,
    });
  });
});
