import { describe, expect, it } from 'vitest';
import type { ParsedAddress, ParsedMessage } from '../src/api';
import {
  MAX_QUOTE_BODY_BYTES,
  MAX_REFERENCES,
  buildQuoteSource,
  buildReplyDraft,
  buildThreading,
  composerTitleFor,
  initialFocusFor,
  isDraftDirty,
  quoteNoticeFor,
  replyKey,
  replyWireFields,
  seedReplyDraft,
  senderLabel,
} from '../src/replyDraft';

/**
 * Plan 9 Task 4 — every judgement a reply makes, tested where it lives.
 *
 * `client/CLAUDE.md`'s standing constraint is that no test in this client
 * renders a component, so recipient derivation, subject prefixing,
 * threading and the quote SOURCE all live in one pure module and are
 * exercised exhaustively here. `tests/reply-wiring-static-guards.test.ts`
 * checks that the components actually call them; the browser is the only
 * proof that a reply threads, and the task report records it separately.
 *
 * The four decisions this file exists to pin, each of which is a real
 * misfire this product could otherwise ship:
 *
 *   1. reply       → the sender ONLY, never the rest of the recipients.
 *   2. replyAll    → everyone EXCEPT me, matched case-insensitively.
 *   3. forward     → `Fwd:` and NO pre-filled recipient.
 *   4. the prefix  → anchored and case-insensitive, so "Agenda: Re-org"
 *                    is not read as already prefixed and "Re: x" is not
 *                    prefixed twice.
 */

const OWN = ['me@example.com'];

function address(value: string): ParsedAddress {
  const match = /^(.*)<(.+)>$/.exec(value);
  const name = match?.[1];
  const inner = match?.[2];
  if (name === undefined || inner === undefined) return { name: null, address: value };
  return { name: name.trim(), address: inner };
}

interface MessageOverrides {
  readonly from?: string | null;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly subject?: string | null;
  readonly html?: string | null;
  readonly text?: string | null;
  readonly date?: number | null;
  readonly messageId?: string | null;
  readonly references?: readonly string[];
}

function msg(overrides: MessageOverrides = {}): ParsedMessage {
  const from = overrides.from === undefined ? 'ada@x.com' : overrides.from;
  return {
    html: overrides.html ?? null,
    text: overrides.text ?? null,
    subject: overrides.subject === undefined ? 'numbers' : overrides.subject,
    from: from === null ? null : address(from),
    to: (overrides.to ?? []).map(address),
    cc: (overrides.cc ?? []).map(address),
    date: overrides.date === undefined ? 1_700_000_000_000 : overrides.date,
    messageId: overrides.messageId === undefined ? '<c@example.com>' : overrides.messageId,
    references: overrides.references ?? [],
    attachments: [],
  };
}

