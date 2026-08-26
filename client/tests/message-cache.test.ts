import { describe, expect, it } from 'vitest';
import type { ParsedMessage } from '../src/api';
import {
  MAX_CACHED_ENTRY_BYTES,
  MESSAGE_CACHE_MAX_BYTES,
  MessageCache,
  measureBytes,
  messageCacheKey,
} from '../src/messageCache';

/**
 * The reader's message cache — what makes back-then-forward instant.
 *
 * Everything here drives the CLASS, never the module-level `messageCache`
 * singleton the app uses: a shared instance would make these tests
 * order-dependent on each other, which is exactly the property a cache
 * makes easy to lose and hard to notice.
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
    messageId: null,
    references: [],
    attachments: [],
  };
}

/** A message whose `measureBytes` lands on `target`. Two bytes per code
 *  unit, less the flat per-entry overhead. */
function messageOfApproximately(target: number): ParsedMessage {
  return messageOf('x'.repeat(Math.max(0, Math.floor(target / 2) - 256)));
}

const TARGET = { account_id: 'primary', folder: 'INBOX', uid: '42' };

describe('messageCacheKey', () => {
  it('includes the folder — the same uid in two mailboxes is two messages', () => {
    // Gmail numbers each mailbox independently. components/messageBody's
    // `messageKey` is account_id:uid and answers "same ROW"; this one has
    // to answer "same MESSAGE", and dropping the folder would serve a
    // Sent message under an inbox row.
    expect(messageCacheKey({ ...TARGET, folder: 'INBOX' })).not.toBe(
      messageCacheKey({ ...TARGET, folder: '[Gmail]/Sent Mail' }),
    );
  });

  it('includes the account', () => {
    expect(messageCacheKey({ ...TARGET, account_id: 'a' })).not.toBe(
      messageCacheKey({ ...TARGET, account_id: 'b' }),
    );
  });

  it('cannot collide two targets by concatenation', () => {
    // The NUL separator's whole job. A `:` or `/` join would make these
    // one key, and both characters appear in real Gmail folder paths.
    expect(messageCacheKey({ account_id: 'a', folder: 'bc', uid: '1' })).not.toBe(
      messageCacheKey({ account_id: 'ab', folder: 'c', uid: '1' }),
    );
  });
});

