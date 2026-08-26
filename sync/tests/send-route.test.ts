import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import {
  handleSend,
  MAX_IDENTITY_ID_CHARS,
  MAX_RECIPIENT_CHARS,
  MAX_RECIPIENTS,
  MAX_FROM_LABEL_CHARS,
  MAX_MESSAGE_ID_CHARS,
  MAX_QUOTE_BODY_BYTES,
  MAX_REFERENCES,
  MAX_SEND_REQUEST_BODY_BYTES,
  MAX_SUBJECT_CHARS,
  MAX_TEXT_BODY_BYTES,
  SEND_RATE_LIMIT_MAX_ATTEMPTS,
  SEND_RATE_LIMIT_WINDOW_MS,
} from '../src/api/send.ts';
import type { SendRouteDeps } from '../src/api/send';
import { createRouter } from '../src/api/routes.ts';
import {
  createRouterFromConfig,
  requestBodyLimit,
  toWebRequest,
  MAX_REQUEST_BODY_BYTES,
} from '../src/api/server.ts';
import { createFixedWindowLimiter } from '../src/api/rate-limit.ts';
import { createTransports } from '../src/send/transports.ts';
import type { Transports } from '../src/send/transports';
import type { AccountConfig, SyncConfig, TrackingConfig } from '../src/config';
import type { SendMailOptions, SentMessageInfo, Transport } from 'nodemailer';
import { makeFakeDb, makeFakePool, readJson, TOKEN, AUTH } from './helpers/api-fakes.ts';

/**
 * Plan 4 Task 3 — POST /api/send.
 *
 * NO live SMTP and NO live tracking call: every test injects both a fake
 * `fetch` (the token mint) and a fake nodemailer transport. The four
 * accounts this service sends from are real Gmail accounts.
 */

const ACCOUNT_PRIMARY: AccountConfig = {
  id: 'primary',
  email: 'primary@example.com',
  appPassword: 'p'.repeat(16),
  isPrimary: true,
};
const ACCOUNT_SECOND: AccountConfig = {
  id: 'second',
  email: 'second@example.com',
  appPassword: 's'.repeat(16),
  isPrimary: false,
};
const ACCOUNTS = [ACCOUNT_PRIMARY, ACCOUNT_SECOND];

const TRACKING: TrackingConfig = {
  baseUrl: 'https://track.example',
  readToken: 'k'.repeat(32),
};

