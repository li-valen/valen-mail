import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildMessageId,
  mintTokens,
  sendTracked,
  MINT_REQUEST_TIMEOUT_MS,
} from '../src/send/send.ts';
import type { MintSend, SendTrackedRequest } from '../src/send/send';
import type { SendMailOptions, SentMessageInfo, Transport } from 'nodemailer';

/**
 * Plan 4 Task 3 — the dispatch half of the send path.
 *
 * NO live SMTP and NO live tracking call anywhere in this file: every test
 * injects a fake transport and a fake fetch, exactly as
 * tests/transports.test.ts and tests/opens-proxy.test.ts already do. The
 * accounts this service sends from are real Gmail accounts and the
 * tracking service is a real Vercel deployment; a test that touched
 * either would eventually send real mail or mint real database rows.
 */

const MINT_BASE = { baseUrl: 'https://track.example', token: 'k'.repeat(32) };
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const TOKEN_C = 'c'.repeat(32);

afterEach(() => {
  vi.restoreAllMocks();
});

function mintSend(overrides: Partial<MintSend> = {}): MintSend {
  return {
    recipientEmail: 'one@example.com',
    subject: 'Subject',
    accountId: 'primary',
    messageId: '<mid@example.com>',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildMessageId', () => {
  it('is an angle-bracketed id at the sender address domain', () => {
    const id = buildMessageId('primary@example.com');
    expect(id).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
  });

  it('is unique per call — two logical messages never share one', () => {
    expect(buildMessageId('a@example.com')).not.toBe(buildMessageId('a@example.com'));
  });

  it('falls back to a fixed local domain when the address carries none', () => {
    // config.ts already rejects an address with no "@", so this is a
    // defensive default rather than a reachable production path — it must
    // still be a syntactically usable Message-ID rather than "<uuid@>".
    expect(buildMessageId('not-an-address')).toMatch(/^<[0-9a-f-]{36}@postbox\.local>$/);
  });

  it('stays inside the 256-character bound the tracking mint route enforces', () => {
    expect(buildMessageId('primary@example.com').length).toBeLessThanOrEqual(256);
  });
});

describe('mintTokens — request', () => {
  it('POSTs the widened {recipientEmail,subject,accountId,messageId} shape to /api/tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ tokens: [{ token: TOKEN_A, recipientEmail: 'one@example.com' }] }),
    );

    await mintTokens({ ...MINT_BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, [
      mintSend(),
    ]);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://track.example/api/tokens');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      sends: [
        {
          recipientEmail: 'one@example.com',
          subject: 'Subject',
          accountId: 'primary',
          messageId: '<mid@example.com>',
        },
      ],
    });
  });

  it('sends the read token as a bearer header and never in the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ tokens: [{ token: TOKEN_A, recipientEmail: 'one@example.com' }] }),
    );

    await mintTokens({ ...MINT_BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, [
      mintSend(),
    ]);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).not.toContain(MINT_BASE.token);
    expect(init.headers.authorization).toBe(`Bearer ${MINT_BASE.token}`);
  });

  it('keeps a path prefix on the tracking base url', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ tokens: [{ token: TOKEN_A, recipientEmail: 'one@example.com' }] }),
    );

    await mintTokens(
      { baseUrl: 'https://track.example/', token: MINT_BASE.token, fetchImpl: fetchImpl as unknown as typeof fetch },
      [mintSend()],
    );

    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://track.example/api/tokens');
  });
});

describe('mintTokens — success', () => {
  it('returns the minted tokens paired with their recipients, in request order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        tokens: [
          { token: TOKEN_A, recipientEmail: 'one@example.com' },
          { token: TOKEN_B, recipientEmail: 'two@example.com' },
        ],
      }),
    );

    const result = await mintTokens({ ...MINT_BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, [
      mintSend({ recipientEmail: 'one@example.com' }),
      mintSend({ recipientEmail: 'two@example.com' }),
    ]);

    expect(result).toEqual({
      ok: true,
      tokens: [
        { recipientEmail: 'one@example.com', token: TOKEN_A },
        { recipientEmail: 'two@example.com', token: TOKEN_B },
      ],
    });
  });

  it('accepts a case-different echo of the recipient address', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ tokens: [{ token: TOKEN_A, recipientEmail: 'ONE@Example.com' }] }),
    );

    const result = await mintTokens({ ...MINT_BASE, fetchImpl: fetchImpl as unknown as typeof fetch }, [
      mintSend({ recipientEmail: 'one@example.com' }),
    ]);

    expect(result.ok).toBe(true);
  });
});

