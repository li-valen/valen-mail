import { describe, it, expect } from 'vitest';
import { isUnread } from '../src/components/messageFlags';
import type { InboxMessage } from '../src/api';

/**
 * Task 4 "fix round 1". DESIGN.md's MessageRow anatomy renders the sender
 * at weight 500 "if unread"; this file covers the boolean that decision
 * is based on, `isUnread`, in isolation from any component (client/
 * CLAUDE.md's standing constraint: no test in this plan renders one).
 *
 * The coordinator sampled 200 live messages and confirmed flags are
 * genuinely captured (not silently empty everywhere): 156 `[]`, 38
 * `['\Seen']`, 5 `['\Answered', '\Seen']`, 1 `['\Flagged', '\Seen']` — so
 * unread is the standard IMAP reading, "absence of \Seen".
 *
 * The two cases below that actually matter are the last two: a message
 * carrying \Seen alongside another flag must still read as READ, and a
 * message carrying some OTHER flag but not \Seen must still read as
 * UNREAD. Both are membership checks that a `flags.length === 0` (or any
 * other length-based) implementation gets wrong — see task-4-report.md's
 * "fix round 1" section for the exact arithmetic against a couple of
 * plausible naive implementations.
 */

function buildMessage(flags: readonly string[] | null): InboxMessage {
  return {
    account_id: 'primary',
    uid: '1',
    message_id: null,
    thread_id: null,
    folder: 'INBOX',
    subject: null,
    from_name: null,
    from_email: null,
    to_emails: [],
    cc_emails: [],
    date: null,
    snippet: null,
    flags,
    labels: [],
    has_attach: false,
    size_bytes: null,
    attachments: [],
  };
}

describe('isUnread', () => {
  it('is read (not unread) when \\Seen is present', () => {
    expect(isUnread(buildMessage(['\\Seen']))).toBe(false);
  });

  it('is unread when flags is empty', () => {
    expect(isUnread(buildMessage([]))).toBe(true);
  });

  // The membership check, not array-emptiness: two flags present,
  // \Seen among them, must still read as READ. A `flags.length === 0`
  // implementation happens to agree here too (length 2 !== 0), so this
  // case alone does not catch that specific bug — it exists to prove the
  // implementation is not, say, "read only when \Seen is the ONLY flag".
  it('is read when \\Seen is present alongside another flag (membership, not length)', () => {
    expect(isUnread(buildMessage(['\\Answered', '\\Seen']))).toBe(false);
  });

  // The discriminating case: one flag present, \Seen absent. This is
  // where a length-based implementation breaks — `flags.length === 0` is
  // false here (length is 1), so a naive "unread iff empty" reading
  // returns "read", which is wrong. Only a real membership check
  // (`.includes('\Seen')`) gets this right.
  it('is unread when another flag is present but \\Seen is absent', () => {
    expect(isUnread(buildMessage(['\\Flagged']))).toBe(true);
  });

  it('treats a null flags value as unread — the conservative default for missing data', () => {
    expect(isUnread(buildMessage(null))).toBe(true);
  });
});