describe('who a reply goes to', () => {
  it('reply goes to the sender only, never to the other recipients', () => {
    const draft = buildReplyDraft(
      msg({ from: 'ada@x.com', to: ['me@example.com', 'bob@x.com'] }),
      'reply',
      OWN,
    );
    expect(draft.to).toEqual(['ada@x.com']);
    expect(draft.cc).toEqual([]);
  });

  it('reply-all keeps everyone EXCEPT me — otherwise every reply mails myself', () => {
    const draft = buildReplyDraft(
      msg({ from: 'ada@x.com', to: ['me@example.com', 'bob@x.com'], cc: ['carol@x.com'] }),
      'replyAll',
      OWN,
    );
    expect(draft.to).toEqual(['ada@x.com', 'bob@x.com']);
    expect(draft.cc).toEqual(['carol@x.com']);
    expect([...draft.to, ...draft.cc]).not.toContain('me@example.com');
  });

  it('own-address matching is case-insensitive — Gmail echoes mixed case', () => {
    const draft = buildReplyDraft(msg({ from: 'ada@x.com', to: ['ME@Example.com'] }), 'replyAll', OWN);
    expect(draft.to).toEqual(['ada@x.com']);
  });

  it('matches case-insensitively in the OTHER direction too — the configured address may be the mixed one', () => {
    // The identity list comes from accounts.json, which a person typed.
    // A guard that only lower-cased one side would pass the test above
    // and still mail the user themselves in production.
    const draft = buildReplyDraft(msg({ from: 'ada@x.com', to: ['me@example.com'] }), 'replyAll', [
      'Me@Example.COM',
    ]);
    expect(draft.to).toEqual(['ada@x.com']);
  });

  it('drops every one of my addresses, not just the first', () => {
    const draft = buildReplyDraft(
      msg({ from: 'ada@x.com', to: ['me@example.com', 'valen@harvard.edu', 'bob@x.com'] }),
      'replyAll',
      ['me@example.com', 'valen@harvard.edu'],
    );
    expect(draft.to).toEqual(['ada@x.com', 'bob@x.com']);
  });

  it('reply-all with no Cc leaves Cc empty rather than undefined', () => {
    const draft = buildReplyDraft(msg({ from: 'ada@x.com', to: ['bob@x.com'] }), 'replyAll', OWN);
    expect(draft.cc).toEqual([]);
  });

  it('de-duplicates case-insensitively, keeping the FIRST spelling seen', () => {
    const draft = buildReplyDraft(
      msg({ from: 'Ada <Ada@X.com>', to: ['ada@x.com', 'bob@x.com'], cc: ['BOB@x.com'] }),
      'replyAll',
      OWN,
    );
    expect(draft.to).toEqual(['Ada@X.com', 'bob@x.com']);
    // Already in To — a person copied twice would get two SMTP copies and
    // two tracking pixels for one message.
    expect(draft.cc).toEqual([]);
  });

  it('never puts the same person in both To and Cc', () => {
    const draft = buildReplyDraft(
      msg({ from: 'ada@x.com', to: ['bob@x.com'], cc: ['Bob@X.com', 'carol@x.com'] }),
      'replyAll',
      OWN,
    );
    expect(draft.to).toEqual(['ada@x.com', 'bob@x.com']);
    expect(draft.cc).toEqual(['carol@x.com']);
  });

  it('a message with no From yields no recipient rather than a blank one', () => {
    const draft = buildReplyDraft(msg({ from: null, to: ['bob@x.com'] }), 'reply', OWN);
    expect(draft.to).toEqual([]);
  });

  it('replying to my OWN sent message answers the people I wrote to, not me', () => {
    // Reachable from the Sent folder, which this app has in its nav (`g t`).
    // Pre-filling my own address there is the same failure reply-all has
    // to avoid, arriving by a different route.
    const draft = buildReplyDraft(
      msg({ from: 'me@example.com', to: ['ada@x.com', 'bob@x.com'] }),
      'reply',
      OWN,
    );
    expect(draft.to).toEqual(['ada@x.com', 'bob@x.com']);
    expect(draft.to).not.toContain('me@example.com');
  });

  it('reply-all on my own sent message needs no special case — the filter already removes me', () => {
    const draft = buildReplyDraft(
      msg({ from: 'me@example.com', to: ['ada@x.com'], cc: ['carol@x.com'] }),
      'replyAll',
      OWN,
    );
    expect(draft.to).toEqual(['ada@x.com']);
    expect(draft.cc).toEqual(['carol@x.com']);
  });

  it('an empty own-address list changes nothing else about the derivation', () => {
    // The identity fetch can fail; a reply derived with no known
    // identities must still address the sender rather than nobody.
    const draft = buildReplyDraft(msg({ from: 'ada@x.com', to: ['me@example.com'] }), 'replyAll', []);
    expect(draft.to).toEqual(['ada@x.com', 'me@example.com']);
  });

  it('ignores blank and whitespace-only addresses instead of chipping them', () => {
    const draft = buildReplyDraft(msg({ from: 'ada@x.com', to: ['   ', 'bob@x.com'] }), 'replyAll', OWN);
    expect(draft.to).toEqual(['ada@x.com', 'bob@x.com']);
  });
});

