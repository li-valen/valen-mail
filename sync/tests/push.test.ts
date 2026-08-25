import { describe, it, expect, vi } from 'vitest';
import {
  isValidSubscription,
  shouldPruneOnStatus,
  parseVapidConfig,
  MAX_ENDPOINT_LENGTH,
  MAX_KEY_LENGTH,
} from '../src/push/vapid';
import { sendPush } from '../src/push/send';
import { createRouter } from '../src/api/routes';
import { createRouterFromConfig } from '../src/api/server';
import { makeFakeDb, makeFakePool, readJson, TOKEN, AUTH } from './helpers/api-fakes.ts';

/**
 * Task 6 — Web Push.
 *
 * Two things this suite is deliberately built to prove, because a test
 * that passes whether or not the code exists has already shipped in this
 * project three times:
 *
 *  1. Every predicate is asserted in BOTH directions. `shouldPruneOnStatus`
 *     that returned `true` unconditionally would satisfy "410 prunes"; only
 *     the 429/5xx half catches it, and pruning on a transient failure
 *     silently unsubscribes a real phone with nothing to notice it by.
 *  2. The degraded-config path asserts a warning was actually logged, not
 *     merely that nothing threw. "Doesn't throw" is exactly what a silent
 *     swallow looks like.
 */

const VALID_SUBSCRIPTION = {
  endpoint: 'https://push.example/x',
  keys: { p256dh: 'a', auth: 'b' },
};

const VAPID = {
  publicKey: 'test-public-key',
  privateKey: 'test-private-key',
  subject: 'https://postbox.example',
};

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe('isValidSubscription', () => {
  it('accepts a well-formed subscription', () => {
    expect(isValidSubscription(VALID_SUBSCRIPTION)).toBe(true);
  });

  it('rejects a missing endpoint', () => {
    expect(isValidSubscription({ keys: { p256dh: 'a', auth: 'b' } })).toBe(false);
  });

  it('rejects missing keys entirely', () => {
    expect(isValidSubscription({ endpoint: 'https://push.example/x' })).toBe(false);
  });

  it('rejects a keys object missing p256dh, and one missing auth', () => {
    expect(isValidSubscription({ endpoint: 'https://push.example/x', keys: { auth: 'b' } })).toBe(
      false,
    );
    expect(isValidSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: 'a' } })).toBe(
      false,
    );
  });

  it('rejects empty-string key material', () => {
    expect(
      isValidSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: '', auth: 'b' } }),
    ).toBe(false);
    expect(
      isValidSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: '' } }),
    ).toBe(false);
  });

  it('rejects a non-https endpoint', () => {
    expect(
      isValidSubscription({
        endpoint: 'http://push.example/x',
        keys: { p256dh: 'a', auth: 'b' },
      }),
    ).toBe(false);
  });

  it('rejects an endpoint that is not a URL at all', () => {
    expect(isValidSubscription({ endpoint: 'not a url', keys: { p256dh: 'a', auth: 'b' } })).toBe(
      false,
    );
  });

  it('rejects an endpoint longer than the column can index', () => {
    const tooLong = `https://push.example/${'x'.repeat(MAX_ENDPOINT_LENGTH)}`;
    expect(isValidSubscription({ ...VALID_SUBSCRIPTION, endpoint: tooLong })).toBe(false);
  });

  it('rejects oversized key material', () => {
    const tooLong = 'k'.repeat(MAX_KEY_LENGTH + 1);
    expect(
      isValidSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: tooLong, auth: 'b' } }),
    ).toBe(false);
  });

  it('rejects a non-object without throwing', () => {
    expect(isValidSubscription(null)).toBe(false);
    expect(isValidSubscription(undefined)).toBe(false);
    expect(isValidSubscription('nope')).toBe(false);
    expect(isValidSubscription(42)).toBe(false);
    expect(isValidSubscription(['https://push.example/x'])).toBe(false);
  });

  it('rejects non-string key material rather than coercing it', () => {
    expect(
      isValidSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: 1, auth: 2 } }),
    ).toBe(false);
    expect(isValidSubscription({ endpoint: 123, keys: { p256dh: 'a', auth: 'b' } })).toBe(false);
  });
});

