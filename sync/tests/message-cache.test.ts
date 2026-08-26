import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouter } from '../src/api/routes';
import type { ParsedMessage } from '../src/api/message.ts';
import {
  MAX_CACHED_ENTRY_BYTES,
  MESSAGE_CACHE_MAX_BYTES,
  MessageCache,
  measureBytes,
} from '../src/api/message-cache.ts';
import {
  AUTH as auth,
  TOKEN,
  makeFakeConnection,
  makeFakeDb,
  makeFakePool,
  readJson,
  type FakeDownloadCall,
} from './helpers/api-fakes.ts';

/**
 * The parsed-message cache — the thing that makes re-opening a message
 * instant instead of another IMAP round trip.
 *
 * TWO LEVELS, deliberately. The class is exercised directly for the
 * policy questions (what the ceiling holds, what eviction chooses, what a
 * renumbered mailbox does), because those need a controlled ceiling and a
 * message of a known size and are miserable to drive through a router.
 * The ROUTE is exercised through the real router for the questions only
 * an integrated path can answer — did the second open really skip IMAP,
 * is the body a hit serves really the stripped one, does a flag write
 * really invalidate.
 *
 * "Skipped IMAP" is asserted as "the fake connection's `download` was not
 * called again", never as "the second response was fast": a timing
 * assertion would pass on a machine that happened to be quick and would
 * not fail for the mutation this suite exists to catch.
 */

const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixtures', 'messages');

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURE_DIR, `${name}.eml`));
}

const TRACKING = { baseUrl: 'https://track.example', readToken: 'read-token' } as const;
const OUR_PIXEL = 'https://track.example/o/aaaabbbbccccddddeeeeffff00001111.png';

interface Harness {
  readonly router: (request: Request) => Promise<Response>;
  /** Every IMAP body download this router actually performed. Length is
   *  the whole assertion in most cases below. */
  readonly downloads: readonly FakeDownloadCall[];
}

/** A router whose one connected account serves `name.eml` and records
 *  every download it is asked for. */
function harness(
  name: string,
  options: {
    tracking?: typeof TRACKING | null;
    uidValidity?: Readonly<Record<string, bigint>>;
    db?: ReturnType<typeof makeFakeDb>;
  } = {},
): Harness {
  const downloads: FakeDownloadCall[] = [];
  const { pool } = makeFakePool({
    statuses: [['acct1', 'connected']],
    connections: {
      acct1: makeFakeConnection({
        chunks: [fixture(name)],
        onDownload: (call) => {
          downloads.push(call);
        },
      }),
    },
    uidValidity: options.uidValidity,
  });
  return {
    router: createRouter(options.db ?? makeFakeDb(), pool, TOKEN, options.tracking ?? null),
    downloads,
  };
}

function get(
  router: (request: Request) => Promise<Response>,
  { uid = '42', folder = 'INBOX' } = {},
): Promise<Response> {
  const url = `http://x/api/message/acct1/${encodeURIComponent(folder)}/${uid}`;
  return router(new Request(url, { headers: auth }));
}

function patchSeen(
  router: (request: Request) => Promise<Response>,
  { uid = '42', folder = 'INBOX' } = {},
): Promise<Response> {
  const url = `http://x/api/message/acct1/${encodeURIComponent(folder)}/${uid}/flags`;
  return router(
    new Request(url, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ seen: true }),
    }),
  );
}

/** A parsed message of a known measured weight, for the ceiling cases.
 *  `filler` is what carries the bytes; everything else is the minimum a
 *  ParsedMessage needs to be well-formed. */
