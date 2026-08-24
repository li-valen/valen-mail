import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ImapConnection } from '../src/imap/connection';
import { fetchHeaders } from '../src/imap/fetch';

const EMAIL = process.env.TEST_IMAP_EMAIL;
const PASSWORD = process.env.TEST_IMAP_PASSWORD;
const maybe = EMAIL && PASSWORD ? describe : describe.skip;

/** Amendment 1: below this sampled average, the byte-estimate sanity check
 *  below skips honestly instead of risking a spurious pass/fail on a
 *  mailbox of unusually tiny messages. */
const MIN_AVG_MESSAGE_BYTES_FOR_SANITY_CHECK = 4096;

maybe('fetchHeaders (live Gmail)', () => {
  // One connection shared across every test in this file via beforeAll/afterAll,
  // per the task's economical-live-connections requirement — repeated auth
  // attempts against the same shared test account risk rate-limiting it.
  const connection = new ImapConnection({
    id: 'test', email: EMAIL!, appPassword: PASSWORD!, isPrimary: true,
  });
  beforeAll(async () => { await connection.connect(); }, 30_000);
  afterAll(async () => { await connection.disconnect(); });

  it('fetches recent headers with envelope fields populated', async () => {
    const result = await fetchHeaders(connection, 'INBOX', { limit: 5 });
    expect(result.messages.length).toBeGreaterThan(0);
    const first = result.messages[0]!;
    expect(first.accountId).toBe('test');
    expect(first.folder).toBe('INBOX');
    expect(typeof first.uid).toBe('number');
  }, 60_000);

  it('reports bytes downloaded so the budget can be charged', async () => {
    const result = await fetchHeaders(connection, 'INBOX', { limit: 5 });
    expect(result.bytesDownloaded).toBeGreaterThan(0);
  }, 60_000);

  it('the per-message byte estimate stays a small fraction of real message size (sanity check, NOT the BODY[] guard)', async () => {
    // NOTE ON WHAT THIS TEST DOES AND DOES NOT PROVE:
    // The real, causal guard against BODY[] creeping into the fetch is
    // tests/fetch-unit.test.ts's assertion on HEADER_FETCH_OPTIONS's exact
    // shape — that test fails immediately and deterministically the moment
    // a body-bearing key (source, bodyParts, ...) is added to the query.
    //
    // This test cannot do that job: bytesDownloaded is a FIXED
    // 2048-byte-per-message estimate (see ESTIMATED_BYTES_PER_HEADER_FETCH
    // in src/imap/fetch.ts), not a measurement of what actually crossed the
    // wire. If someone added `source: true` to the fetch query tomorrow,
    // bytesDownloaded would not move, and this comparison would very likely
    // still pass. All this test verifies is that the fixed estimate is a
    // small, plausible fraction of real Gmail message sizes for typical
    // mail — which is what makes it usable as a budget proxy at all. Do not
    // read a pass here as "no BODY[] was fetched."
    const result = await fetchHeaders(connection, 'INBOX', { limit: 20 });
    const totalMessageBytes = result.messages.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0);
    const avgMessageBytes = totalMessageBytes / result.messages.length;

    // Amendment 1: on a mailbox whose sampled messages average under ~4 KB,
    // the comparison below could fail with no bug present, and the fix for
    // that flake would be to weaken the assertion. So: skip honestly
    // instead, naming the measured average, rather than weakening the check.
    if (avgMessageBytes < MIN_AVG_MESSAGE_BYTES_FOR_SANITY_CHECK) {
      console.warn(
        `[fetch.test] skipping byte-estimate sanity check: sampled ${result.messages.length} ` +
        `messages average ${avgMessageBytes.toFixed(0)} bytes each, below the ` +
        `${MIN_AVG_MESSAGE_BYTES_FOR_SANITY_CHECK}-byte floor needed for this comparison to be meaningful.`,
      );
      return;
    }

    // Do not relax this comparison to make a flake go away — if it's
    // flaking, the fix is the skip-below-floor guard above, not a weaker
    // threshold here.
    expect(result.bytesDownloaded).toBeLessThan(totalMessageBytes);
  }, 60_000);

  it('returns an empty result for an empty range rather than throwing', async () => {
    const result = await fetchHeaders(connection, 'INBOX', { limit: 0 });
    expect(result.messages).toEqual([]);
  }, 30_000);

  it('sets hasAttach from BODYSTRUCTURE, not from normalizeMessage', async () => {
    // normalizeMessage() always returns hasAttach: false — it has no
    // visibility into BODYSTRUCTURE. Amendment 2 requires the fetch loop to
    // override it from extractAttachments()'s result (see
    // applyAttachmentFlag() in src/imap/fetch.ts, which is unit-tested
    // directly and deterministically in tests/fetch-unit.test.ts). This live
    // test only additionally confirms the override actually fires end to
    // end — but whether this specific mailbox HAS an attachment to observe
    // is outside our control, so we sample a wider window and report
    // honestly rather than assert something we did not see.
    const result = await fetchHeaders(connection, 'INBOX', { limit: 50 });
    const withAttachment = result.messages.find((m) => m.hasAttach);

    if (!withAttachment) {
      console.warn(
        '[fetch.test] no message with an attachment found in the sampled 50 — ' +
        'cannot positively assert hasAttach: true on a real message.',
      );
      return;
    }

    expect(withAttachment.hasAttach).toBe(true);
    expect(result.attachments.get(withAttachment.uid)?.length).toBeGreaterThan(0);
  }, 60_000);
});
