import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleSend,
  MAX_RECIPIENTS,
  MAX_SUBJECT_CHARS,
  MAX_TEXT_BODY_BYTES,
  SEND_RATE_LIMIT_MAX_ATTEMPTS,
  SEND_RATE_LIMIT_WINDOW_MS,
} from '../src/api/send.ts';
import type { SendRouteDeps } from '../src/api/send';
import { createRouter } from '../src/api/routes.ts';
import { createRouterFromConfig } from '../src/api/server.ts';
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