describe('mintTokens — failure is closed, never a fallback', () => {
  it('reports unreachable when the tracking service never responds within MINT_REQUEST_TIMEOUT_MS', async () => {
    // The timeout test that actually depends on the abort signal being
    // wired to the fetch call — a stub that only rejects when its
    // AbortSignal fires (the shape opens-proxy.test.ts proved out).
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      const pending = mintTokens(
        { ...MINT_BASE, fetchImpl: fetchImpl as unknown as typeof fetch },
        [mintSend()],
      );
      await vi.advanceTimersByTimeAsync(MINT_REQUEST_TIMEOUT_MS);

      expect(await pending).toEqual({ ok: false, reason: 'unreachable' });
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it('reports unreachable when the fetch itself throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await mintTokens({ ...MINT_BASE, fetchImpl }, [mintSend()])).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('reports upstream_error on a non-200 rather than inventing tokens', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));

    expect(await mintTokens({ ...MINT_BASE, fetchImpl }, [mintSend()])).toEqual({
      ok: false,
      reason: 'upstream_error',
    });
  });

  it('reports upstream_error on a 200 whose body is not JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));

    expect(await mintTokens({ ...MINT_BASE, fetchImpl }, [mintSend()])).toEqual({
      ok: false,
      reason: 'upstream_error',
    });
  });

  it('reports upstream_error when fewer tokens come back than recipients went out', async () => {
    // A partial mint must never become a partial send: two recipients and
    // one token would otherwise silently mail one person an untracked copy
    // or, worse, reuse another recipient's token.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ tokens: [{ token: TOKEN_A, recipientEmail: 'one@example.com' }] }),
    );

    const result = await mintTokens({ ...MINT_BASE, fetchImpl }, [
      mintSend({ recipientEmail: 'one@example.com' }),
      mintSend({ recipientEmail: 'two@example.com' }),
    ]);

    expect(result).toEqual({ ok: false, reason: 'upstream_error' });
  });

  it('reports upstream_error when the echoed recipients are not in request order', async () => {
    // The contract is order-preserving. If it ever stops being, pairing by
    // index would attach Alice's token to Bob's copy and report both
    // opens under the wrong name — fail closed instead.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        tokens: [
          { token: TOKEN_A, recipientEmail: 'two@example.com' },
          { token: TOKEN_B, recipientEmail: 'one@example.com' },
        ],
      }),
    );

    const result = await mintTokens({ ...MINT_BASE, fetchImpl }, [
      mintSend({ recipientEmail: 'one@example.com' }),
      mintSend({ recipientEmail: 'two@example.com' }),
    ]);

    expect(result).toEqual({ ok: false, reason: 'upstream_error' });
  });

  it('reports upstream_error when a token is missing or empty', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ tokens: [{ token: '', recipientEmail: 'one@example.com' }] }),
    );

    expect(await mintTokens({ ...MINT_BASE, fetchImpl }, [mintSend()])).toEqual({
      ok: false,
      reason: 'upstream_error',
    });
  });

  it('refuses a token carrying characters that would break out of the img src attribute', async () => {
    // The token is interpolated into an HTML attribute in ./build.ts
    // WITHOUT escaping, because the pixel markup is byte-binding (spec
    // §5.1). This boundary check is what makes that safe: a token of
    // `x" onerror="alert(1)` must never reach the builder.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        tokens: [{ token: 'x" onerror="alert(1)', recipientEmail: 'one@example.com' }],
      }),
    );

    expect(await mintTokens({ ...MINT_BASE, fetchImpl }, [mintSend()])).toEqual({
      ok: false,
      reason: 'upstream_error',
    });
  });

  it('never logs a subject or a recipient address when a mint fails', async () => {
    const logged: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500));

    await mintTokens({ ...MINT_BASE, fetchImpl }, [
      mintSend({ recipientEmail: 'secret-person@example.com', subject: 'SENTINEL-SUBJECT' }),
    ]);

    const output = JSON.stringify(logged);
    expect(output).not.toContain('secret-person@example.com');
    expect(output).not.toContain('SENTINEL-SUBJECT');
  });
});

