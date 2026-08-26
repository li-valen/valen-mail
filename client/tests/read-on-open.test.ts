import { describe, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../src/api';
import { markReadOnOpen } from '../src/readOnOpen';
import prefetchSource from '../src/messagePrefetch.ts?raw';
import loaderSource from '../src/messageLoader.ts?raw';
import appSource from '../src/App.tsx?raw';
import readOnOpenSource from '../src/readOnOpen.ts?raw';

/**
 * Opening a message marks it read — *"when I read an email and go back
 * that email should no longer be highlighted... this way I know which
 * emails I have opened."*
 *
 * Two halves, and the second is the one that matters most. The BEHAVIOUR
 * (optimistic, rolled back, idempotent) is unit-tested against
 * ../src/readOnOpen.ts, which is a pure module precisely so it can be —
 * client/CLAUDE.md's standing constraint is that no test here renders a
 * component. The WIRING (that only a real open reaches it, and that the
 * prefetcher cannot) is a static guard, because no unit test can see
 * which function App.tsx chose to call.
 */

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    account_id: 'primary',
    uid: '10',
    message_id: '<m10@x>',
    thread_id: 't1',
    folder: 'INBOX',
    subject: 'Subject',
    from_name: 'Ann Lei',
    from_email: 'ann@example.com',
    to_emails: [],
    cc_emails: [],
    date: '2026-08-01T00:00:00.000Z',
    snippet: null,
    flags: [],
    labels: [],
    has_attach: false,
    size_bytes: '1',
    attachments: [],
    ...overrides,
  };
}

/** The two overlay writers App.tsx passes in, as spies. */
function ports(write: (m: InboxMessage, seen: boolean) => Promise<void>) {
  return {
    key: 'primary:INBOX:10',
    setSeen: vi.fn(),
    revertSeen: vi.fn(),
    onError: vi.fn(),
    write: vi.fn(write),
  };
}

describe('markReadOnOpen — the write', () => {
  it('marks an unread message read, and says which flag in which direction', async () => {
    const p = ports(async () => undefined);
    const opened = message();
    const outcome = await markReadOnOpen(opened, { isUnread: true, ...p });

    expect(outcome).toBe('marked');
    expect(p.write).toHaveBeenCalledWith(opened, true);
  });

  it('un-highlights the row BEFORE the write resolves', async () => {
    // The optimistic half. A row that stays bold for a round trip after
    // the reader has already painted reads as a broken click.
    let release: (() => void) | undefined;
    const p = ports(() => new Promise<void>((resolve) => (release = resolve)));
    const pending = markReadOnOpen(message(), { isUnread: true, ...p });

    expect(p.setSeen).toHaveBeenCalledWith(['primary:INBOX:10'], true);
    expect(p.revertSeen).not.toHaveBeenCalled();
    release!();
    await pending;
  });

  it('writes NOTHING for a message that is already read', async () => {
    // Idempotence, and it is about Gmail rather than about tidiness:
    // re-opening the same message repeatedly would otherwise fire a PATCH
    // per open for a flag the mailbox already has.
    const p = ports(async () => undefined);
    const outcome = await markReadOnOpen(message({ flags: ['\\Seen'] }), { isUnread: false, ...p });

    expect(outcome).toBe('skipped');
    expect(p.write).not.toHaveBeenCalled();
    expect(p.setSeen).not.toHaveBeenCalled();
  });

  it('asks about UNREADNESS, not about flags, so an in-flight open is not repeated', async () => {
    // `isUnread` is resolved through the optimistic overrides by the
    // caller (components/messageFlags.ts's `resolveUnread`), so a message
    // whose `flags` still lack \Seen but whose override says "read" is
    // correctly skipped.
    const p = ports(async () => undefined);
    await markReadOnOpen(message({ flags: [] }), { isUnread: false, ...p });
    expect(p.write).not.toHaveBeenCalled();
  });
});