describe('shouldPruneOnStatus', () => {
  it('prunes a subscription the push service says is gone', () => {
    expect(shouldPruneOnStatus(404)).toBe(true);
    expect(shouldPruneOnStatus(410)).toBe(true);
  });

  it('keeps a subscription on a transient failure', () => {
    // The load-bearing half. A `shouldPruneOnStatus` that returned true
    // unconditionally passes the block above and fails here — pruning on a
    // 429 or a 503 silently unsubscribes the user's phone, and nothing in
    // the product would ever surface that it happened.
    expect(shouldPruneOnStatus(429)).toBe(false);
    expect(shouldPruneOnStatus(500)).toBe(false);
    expect(shouldPruneOnStatus(502)).toBe(false);
    expect(shouldPruneOnStatus(503)).toBe(false);
  });

  it('keeps a subscription on a client error that is not "gone"', () => {
    expect(shouldPruneOnStatus(400)).toBe(false);
    expect(shouldPruneOnStatus(401)).toBe(false);
    expect(shouldPruneOnStatus(403)).toBe(false);
    expect(shouldPruneOnStatus(413)).toBe(false);
  });

  it('does not prune on a success status', () => {
    expect(shouldPruneOnStatus(200)).toBe(false);
    expect(shouldPruneOnStatus(201)).toBe(false);
  });
});

/**
 * The degraded path. Mirrors loadConfig's trackingConfig rule and is
 * deliberately unlike the fail-closed rule that governs API_TOKEN: email
 * sync is this service's primary job and must not be held hostage to a
 * secondary feature. So a missing key returns null AND says so loudly —
 * both halves asserted, because a silent `return null` would pass the
 * first assertion on its own.
 */
describe('parseVapidConfig', () => {
  it('is null and warns when both keys are absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseVapidConfig(envWith({}))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is null and warns when only the public key is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseVapidConfig(envWith({ VAPID_PUBLIC_KEY: 'pub' }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is null and warns when only the private key is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseVapidConfig(envWith({ VAPID_PRIVATE_KEY: 'priv' }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('is null and warns when VAPID_SUBJECT is present but unusable', () => {
    // RFC 8292 §2.1: the `sub` claim must be a mailto: or an https: URL.
    // A bare hostname produces a JWT every push service rejects, which is
    // strictly worse than not being configured at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      parseVapidConfig(
        envWith({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'postbox' }),
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('returns a populated config and does not warn when both keys are set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = parseVapidConfig(
      envWith({
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: 'https://postbox.example',
      }),
    );
    expect(config).toEqual({
      publicKey: 'pub',
      privateKey: 'priv',
      subject: 'https://postbox.example',
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never puts the private key into a warning message', () => {
    const secret = 'super-secret-vapid-private-key-value';
    const warnings: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args);
    });
    // Public key absent, private present: the one shape where a naive
    // "here is what I got" warning would print the secret.
    parseVapidConfig(envWith({ VAPID_PRIVATE_KEY: secret }));
    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnings)).not.toContain(secret);
    warn.mockRestore();
  });

  it('does not mutate the env object it is given', () => {
    const env = envWith({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });
    const before = { ...env };
    parseVapidConfig(env);
    expect(env).toEqual(before);
  });
});

