import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchOpens, REQUEST_TIMEOUT_MS } from '../src/api/opens';

/**
 * Unit tests for fetchOpens: the module that reaches across the network
 * boundary to the tracking service. Every test here injects fetchImpl —
 * never a live network call — per Amendment: tests must be hermetic.
 *
 * Amendment 1 changed the return shape from `readonly OpenEvent[]` to a
 * discriminated OpensResult so "unreachable" and "nobody has opened
 * anything" are distinguishable. These tests assert on `result.ok` and
 * `result.reason` explicitly rather than only checking `opens: []`, which
 * is the mutation-testable version of the failure-mode assertions: a
 * fetchOpens that always returned `{ ok: true, opens: [] }` on failure
 * would fail every one of the `ok === false` assertions below.
 */

const BASE = { baseUrl: 'https://t.example', token: 't'.repeat(32) };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchOpens', () => {
  it('aborts and reports unreachable when the tracking service never responds within REQUEST_TIMEOUT_MS', async () => {
    // Fix 1 (fix round 1 review): `fetchStub.mockRejectedValue(...)` in the
    // test below this one reaches the same catch block a real timeout
    // would, so it looks like timeout coverage without being any — deleting
    // `signal: controller.signal` from fetchOpens still passes every other
    // test in this file. This test is the one that actually depends on the
    // timer firing and the abort signal being wired to the fetch call: a
    // fetchImpl that never settles on its own, and only rejects when its
    // AbortSignal fires.
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('The operation was aborted'));
          });
        });
      });
      const pending = fetchOpens(50, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      const out = await pending;
      expect(out).toEqual({ ok: false, reason: 'unreachable' });
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it('reports unreachable and logs when the tracking service is unreachable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchStub = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await fetchOpens(50, { ...BASE, fetchImpl: fetchStub });
    expect(out).toEqual({ ok: false, reason: 'unreachable' });
    expect(spy).toHaveBeenCalled();
  });

  it('reports upstream_error and logs on a non-200 rather than throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchStub = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const out = await fetchOpens(50, { ...BASE, fetchImpl: fetchStub });
    expect(out).toEqual({ ok: false, reason: 'upstream_error' });
    expect(spy).toHaveBeenCalled();
  });

  it('reports upstream_error on a 200 with a body that is not valid JSON', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchStub = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const out = await fetchOpens(50, { ...BASE, fetchImpl: fetchStub });
    expect(out).toEqual({ ok: false, reason: 'upstream_error' });
    expect(spy).toHaveBeenCalled();
  });

  it('passes the bearer token and never puts it in the URL', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await fetchOpens(50, { baseUrl: 'https://t.example', token: 'z'.repeat(32), fetchImpl: fetchStub });
    const [calledUrl, init] = fetchStub.mock.calls[0]!;
    expect(String(calledUrl)).not.toContain('z'.repeat(32));
    expect(init.headers.authorization).toBe(`Bearer ${'z'.repeat(32)}`);
  });

  it('clamps the limit it forwards', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await fetchOpens(999999, { ...BASE, fetchImpl: fetchStub });
    expect(String(fetchStub.mock.calls[0]![0])).toContain('limit=200');
  });

  it('returns ok:true with parsed opens on success, preserving numeric sentAt/occurredAt', async () => {
    const event = {
      token: 'abc123',
      recipientEmail: 'li.valen.008@gmail.com',
      subject: 'hello',
      sentAt: 1787535607578,
      occurredAt: 1787599793591,
      classification: 'mpp',
      deviceClass: 'unknown',
      os: null,
    };
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [event] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const out = await fetchOpens(50, { ...BASE, fetchImpl: fetchStub });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.opens).toEqual([event]);
      expect(typeof out.opens[0]!.sentAt).toBe('number');
      expect(typeof out.opens[0]!.occurredAt).toBe('number');
    }
  });

  it('accepts an unrecognised classification value rather than rejecting the element', async () => {
    // Amendment 2: classification must not be narrowed to a union — a
    // future classifier value must not break parsing.
    const event = {
      token: 'abc123',
      recipientEmail: 'x@example.com',
      subject: null,
      sentAt: 1,
      occurredAt: 2,
      classification: 'some-future-value',
      deviceClass: null,
      os: null,
    };
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [event] }), { status: 200 }),
    );
    const out = await fetchOpens(50, { ...BASE, fetchImpl: fetchStub });
    expect(out).toEqual({ ok: true, opens: [event] });
  });

  it('drops elements missing a string token or numeric occurredAt, keeps the valid ones, and logs once', async () => {
    // Amendment 3: boundary validation. This would fail if the predicate
    // were deleted (all three elements would come back, including the two
    // malformed ones) or inverted (the valid element would be dropped
    // instead of kept).
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const valid = {
      token: 'good-token',
      recipientEmail: 'x@example.com',
      subject: null,
      sentAt: 1,
      occurredAt: 2,
      classification: 'open',
      deviceClass: null,
      os: null,
    };
    const missingToken = { ...valid, token: undefined };
    const nonNumericOccurredAt = { ...valid, occurredAt: 'not-a-number' };
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ opens: [valid, missingToken, nonNumericOccurredAt] }), { status: 200 }),
    );
    const out = await fetchOpens(50, { ...BASE, fetchImpl: fetchStub });
    expect(out).toEqual({ ok: true, opens: [valid] });
    // Logged once, not once per dropped element.
    const dropLogCalls = spy.mock.calls.filter((call) => String(call[0]).includes('dropped'));
    expect(dropLogCalls).toHaveLength(1);
  });

  it('treats a response whose body has no opens array as zero results, not a crash', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const out = await fetchOpens(50, { ...BASE, fetchImpl: fetchStub });
    expect(out).toEqual({ ok: true, opens: [] });
  });

  it('never includes the token in any logged message', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const secretToken = 'super-secret-token-value-1234567890';
    const fetchStub = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await fetchOpens(50, { baseUrl: 'https://t.example', token: secretToken, fetchImpl: fetchStub });
    const serialized = JSON.stringify(errors);
    expect(serialized).not.toContain(secretToken);
  });
});