describe('markReadOnOpen — the rollback', () => {
  it('puts the row back to unread when the write fails', async () => {
    // THE MUTATION GUARD for rollback. Deleting the revert would leave a
    // row looking dealt-with over mail Gmail still considers unread —
    // the user believing they had handled something they had not.
    const p = ports(async () => {
      throw new Error('502');
    });
    const outcome = await markReadOnOpen(message(), { isUnread: true, ...p });

    expect(outcome).toBe('reverted');
    expect(p.setSeen).toHaveBeenCalledWith(['primary:INBOX:10'], true);
    expect(p.revertSeen).toHaveBeenCalledWith(['primary:INBOX:10']);
  });

  it('DELETES the override rather than inverting it', async () => {
    // `revertSeen` drops the entry so the row falls back to what `flags`
    // actually says — components/messageFlags.ts's `resolveUnread`. A
    // `setSeen([key], false)` here would assert "unread" over a message
    // the mailbox may genuinely have had read all along.
    const p = ports(async () => {
      throw new Error('502');
    });
    await markReadOnOpen(message(), { isUnread: true, ...p });

    expect(p.setSeen).toHaveBeenCalledTimes(1);
    expect(p.setSeen).not.toHaveBeenCalledWith(['primary:INBOX:10'], false);
  });

  it('reports the failure instead of swallowing it, and never rejects', async () => {
    const p = ports(async () => {
      throw new Error('502');
    });
    // No `.rejects` — opening a message succeeded; only the flag did not.
    await expect(markReadOnOpen(message(), { isUnread: true, ...p })).resolves.toBe('reverted');
    expect(p.onError).toHaveBeenCalled();
  });
});

/** Strips comments, so a doc comment that MENTIONS an identifier is never
 *  read as live code — these files discuss each other at length. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const PREFETCH = stripComments(prefetchSource);
const LOADER = stripComments(loaderSource);
const APP = stripComments(appSource);
const READ_ON_OPEN = stripComments(readOnOpenSource);

describe('a hover or a prefetch never marks anything read', () => {
  it('the prefetcher cannot reach the flag write at all', () => {
    // THE MUTATION GUARD for prefetch. ./messagePrefetch.ts warms the
    // hovered row and the two adjacent ones; marking those read would
    // silently clear mail the user only swept a pointer past, which is
    // exactly the signal the feature exists to preserve.
    expect(PREFETCH).not.toContain('markReadOnOpen');
    expect(PREFETCH).not.toContain('setMessageFlag');
    expect(PREFETCH).not.toContain('applySeen');
    expect(PREFETCH).not.toContain('seen');
  });

  it('the loader cannot either, so a warmed cache entry is not a read receipt', () => {
    // The prefetcher fetches THROUGH the loader, so a mark-read hidden in
    // the loader would be reachable from every hover by another route.
    expect(LOADER).not.toContain('markReadOnOpen');
    expect(LOADER).not.toContain('setMessageFlag');
  });

  it('the write hangs off the OPEN, which is what makes a cached open still count', () => {
    // Wired into `openMessage` — the funnel a list row, a thread row and
    // an opens-rail click all go through — rather than into the fetch,
    // which a cached open never performs.
    expect(/const openMessage = useCallback\([\s\S]{0,900}?markReadOnOpen\(next, \{/.test(APP)).toBe(
      true,
    );
  });

  it('and the guard above would catch its own regression', () => {
    // The synthetic-fixture discipline the other static-guard suites use:
    // prove the pattern fails on a source that lacks the wiring, so a
    // passing guard means something.
    const withoutWiring = 'const openMessage = useCallback((next) => { setSelected(next); }, []);';
    expect(/const openMessage = useCallback\([\s\S]{0,900}?markReadOnOpen\(next, \{/.test(withoutWiring)).toBe(
      false,
    );
  });
});

describe('the \\Seen flag is kept apart from the tracking read-states', () => {
  it('never renders through readStateFor, whose three tones mean something else', () => {
    // components/ReadState.tsx answers "did the RECIPIENT read mail I
    // sent", across `confirmed`, `unknown` and the feed's own
    // `unavailable`. Routing a mailbox flag through that vocabulary would
    // turn "you opened this" into "they opened this" — the one claim this
    // product exists not to make.
    expect(READ_ON_OPEN).not.toContain('readStateFor');
    expect(READ_ON_OPEN).not.toContain('ReadState');
    expect(READ_ON_OPEN).not.toContain('classification');
  });
});