describe('forward', () => {
  it('prefixes Fwd: and pre-fills NO recipient', () => {
    const draft = buildReplyDraft(msg({ subject: 'numbers', from: 'ada@x.com' }), 'forward', OWN);
    expect(draft.subject).toBe('Fwd: numbers');
    // Sending a forward to the original sender is the classic misfire.
    expect(draft.to).toEqual([]);
  });

  it('pre-fills no Cc either, however many the original carried', () => {
    const draft = buildReplyDraft(
      msg({ from: 'ada@x.com', to: ['bob@x.com'], cc: ['carol@x.com'] }),
      'forward',
      OWN,
    );
    expect(draft.cc).toEqual([]);
  });

  it('does not double-prefix an already-forwarded subject', () => {
    expect(buildReplyDraft(msg({ subject: 'Fwd: numbers' }), 'forward', OWN).subject).toBe('Fwd: numbers');
  });

  it('treats the older Fw: spelling as already prefixed', () => {
    expect(buildReplyDraft(msg({ subject: 'Fw: numbers' }), 'forward', OWN).subject).toBe('Fw: numbers');
  });

  it('forwards a Re: subject as Fwd: Re: — they are different prefixes', () => {
    expect(buildReplyDraft(msg({ subject: 'Re: numbers' }), 'forward', OWN).subject).toBe(
      'Fwd: Re: numbers',
    );
  });
});

describe('the subject prefix', () => {
  it('does not double-prefix an already-Re: subject', () => {
    expect(buildReplyDraft(msg({ subject: 'Re: numbers' }), 'reply', OWN).subject).toBe('Re: numbers');
    expect(buildReplyDraft(msg({ subject: 'numbers' }), 'reply', OWN).subject).toBe('Re: numbers');
  });

  it('is ANCHORED — "Agenda: Re-org" is not already prefixed', () => {
    // An unanchored /re:\s*/i matches the "re:" nowhere in this string,
    // but an unanchored match against a subject that merely CONTAINS
    // "Re:" later on would leave the reply unprefixed and unrecognisable
    // as a reply in every client that groups by subject.
    expect(buildReplyDraft(msg({ subject: 'Agenda: Re-org' }), 'reply', OWN).subject).toBe(
      'Re: Agenda: Re-org',
    );
    expect(buildReplyDraft(msg({ subject: 'Fwd: Re: numbers' }), 'reply', OWN).subject).toBe(
      'Re: Fwd: Re: numbers',
    );
    expect(buildReplyDraft(msg({ subject: 'question re: numbers' }), 'reply', OWN).subject).toBe(
      'Re: question re: numbers',
    );
  });

  it('is case-insensitive — RE:, re: and Re: are all already prefixed', () => {
    expect(buildReplyDraft(msg({ subject: 'RE: numbers' }), 'reply', OWN).subject).toBe('RE: numbers');
    expect(buildReplyDraft(msg({ subject: 're: numbers' }), 'reply', OWN).subject).toBe('re: numbers');
  });

  it('accepts a prefix with no space after the colon', () => {
    expect(buildReplyDraft(msg({ subject: 'Re:numbers' }), 'reply', OWN).subject).toBe('Re:numbers');
  });

  it('leaves nested Re: alone rather than stacking another', () => {
    expect(buildReplyDraft(msg({ subject: 'Re: Re: numbers' }), 'reply', OWN).subject).toBe(
      'Re: Re: numbers',
    );
  });

  it('a message with no subject replies as "Re:" with nothing dangling after it', () => {
    expect(buildReplyDraft(msg({ subject: null }), 'reply', OWN).subject).toBe('Re:');
    expect(buildReplyDraft(msg({ subject: '   ' }), 'reply', OWN).subject).toBe('Re:');
    expect(buildReplyDraft(msg({ subject: null }), 'forward', OWN).subject).toBe('Fwd:');
  });

  it('trims a subject before prefixing it', () => {
    expect(buildReplyDraft(msg({ subject: '  numbers  ' }), 'reply', OWN).subject).toBe('Re: numbers');
  });
});