describe('MessageCache', () => {
  it('answers undefined for something it has never seen', () => {
    expect(new MessageCache().get(TARGET)).toBeUndefined();
  });

  it('returns the very same object it was given, synchronously', () => {
    // Identity matters: the reader compares by reference to decide
    // whether a re-resolve needs a render at all, and "synchronously" is
    // the whole feature — a promise, even an already-resolved one,
    // delivers on a microtask and leaves a frame with nothing to show.
    const cache = new MessageCache();
    const message = messageOf('<p>hi</p>');
    cache.set(TARGET, message);
    expect(cache.get(TARGET)).toBe(message);
  });

  it('keeps messages in different folders apart', () => {
    const cache = new MessageCache();
    const inbox = messageOf('inbox');
    const sent = messageOf('sent');
    cache.set({ ...TARGET, folder: 'INBOX' }, inbox);
    cache.set({ ...TARGET, folder: '[Gmail]/Sent Mail' }, sent);
    expect(cache.get({ ...TARGET, folder: 'INBOX' })).toBe(inbox);
    expect(cache.get({ ...TARGET, folder: '[Gmail]/Sent Mail' })).toBe(sent);
  });

  it('evicts by measured BYTES, not by entry count', () => {
    // A 4 KB ceiling and ~1 KB messages. An entry-count LRU would hold
    // all six; on a real mailbox, where one message can be a hundred
    // times another, "20 entries" is a bound on nothing at all.
    const cache = new MessageCache(4_096, 4_096);
    for (let uid = 1; uid <= 6; uid += 1) {
      cache.set({ ...TARGET, uid: String(uid) }, messageOfApproximately(1_024));
    }
    expect(cache.sizeBytes).toBeLessThanOrEqual(4_096);
    expect(cache.size).toBeLessThan(6);
  });

  it('holds the ceiling after every set, including the one that overflows it', () => {
    const cache = new MessageCache(4_096, 4_096);
    for (let uid = 1; uid <= 20; uid += 1) {
      cache.set({ ...TARGET, uid: String(uid) }, messageOfApproximately(1_500));
      expect(cache.sizeBytes).toBeLessThanOrEqual(4_096);
    }
  });

  it('evicts the LEAST RECENTLY USED entry, not the oldest written', () => {
    const cache = new MessageCache(2_500, 2_500);
    cache.set({ ...TARGET, uid: '1' }, messageOfApproximately(1_000));
    cache.set({ ...TARGET, uid: '2' }, messageOfApproximately(1_000));

    // Reading 1 makes 2 the least recently used. Without the
    // delete-then-set inside `get`, a Map keeps its original insertion
    // order and this is FIFO wearing an LRU's name — 1 would be the one
    // evicted and the next line would fail.
    expect(cache.get({ ...TARGET, uid: '1' })).toBeDefined();
    cache.set({ ...TARGET, uid: '3' }, messageOfApproximately(1_000));

    expect(cache.get({ ...TARGET, uid: '1' })).toBeDefined();
    expect(cache.get({ ...TARGET, uid: '2' })).toBeUndefined();
    expect(cache.get({ ...TARGET, uid: '3' })).toBeDefined();
  });

  it('refuses one oversized message rather than flushing everything to hold it', () => {
    const cache = new MessageCache(8_000, 1_000);
    cache.set({ ...TARGET, uid: '1' }, messageOfApproximately(900));
    const warmBytes = cache.sizeBytes;

    cache.set({ ...TARGET, uid: '2' }, messageOfApproximately(4_000));

    expect(cache.get({ ...TARGET, uid: '2' })).toBeUndefined();
    // And the already-warm entry paid nothing for the refusal.
    expect(cache.get({ ...TARGET, uid: '1' })).toBeDefined();
    expect(cache.sizeBytes).toBe(warmBytes);
  });

  it('replaces rather than double-counts when the same message is cached twice', () => {
    const cache = new MessageCache();
    cache.set(TARGET, messageOfApproximately(1_000));
    const once = cache.sizeBytes;
    cache.set(TARGET, messageOfApproximately(1_000));
    expect(cache.sizeBytes).toBe(once);
    expect(cache.size).toBe(1);
  });

  it('returns to zero bytes when everything is evicted', () => {
    const cache = new MessageCache();
    cache.set({ ...TARGET, uid: '1' }, messageOfApproximately(1_000));
    cache.set({ ...TARGET, uid: '2' }, messageOfApproximately(1_000));
    cache.evict({ ...TARGET, uid: '1' });
    cache.evict({ ...TARGET, uid: '2' });
    expect(cache.size).toBe(0);
    expect(cache.sizeBytes).toBe(0);
  });

  it('treats evicting something absent as a no-op, never a negative total', () => {
    const cache = new MessageCache();
    cache.set(TARGET, messageOfApproximately(1_000));
    const before = cache.sizeBytes;
    cache.evict({ ...TARGET, uid: '999' });
    expect(cache.sizeBytes).toBe(before);
  });
});

describe('measureBytes', () => {
  it('counts two bytes per code unit, because a JS engine does for anything outside Latin-1', () => {
    const ascii = measureBytes(messageOf('x'.repeat(1_000)));
    const cjk = measureBytes(messageOf('あ'.repeat(1_000)));
    // Same charge for both — the ASCII one is over-counted rather than
    // the CJK one under-counted. Wrong-high costs entries; wrong-low
    // costs the tab.
    expect(ascii).toBe(cjk);
    expect(ascii).toBeGreaterThanOrEqual(2_000);
  });

  it('charges every string field, not only the html', () => {
    const bare = measureBytes(messageOf('x'));
    const full = measureBytes({
      ...messageOf('x'),
      text: 'y'.repeat(500),
      subject: 'z'.repeat(500),
      cc: [{ name: 'n'.repeat(100), address: 'a'.repeat(100) }],
    });
    // Exactly the extra characters, at two bytes each — a field this
    // forgot to count would land under this number, not merely near it.
    expect(full).toBe(bare + 2 * (500 + 500 + 100 + 100));
  });

  it('never returns zero — an empty message still costs its own bookkeeping', () => {
    expect(measureBytes(messageOf(''))).toBeGreaterThan(0);
  });
});

describe('the ceiling', () => {
  it('is 8 MiB, sized for a browser tab rather than for a server', () => {
    expect(MESSAGE_CACHE_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('admits no entry larger than an eighth of itself', () => {
    expect(MAX_CACHED_ENTRY_BYTES).toBe(MESSAGE_CACHE_MAX_BYTES / 8);
  });

  it('holds enough real messages that an ordinary session never evicts', () => {
    // A body here runs 60–90 KB of html; at the two-byte upper bound that
    // is ~180 KB an entry. Fewer than a couple of dozen and this would be
    // a ceiling with no cache under it.
    const typicalEntry = measureBytes(messageOf('x'.repeat(90_000)));
    expect(Math.floor(MESSAGE_CACHE_MAX_BYTES / typicalEntry)).toBeGreaterThan(40);
  });
});