interface RecordedSend {
  readonly options: SendMailOptions;
  readonly startedAt: number;
}

/**
 * A fake transport that records every sendMail call, can be told to fail
 * for one specific envelope recipient, and tracks whether two sends were
 * ever in flight at the same time.
 */
function makeFakeTransport(options: { failFor?: string } = {}) {
  const calls: RecordedSend[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let order = 0;

  const transport = {
    async sendMail(mail: SendMailOptions): Promise<SentMessageInfo> {
      calls.push({ options: mail, startedAt: order++ });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Two turns of the event loop: enough that a Promise.all fan-out
      // would overlap and be caught by maxInFlight below.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;

      const envelopeTo = mail.envelope.to;
      if (options.failFor && envelopeTo.includes(options.failFor)) {
        throw new Error('550 mailbox unavailable');
      }
      return {
        accepted: [...envelopeTo],
        rejected: [],
        response: '250 OK',
        envelope: { from: mail.envelope.from, to: [...envelopeTo] },
        messageId: mail.messageId,
      };
    },
    close(): void {},
  } satisfies Transport;

  return { transport, calls, getMaxInFlight: () => maxInFlight };
}

function sendRequest(overrides: Partial<SendTrackedRequest> = {}): SendTrackedRequest {
  return {
    accountId: 'primary',
    fromEmail: 'primary@example.com',
    to: ['one@example.com', 'two@example.com'],
    cc: ['three@example.com'],
    subject: 'Group subject',
    textBody: 'body text',
    messageId: '<mid@example.com>',
    pixelBase: 'https://track.example',
    recipients: [
      { recipientEmail: 'one@example.com', token: TOKEN_A },
      { recipientEmail: 'two@example.com', token: TOKEN_B },
      { recipientEmail: 'three@example.com', token: TOKEN_C },
    ],
    ...overrides,
  };
}

describe('sendTracked — headers vs envelope (spec §5.3)', () => {
  it('puts the FULL group in To:/Cc: on every copy while the envelope targets ONE recipient', async () => {
    const { transport, calls } = makeFakeTransport();

    await sendTracked({ transport }, sendRequest());

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      // Headers: the whole group, identical on all three copies — the
      // recipients must see a normal group email, not three private ones.
      expect(call.options.to).toEqual(['one@example.com', 'two@example.com']);
      expect(call.options.cc).toEqual(['three@example.com']);
    }

    // Envelope: exactly one RCPT TO per send, and between them they cover
    // the group exactly once. This is the whole point of the per-recipient
    // send — collapse it to `envelope.to = all` and everyone would receive
    // the first recipient's pixel.
    expect(calls.map((call) => call.options.envelope.to)).toEqual([
      ['one@example.com'],
      ['two@example.com'],
      ['three@example.com'],
    ]);
    for (const call of calls) {
      expect(call.options.envelope.to).toHaveLength(1);
      expect(call.options.envelope.from).toBe('primary@example.com');
    }
  });

  it('gives each recipient their OWN token in their OWN copy', async () => {
    const { transport, calls } = makeFakeTransport();

    await sendTracked({ transport }, sendRequest());

    expect(calls[0]!.options.html).toContain(`/o/${TOKEN_A}.png`);
    expect(calls[0]!.options.html).not.toContain(TOKEN_B);
    expect(calls[1]!.options.html).toContain(`/o/${TOKEN_B}.png`);
    expect(calls[2]!.options.html).toContain(`/o/${TOKEN_C}.png`);
  });

  it('sends the same subject, text alternative and From on every copy', async () => {
    const { transport, calls } = makeFakeTransport();

    await sendTracked({ transport }, sendRequest());

    for (const call of calls) {
      expect(call.options.subject).toBe('Group subject');
      expect(call.options.text).toBe('body text');
      expect(call.options.from).toBe('primary@example.com');
    }
  });

  it('formats a display name into From when the identity has one', async () => {
    const { transport, calls } = makeFakeTransport();

    await sendTracked({ transport }, sendRequest({ fromName: 'Valen Li' }));

    expect(calls[0]!.options.from).toBe('"Valen Li" <primary@example.com>');
  });

  it('omits Cc entirely when there are no cc recipients', async () => {
    const { transport, calls } = makeFakeTransport();

    await sendTracked(
      { transport },
      sendRequest({
        to: ['one@example.com'],
        cc: [],
        recipients: [{ recipientEmail: 'one@example.com', token: TOKEN_A }],
      }),
    );

    expect(calls[0]!.options.cc).toBeUndefined();
  });
});