describe('threading', () => {
  it('replies In-Reply-To the message, with its id appended to the chain', () => {
    const threading = buildThreading(
      msg({ messageId: '<c@example.com>', references: ['<a@example.com>', '<b@example.com>'] }),
      'reply',
    );
    expect(threading.inReplyTo).toBe('<c@example.com>');
    expect(threading.references).toEqual(['<a@example.com>', '<b@example.com>', '<c@example.com>']);
  });

  it('keeps the angle brackets — these values become headers verbatim', () => {
    const threading = buildThreading(msg({ messageId: '<c@example.com>' }), 'reply');
    expect(threading.inReplyTo).toBe('<c@example.com>');
    expect(threading.references).toEqual(['<c@example.com>']);
  });

  it('a first reply in a thread references only the message being answered', () => {
    const threading = buildThreading(msg({ messageId: '<c@example.com>', references: [] }), 'replyAll');
    expect(threading.references).toEqual(['<c@example.com>']);
  });

  it('a message with no Message-ID threads nothing rather than emitting a blank header', () => {
    const threading = buildThreading(msg({ messageId: null, references: ['<a@example.com>'] }), 'reply');
    expect(threading.inReplyTo).toBeUndefined();
    expect(threading.references).toEqual([]);
  });

  it('a forward starts its own conversation and carries no threading headers', () => {
    const threading = buildThreading(msg({ messageId: '<c@example.com>' }), 'forward');
    expect(threading.inReplyTo).toBeUndefined();
    expect(threading.references).toEqual([]);
  });

  it('caps the chain at the server limit so a long thread cannot 400 the send', () => {
    const long = Array.from({ length: 200 }, (_, index) => `<${index}@x.com>`);
    const threading = buildThreading(msg({ messageId: '<last@x.com>', references: long }), 'reply');
    expect(threading.references.length).toBe(MAX_REFERENCES);
  });

  it('keeps the ROOT and the newest when it caps — the root is what groups the thread', () => {
    const long = Array.from({ length: 200 }, (_, index) => `<${index}@x.com>`);
    const threading = buildThreading(msg({ messageId: '<last@x.com>', references: long }), 'reply');
    expect(threading.references[0]).toBe('<0@x.com>');
    expect(threading.references[threading.references.length - 1]).toBe('<last@x.com>');
  });

  it('mirrors the server cap exactly', () => {
    // sync/src/api/send.ts MAX_REFERENCES. A client that sent one more
    // than the route accepts would 400 a reply the user can see no fault
    // in.
    expect(MAX_REFERENCES).toBe(50);
  });
});