function messageOfBytes(filler: string): ParsedMessage {
  return {
    html: filler,
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

/** An html body whose `measureBytes` lands close to `target`. Two bytes a
 *  character (see measureBytes), minus the flat per-entry overhead. */
function messageOfApproximately(target: number): ParsedMessage {
  return messageOfBytes('x'.repeat(Math.max(0, Math.floor(target / 2) - 256)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('message cache / the route skips IMAP on a hit', () => {
  it('fetches once and serves the second open from memory', async () => {
    const h = harness('html-text-attachment');

    const first = await get(h.router);
    expect(first.status).toBe(200);
    expect(h.downloads).toHaveLength(1);

    const second = await get(h.router);
    expect(second.status).toBe(200);
    // THE assertion of this whole feature: the connection was not asked
    // for those bytes a second time.
    expect(h.downloads).toHaveLength(1);
  });

  it('serves a byte-identical body on the hit', async () => {
    const h = harness('html-text-attachment');
    const first = await (await get(h.router)).text();
    const second = await (await get(h.router)).text();
    expect(second).toBe(first);
  });

  it('keeps the same freshness headers on a hit — a cached answer is not a cacheable one', async () => {
    // The response this service holds in memory must still be refused by
    // every cache between here and the browser; ./http.ts's
    // PRIVATE_NO_STORE is about the wire, not about this Map.
    const h = harness('text-only');
    await get(h.router);
    const hit = await get(h.router);
    expect(hit.headers.get('cache-control')).toBe('private, no-store');
    expect(hit.headers.get('content-type')).toBe('application/json');
  });

  it('caches per (account, folder, uid) — a different uid is its own fetch', async () => {
    const h = harness('text-only');
    await get(h.router, { uid: '42' });
    await get(h.router, { uid: '43' });
    await get(h.router, { uid: '42' });
    expect(h.downloads.map((call) => call.uid)).toEqual(['42', '43']);
  });

  it('caches per FOLDER too — the same uid in another mailbox is another message', async () => {
    // Gmail numbers each mailbox independently, so uid 42 in Sent has
    // nothing to do with uid 42 in INBOX. A key that dropped the folder
    // would serve one for the other.
    const h = harness('text-only');
    await get(h.router, { folder: 'INBOX' });
    await get(h.router, { folder: '[Gmail]/Sent Mail' });
    expect(h.downloads).toHaveLength(2);
  });

  it('does not re-query the attachments table on a hit', async () => {
    const query = vi.fn(async () => [{ part_id: '2', filename: 'q3-report.pdf' }]);
    const h = harness('html-text-attachment', { db: makeFakeDb({ query }) });
    await get(h.router);
    await get(h.router);
    // The Postgres round trip is the route's second per-open cost, and a
    // cache that only skipped IMAP would still pay it every time.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches nothing for a failed fetch — the next open retries rather than serving an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: {
        acct1: makeFakeConnection({ downloadError: new Error('connection reset') }),
      },
    });
    const router = createRouter(makeFakeDb(), pool, TOKEN);
    expect((await get(router)).status).toBe(502);
    expect((await get(router)).status).toBe(502);
  });
});

describe('message cache / the cached body is the STRIPPED body (spec 5.6)', () => {
  it('never serves our own tracking pixel back on a cache hit', async () => {
    // THE correctness trap of caching this route. ./message.ts computes
    // `shaped` (raw parse) and then `message` (pixel stripped); caching
    // the first would mean the first open of a message strips our pixel
    // and every later open serves it, firing a pixel this installation
    // minted and manufacturing an open attributed to a recipient who did
    // nothing. Spec 5.6 defeated by a cache.
    const h = harness('tracked-copy', { tracking: TRACKING });

    const first = await readJson<ParsedMessage>(await get(h.router));
    expect(first.html).not.toContain(OUR_PIXEL);
    expect(first.html).not.toContain('/o/');

    const second = await readJson<ParsedMessage>(await get(h.router));
    expect(h.downloads).toHaveLength(1);
    expect(second.html).not.toContain(OUR_PIXEL);
    expect(second.html).not.toContain('/o/');
  });

  it('still keeps every OTHER image on the hit', async () => {
    // The other half: a cache that stored a blanket-stripped body would
    // pass the assertion above while deleting the pictures the user asked
    // to see on every open after the first.
    const h = harness('tracked-copy', { tracking: TRACKING });
    await get(h.router);
    const hit = await readJson<ParsedMessage>(await get(h.router));
    expect(hit.html).toContain('https://cdn.example/chart.png');
    expect(hit.html).toContain('https://tracker.example/open.gif');
  });

  it('serves the corrected attachment partId on the hit, not the parsed one', async () => {
    // The other post-processing step. mailparser numbers this fixture's
    // inline image "2.2.2" where IMAP calls it "2.2"; a hit that served
    // the pre-correction value would hand the client a download URL that
    // resolves to the wrong part.
    const db = makeFakeDb({ query: async () => [{ part_id: '2.2', filename: 'logo.png' }] });
    const h = harness('sibling-multipart', { db });
    expect((await readJson<ParsedMessage>(await get(h.router))).attachments[0]?.partId).toBe('2.2');
    const hit = await readJson<ParsedMessage>(await get(h.router));
    expect(h.downloads).toHaveLength(1);
    expect(hit.attachments[0]?.partId).toBe('2.2');
  });
});

describe('message cache / a flag write invalidates its key', () => {
  it('re-fetches the message after a successful PATCH .../flags', async () => {
    const h = harness('text-only');

    await get(h.router);
    await get(h.router);
    expect(h.downloads).toHaveLength(1);

    expect((await patchSeen(h.router)).status).toBe(200);

    // MUTATION TEST: delete `cache.evict(...)` from src/api/flags.ts and
    // this line fails with 1 — the route would keep serving the snapshot
    // taken before the STORE for the rest of the process's life.
    await get(h.router);
    expect(h.downloads).toHaveLength(2);
  });

  it('evicts only the message it wrote to', async () => {
    const h = harness('text-only');
    await get(h.router, { uid: '42' });
    await get(h.router, { uid: '43' });
    expect(h.downloads).toHaveLength(2);

    await patchSeen(h.router, { uid: '42' });

    await get(h.router, { uid: '43' });
    expect(h.downloads).toHaveLength(2);
    await get(h.router, { uid: '42' });
    expect(h.downloads).toHaveLength(3);
  });

  it('leaves the cache alone when the IMAP write itself failed', async () => {
    // A refused STORE changed nothing on the server, so the cached copy
    // is still accurate and throwing it away would cost a fetch for
    // nothing.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const downloads: FakeDownloadCall[] = [];
    const { pool } = makeFakePool({
      statuses: [['acct1', 'connected']],
      connections: {
        acct1: makeFakeConnection({
          chunks: [fixture('text-only')],
          onDownload: (call) => {
            downloads.push(call);
          },
          flagError: new Error('STORE refused'),
        }),
      },
    });
    const router = createRouter(makeFakeDb(), pool, TOKEN);

    await get(router);
    expect((await patchSeen(router)).status).toBe(502);
    await get(router);
    expect(downloads).toHaveLength(1);
  });
});

describe('message cache / a renumbered mailbox (UIDVALIDITY)', () => {
  it('serves a hit while UIDVALIDITY is unchanged', () => {
    const cache = new MessageCache();
    const message = messageOfBytes('<p>hi</p>');
    cache.set('acct1', 'INBOX', 42, message, 7n);
    expect(cache.get('acct1', 'INBOX', 42, 7n)).toBe(message);
  });

  it('drops the whole folder once the server renumbers it', () => {
    // Every uid in a renumbered mailbox now addresses a DIFFERENT
    // message, so the other entries are exactly as wrong as this one and
    // are dropped together rather than one wrong answer at a time.
    const cache = new MessageCache();
    cache.set('acct1', 'INBOX', 42, messageOfBytes('a'), 7n);
    cache.set('acct1', 'INBOX', 43, messageOfBytes('b'), 7n);
    cache.set('acct1', '[Gmail]/Sent Mail', 42, messageOfBytes('c'), 7n);

    expect(cache.get('acct1', 'INBOX', 42, 9n)).toBeUndefined();
    expect(cache.size).toBe(1);
    // Another mailbox's numbering is its own — Trash being renumbered
    // must not flush INBOX, and vice versa.
    expect(cache.get('acct1', '[Gmail]/Sent Mail', 42, 7n)).toBeDefined();
  });

  it('keeps another account out of it entirely', () => {
    const cache = new MessageCache();
    cache.set('acct1', 'INBOX', 42, messageOfBytes('a'), 7n);
    cache.set('acct2', 'INBOX', 42, messageOfBytes('b'), 7n);
    expect(cache.get('acct1', 'INBOX', 42, 9n)).toBeUndefined();
    expect(cache.get('acct2', 'INBOX', 42, 7n)).toBeDefined();
  });

  it('serves the entry when either side is unknown — "cannot tell" is not "changed"', () => {
    // The same resolution src/imap/backfill.ts's hasUidValidityChanged
    // makes. Treating unknown as changed would flush the cache on every
    // start-up until the first sync cycle lands, which is exactly the
    // window a cold client reads in.
    const cache = new MessageCache();
    cache.set('acct1', 'INBOX', 42, messageOfBytes('a'), null);
    expect(cache.get('acct1', 'INBOX', 42, 9n)).toBeDefined();

    cache.set('acct1', 'INBOX', 43, messageOfBytes('b'), 7n);
    expect(cache.get('acct1', 'INBOX', 43, null)).toBeDefined();
  });

  it('re-fetches through the route once the pool reports a new UIDVALIDITY', async () => {
    // The wired version of the cases above: the route reads the pool's own
    // observation (ConnectionPool.getUidValidity, recorded by the sync
    // loop) rather than SELECTing the mailbox itself, which would be the
    // very round trip this cache exists to remove.
    //
    // The record is mutated mid-test because that is what the real signal
    // is: a sync cycle lands, observes a different UIDVALIDITY, and the
    // next request sees the new one.
    const observed: Record<string, bigint> = { INBOX: 7n };
    const h = harness('text-only', { uidValidity: observed });

    await get(h.router);
    await get(h.router);
    expect(h.downloads).toHaveLength(1);

    observed.INBOX = 9n;

    await get(h.router);
    expect(h.downloads).toHaveLength(2);
  });
});

describe('message cache / the ceiling is bytes, never entries', () => {
  it('evicts by measured bytes rather than by count', () => {
    // A 4 KB ceiling and messages of ~1 KB: an entry-count LRU would hold
    // all six, and on the real ceiling with real 32 MB messages that is
    // the 3.2 GB an entry-count cache is worth on a 955 MB box.
    const cache = new MessageCache(4_096, 4_096);
    for (let uid = 1; uid <= 6; uid += 1) {
      cache.set('acct1', 'INBOX', uid, messageOfApproximately(1_024), 7n);
    }
    expect(cache.sizeBytes).toBeLessThanOrEqual(4_096);
    expect(cache.size).toBeLessThan(6);
  });

  it('holds the ceiling after every single set, including the one that overflows it', () => {
    const cache = new MessageCache(4_096, 4_096);
    for (let uid = 1; uid <= 20; uid += 1) {
      cache.set('acct1', 'INBOX', uid, messageOfApproximately(1_500), 7n);
      expect(cache.sizeBytes).toBeLessThanOrEqual(4_096);
    }
  });

  it('evicts the LEAST RECENTLY USED entry, not the oldest one written', () => {
    const cache = new MessageCache(2_500, 2_500);
    cache.set('acct1', 'INBOX', 1, messageOfApproximately(1_000), 7n);
    cache.set('acct1', 'INBOX', 2, messageOfApproximately(1_000), 7n);
    // Touching 1 makes 2 the least recently used, so the next insert must
    // take 2 and leave 1. Without the delete-then-set in `get`, a Map
    // keeps its original insertion order and this is FIFO wearing an
    // LRU's name — 1 would go and this line would fail.
    expect(cache.get('acct1', 'INBOX', 1, 7n)).toBeDefined();
    cache.set('acct1', 'INBOX', 3, messageOfApproximately(1_000), 7n);

    expect(cache.get('acct1', 'INBOX', 1, 7n)).toBeDefined();
    expect(cache.get('acct1', 'INBOX', 2, 7n)).toBeUndefined();
    expect(cache.get('acct1', 'INBOX', 3, 7n)).toBeDefined();
  });

  it('refuses a single entry above the per-entry cap instead of flushing everything for it', () => {
    const cache = new MessageCache(8_000, 1_000);
    cache.set('acct1', 'INBOX', 1, messageOfApproximately(900), 7n);
    const warmBytes = cache.sizeBytes;

    cache.set('acct1', 'INBOX', 2, messageOfApproximately(4_000), 7n);

    expect(cache.get('acct1', 'INBOX', 2, 7n)).toBeUndefined();
    // And it cost the already-warm entry nothing.
    expect(cache.get('acct1', 'INBOX', 1, 7n)).toBeDefined();
    expect(cache.sizeBytes).toBe(warmBytes);
  });

  it('re-setting the same key replaces its bytes rather than double-counting them', () => {
    const cache = new MessageCache();
    cache.set('acct1', 'INBOX', 1, messageOfApproximately(1_000), 7n);
    const once = cache.sizeBytes;
    cache.set('acct1', 'INBOX', 1, messageOfApproximately(1_000), 7n);
    expect(cache.sizeBytes).toBe(once);
    expect(cache.size).toBe(1);
  });

  it('returns to zero bytes once everything is evicted', () => {
    const cache = new MessageCache();
    cache.set('acct1', 'INBOX', 1, messageOfApproximately(1_000), 7n);
    cache.set('acct1', 'INBOX', 2, messageOfApproximately(1_000), 7n);
    cache.evict('acct1', 'INBOX', 1);
    cache.evictFolder('acct1', 'INBOX');
    expect(cache.size).toBe(0);
    expect(cache.sizeBytes).toBe(0);
  });

  it('evicting something absent is a no-op, not a negative total', () => {
    const cache = new MessageCache();
    cache.set('acct1', 'INBOX', 1, messageOfApproximately(1_000), 7n);
    const before = cache.sizeBytes;
    cache.evict('acct1', 'INBOX', 999);
    cache.evict('nobody', 'INBOX', 1);
    expect(cache.sizeBytes).toBe(before);
  });
});

describe('message cache / measureBytes is an UPPER bound', () => {
  it('counts two bytes per code unit, because V8 does for anything outside Latin-1', () => {
    const ascii = measureBytes(messageOfBytes('x'.repeat(1_000)));
    const cjk = measureBytes(messageOfBytes('あ'.repeat(1_000)));
    // Same code-unit count, same charge — the point being that the ASCII
    // one is over-counted rather than the CJK one under-counted. Being
    // wrong high costs cache entries; being wrong low costs the box.
    expect(ascii).toBe(cjk);
    expect(ascii).toBeGreaterThanOrEqual(2_000);
  });

  it('charges every string field, not just the html', () => {
    const bare = measureBytes(messageOfBytes('x'));
    const full = measureBytes({
      ...messageOfBytes('x'),
      text: 'y'.repeat(500),
      subject: 'z'.repeat(500),
      to: [{ name: 'n'.repeat(100), address: 'a'.repeat(100) }],
      attachments: [
        {
          partId: '2',
          filename: 'f'.repeat(100),
          mimeType: 'application/pdf',
          sizeBytes: 1,
          isInline: false,
          contentId: null,
        },
      ],
    });
    expect(full).toBeGreaterThan(bare + 2 * (500 + 500 + 100 + 100 + 100));
  });

  it('never returns zero, so an empty message still costs its own bookkeeping', () => {
    const empty = measureBytes(messageOfBytes(''));
    expect(empty).toBeGreaterThan(0);
  });
});

describe('message cache / the ceiling itself', () => {
  it('is stated in bytes and sized against the 955 MB box', () => {
    expect(MESSAGE_CACHE_MAX_BYTES).toBe(32 * 1024 * 1024);
    // Under 5% of the box, so the cache at its ceiling cannot be what
    // pushes a process sharing 955 MB with Postgres and ten IMAP
    // connections into the OOM killer.
    expect(MESSAGE_CACHE_MAX_BYTES).toBeLessThan(0.05 * 955 * 1_000_000);
  });

  it('admits no entry larger than an eighth of itself', () => {
    expect(MAX_CACHED_ENTRY_BYTES).toBe(MESSAGE_CACHE_MAX_BYTES / 8);
  });

  it('holds a realistic mailbox comfortably at that ceiling', () => {
    // A real body here runs 60–90 KB of html; at the two-byte upper bound
    // that is ~180 KB an entry. The ceiling must hold enough of those
    // that a reading session never evicts, or the cache is a ceiling with
    // no cache under it.
    const typicalEntry = measureBytes(messageOfBytes('x'.repeat(90_000)));
    expect(Math.floor(MESSAGE_CACHE_MAX_BYTES / typicalEntry)).toBeGreaterThan(150);
  });
});
