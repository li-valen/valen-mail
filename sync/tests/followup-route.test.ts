import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/api/routes';
import type { AccountConfig, TrackingConfig } from '../src/config';
import type { FollowupPage } from '../src/followup/query';
import { AUTH as auth, TOKEN, makeFakeDb, makeFakePool, readJson } from './helpers/api-fakes.ts';

/**
 * GET /api/followup (Plan 10 Task 2) — the HTTP contract only.
 *
 * The decisions behind it (what counts as a reply, which opens count,
 * angle-bracket normalisation, the engagement states) are proven in
 * tests/followup-query.test.ts and tests/followup-classify.test.ts. What
 * THIS suite proves is that the route exists behind the auth gate, that
 * it resolves Sent per account rather than guessing a folder name, that
 * the user's own addresses actually reach the query, and that a tracking
 * outage degrades to an honest 200 rather than an error.
 *
 * Nothing here opens a socket or touches Postgres.
 */

const ACCOUNTS: readonly AccountConfig[] = [
  { id: 'harvard', email: 'me@example.com', appPassword: 'x'.repeat(16), isPrimary: true },
  { id: 'personal', email: 'other@example.com', appPassword: 'y'.repeat(16), isPrimary: false },
];

const TRACKING: TrackingConfig = { baseUrl: 'https://tracking.invalid', readToken: 'z'.repeat(32) };

const DISCOVERED = {
  harvard: { inbox: 'INBOX', sent: '[Gmail]/Sent Mail', spam: null, trash: null },
  personal: { inbox: 'INBOX', sent: 'Sent Items', spam: null, trash: null },
};

interface SeenQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function routerWith(
  options: {
    rows?: readonly Record<string, unknown>[];
    tracking?: TrackingConfig | null;
    opensBody?: unknown;
    opensStatus?: number;
  } = {},
) {
  const seen: SeenQuery[] = [];
  const fetchCalls: string[] = [];

  const db = makeFakeDb({
    query: async (text: string, values: readonly unknown[]) => {
      seen.push({ text, values });
      return [...(options.rows ?? [])];
    },
  });
  const pool = makeFakePool({ discoveredFolders: DISCOVERED as never }).pool;

  const fetchImpl = (async (input: unknown) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify(options.opensBody ?? { opens: [] }), {
      status: options.opensStatus ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const router = createRouter(
    db,
    pool,
    TOKEN,
    options.tracking === undefined ? TRACKING : options.tracking,
    fetchImpl,
    null,
    undefined,
    ACCOUNTS,
  );
  return { router, seen, fetchCalls };
}

function sentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: 'harvard',
    uid: '7',
    folder: '[Gmail]/Sent Mail',
    message_id: '<abc@x.com>',
    subject: 'Q3 numbers',
    to_emails: ['ada@x.com'],
    cc_emails: [],
    date: new Date('2026-08-01T10:00:00Z'),
    later_senders: [],
    ...overrides,
  };
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: auth });
}

describe('GET /api/followup', () => {
  it('refuses an unauthenticated request', async () => {
    const { router } = routerWith();
    const response = await router(new Request('http://localhost/api/followup'));
    expect(response.status).toBe(401);
  });

  it('answers 200 with rows, a cursor field and the evidence flag', async () => {
    const { router } = routerWith({ rows: [sentRow()] });
    const response = await router(get('/api/followup'));
    expect(response.status).toBe(200);
    const body = await readJson<FollowupPage>(response);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.subject).toBe('Q3 numbers');
    expect(body.nextCursor).toBeNull();
    expect(body.opensAvailable).toBe(true);
  });

  it('never caches a page of the user\'s own sent mail', async () => {
    const { router } = routerWith({ rows: [sentRow()] });
    const response = await router(get('/api/followup'));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects an account id that is not configured', async () => {
    const { router } = routerWith();
    const response = await router(get('/api/followup?account=nope'));
    expect(response.status).toBe(400);
  });

  it('resolves each account\'s own discovered Sent folder rather than guessing', async () => {
    const { router, seen } = routerWith();
    await router(get('/api/followup'));
    const values = JSON.stringify(seen[0]?.values);
    expect(values).toContain('[Gmail]/Sent Mail');
    expect(values).toContain('Sent Items');
  });

  it('narrows to one account\'s Sent folder when asked', async () => {
    const { router, seen } = routerWith();
    await router(get('/api/followup?account=personal'));
    const values = JSON.stringify(seen[0]?.values);
    expect(values).toContain('Sent Items');
    expect(values).not.toContain('[Gmail]/Sent Mail');
  });

  it('threads the configured addresses through, so my own follow-up is not a reply', async () => {
    const { router } = routerWith({ rows: [sentRow({ later_senders: ['me@example.com'] })] });
    const body = await readJson<FollowupPage>(await router(get('/api/followup')));
    expect(body.rows[0]?.hasReply).toBe(false);
  });

  it('counts a reply from anyone who is not one of my accounts', async () => {
    const { router } = routerWith({ rows: [sentRow({ later_senders: ['ada@x.com'] })] });
    const body = await readJson<FollowupPage>(await router(get('/api/followup')));
    expect(body.rows[0]?.hasReply).toBe(true);
  });

  it('bounds the page and honours an explicit limit', async () => {
    const { router, seen } = routerWith();
    await router(get('/api/followup?limit=10'));
    expect(seen[0]?.text).toMatch(/limit \$\d+/);
    expect(seen[0]?.values).toContain(10);
  });

  it('asks the tracking service for opens exactly once per request', async () => {
    const { router, fetchCalls } = routerWith({ rows: [sentRow(), sentRow({ uid: '8' })] });
    await router(get('/api/followup'));
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain('/api/opens');
  });

  it('still answers 200 when the tracking service errors, with every row unknown', async () => {
    const { router } = routerWith({ rows: [sentRow()], opensStatus: 503 });
    const response = await router(get('/api/followup'));
    expect(response.status).toBe(200);
    const body = await readJson<FollowupPage>(response);
    expect(body.opensAvailable).toBe(false);
    expect(body.rows[0]?.state).toBe('unverifiable');
  });

  it('makes no network call at all when tracking was never configured', async () => {
    const { router, fetchCalls } = routerWith({ rows: [sentRow()], tracking: null });
    const body = await readJson<FollowupPage>(await router(get('/api/followup')));
    expect(fetchCalls).toHaveLength(0);
    expect(body.opensAvailable).toBe(false);
  });

  it('folds a confirmed open into the row it belongs to', async () => {
    const { router } = routerWith({
      rows: [sentRow()],
      opensBody: {
        opens: [
          {
            token: 't1',
            accountId: 'harvard',
            messageId: 'abc@x.com',
            recipientEmail: 'ada@x.com',
            subject: 'Q3 numbers',
            sentAt: 1,
            occurredAt: 2,
            classification: 'open',
            deviceClass: 'unknown',
            os: null,
          },
        ],
      },
    });
    const body = await readJson<FollowupPage>(await router(get('/api/followup')));
    expect(body.rows[0]?.openCount).toBe(1);
    expect(body.rows[0]?.state).toBe('opened-no-reply');
  });

  it('never puts device attribution on the wire', async () => {
    const { router } = routerWith({ rows: [sentRow()] });
    const response = await router(get('/api/followup'));
    const text = await response.text();
    expect(text).not.toContain('device');
    expect(text).not.toContain('unknown');
  });
});