describe('the quote source handed to the server', () => {
  it('sends the ORIGINAL body, not a built quote — only the server can strip our pixel', () => {
    const quote = buildQuoteSource(msg({ html: '<p>hi</p>', from: 'Ada <ada@x.com>', date: 1_700_000_000_000 }));
    expect(quote).not.toBeNull();
    expect(quote?.originalHtml).toBe('<p>hi</p>');
    expect(quote?.fromLabel).toBe('Ada <ada@x.com>');
    expect(quote?.sentAtMs).toBe(1_700_000_000_000);
  });

  it('never builds a .gmail_quote element in the client', () => {
    const quote = buildQuoteSource(msg({ html: '<p>hi</p>' }));
    expect(JSON.stringify(quote)).not.toContain('gmail_quote');
  });

  it('omits the plaintext alternative when there is html — the server only reads one', () => {
    // sync/src/send/quote.ts uses originalText ONLY when originalHtml is
    // null. Sending both spends the 100 KB quote budget on a field that
    // will not be read, and a 100 KB newsletter has both.
    const quote = buildQuoteSource(msg({ html: '<p>hi</p>', text: 'hi' }));
    expect(quote?.originalText).toBeNull();
  });

  it('sends the plaintext alternative when there is no html', () => {
    const quote = buildQuoteSource(msg({ html: null, text: 'plain body' }));
    expect(quote?.originalHtml).toBeNull();
    expect(quote?.originalText).toBe('plain body');
  });

  it('sentAtMs is epoch MILLISECONDS, never an ISO string', () => {
    const quote = buildQuoteSource(msg({ html: '<p>x</p>', date: 1_700_000_000_000 }));
    expect(typeof quote?.sentAtMs).toBe('number');
  });

  it('a message with no date quotes without one rather than sending null-as-string', () => {
    const quote = buildQuoteSource(msg({ html: '<p>x</p>', date: null }));
    expect(quote?.sentAtMs).toBeNull();
  });

  it('a message with neither body has nothing to quote', () => {
    expect(buildQuoteSource(msg({ html: null, text: null }))).toBeNull();
  });

  it('drops the quote rather than sending a body the route will refuse', () => {
    // sync/src/api/send.ts MAX_QUOTE_BODY_BYTES. Message bodies in this
    // reader are routinely 60–90 KB; a quote over the cap 400s the whole
    // send, which loses the user's own writing too.
    const huge = 'x'.repeat(MAX_QUOTE_BODY_BYTES + 1);
    expect(buildQuoteSource(msg({ html: huge }))).toBeNull();
  });

  it('measures the cap in BYTES, not characters', () => {
    // One emoji is four UTF-8 bytes. A character count would let four
    // times the limit through.
    const huge = '😀'.repeat(MAX_QUOTE_BODY_BYTES / 2);
    expect(buildQuoteSource(msg({ html: huge }))).toBeNull();
  });

  it('keeps a body exactly at the cap', () => {
    const atCap = 'x'.repeat(MAX_QUOTE_BODY_BYTES);
    expect(buildQuoteSource(msg({ html: atCap }))).not.toBeNull();
  });

  it('mirrors the server cap exactly', () => {
    expect(MAX_QUOTE_BODY_BYTES).toBe(100 * 1024);
  });
});

describe('the sender label in the attribution line', () => {
  it('is "Name <address>" when the sender has a display name', () => {
    expect(senderLabel({ name: 'Ada Lovelace', address: 'ada@x.com' })).toBe('Ada Lovelace <ada@x.com>');
  });

  it('is the bare address when there is no display name', () => {
    expect(senderLabel({ name: null, address: 'ada@x.com' })).toBe('ada@x.com');
    expect(senderLabel({ name: '  ', address: 'ada@x.com' })).toBe('ada@x.com');
  });

  it('never returns an empty string — the route refuses a blank fromLabel', () => {
    expect(senderLabel(null)).not.toBe('');
    expect(senderLabel({ name: null, address: '' })).not.toBe('');
  });

  it('strips control characters — this value is interpolated toward a header', () => {
    // sync/src/api/send.ts refuses the whole C0 range in fromLabel and
    // answers one opaque 400 for it. Stripping here means a mail with a
    // tab in its display name still sends.
    expect(senderLabel({ name: 'Ada\r\nBcc: attacker@evil.test', address: 'ada@x.com' })).not.toMatch(
      /[\u0000-\u001F\u007F]/,
    );
  });

  it('clamps a very long display name below the route cap', () => {
    const label = senderLabel({ name: 'A'.repeat(1000), address: 'ada@x.com' });
    expect(label.length).toBeLessThanOrEqual(320);
  });
});

describe('the fields that ride to POST /api/send', () => {
  const reply = {
    mode: 'reply' as const,
    accountId: 'personal',
    parsed: msg({ html: '<p>hi</p>', messageId: '<c@example.com>', references: ['<a@example.com>'] }),
  };

  it('carries inReplyTo, references and the quote source together', () => {
    const fields = replyWireFields(reply);
    expect(fields.inReplyTo).toBe('<c@example.com>');
    expect(fields.references).toEqual(['<a@example.com>', '<c@example.com>']);
    expect(fields.quote?.originalHtml).toBe('<p>hi</p>');
  });

  it('sends no quote key at all when there is nothing to quote', () => {
    const fields = replyWireFields({ ...reply, parsed: msg({ html: null, text: null }) });
    expect(fields.quote).toBeUndefined();
  });

  it('a forward carries the quote but no threading headers', () => {
    const fields = replyWireFields({ ...reply, mode: 'forward' });
    expect(fields.quote?.originalHtml).toBe('<p>hi</p>');
    expect(fields.inReplyTo).toBeUndefined();
    expect(fields.references).toEqual([]);
  });
});