describe('sendPush', () => {
  it('reports success and no prune when the push service accepts it', async () => {
    const sendImpl = vi.fn(async () => ({ statusCode: 201 }));
    const result = await sendPush(VALID_SUBSCRIPTION, { title: 'Hi' }, VAPID, sendImpl);
    expect(result).toEqual({ ok: true, prune: false });
    expect(sendImpl).toHaveBeenCalledTimes(1);
  });

  it('asks for a prune when the push service says the subscription is gone', async () => {
    const sendImpl = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    });
    expect(await sendPush(VALID_SUBSCRIPTION, { title: 'Hi' }, VAPID, sendImpl)).toEqual({
      ok: false,
      prune: true,
    });
  });

  it('does NOT ask for a prune on a transient failure', async () => {
    const sendImpl = vi.fn(async () => {
      throw Object.assign(new Error('slow down'), { statusCode: 429 });
    });
    expect(await sendPush(VALID_SUBSCRIPTION, { title: 'Hi' }, VAPID, sendImpl)).toEqual({
      ok: false,
      prune: false,
    });
  });

  it('does not throw, and does not prune, when the failure carries no status at all', async () => {
    const sendImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    expect(await sendPush(VALID_SUBSCRIPTION, { title: 'Hi' }, VAPID, sendImpl)).toEqual({
      ok: false,
      prune: false,
    });
  });

  it('never logs the endpoint, which carries the subscription secret', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const endpoint = 'https://push.example/SECRET-SUBSCRIPTION-PATH';
    const sendImpl = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    });
    await sendPush({ ...VALID_SUBSCRIPTION, endpoint }, { title: 'Hi' }, VAPID, sendImpl);
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).not.toContain('SECRET-SUBSCRIPTION-PATH');
    spy.mockRestore();
  });

  it('does not mutate the subscription it is handed', async () => {
    const subscription = { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } };
    const snapshot = JSON.stringify(subscription);
    await sendPush(subscription, { title: 'Hi' }, VAPID, async () => ({ statusCode: 201 }));
    expect(JSON.stringify(subscription)).toBe(snapshot);
  });
});

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function makeRecordingDb(): { db: never; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const db = makeFakeDb({
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return [];
    },
  });
  return { db, calls };
}

const FAKE_POOL = makeFakePool().pool;

function routerWith(vapid: typeof VAPID | null, db: never = makeFakeDb()) {
  return createRouter(db, FAKE_POOL, TOKEN, null, undefined, vapid);
}