describe('sendTracked — one message id across every copy', () => {
  it('stamps the SAME Message-ID on all N sends', async () => {
    const { transport, calls } = makeFakeTransport();

    await sendTracked({ transport }, sendRequest({ messageId: '<shared@example.com>' }));

    expect(calls.map((call) => call.options.messageId)).toEqual([
      '<shared@example.com>',
      '<shared@example.com>',
      '<shared@example.com>',
    ]);
  });
});

describe('sendTracked — partial failure', () => {
  it('marks only the failing recipient not-ok and keeps sending to the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { transport, calls } = makeFakeTransport({ failFor: 'two@example.com' });

    const results = await sendTracked({ transport }, sendRequest());

    expect(results).toEqual([
      { recipientEmail: 'one@example.com', ok: true },
      { recipientEmail: 'two@example.com', ok: false },
      { recipientEmail: 'three@example.com', ok: true },
    ]);
    // The load-bearing half: the loop did not stop at the failure.
    expect(calls).toHaveLength(3);
  });

  it('marks a recipient not-ok when SMTP resolves but rejects the address', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = {
      async sendMail(mail: SendMailOptions): Promise<SentMessageInfo> {
        return {
          accepted: [],
          rejected: [...mail.envelope.to],
          response: '550 rejected',
          envelope: { from: mail.envelope.from, to: [...mail.envelope.to] },
          messageId: mail.messageId,
        };
      },
      close(): void {},
    } satisfies Transport;

    const results = await sendTracked(
      { transport },
      sendRequest({
        to: ['one@example.com'],
        cc: [],
        recipients: [{ recipientEmail: 'one@example.com', token: TOKEN_A }],
      }),
    );

    expect(results).toEqual([{ recipientEmail: 'one@example.com', ok: false }]);
  });

  it('never logs the subject, body, recipient address or token when a send fails', async () => {
    const logged: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const { transport } = makeFakeTransport({ failFor: 'two@example.com' });

    await sendTracked(
      { transport },
      sendRequest({ subject: 'SENTINEL-SUBJECT', textBody: 'SENTINEL-BODY' }),
    );

    const output = JSON.stringify(logged);
    expect(output).not.toContain('SENTINEL-SUBJECT');
    expect(output).not.toContain('SENTINEL-BODY');
    expect(output).not.toContain('two@example.com');
    expect(output).not.toContain(TOKEN_B);
  });
});

describe('sendTracked — sequential dispatch', () => {
  it('never has two sends in flight at once', async () => {
    // Four accounts against Gmail's per-account limits: a Promise.all
    // fan-out would open N simultaneous SMTP conversations on ONE
    // connection and is exactly what this loop exists not to do.
    const { transport, getMaxInFlight } = makeFakeTransport();

    await sendTracked({ transport }, sendRequest());

    expect(getMaxInFlight()).toBe(1);
  });

  it('dispatches in recipient order', async () => {
    const { transport, calls } = makeFakeTransport();

    await sendTracked({ transport }, sendRequest());

    expect(calls.map((call) => call.options.envelope.to[0])).toEqual([
      'one@example.com',
      'two@example.com',
      'three@example.com',
    ]);
  });

  it('returns an empty result list, and sends nothing, for no recipients', async () => {
    const { transport, calls } = makeFakeTransport();

    const results = await sendTracked({ transport }, sendRequest({ recipients: [] }));

    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('does not mutate the request it is given', async () => {
    const { transport } = makeFakeTransport();
    const request = sendRequest();
    const snapshot = JSON.stringify(request);

    await sendTracked({ transport }, request);

    expect(JSON.stringify(request)).toBe(snapshot);
  });
});
