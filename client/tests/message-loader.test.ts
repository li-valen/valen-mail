import { describe, expect, it, vi } from 'vitest';
import type { ParsedMessage } from '../src/api';
import { MessageCache } from '../src/messageCache';
import {
  loadMessage,
  readCachedMessage,
  refetchMessage,
  targetFor,
} from '../src/messageLoader';

/**
 * The reader's open path: cache first, network only on a miss.
 *
 * This is where "instant" is actually decided, and it lives in a module
 * rather than inside MessageView's effect precisely so it can be asserted
 * — client/CLAUDE.md's standing constraint is that no test here renders a
 * component, so a cache check written inline in an effect would be a
 * claim nothing could hold.
 */

function messageOf(html: string): ParsedMessage {
  return {
    html,
    text: null,
    subject: null,
    from: null,
    to: [],
    cc: [],
    date: null,
    attachments: [],
  };
}

const TARGET = { account_id: 'primary', folder: 'INBOX', uid: '42' };

describe('loadMessage', () => {
  it('makes NO network call for a message already cached', async () => {
    // THE assertion this whole feature exists for. Not "returns fast",
    // not "returns the cached value as well" — the fetch is never
    // attempted at all.
    const cache = new MessageCache();
    const cached = messageOf('<p>already here</p>');
    cache.set(TARGET, cached);
    const fetchImpl = vi.fn();

    const outcome = loadMessage(cache, TARGET, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('cached');
  });

  it('hands a cached message back SYNCHRONOUSLY, not as a resolved promise', () => {
    // A `Promise` that happens to be already resolved still delivers on a
    // microtask, which is one frame with state and nothing to render —
    // a loading flash for a message that was in memory the whole time.
    const cache = new MessageCache();
    const cached = messageOf('<p>hi</p>');
    cache.set(TARGET, cached);

    const outcome = loadMessage(cache, TARGET, vi.fn());

    expect(outcome).toEqual({ kind: 'cached', parsed: cached });
    if (outcome.kind === 'cached') expect(outcome.parsed).toBe(cached);
  });

  it('fetches on a miss and caches what comes back', async () => {
    const cache = new MessageCache();
    const fetched = messageOf('<p>from the wire</p>');
    const fetchImpl = vi.fn().mockResolvedValue(fetched);

    const outcome = loadMessage(cache, TARGET, fetchImpl);
    expect(outcome.kind).toBe('pending');
    if (outcome.kind !== 'pending') return;

    await expect(outcome.parsed).resolves.toBe(fetched);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // And the SECOND open is now free.
    expect(loadMessage(cache, TARGET, fetchImpl).kind).toBe('cached');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes the target through as the three path segments the API takes', async () => {
    const cache = new MessageCache();
    const fetchImpl = vi.fn().mockResolvedValue(messageOf(''));
    const outcome = loadMessage(cache, { account_id: 'harvard', folder: '[Gmail]/Sent Mail', uid: '7' }, fetchImpl);
    if (outcome.kind === 'pending') await outcome.parsed;
    expect(fetchImpl.mock.calls[0]?.[0]).toEqual({
      account_id: 'harvard',
      folder: '[Gmail]/Sent Mail',
      uid: '7',
    });
  });

  it('caches nothing when the fetch fails, so the next attempt is a real retry', async () => {
    const cache = new MessageCache();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('502'));

    const outcome = loadMessage(cache, TARGET, fetchImpl);
    if (outcome.kind !== 'pending') throw new Error('expected a pending load');
    await expect(outcome.parsed).rejects.toThrow('502');

    expect(cache.get(TARGET)).toBeUndefined();

    const retry = loadMessage(cache, TARGET, fetchImpl);
    expect(retry.kind).toBe('pending');
    if (retry.kind === 'pending') await expect(retry.parsed).rejects.toThrow('502');
  });

  it('propagates the failure rather than swallowing it into an empty message', async () => {
    // The reader needs the error to tell a 401 (session gone) from a 502
    // (IMAP unreachable) and to offer "Try again"; a loader that resolved
    // to an empty ParsedMessage would render "this message has no body"
    // for a message that failed to load.
    const cache = new MessageCache();
    const outcome = loadMessage(cache, TARGET, vi.fn().mockRejectedValue(new Error('boom')));
    if (outcome.kind !== 'pending') throw new Error('expected a pending load');
    await expect(outcome.parsed).rejects.toThrow('boom');
  });
});

describe('readCachedMessage', () => {
  it('reads without starting anything — safe to call during render', () => {
    // React invokes a useState initializer during render, and twice under
    // StrictMode. Anything that issued a request from there would issue
    // two in development.
    const cache = new MessageCache();
    expect(readCachedMessage(cache, TARGET)).toBeUndefined();
    const message = messageOf('<p>hi</p>');
    cache.set(TARGET, message);
    expect(readCachedMessage(cache, TARGET)).toBe(message);
  });
});

describe('refetchMessage', () => {
  it('ignores the cache — "Try again" must not answer with what it is retrying past', async () => {
    const cache = new MessageCache();
    cache.set(TARGET, messageOf('<p>stale</p>'));
    const fresh = messageOf('<p>fresh</p>');
    const fetchImpl = vi.fn().mockResolvedValue(fresh);

    await expect(refetchMessage(cache, TARGET, fetchImpl)).resolves.toBe(fresh);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // And it replaces the entry rather than leaving the old one behind.
    expect(cache.get(TARGET)).toBe(fresh);
  });
});

describe('targetFor', () => {
  it('narrows a row to exactly the three fields identity depends on', () => {
    // Taking a whole InboxMessage would let the cache key silently start
    // depending on fields that change between syncs (flags, snippet), and
    // a key that changes when the message did not is a cache that never
    // hits.
    expect(
      targetFor({ account_id: 'primary', folder: 'INBOX', uid: '42' }),
    ).toEqual(TARGET);
  });
});
