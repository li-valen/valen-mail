import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { toWebRequest, writeWebResponse, MAX_REQUEST_BODY_BYTES } from '../src/api/server';
import { createRouter } from '../src/api/routes';
import { TOKEN, makeFakeDb, makeFakePool } from './helpers/api-fakes.ts';

/**
 * POST /api/session is the first route in this service that reads a
 * request BODY. The Node-to-Web request adapter previously forwarded only
 * the method, URL and headers, so a route reading `request.json()` would
 * work perfectly in a test that constructs a `Request` by hand and fail
 * with an empty body against the real HTTP server — exactly the class of
 * "green tests, broken service" defect this project has already shipped
 * once. These tests cover the adapter itself.
 */

function fakeIncoming(options: {
  method: string;
  url?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
}): IncomingMessage {
  const stream = new PassThrough();
  if (options.body !== undefined) stream.end(options.body);
  else stream.end();
  return Object.assign(stream, {
    method: options.method,
    url: options.url ?? '/api/session',
    headers: options.headers ?? {},
  }) as unknown as IncomingMessage;
}

describe('toWebRequest', () => {
  it('forwards a POST body so a route can actually read it', async () => {
    const request = await toWebRequest(fakeIncoming({
      method: 'POST',
      body: JSON.stringify({ token: 'abc' }),
    }));
    expect(request).not.toBeNull();
    expect(await request!.json()).toEqual({ token: 'abc' });
  });

  it('forwards headers and method unchanged', async () => {
    const request = await toWebRequest(fakeIncoming({
      method: 'DELETE',
      headers: { cookie: 'postbox_session=abc', 'x-multi': 'one' },
    }));
    expect(request!.method).toBe('DELETE');
    expect(request!.headers.get('cookie')).toBe('postbox_session=abc');
  });

  it('builds a bodyless request for GET without hanging on the stream', async () => {
    const request = await toWebRequest(fakeIncoming({ method: 'GET', url: '/api/inbox' }));
    expect(request!.method).toBe('GET');
    expect(request!.body).toBeNull();
  });

  it('refuses a body over the cap instead of buffering it', async () => {
    const oversized = 'a'.repeat(MAX_REQUEST_BODY_BYTES + 1);
    expect(await toWebRequest(fakeIncoming({ method: 'POST', body: oversized }))).toBeNull();
  });

  it('accepts a body exactly at the cap', async () => {
    const atCap = 'a'.repeat(MAX_REQUEST_BODY_BYTES);
    const request = await toWebRequest(fakeIncoming({ method: 'POST', body: atCap }));
    expect(request).not.toBeNull();
    expect((await request!.text()).length).toBe(MAX_REQUEST_BODY_BYTES);
  });
});

describe('writeWebResponse / Set-Cookie', () => {
  it('writes two Set-Cookie headers as two headers, not one comma-joined value', async () => {
    // `Object.fromEntries(headers)` collapses repeated headers into a
    // single comma-joined string. For every other header that is correct;
    // for Set-Cookie it produces one malformed cookie out of two good
    // ones. Only `getSetCookie()` keeps them apart. This service sends one
    // cookie today, so this is the only place the distinction is
    // observable — which is precisely why it is asserted here rather than
    // left to be discovered by whoever adds the second one.
    const response = new Response(null, { status: 204 });
    response.headers.append('set-cookie', 'a=1; Path=/');
    response.headers.append('set-cookie', 'b=2; Path=/');

    const written: Array<[number, unknown]> = [];
    const nodeResponse = {
      writeHead(status: number, headers: unknown) {
        written.push([status, headers]);
        return this;
      },
      end() {},
    } as unknown as ServerResponse;

    await writeWebResponse(response, nodeResponse);

    const headers = written[0]?.[1] as Record<string, string | string[]>;
    expect(headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });
});

/**
 * One end-to-end pass over a REAL http.Server, because every other test in
 * this file and in session-route.test.ts constructs a `Request` by hand.
 * Two things only a real socket can prove: that a POST body survives the
 * Node-to-Web adapter, and that `Set-Cookie` survives `writeWebResponse`
 * intact rather than being flattened by `Object.fromEntries`.
 */
describe('the session cookie over a real HTTP server', () => {
  it('round-trips POST /api/session then authenticates the inbox with the cookie it set', async () => {
    const router = createRouter(makeFakeDb(), makeFakePool().pool, TOKEN);
    const server = createServer((nodeRequest, nodeResponse) => {
      void (async () => {
        const request = await toWebRequest(nodeRequest);
        if (!request) {
          nodeResponse.writeHead(413).end();
          return;
        }
        await writeWebResponse(await router(request), nodeResponse);
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const login = await fetch(`${base}/api/session`, {
        method: 'POST',
        body: JSON.stringify({ token: TOKEN }),
      });
      expect(login.status).toBe(204);

      const setCookie = login.headers.getSetCookie();
      expect(setCookie).toHaveLength(1);
      expect(setCookie[0]).toContain('HttpOnly');
      expect(setCookie[0]).not.toContain(TOKEN);

      const cookie = (setCookie[0] ?? '').split(';')[0] ?? '';
      const inbox = await fetch(`${base}/api/inbox`, { headers: { cookie } });
      expect(inbox.status).toBe(200);

      const unauthenticated = await fetch(`${base}/api/inbox`);
      expect(unauthenticated.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('refuses an oversized body at the socket rather than buffering it', async () => {
    const router = createRouter(makeFakeDb(), makeFakePool().pool, TOKEN);
    const server = createServer((nodeRequest, nodeResponse) => {
      void (async () => {
        const request = await toWebRequest(nodeRequest);
        if (!request) {
          nodeResponse.writeHead(413, { 'content-type': 'application/json' });
          nodeResponse.end(JSON.stringify({ error: 'request body too large' }));
          return;
        }
        await writeWebResponse(await router(request), nodeResponse);
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    try {
      // Deliberately a body that WOULD succeed if the cap were removed: a
      // valid JSON object carrying the correct token, padded past the
      // limit. A body of junk would be rejected as unparsable JSON with or
      // without the cap, and this test would prove nothing.
      const oversized = JSON.stringify({
        token: TOKEN,
        pad: 'a'.repeat(MAX_REQUEST_BODY_BYTES),
      });
      expect(oversized.length).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);

      const response = await fetch(`http://127.0.0.1:${address.port}/api/session`, {
        method: 'POST',
        body: oversized,
      }).catch(() => null);

      // Node may reset the connection when the request stream is destroyed
      // mid-upload, so a refused connection counts as a refusal too — but
      // a 204 (a session issued from a body that was never fully read)
      // does not, and that is exactly what would happen without the cap.
      expect(response?.status).not.toBe(204);
      if (response) expect(response.status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