describe('what the composer opens with', () => {
  const parsed = msg({
    from: 'ada@x.com',
    to: ['me@example.com', 'bob@x.com'],
    cc: ['carol@x.com'],
    subject: 'numbers',
  });

  it('seeds the fields from the derivation', () => {
    const seeded = seedReplyDraft({ mode: 'replyAll', accountId: 'personal', parsed }, OWN);
    expect(seeded.to).toEqual(['ada@x.com', 'bob@x.com']);
    expect(seeded.cc).toEqual(['carol@x.com']);
    expect(seeded.subject).toBe('Re: numbers');
  });

  it('reveals the Cc field when a reply-all actually has a Cc', () => {
    const seeded = seedReplyDraft({ mode: 'replyAll', accountId: 'personal', parsed }, OWN);
    expect(seeded.isCcShown).toBe(true);
  });

  it('leaves Cc hidden when there is none — an empty field is noise', () => {
    const seeded = seedReplyDraft({ mode: 'reply', accountId: 'personal', parsed }, OWN);
    expect(seeded.isCcShown).toBe(false);
  });

  it('opens a reply in the BODY — the recipients are already filled in', () => {
    expect(initialFocusFor('reply')).toBe('body');
    expect(initialFocusFor('replyAll')).toBe('body');
  });

  it('opens a forward in To — that is the one field a forward leaves empty', () => {
    expect(initialFocusFor('forward')).toBe('to');
  });

  it('opens a plain compose in To, exactly as it does today', () => {
    expect(initialFocusFor(null)).toBe('to');
  });
});