describe('GET /api/push/key', () => {
  it('returns the public key when push is configured', async () => {
    const response = await routerWith(VAPID)(
      new Request('http://x/api/push/key', { headers: AUTH }),
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ available: true, publicKey: VAPID.publicKey });
  });

  it('reports unavailable, not an error, when the keys are missing', async () => {
    const response = await routerWith(null)(
      new Request('http://x/api/push/key', { headers: AUTH }),
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ available: false, publicKey: null });
  });

  it('never returns the private key', async () => {
    const response = await routerWith(VAPID)(
      new Request('http://x/api/push/key', { headers: AUTH }),
    );
    expect(JSON.stringify(await readJson(response))).not.toContain(VAPID.privateKey);
  });

  it('is not cached', async () => {
    const response = await routerWith(VAPID)(
      new Request('http://x/api/push/key', { headers: AUTH }),
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('requires a credential', async () => {
    const response = await routerWith(VAPID)(new Request('http://x/api/push/key'));
    expect(response.status).toBe(401);
  });
});

describe('POST /api/push/subscribe', () => {
  function postBody(body: unknown): Request {
    return new Request('http://x/api/push/subscribe', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('stores a well-formed subscription and answers 204', async () => {
    const { db, calls } = makeRecordingDb();
    const response = await routerWith(VAPID, db)(postBody(VALID_SUBSCRIPTION));
    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/insert into push_subscriptions/);
    expect(calls[0]!.values.slice(0, 3)).toEqual(['https://push.example/x', 'a', 'b']);
  });

  it('uses placeholders, never route data interpolated into SQL', async () => {
    const { db, calls } = makeRecordingDb();
    await routerWith(VAPID, db)(postBody(VALID_SUBSCRIPTION));
    expect(calls[0]!.text).not.toContain('https://push.example/x');
    expect(calls[0]!.text).toMatch(/\$1/);
  });

  it('accepts an optional label and stores it', async () => {
    const { db, calls } = makeRecordingDb();
    await routerWith(VAPID, db)(postBody({ ...VALID_SUBSCRIPTION, label: 'iPhone' }));
    expect(calls[0]!.values[3]).toBe('iPhone');
  });

  it('stores a null label when none is given', async () => {
    const { db, calls } = makeRecordingDb();
    await routerWith(VAPID, db)(postBody(VALID_SUBSCRIPTION));
    expect(calls[0]!.values[3]).toBeNull();
  });

  it('drops a label that is not a usable string rather than refusing the subscription', async () => {
    const { db, calls } = makeRecordingDb();
    await routerWith(VAPID, db)(postBody({ ...VALID_SUBSCRIPTION, label: { evil: true } }));
    expect(calls[0]!.values[3]).toBeNull();
  });

  it('refuses a malformed subscription with 400 and writes nothing', async () => {
    const { db, calls } = makeRecordingDb();
    const response = await routerWith(VAPID, db)(postBody({ endpoint: 'http://push.example/x' }));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses a body that is not JSON with 400 and writes nothing', async () => {
    const { db, calls } = makeRecordingDb();
    const request = new Request('http://x/api/push/subscribe', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: '{not json',
    });
    const response = await routerWith(VAPID, db)(request);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('reports 503 and writes nothing when push is not configured', async () => {
    // Storing a subscription that can never be delivered to is worse than
    // refusing it: the client would render "on" for a feature that is off.
    const { db, calls } = makeRecordingDb();
    const response = await routerWith(null, db)(postBody(VALID_SUBSCRIPTION));
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('requires a credential', async () => {
    const request = new Request('http://x/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_SUBSCRIPTION),
    });
    expect((await routerWith(VAPID)(request)).status).toBe(401);
  });
});

describe('DELETE /api/push/subscribe', () => {
  function deleteBody(body: unknown): Request {
    return new Request('http://x/api/push/subscribe', {
      method: 'DELETE',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('deletes the row for the endpoint and answers 204', async () => {
    const { db, calls } = makeRecordingDb();
    const response = await routerWith(VAPID, db)(
      deleteBody({ endpoint: 'https://push.example/x' }),
    );
    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/delete from push_subscriptions/);
    expect(calls[0]!.values).toEqual(['https://push.example/x']);
  });

  it('refuses a missing or malformed endpoint with 400 and deletes nothing', async () => {
    const { db, calls } = makeRecordingDb();
    expect((await routerWith(VAPID, db)(deleteBody({}))).status).toBe(400);
    expect((await routerWith(VAPID, db)(deleteBody({ endpoint: 42 }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('still works when push is unconfigured, so a client can always turn it off', async () => {
    // The reverse of subscribe: if the keys were removed while a device
    // held a subscription, "turn it off" must still clear the stored row.
    const { db, calls } = makeRecordingDb();
    const response = await routerWith(null, db)(deleteBody({ endpoint: 'https://push.example/x' }));
    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
  });

  it('requires a credential', async () => {
    const request = new Request('http://x/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/x' }),
    });
    expect((await routerWith(VAPID)(request)).status).toBe(401);
  });
});

describe('push route registration does not disturb the existing router', () => {
  it('leaves an unknown /api path a 404, not a push response', async () => {
    const response = await routerWith(VAPID)(new Request('http://x/api/nope', { headers: AUTH }));
    expect(response.status).toBe(404);
  });

  it('adds no catch-all of its own: a non-/api path with no built client at its static root is still 404', async () => {
    // Task 8 gave non-/api paths real behaviour (static files, SPA
    // fallback) — this router just has nothing built at the static root it
    // was given, so the assertion is still "push registration alone adds
    // no route here", not "Task 8 never shipped". A nonexistent root is
    // passed explicitly rather than relying on the default (which resolves
    // to the real sync/public and would make this test's outcome depend on
    // whatever happens to be built there at run time).
    const router = createRouter(
      makeFakeDb(),
      FAKE_POOL,
      TOKEN,
      null,
      undefined,
      VAPID,
      '/nonexistent-static-root-for-push-test',
    );
    const response = await router(new Request('http://x/index.html', { headers: AUTH }));
    expect(response.status).toBe(404);
  });

  it('a PUT to the subscribe path is 404, not a silent success', async () => {
    const request = new Request('http://x/api/push/subscribe', { method: 'PUT', headers: AUTH });
    expect((await routerWith(VAPID)(request)).status).toBe(404);
  });
});

// =====================================================================
// Fix round 1
// =====================================================================

/**
 * Fix 1. `sendPush` bounds every payload field before serialising.
 *
 * Before this, an email with a pathological subject produced a payload
 * over the ~4 KB every push service enforces. It degraded safely — 413,
 * no subscription pruned — but the notification was SILENTLY LOST, which
 * is exactly the confident-wrong-answer this product exists to refuse.
 */
describe('sendPush payload bounds', () => {
  /** A subject an attacker would actually send: long, with astral-plane
   *  characters (2 UTF-16 units, 4 UTF-8 bytes each). */
  const PATHOLOGICAL = `${'\u{1F600}'.repeat(2000)} ${'x'.repeat(5000)}`;

  /** Control characters, which JSON.stringify escapes to six bytes each
   *  (\u0007) — the case that makes a character-count bound insufficient
   *  as a byte-count guarantee. */
  const WITH_CONTROLS = `a\u0007b\u0008c`;

  function capture() {
    const sent: string[] = [];
    const sendImpl = async (_s: unknown, payload: string) => {
      sent.push(payload);
      return { statusCode: 201 };
    };
    return { sent, sendImpl: sendImpl as never };
  }

  it('keeps a pathological subject deliverable, under the 4KB push limit', async () => {
    const { sent, sendImpl } = capture();
    const result = await sendPush(
      VALID_SUBSCRIPTION,
      {
        title: PATHOLOGICAL,
        body: PATHOLOGICAL,
        url: `/m/${'y'.repeat(5000)}`,
        tag: 'z'.repeat(500),
      },
      VAPID,
      sendImpl,
    );
    expect(result).toEqual({ ok: true, prune: false });
    // The assertion that matters: measured BYTES, not character count.
    expect(Buffer.byteLength(sent[0]!, 'utf8')).toBeLessThan(4096);
  });

  it('truncates rather than dropping — the notification still says something', async () => {
    const { sent, sendImpl } = capture();
    await sendPush(VALID_SUBSCRIPTION, { title: `Re: ${'x'.repeat(5000)}` }, VAPID, sendImpl);
    const payload = JSON.parse(sent[0]!) as { title: string };
    expect(payload.title).toHaveLength(120);
    expect(payload.title.startsWith('Re: ')).toBe(true);
  });

  it('bounds the body to the same length sw.js expects', async () => {
    const { sent, sendImpl } = capture();
    await sendPush(VALID_SUBSCRIPTION, { title: 'T', body: 'b'.repeat(5000) }, VAPID, sendImpl);
    expect((JSON.parse(sent[0]!) as { body: string }).body).toHaveLength(300);
  });

  it('strips control characters, which JSON would escape to six bytes each', async () => {
    const { sent, sendImpl } = capture();
    await sendPush(VALID_SUBSCRIPTION, { title: WITH_CONTROLS }, VAPID, sendImpl);
    expect((JSON.parse(sent[0]!) as { title: string }).title).toBe('a b c');
  });

  it('falls back to a usable title when the subject bounds away to nothing', async () => {
    const { sent, sendImpl } = capture();
    await sendPush(VALID_SUBSCRIPTION, { title: '   ' }, VAPID, sendImpl);
    expect((JSON.parse(sent[0]!) as { title: string }).title).toBe('Postbox');
  });

  it('leaves an absent optional field absent rather than sending an empty string', async () => {
    const { sent, sendImpl } = capture();
    await sendPush(VALID_SUBSCRIPTION, { title: 'T' }, VAPID, sendImpl);
    expect(Object.keys(JSON.parse(sent[0]!) as object)).toEqual(['title']);
  });

  it('passes an ordinary payload through unchanged', async () => {
    const { sent, sendImpl } = capture();
    const payload = {
      title: 'Re: lunch',
      body: 'from ada@example.com',
      url: '/thread/42',
      tag: 't42',
    };
    await sendPush(VALID_SUBSCRIPTION, payload, VAPID, sendImpl);
    expect(JSON.parse(sent[0]!)).toEqual(payload);
  });

  it('does not mutate the payload it is handed', async () => {
    const payload = { title: `Re: ${'x'.repeat(5000)}`, body: WITH_CONTROLS };
    const snapshot = JSON.stringify(payload);
    await sendPush(VALID_SUBSCRIPTION, payload, VAPID, async () => ({ statusCode: 201 }));
    expect(JSON.stringify(payload)).toBe(snapshot);
  });
});

/**
 * Fix 8. `isUsableSubject`'s mailto: arm, which RFC 8292 §2.1 permits
 * alongside https: and which nothing exercised.
 */
describe('parseVapidConfig — the mailto: subject arm', () => {
  it('accepts a mailto: subject', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      parseVapidConfig(
        envWith({
          VAPID_PUBLIC_KEY: 'pub',
          VAPID_PRIVATE_KEY: 'priv',
          VAPID_SUBJECT: 'mailto:ops@example.com',
        }),
      ),
    ).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects a bare "mailto:" carrying no address', () => {
    // The inverse fixture. A plain `startsWith('mailto:')` with no length
    // test passes this and signs every JWT with an empty contact.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      parseVapidConfig(
        envWith({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:' }),
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/**
 * Fix 2. The seam between loadConfig and createRouter.
 *
 * parseVapidConfig was tested exhaustively and createRouter was tested
 * with an injected config, but nothing tested the ARGUMENT LIST joining
 * them — so deleting `config.vapidConfig` from server.ts left all 331
 * tests green while production reported push unavailable forever. These
 * drive the real exported seam, so that deletion now fails here.
 */
describe('createRouterFromConfig — the server.ts wiring', () => {
  const BASE_CONFIG = {
    accounts: [],
    databaseUrl: 'postgresql://localhost/x',
    port: 8080,
    trackingConfig: null,
  };

  function routerFor(overrides: Record<string, unknown>, db: never = makeFakeDb()) {
    return createRouterFromConfig(db, FAKE_POOL, TOKEN, {
      ...BASE_CONFIG,
      ...overrides,
    } as never);
  }

  it('passes vapidConfig through, so GET /api/push/key reports the real key', async () => {
    const response = await routerFor({ vapidConfig: VAPID })(
      new Request('http://x/api/push/key', { headers: AUTH }),
    );
    expect(await readJson(response)).toEqual({ available: true, publicKey: VAPID.publicKey });
  });

  it('reports unavailable when the config carries no keypair', async () => {
    const response = await routerFor({ vapidConfig: null })(
      new Request('http://x/api/push/key', { headers: AUTH }),
    );
    expect(await readJson(response)).toEqual({ available: false, publicKey: null });
  });

  it('accepts a real subscription, proving vapidConfig reached the write path too', async () => {
    // The key route alone would still pass if vapidConfig were somehow
    // wired to it but not to the router as a whole; POST answers 503
    // without it, so this covers the other branch that reads the config.
    const { db, calls } = makeRecordingDb();
    const response = await routerFor({ vapidConfig: VAPID }, db)(
      new Request('http://x/api/push/subscribe', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(VALID_SUBSCRIPTION),
      }),
    );
    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
  });

  it('still passes trackingConfig through — one argument list carries both', async () => {
    // Deliberately a MALFORMED baseUrl, so fetchOpens throws inside its own
    // `new URL` and degrades without ever touching the network — a version
    // of this test with a plausible hostname spent 1.3s on a real DNS
    // lookup, which is not something a unit suite should do.
    //
    // The spy is what makes it causal. Both a correctly-wired non-null
    // trackingConfig and a dropped one answer 200, so the status alone
    // proves nothing; only the wired one reaches fetchOpens and logs
    // 'opens: tracking service unreachable'. Drop the argument, or
    // transpose it with fetchImpl, and this assertion fails.
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });

    const response = await routerFor({
      trackingConfig: { baseUrl: 'not a url', readToken: 'r'.repeat(32) },
      vapidConfig: null,
    })(new Request('http://x/api/opens', { headers: AUTH }));

    spy.mockRestore();
    expect(response.status).toBe(200);
    expect(errors.some((line) => line.includes('tracking service unreachable'))).toBe(true);
  });
});