interface SendBody {
  readonly results?: readonly { readonly recipientEmail: string; readonly ok: boolean }[];
  readonly error?: string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A mint stub that hands back one sequential token per requested send,
 *  echoing recipients in order — the contract tracking's route follows. */
function makeMintFetch() {
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const parsed = JSON.parse(init?.body ?? '{}') as {
      sends: { recipientEmail: string }[];
    };
    bodies.push(parsed);
    return new Response(
      JSON.stringify({
        tokens: parsed.sends.map((send, index) => ({
          token: `${index}`.padStart(32, 'f'),
          recipientEmail: send.recipientEmail,
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies, spy: fetchImpl };
}

/** A `Transports` whose transports are fakes — never nodemailer's real
 *  createTransport (see ../src/send/transports.ts's doc comment). */
function makeFakeTransports(options: { failFor?: string; throwOnSend?: boolean } = {}) {
  const calls: SendMailOptions[] = [];
  const transports = createTransports(ACCOUNTS, () => {
    const transport = {
      async sendMail(mail: SendMailOptions): Promise<SentMessageInfo> {
        calls.push(mail);
        if (options.throwOnSend) throw new Error('smtp down');
        const rejected = options.failFor && mail.envelope.to.includes(options.failFor)
          ? [...mail.envelope.to]
          : [];
        return {
          accepted: rejected.length > 0 ? [] : [...mail.envelope.to],
          rejected,
          response: '250 OK',
          envelope: { from: mail.envelope.from, to: [...mail.envelope.to] },
          messageId: mail.messageId,
        };
      },
      close(): void {},
    } satisfies Transport;
    return transport;
  });
  return { transports, calls };
}

function makeDeps(overrides: Partial<SendRouteDeps> = {}): SendRouteDeps {
  return {
    accounts: ACCOUNTS,
    transports: makeFakeTransports().transports,
    trackingConfig: TRACKING,
    limiter: createFixedWindowLimiter(SEND_RATE_LIMIT_MAX_ATTEMPTS, SEND_RATE_LIMIT_WINDOW_MS),
    nowMs: 1_000_000,
    fetchImpl: makeMintFetch().fetchImpl,
    ...overrides,
  };
}

function sendRequest(body: unknown): Request {
  return new Request('https://sync.example/api/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    identityId: 'primary',
    to: ['one@example.com'],
    cc: [],
    subject: 'Hello',
    textBody: 'body text',
    ...overrides,
  };
}

describe('POST /api/send — happy path', () => {
  it('answers 200 with one result per recipient, to and cc alike', async () => {
    const response = await handleSend(
      sendRequest(validBody({ to: ['one@example.com', 'two@example.com'], cc: ['three@example.com'] })),
      makeDeps(),
    );

    expect(response.status).toBe(200);
    expect(await readJson<SendBody>(response)).toEqual({
      results: [
        { recipientEmail: 'one@example.com', ok: true },
        { recipientEmail: 'two@example.com', ok: true },
        { recipientEmail: 'three@example.com', ok: true },
      ],
    });
  });

  it('is private/no-store like every other route returning mailbox data', async () => {
    const response = await handleSend(sendRequest(validBody()), makeDeps());
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('mints one token per recipient, attributed to the sending account', async () => {
    const mint = makeMintFetch();

    await handleSend(
      sendRequest(validBody({ to: ['one@example.com'], cc: ['two@example.com'] })),
      makeDeps({ fetchImpl: mint.fetchImpl }),
    );

    expect(mint.spy).toHaveBeenCalledTimes(1);
    const body = mint.bodies[0] as { sends: Record<string, string>[] };
    expect(body.sends).toHaveLength(2);
    expect(body.sends.map((send) => send.recipientEmail)).toEqual([
      'one@example.com',
      'two@example.com',
    ]);
    for (const send of body.sends) {
      expect(send.accountId).toBe('primary');
      expect(send.subject).toBe('Hello');
    }
  });

  it('stamps ONE Message-ID on every copy and mints that same id', async () => {
    // The amendment's cross-layer assertion: the id sync generates before
    // the mint is the id tracking stores AND the id every SMTP copy
    // carries. Three recipients, one logical message, one Message-ID.
    const mint = makeMintFetch();
    const { transports, calls } = makeFakeTransports();

    await handleSend(
      sendRequest(validBody({ to: ['one@example.com', 'two@example.com'], cc: ['three@example.com'] })),
      makeDeps({ fetchImpl: mint.fetchImpl, transports }),
    );

    const minted = (mint.bodies[0] as { sends: { messageId: string }[] }).sends;
    const mintedIds = new Set(minted.map((send) => send.messageId));
    expect(mintedIds.size).toBe(1);

    const sentIds = new Set(calls.map((call) => call.messageId));
    expect(sentIds.size).toBe(1);
    expect([...sentIds][0]).toBe([...mintedIds][0]);
    expect([...sentIds][0]).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
  });

  it('sends from the identity that was asked for, not the primary', async () => {
    const { transports, calls } = makeFakeTransports();

    await handleSend(
      sendRequest(validBody({ identityId: 'second' })),
      makeDeps({ transports }),
    );

    expect(calls[0]!.from).toBe('second@example.com');
    expect(calls[0]!.envelope.from).toBe('second@example.com');
  });

  it('builds the pixel from TRACKING_BASE_URL', async () => {
    const { transports, calls } = makeFakeTransports();

    await handleSend(sendRequest(validBody()), makeDeps({ transports }));

    expect(calls[0]!.html).toContain('src="https://track.example/o/');
  });

  it('still answers 200 when only some copies went out, with the truth per recipient', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { transports } = makeFakeTransports({ failFor: 'two@example.com' });

    const response = await handleSend(
      sendRequest(validBody({ to: ['one@example.com', 'two@example.com'] })),
      makeDeps({ transports }),
    );

    expect(response.status).toBe(200);
    expect(await readJson<SendBody>(response)).toEqual({
      results: [
        { recipientEmail: 'one@example.com', ok: true },
        { recipientEmail: 'two@example.com', ok: false },
      ],
    });
  });
});

describe('POST /api/send — validation (400, one fixed string)', () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ['a body that is not JSON', '{not json'],
    ['a body that is not an object', '"a string"'],
    ['no identityId', { ...validBody(), identityId: undefined }],
    ['a non-string identityId', validBody({ identityId: 42 })],
    ['no to array', { ...validBody(), to: undefined }],
    ['a to that is not an array', validBody({ to: 'one@example.com' })],
    ['an empty to array', validBody({ to: [] })],
    ['a non-string recipient', validBody({ to: [42] })],
    ['a recipient with no @', validBody({ to: ['not-an-address'] })],
    ['a recipient carrying a newline', validBody({ to: ['a@example.com\r\nbcc: evil@example.com'] })],
    ['a cc that is not an array', validBody({ cc: 'two@example.com' })],
    ['a non-string subject', validBody({ subject: 42 })],
    ['a subject carrying a newline', validBody({ subject: 'hi\r\nX-Injected: yes' })],
    ['a non-string textBody', validBody({ textBody: 42 })],
  ];

  for (const [label, body] of cases) {
    it(`rejects ${label}`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await handleSend(sendRequest(body), makeDeps());

      expect(response.status).toBe(400);
      expect(await readJson<SendBody>(response)).toEqual({ error: 'invalid request body' });
    });
  }

  it(`rejects a subject longer than ${MAX_SUBJECT_CHARS} characters`, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleSend(
      sendRequest(validBody({ subject: 'x'.repeat(MAX_SUBJECT_CHARS + 1) })),
      makeDeps(),
    );
    expect(response.status).toBe(400);
  });

  it(`accepts a subject of exactly ${MAX_SUBJECT_CHARS} characters`, async () => {
    const response = await handleSend(
      sendRequest(validBody({ subject: 'x'.repeat(MAX_SUBJECT_CHARS) })),
      makeDeps(),
    );
    expect(response.status).toBe(200);
  });

  it('rejects a body over the byte cap, measured in BYTES not characters', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Half as many 4-byte characters as the byte cap, plus one character:
    // a character-counting cap would let this through at a quarter of the
    // size it actually is.
    const oversized = '😀'.repeat(MAX_TEXT_BODY_BYTES / 4 + 1);
    const response = await handleSend(sendRequest(validBody({ textBody: oversized })), makeDeps());

    expect(response.status).toBe(400);
  });

  it(`rejects more than ${MAX_RECIPIENTS} recipients counting to AND cc together`, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const to = Array.from({ length: 20 }, (_, index) => `to-${index}@example.com`);
    const cc = Array.from({ length: 6 }, (_, index) => `cc-${index}@example.com`);

    const response = await handleSend(sendRequest(validBody({ to, cc })), makeDeps());

    expect(response.status).toBe(400);
  });

  it(`accepts exactly ${MAX_RECIPIENTS} recipients across to and cc`, async () => {
    const to = Array.from({ length: 20 }, (_, index) => `to-${index}@example.com`);
    const cc = Array.from({ length: 5 }, (_, index) => `cc-${index}@example.com`);

    const response = await handleSend(sendRequest(validBody({ to, cc })), makeDeps());

    expect(response.status).toBe(200);
    expect((await readJson<SendBody>(response)).results).toHaveLength(MAX_RECIPIENTS);
  });

  it('never mints a token or opens a transport when validation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mint = makeMintFetch();
    const { transports, calls } = makeFakeTransports();

    await handleSend(
      sendRequest(validBody({ to: [] })),
      makeDeps({ fetchImpl: mint.fetchImpl, transports }),
    );

    expect(mint.spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('POST /api/send — unknown identity (404)', () => {
  it('refuses an identityId no configured account owns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleSend(
      sendRequest(validBody({ identityId: 'not-an-account' })),
      makeDeps(),
    );

    expect(response.status).toBe(404);
    expect(await readJson<SendBody>(response)).toEqual({ error: 'unknown identity' });
  });

  it('mints nothing for an unknown identity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mint = makeMintFetch();

    await handleSend(
      sendRequest(validBody({ identityId: 'nope' })),
      makeDeps({ fetchImpl: mint.fetchImpl }),
    );

    expect(mint.spy).not.toHaveBeenCalled();
  });
});

describe('POST /api/send — tracking failure is closed (502)', () => {
  it('refuses with 502 when the tracking service is unreachable, and sends NOTHING', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { transports, calls } = makeFakeTransports();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await handleSend(
      sendRequest(validBody()),
      makeDeps({ transports, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(response.status).toBe(502);
    expect(await readJson<SendBody>(response)).toEqual({ error: 'tracking unavailable' });
    // The whole point: no untracked fallback. A send that claims to be
    // tracked and is not is the product lying.
    expect(calls).toHaveLength(0);
  });

  it('refuses with 502 on a non-200 from the mint route', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { transports, calls } = makeFakeTransports();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));

    const response = await handleSend(
      sendRequest(validBody()),
      makeDeps({ transports, fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(response.status).toBe(502);
    expect(calls).toHaveLength(0);
  });

  it('refuses with 502 when tracking was never configured at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { transports, calls } = makeFakeTransports();

    const response = await handleSend(
      sendRequest(validBody()),
      makeDeps({ transports, trackingConfig: null }),
    );

    expect(response.status).toBe(502);
    expect(await readJson<SendBody>(response)).toEqual({ error: 'tracking unavailable' });
    expect(calls).toHaveLength(0);
  });
});

describe('POST /api/send — sending unconfigured (503)', () => {
  it('refuses, and mints nothing, when no transports were wired in', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mint = makeMintFetch();

    const response = await handleSend(
      sendRequest(validBody()),
      makeDeps({ transports: null, fetchImpl: mint.fetchImpl }),
    );

    expect(response.status).toBe(503);
    expect(mint.spy).not.toHaveBeenCalled();
  });

  it('refuses when the identity exists but has no transport', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const emptyTransports: Transports = { get: () => undefined, closeAll: () => {} };

    const response = await handleSend(
      sendRequest(validBody()),
      makeDeps({ transports: emptyTransports }),
    );

    expect(response.status).toBe(503);
  });
});

describe('POST /api/send — global send cap (429)', () => {
  it(`allows ${SEND_RATE_LIMIT_MAX_ATTEMPTS} sends in a window and refuses the next`, async () => {
    const deps = makeDeps();

    for (let attempt = 0; attempt < SEND_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const response = await handleSend(sendRequest(validBody()), deps);
      expect(response.status).toBe(200);
    }

    const refused = await handleSend(sendRequest(validBody()), deps);
    expect(refused.status).toBe(429);
    expect(await readJson<SendBody>(refused)).toEqual({ error: 'too many sends' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('counts EVERY attempt, including the ones that failed validation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps();

    for (let attempt = 0; attempt < SEND_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const response = await handleSend(sendRequest(validBody({ to: [] })), deps);
      expect(response.status).toBe(400);
    }

    // A runaway script that sends garbage must not get an unlimited budget
    // just because the garbage never reached SMTP.
    expect((await handleSend(sendRequest(validBody()), deps)).status).toBe(429);
  });

  it('mints nothing and sends nothing once the cap has tripped', async () => {
    const mint = makeMintFetch();
    const { transports, calls } = makeFakeTransports();
    const limiter = createFixedWindowLimiter(
      SEND_RATE_LIMIT_MAX_ATTEMPTS,
      SEND_RATE_LIMIT_WINDOW_MS,
    );
    for (let attempt = 0; attempt < SEND_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      limiter.recordFailure(1_000_000);
    }

    await handleSend(
      sendRequest(validBody()),
      makeDeps({ limiter, fetchImpl: mint.fetchImpl, transports }),
    );

    expect(mint.spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('rolls the window forward — the budget returns after the window passes', async () => {
    const limiter = createFixedWindowLimiter(
      SEND_RATE_LIMIT_MAX_ATTEMPTS,
      SEND_RATE_LIMIT_WINDOW_MS,
    );
    const start = 5_000_000;
    for (let attempt = 0; attempt < SEND_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      limiter.recordFailure(start);
    }

    expect((await handleSend(sendRequest(validBody()), makeDeps({ limiter, nowMs: start }))).status).toBe(429);
    expect(
      (await handleSend(
        sendRequest(validBody()),
        makeDeps({ limiter, nowMs: start + SEND_RATE_LIMIT_WINDOW_MS }),
      )).status,
    ).toBe(200);
  });

  it('is an hour long and 30 sends wide', () => {
    expect(SEND_RATE_LIMIT_MAX_ATTEMPTS).toBe(30);
    expect(SEND_RATE_LIMIT_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

describe('POST /api/send — never logs message content', () => {
  it('keeps the subject, body, recipients and tokens out of EVERY console channel', async () => {
    const captured: unknown[] = [];
    const record = (...args: unknown[]) => {
      captured.push(args);
    };
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
    vi.spyOn(console, 'log').mockImplementation(record);

    const { transports } = makeFakeTransports({ throwOnSend: true });

    await handleSend(
      sendRequest(
        validBody({
          to: ['sentinel-recipient@example.com'],
          subject: 'SENTINEL-SUBJECT-9f3a',
          textBody: 'SENTINEL-BODY-9f3a',
        }),
      ),
      makeDeps({ transports }),
    );

    const output = JSON.stringify(captured);
    expect(output).not.toContain('SENTINEL-SUBJECT-9f3a');
    expect(output).not.toContain('SENTINEL-BODY-9f3a');
    expect(output).not.toContain('sentinel-recipient@example.com');
  });

  it('keeps the subject out of the logs on the 502 path too', async () => {
    const captured: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      captured.push(args);
    });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await handleSend(
      sendRequest(validBody({ subject: 'SENTINEL-SUBJECT-502' })),
      makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(JSON.stringify(captured)).not.toContain('SENTINEL-SUBJECT-502');
  });
});

const FAKE_POOL = makeFakePool().pool;

function routerWith(options: {
  transports?: Transports | null;
  fetchImpl?: typeof fetch;
  trackingConfig?: TrackingConfig | null;
} = {}) {
  return createRouter(
    makeFakeDb(),
    FAKE_POOL,
    TOKEN,
    options.trackingConfig === undefined ? TRACKING : options.trackingConfig,
    options.fetchImpl ?? makeMintFetch().fetchImpl,
    null,
    undefined,
    ACCOUNTS,
    options.transports === undefined ? makeFakeTransports().transports : options.transports,
  );
}

describe('POST /api/send — routing', () => {
  it('is refused with 401 without a credential, before any validation', async () => {
    const mint = makeMintFetch();
    const router = routerWith({ fetchImpl: mint.fetchImpl });

    const response = await router(
      new Request('https://sync.example/api/send', {
        method: 'POST',
        body: JSON.stringify(validBody()),
      }),
    );

    expect(response.status).toBe(401);
    expect(mint.spy).not.toHaveBeenCalled();
  });

  it('answers 200 with results for an authenticated caller', async () => {
    const router = routerWith();

    const response = await router(
      new Request('https://sync.example/api/send', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      }),
    );

    expect(response.status).toBe(200);
    expect((await readJson<SendBody>(response)).results).toEqual([
      { recipientEmail: 'one@example.com', ok: true },
    ]);
  });

  it('does not answer GET /api/send', async () => {
    const router = routerWith();

    const response = await router(
      new Request('https://sync.example/api/send', { headers: AUTH }),
    );

    expect(response.status).toBe(404);
  });

  it('shares one send budget across the router, refusing the 31st attempt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = routerWith();
    const post = () =>
      router(
        new Request('https://sync.example/api/send', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify(validBody()),
        }),
      );

    for (let attempt = 0; attempt < SEND_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      expect((await post()).status).toBe(200);
    }

    expect((await post()).status).toBe(429);
  });

  it('does not spend the SESSION limiter budget — signing in still works after 30 sends', async () => {
    // The two counters are independent instances on purpose: a burst of
    // sends must never lock the owner out of signing in.
    const router = routerWith();
    for (let attempt = 0; attempt < SEND_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      await router(
        new Request('https://sync.example/api/send', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify(validBody()),
        }),
      );
    }

    const session = await router(
      new Request('https://sync.example/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      }),
    );

    expect(session.status).not.toBe(429);
  });
});

describe('createRouterFromConfig — the transports wire', () => {
  it('reaches the transports it was built with, not a fossil default', async () => {
    // The wire test server.ts's own doc comment demands: deleting the
    // `transports` argument from createRouterFromConfig leaves every other
    // test in this file green and makes production answer 503 forever.
    const { transports, calls } = makeFakeTransports();
    const config: SyncConfig = {
      accounts: ACCOUNTS,
      databaseUrl: 'postgres://unused',
      port: 8080,
      trackingConfig: TRACKING,
      vapidConfig: null,
    };
    const router = createRouterFromConfig(
      makeFakeDb(),
      FAKE_POOL,
      TOKEN,
      config,
      transports,
      makeMintFetch().fetchImpl,
    );

    const response = await router(
      new Request('https://sync.example/api/send', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.envelope.to).toEqual(['one@example.com']);
  });
});

/**
 * Fix round 1, Fix 1 — the transport seam.
 *
 * `MAX_TEXT_BODY_BYTES` is enforced by handleSend, but the body has to
 * survive `toWebRequest` first, and that ran a flat 8 KiB cap chosen when
 * POST /api/session was the only route reading a body. Nothing crossed the
 * seam: server-request.test.ts proved the 8 KiB refusal in isolation and
 * every test above builds a Web `Request` directly. The result was that a
 * ~1,300-word email came back 413 with an opaque error and the 100 KiB cap
 * could never bind. These tests cross it.
 */
function fakeIncoming(options: {
  method: string;
  url: string;
  body: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const stream = new PassThrough();
  stream.end(options.body);
  return Object.assign(stream, {
    method: options.method,
    url: options.url,
    headers: options.headers ?? {},
  }) as unknown as IncomingMessage;
}

describe('POST /api/send — the request body cap at the transport seam', () => {
  it('carries a near-cap compose body through toWebRequest to a 200', async () => {
    // End to end through the adapter the real HTTP server uses, not a
    // hand-built Request: ~100 KiB of body, which the old flat 8 KiB cap
    // refused before auth, before the limiter, before handleSend.
    const textBody = 'x'.repeat(MAX_TEXT_BODY_BYTES - 1024);
    const router = routerWith();

    const request = await toWebRequest(
      fakeIncoming({
        method: 'POST',
        url: '/api/send',
        body: JSON.stringify(validBody({ textBody })),
        headers: { ...AUTH, 'content-type': 'application/json' },
      }),
    );

    expect(request).not.toBeNull();
    const response = await router(request!);
    expect(response.status).toBe(200);
    expect((await readJson<SendBody>(response)).results).toEqual([
      { recipientEmail: 'one@example.com', ok: true },
    ]);
  });

  it(`accepts a textBody of EXACTLY ${MAX_TEXT_BODY_BYTES} bytes`, async () => {
    // The accept side of the one cap that had only a refuse side.
    const textBody = 'x'.repeat(MAX_TEXT_BODY_BYTES);
    expect(Buffer.byteLength(textBody, 'utf8')).toBe(MAX_TEXT_BODY_BYTES);

    const response = await handleSend(sendRequest(validBody({ textBody })), makeDeps());

    expect(response.status).toBe(200);
  });

  it('carries an exactly-at-cap textBody through the seam too', async () => {
    const textBody = 'x'.repeat(MAX_TEXT_BODY_BYTES);
    const router = routerWith();

    const request = await toWebRequest(
      fakeIncoming({
        method: 'POST',
        url: '/api/send',
        body: JSON.stringify(validBody({ textBody })),
        headers: { ...AUTH, 'content-type': 'application/json' },
      }),
    );

    expect(request).not.toBeNull();
    expect((await router(request!)).status).toBe(200);
  });

  it('still refuses at the transport once the send route cap is crossed', async () => {
    const request = await toWebRequest(
      fakeIncoming({
        method: 'POST',
        url: '/api/send',
        body: 'x'.repeat(MAX_SEND_REQUEST_BODY_BYTES + 1),
        headers: AUTH,
      }),
    );

    expect(request).toBeNull();
  });

  it('leaves the UNAUTHENTICATED session route on the small default cap', async () => {
    // The 8 KiB number is real DoS protection exactly where it was chosen
    // for: a route anyone can reach without a credential. Raising it
    // globally to serve /api/send would have thrown that away.
    const request = await toWebRequest(
      fakeIncoming({
        method: 'POST',
        url: '/api/session',
        body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
        headers: {},
      }),
    );

    expect(request).toBeNull();
  });

  it('does not raise the cap for a GET, or for another POST route', async () => {
    const push = await toWebRequest(
      fakeIncoming({
        method: 'POST',
        url: '/api/push/subscribe',
        body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
        headers: AUTH,
      }),
    );

    expect(push).toBeNull();
  });

  it('applies the send cap regardless of a query string on the path', async () => {
    const request = await toWebRequest(
      fakeIncoming({
        method: 'POST',
        url: '/api/send?trace=1',
        body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
        headers: AUTH,
      }),
    );

    expect(request).not.toBeNull();
  });

  it('falls back to the TIGHT cap for a request target that is not a parseable URL', () => {
    // `requestPath` resolves the target with `new URL('http://localhost' + raw)`
    // and catches. '%zz' genuinely throws there (verified against this
    // Node version — an invalid percent-escape lands in the HOST position
    // when the target has no leading slash, which is exactly the shape a
    // malformed client or a probe sends). The branch must fail CLOSED: an
    // unparseable target gets the 8 KiB default, never the send route's
    // 768 KiB. Mutating the catch to `return '/api/send'` fails this.
    expect(requestBodyLimit('POST', '%zz')).toBe(MAX_REQUEST_BODY_BYTES);
    expect(requestBodyLimit('POST', ':abc')).toBe(MAX_REQUEST_BODY_BYTES);
  });

  it('refuses an oversized body on an unparseable target rather than buffering it', () => {
    // End to end through the adapter: the limit is chosen BEFORE the
    // `new Request(...)` that a malformed target would throw on, so the
    // body is capped at 8 KiB and refused. The refusal is a 413, and
    // crucially not an exception escaping mid-buffer.
    return expect(
      toWebRequest(
        fakeIncoming({
          method: 'POST',
          url: '%zz',
          body: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1),
          headers: AUTH,
        }),
      ),
    ).resolves.toBeNull();
  });

  it('reserves enough transport budget for the worst-case JSON encoding of a maximal body', () => {
    // The arithmetic, asserted rather than asserted-in-a-comment: JSON
    // escaping expands a C0 control character to \u00XX — six bytes for
    // one — so a maximal body of them is 6x its measured size on the wire.
    // Every other field is bounded the same way. If any component cap
    // grows past what the transport reserves, this fails rather than
    // reintroducing an unreachable cap.
    const JSON_WORST_CASE_EXPANSION = 6;
    const worstCase =
      MAX_TEXT_BODY_BYTES * JSON_WORST_CASE_EXPANSION +
      // Plan 9: a REPLY carries the original message's body as well as the
      // new one, which is what roughly doubled the largest legitimate
      // request and forced this reserve up from 768 KiB.
      MAX_QUOTE_BODY_BYTES * JSON_WORST_CASE_EXPANSION +
      MAX_REFERENCES * (MAX_MESSAGE_ID_CHARS * JSON_WORST_CASE_EXPANSION + 3) +
      MAX_MESSAGE_ID_CHARS * JSON_WORST_CASE_EXPANSION +
      MAX_FROM_LABEL_CHARS * JSON_WORST_CASE_EXPANSION +
      MAX_SUBJECT_CHARS * JSON_WORST_CASE_EXPANSION +
      // 4 bytes per character at most in UTF-8, plus quotes and a comma.
      MAX_RECIPIENTS * (MAX_RECIPIENT_CHARS * 4 + 3) +
      MAX_IDENTITY_ID_CHARS * 4 +
      // sentAtMs, field names, braces, colons
      220;

    expect(worstCase).toBeLessThanOrEqual(MAX_SEND_REQUEST_BODY_BYTES);
  });
});

/**
 * Plan 9 Task 3 — replying.
 *
 * `inReplyTo` and `references` become RAW HEADERS on the outgoing message,
 * and `quote` becomes the body's quoted original. All three arrive over
 * HTTP, so all three are validated here rather than trusted.
 */
describe('POST /api/send — threading headers', () => {
  const IN_REPLY_TO = '<original@example.com>';
  const REFERENCES = ['<first@example.com>', '<original@example.com>'];

  it('emits In-Reply-To and References so the reply lands in the existing thread', async () => {
    // The single most visible way a mail client looks broken: a reply that
    // arrives in the recipient's Gmail as a brand-new thread.
    const { transports, calls } = makeFakeTransports();

    const response = await handleSend(
      sendRequest(validBody({ inReplyTo: IN_REPLY_TO, references: REFERENCES })),
      makeDeps({ transports }),
    );

    expect(response.status).toBe(200);
    expect(calls[0]!.inReplyTo).toBe(IN_REPLY_TO);
    expect(calls[0]!.references).toEqual(REFERENCES);
  });

  it('puts the same threading headers on EVERY per-recipient copy', async () => {
    // One logical message fans out to N copies (spec §5.3). A copy missing
    // the headers threads for some recipients and not others.
    const { transports, calls } = makeFakeTransports();

    await handleSend(
      sendRequest(
        validBody({
          to: ['one@example.com', 'two@example.com'],
          inReplyTo: IN_REPLY_TO,
          references: REFERENCES,
        }),
      ),
      makeDeps({ transports }),
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.inReplyTo).toBe(IN_REPLY_TO);
      expect(call.references).toEqual(REFERENCES);
    }
  });

  it('sets NEITHER header for a plain compose — byte-identical to before Plan 9', async () => {
    const { transports, calls } = makeFakeTransports();

    await handleSend(sendRequest(validBody()), makeDeps({ transports }));

    expect(calls[0]!.inReplyTo).toBeUndefined();
    expect(calls[0]!.references).toBeUndefined();
  });

  it('omits References when the chain is empty rather than sending a blank header', async () => {
    const { transports, calls } = makeFakeTransports();

    await handleSend(
      sendRequest(validBody({ inReplyTo: IN_REPLY_TO, references: [] })),
      makeDeps({ transports }),
    );

    expect(calls[0]!.inReplyTo).toBe(IN_REPLY_TO);
    expect(calls[0]!.references).toBeUndefined();
  });
});

describe('POST /api/send — header injection through the threading fields', () => {
  /**
   * A CR or LF inside `inReplyTo` TERMINATES the header and lets whatever
   * follows become a header of the attacker's choosing — `Bcc:` being the
   * one that matters, since it silently copies the user's mail elsewhere.
   *
   * Rejected outright rather than stripped-and-continued: a silently
   * mangled thread id is indistinguishable from a working one until the
   * reply lands unthreaded, days later, with no error anywhere.
   */
  const injectionCases: readonly (readonly [string, unknown])[] = [
    ['a Message-ID containing CRLF', validBody({ inReplyTo: '<a@b>\r\nBcc: attacker@evil.test' })],
    ['a Message-ID containing a bare LF', validBody({ inReplyTo: '<a@b>\nBcc: attacker@evil.test' })],
    ['a Message-ID containing a bare CR', validBody({ inReplyTo: '<a@b>\rBcc: attacker@evil.test' })],
    ['a reference containing CRLF', validBody({ references: ['<a@b>\r\nBcc: attacker@evil.test'] })],
    ['a non-string inReplyTo', validBody({ inReplyTo: 42 })],
    ['an empty inReplyTo', validBody({ inReplyTo: '' })],
    ['a references that is not an array', validBody({ references: '<a@b>' })],
    ['a non-string reference', validBody({ references: [42] })],
    ['an empty reference', validBody({ references: [''] })],
  ];

  for (const [label, body] of injectionCases) {
    it(`rejects ${label} with a 400`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await handleSend(sendRequest(body), makeDeps());

      expect(response.status).toBe(400);
      expect(await readJson<SendBody>(response)).toEqual({ error: 'invalid request body' });
    });
  }

  it('never lets a rejected value reach the transport at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { transports, calls } = makeFakeTransports();

    await handleSend(
      sendRequest(validBody({ inReplyTo: '<a@b>\r\nBcc: attacker@evil.test' })),
      makeDeps({ transports }),
    );

    expect(calls).toHaveLength(0);
  });

  it(`rejects a References chain longer than ${MAX_REFERENCES}`, async () => {
    // An unbounded References header is an unbounded header: a long-running
    // thread would grow it until the SMTP server refused the whole message.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleSend(
      sendRequest(
        validBody({ references: Array.from({ length: MAX_REFERENCES + 1 }, (_, i) => `<${i}@b>`) }),
      ),
      makeDeps(),
    );

    expect(response.status).toBe(400);
  });

  it(`accepts a References chain of exactly ${MAX_REFERENCES}`, async () => {
    const response = await handleSend(
      sendRequest(
        validBody({ references: Array.from({ length: MAX_REFERENCES }, (_, i) => `<${i}@b>`) }),
      ),
      makeDeps(),
    );

    expect(response.status).toBe(200);
  });

  it(`rejects a message id longer than ${MAX_MESSAGE_ID_CHARS} characters`, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleSend(
      sendRequest(validBody({ inReplyTo: `<${'x'.repeat(MAX_MESSAGE_ID_CHARS)}>` })),
      makeDeps(),
    );

    expect(response.status).toBe(400);
  });
});

describe('POST /api/send — the quoted original (spec §5.2 and §5.6)', () => {
  /** What our own Sent copy of the message being replied to looks like:
   *  the ORIGINAL recipient's live token, on our own tracking origin. */
  const ORIGINAL_TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const ORIGINAL_PIXEL = `<img alt="" src="https://track.example/o/${ORIGINAL_TOKEN}.png">`;

  function replyBody(overrides: Record<string, unknown> = {}) {
    return validBody({
      textBody: 'my reply',
      inReplyTo: '<original@example.com>',
      quote: {
        originalHtml: `<p>Here are the numbers.</p>${ORIGINAL_PIXEL}`,
        originalText: null,
        fromLabel: 'Ada <ada@example.com>',
        sentAtMs: 1_700_000_000_000,
      },
      ...overrides,
    });
  }

  it('strips the ORIGINAL recipient\'s pixel out of the quote while keeping OURS (§5.6)', async () => {
    // THE ORDERING PIN. Two ways to break this, both caught here:
    //
    //  - drop the strip entirely: the original token survives into the
    //    reply and re-fires forever, reporting opens for a recipient who
    //    did nothing. The first assertion fails.
    //  - run the strip AFTER the new pixel is injected, i.e. over the
    //    assembled body: it deletes OUR pixel too, because ours is on the
    //    same origin under the same /o/ path, and the reply goes out
    //    untracked while looking perfectly fine. The second assertion fails.
    //
    // Neither is observable from src/send/quote.ts alone — nothing there
    // injects a pixel — which is why this lives at the route.
    const { transports, calls } = makeFakeTransports();

    await handleSend(sendRequest(replyBody()), makeDeps({ transports }));

    const html = calls[0]!.html;
    expect(html).not.toContain(ORIGINAL_TOKEN);
    expect(html).toContain('src="https://track.example/o/');
    expect(html).toContain('Here are the numbers.');
  });

  it('places OUR pixel before the quote, not inside it (§5.2)', async () => {
    // ORDER, not containment: `toContain` passes for a pixel buried inside
    // the collapsed quote, which is the exact defect §5.2 forbids.
    const { transports, calls } = makeFakeTransports();

    await handleSend(sendRequest(replyBody()), makeDeps({ transports }));

    const html = calls[0]!.html;
    expect(html.indexOf('/o/')).toBeLessThan(html.indexOf('gmail_quote'));
  });

  it('gives each recipient their OWN pixel before one shared quote', async () => {
    const { transports, calls } = makeFakeTransports();

    await handleSend(
      sendRequest(replyBody({ to: ['one@example.com', 'two@example.com'] })),
      makeDeps({ transports }),
    );

    const tokens = calls.map((call) => /\/o\/([^.]+)\.png/.exec(call.html)?.[1]);
    expect(new Set(tokens).size).toBe(2);
    for (const call of calls) {
      expect(call.html.indexOf('/o/')).toBeLessThan(call.html.indexOf('gmail_quote'));
    }
  });

  it('quotes plain text ESCAPED rather than as markup', async () => {
    const { transports, calls } = makeFakeTransports();

    await handleSend(
      sendRequest(
        replyBody({
          quote: {
            originalHtml: null,
            originalText: '<script>alert(1)</script>',
            fromLabel: 'Ada <ada@example.com>',
            sentAtMs: 1_700_000_000_000,
          },
        }),
      ),
      makeDeps({ transports }),
    );

    expect(calls[0]!.html).not.toContain('<script>');
    expect(calls[0]!.html).toContain('&lt;script&gt;');
  });

  it('accepts a quote whose original carried no usable Date', async () => {
    // ParsedMessage.date is nullable and a message with no Date header is
    // ordinary mail. "On Invalid Date, NaN ... wrote:" must never go out.
    const { transports, calls } = makeFakeTransports();

    const response = await handleSend(
      sendRequest(
        replyBody({
          quote: {
            originalHtml: '<p>x</p>',
            originalText: null,
            fromLabel: 'Ada <ada@example.com>',
            sentAtMs: null,
          },
        }),
      ),
      makeDeps({ transports }),
    );

    expect(response.status).toBe(200);
    expect(calls[0]!.html).toContain('Ada &lt;ada@example.com&gt; wrote:');
    expect(calls[0]!.html).not.toContain('NaN');
    expect(calls[0]!.html).not.toContain('Invalid Date');
  });

  it('emits no quote markup at all for a plain compose', async () => {
    const { transports, calls } = makeFakeTransports();

    await handleSend(sendRequest(validBody()), makeDeps({ transports }));

    expect(calls[0]!.html).toBe(
      `<div dir="auto">body text</div><img alt="" src="https://track.example/o/${'f'.repeat(31)}0.png">`,
    );
  });

  const quoteRejections: readonly (readonly [string, unknown])[] = [
    ['a quote that is not an object', validBody({ quote: 'old mail' })],
    ['a quote with no fromLabel', validBody({ quote: { originalHtml: '<p>x</p>', originalText: null, sentAtMs: 1 } })],
    [
      'a fromLabel carrying a newline',
      validBody({
        quote: { originalHtml: '<p>x</p>', originalText: null, fromLabel: 'a\r\nb', sentAtMs: 1 },
      }),
    ],
    [
      'a non-numeric sentAtMs — timestamps are epoch-ms NUMBERS on this wire',
      validBody({
        quote: {
          originalHtml: '<p>x</p>',
          originalText: null,
          fromLabel: 'A <a@x.com>',
          sentAtMs: '2023-11-14T22:13:20Z',
        },
      }),
    ],
    [
      'a quote body over the byte cap',
      validBody({
        quote: {
          originalHtml: 'x'.repeat(MAX_QUOTE_BODY_BYTES + 1),
          originalText: null,
          fromLabel: 'A <a@x.com>',
          sentAtMs: 1,
        },
      }),
    ],
  ];

  for (const [label, body] of quoteRejections) {
    it(`rejects ${label} with a 400`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await handleSend(sendRequest(body), makeDeps());

      expect(response.status).toBe(400);
      expect(await readJson<SendBody>(response)).toEqual({ error: 'invalid request body' });
    });
  }
});