describe('what the composer says it is', () => {
  it('names the action, so r and a are distinguishable after the fact', () => {
    expect(composerTitleFor('reply')).toBe('Reply');
    expect(composerTitleFor('replyAll')).toBe('Reply all');
    expect(composerTitleFor('forward')).toBe('Forward');
  });

  it('is "New message" for a plain compose, unchanged', () => {
    expect(composerTitleFor(null)).toBe('New message');
  });

  it('gives every mode its own title', () => {
    const titles = (['reply', 'replyAll', 'forward', null] as const).map(composerTitleFor);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('what the composer says about the quote', () => {
  const source = { mode: 'reply' as const, accountId: 'personal' };

  it('says nothing at all for a plain compose', () => {
    expect(quoteNoticeFor(undefined)).toBeNull();
  });

  it('promises the quote when there is one', () => {
    expect(quoteNoticeFor({ ...source, parsed: msg({ html: '<p>hi</p>' }) })).toContain('quoted below');
  });

  it('ADMITS when the original is too large to quote', () => {
    // Silently dropping it would have the user send a reply they believe
    // carries the conversation and does not.
    const notice = quoteNoticeFor({
      ...source,
      parsed: msg({ html: 'x'.repeat(MAX_QUOTE_BODY_BYTES + 1) }),
    });
    expect(notice).toContain('too large');
  });

  it('says nothing when the original had no body to quote in the first place', () => {
    expect(quoteNoticeFor({ ...source, parsed: msg({ html: null, text: null }) })).toBeNull();
  });
});

describe('the composer remount key', () => {
  const parsed = msg({ messageId: '<c@example.com>' });

  it('changes when the MODE changes on the same message', () => {
    // `r` then `a` differ in exactly the recipient list; without a
    // remount the second would show the first one's.
    expect(replyKey({ mode: 'reply', accountId: 'a', parsed })).not.toBe(
      replyKey({ mode: 'replyAll', accountId: 'a', parsed }),
    );
  });

  it('changes when the MESSAGE changes', () => {
    expect(replyKey({ mode: 'reply', accountId: 'a', parsed })).not.toBe(
      replyKey({ mode: 'reply', accountId: 'a', parsed: msg({ messageId: '<d@example.com>' }) }),
    );
  });

  it('changes when the ACCOUNT changes — the same mail can be in two mailboxes', () => {
    expect(replyKey({ mode: 'reply', accountId: 'personal', parsed })).not.toBe(
      replyKey({ mode: 'reply', accountId: 'harvard', parsed }),
    );
  });

  it('is stable for the same reply, so a re-render does not throw the draft away', () => {
    expect(replyKey({ mode: 'reply', accountId: 'a', parsed })).toBe(
      replyKey({ mode: 'reply', accountId: 'a', parsed }),
    );
  });

  it('distinguishes two messages that carry no Message-ID at all', () => {
    const first = msg({ messageId: null, subject: 'one', date: 1 });
    const second = msg({ messageId: null, subject: 'two', date: 2 });
    expect(replyKey({ mode: 'reply', accountId: 'a', parsed: first })).not.toBe(
      replyKey({ mode: 'reply', accountId: 'a', parsed: second }),
    );
  });

  it('has its own value for a plain compose', () => {
    expect(replyKey(null)).toBe('compose');
  });
});

describe('an untouched reply is not a draft to discard', () => {
  /**
   * FOUND IN THE BROWSER, not by the suite. Opening a forward and
   * pressing Escape put a native "Discard this draft?" confirm in front
   * of a user who had typed nothing — because a reply arrives with its
   * recipients and subject already filled in, and the old check only
   * asked "is there anything in these fields?".
   */
  const seed = {
    to: ['ada@x.com'],
    cc: ['carol@x.com'],
    subject: 'Re: numbers',
    isCcShown: true,
  };
  const draftOf = (overrides: Partial<{ to: string[]; cc: string[]; subject: string; textBody: string }> = {}) => ({
    identityId: 'personal',
    to: seed.to,
    cc: seed.cc,
    subject: seed.subject,
    textBody: '',
    ...overrides,
  });

  it('is clean when nothing has been touched', () => {
    expect(isDraftDirty(draftOf(), seed)).toBe(false);
  });

  it('is dirty the moment anything is typed into the body', () => {
    expect(isDraftDirty(draftOf({ textBody: 'x' }), seed)).toBe(true);
  });

  it('treats whitespace-only typing as nothing typed', () => {
    expect(isDraftDirty(draftOf({ textBody: '   \n ' }), seed)).toBe(false);
  });

  it('is dirty when the subject is edited', () => {
    expect(isDraftDirty(draftOf({ subject: 'Re: numbers!' }), seed)).toBe(true);
  });

  it('is dirty when a recipient is ADDED', () => {
    expect(isDraftDirty(draftOf({ to: ['ada@x.com', 'dave@x.com'] }), seed)).toBe(true);
  });

  it('is dirty when a seeded recipient is REMOVED', () => {
    // Deleting a chip the seed added is the user's work too, and losing
    // it silently would re-add someone they deliberately took off.
    expect(isDraftDirty(draftOf({ cc: [] }), seed)).toBe(true);
  });

  it('does not mistake a case difference for an edit', () => {
    expect(isDraftDirty(draftOf({ to: ['ADA@X.com'] }), seed)).toBe(false);
  });

  it('notices a REORDER, because an order change is an edit', () => {
    const twoUp = { ...seed, to: ['ada@x.com', 'bob@x.com'] };
    expect(isDraftDirty(draftOf({ to: ['bob@x.com', 'ada@x.com'] }), twoUp)).toBe(true);
  });

  it('falls back to plain content for a compose with no seed at all', () => {
    expect(isDraftDirty(draftOf({ to: [], cc: [], subject: '', textBody: '' }), null)).toBe(false);
    expect(isDraftDirty(draftOf({ to: [], cc: [], subject: 'hi', textBody: '' }), null)).toBe(true);
  });
});
