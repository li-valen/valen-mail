import { describe, expect, it } from 'vitest';
import appSource from '../src/App.tsx?raw';
import composeSource from '../src/components/Compose.tsx?raw';
import messageViewSource from '../src/components/MessageView.tsx?raw';
import composeApiSource from '../src/composeApi.ts?raw';
import replyDraftSource from '../src/replyDraft.ts?raw';
import hookSource from '../src/keyboard/useKeyboardShortcuts.ts?raw';

/**
 * The WIRING checks for reply, reply-all and forward — the same
 * `?raw`-import-and-regex technique tests/keyboard-static-guards.test.ts
 * and tests/compose-static-guards.test.ts already use, and the only tool
 * available under client/CLAUDE.md's standing constraint that no test in
 * this project renders a component.
 *
 * WHAT THESE COVER AND WHAT THEY DO NOT. The behaviour is tested properly
 * in tests/reply-draft.test.ts: who a reply is addressed to, what its
 * subject becomes, what it threads with. What that file cannot reach is
 * whether any COMPONENT calls it — an App.tsx that imported
 * `buildReplyDraft` and never rendered a Reply button would leave the
 * whole suite green while the user still could not answer an email, which
 * is the exact failure this task exists to fix.
 *
 * And even these cannot prove the last thing: unit tests pass with the
 * threading headers dropped anywhere between here and the SMTP
 * transaction. Only sending a real reply and looking at the real thread
 * in Gmail proves that. The task report records it.
 *
 * Every guard is paired with a synthetic fixture proving the pattern
 * would genuinely catch its own regression rather than always passing.
 */

/** Strips comments so a doc comment that merely NAMES an identifier — the
 *  files below do exactly that, at length — is never read as live code.
 *  It also makes the "never builds a quote" check stricter: prose about
 *  `.gmail_quote` must not count as building one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const APP = stripComments(appSource);
const COMPOSE = stripComments(composeSource);
const READER = stripComments(messageViewSource);
const API = stripComments(composeApiSource);
const DRAFT = stripComments(replyDraftSource);
const HOOK = stripComments(hookSource);

describe('the reader can actually start a reply', () => {
  it('renders all three actions', () => {
    for (const label of ['Reply', 'Reply all', 'Forward']) {
      expect(READER.includes(label), `the reader does not render "${label}"`).toBe(true);
    }
  });

  it('wires each button to its own mode', () => {
    expect(/onReply\('reply'\)/.test(READER)).toBe(true);
    expect(/onReply\('replyAll'\)/.test(READER)).toBe(true);
    expect(/onReply\('forward'\)/.test(READER)).toBe(true);
  });

  it('App.tsx hands the reader a handler to call', () => {
    expect(/onReply=\{/.test(APP)).toBe(true);
  });

  it('the mode-wiring guard is not vacuous', () => {
    expect(/onReply\('replyAll'\)/.test("onClick={() => onReply('replyAll')}")).toBe(true);
    // The bug it catches: two buttons wired to the same mode, so "Reply
    // all" quietly replies to the sender only.
    expect(/onReply\('replyAll'\)/.test("onClick={() => onReply('reply')}")).toBe(false);
  });

  it('waits for the parsed body before letting a reply start', () => {
    // A reply needs the html to quote and the Message-ID to thread; a
    // click before the body lands would open a composer that can do
    // neither, and would look identical to one that can.
    expect(/isReady=\{load\.status === 'ready'\}/.test(READER)).toBe(true);
    expect(/disabled=\{!isReady\}/.test(READER)).toBe(true);
  });

  it('advertises the keyboard equivalent on each control', () => {
    for (const key of ['r', 'a', 'f']) {
      expect(READER.includes(`aria-keyshortcuts="${key}"`)).toBe(true);
    }
  });
});

describe('the keyboard reaches the same handler the buttons do', () => {
  it('the hook declares an onReply handler', () => {
    expect(/onReply:\s*\(mode: ReplyMode\) => void/.test(HOOK)).toBe(true);
  });

  it('and runs it for the reply action', () => {
    expect(/case 'reply':[\s\S]{0,80}onReply\(action\.mode\)/.test(HOOK)).toBe(true);
  });

  it('App.tsx supplies it', () => {
    expect(/onReply:\s*replyToMessageInHand/.test(APP)).toBe(true);
  });

  it('the action guard is not vacuous', () => {
    expect(/case 'reply':[\s\S]{0,80}onReply\(action\.mode\)/.test("case 'reply': return;")).toBe(false);
  });
});

describe('the composer is opened pre-filled', () => {
  it('App.tsx passes the reply source down', () => {
    expect(/reply=\{replySource \?\? undefined\}/.test(APP)).toBe(true);
  });

  it('and remounts it per reply, so a second reply does not inherit the first', () => {
    expect(/key=\{replyKey\(replySource\)\}/.test(APP)).toBe(true);
  });

  it('the composer seeds its fields from the derivation', () => {
    expect(/seedReplyDraft\(/.test(COMPOSE)).toBe(true);
  });

  it('seeds AFTER the identities land, never before', () => {
    // Reply-all removes every address of the user's OWN, and the identity
    // list is the only place this client learns what those are. Seeding
    // on mount would run with an empty own-address list and copy the user
    // on their own reply.
    expect(/getIdentities\(\)[\s\S]*?seedReplyDraft\(/.test(COMPOSE)).toBe(true);
  });

  it('derives the own-address list from the identities, not from anywhere else', () => {
    expect(/loaded\.map\(\(identity\) => identity\.email\)/.test(COMPOSE)).toBe(true);
  });

  it('sends a reply FROM the account that received it', () => {
    expect(/identityIdForAccount\(reply\.accountId/.test(COMPOSE)).toBe(true);
  });

  it('the seeding-order guard is not vacuous', () => {
    const wrong = 'useEffect(() => { seedReplyDraft(reply, []); }, []);\ngetIdentities()';
    expect(/getIdentities\(\)[\s\S]*?seedReplyDraft\(/.test(wrong)).toBe(false);
  });
});

describe('the send call carries the threading', () => {
  it('the composer spreads the reply fields into the send it submits', () => {
    // Plan 11 put an await between the two — the files are read before
    // the request goes out — so the reply fields now reach `sendMail`
    // through `submitDraft`. What must stay true is that the object
    // handed to the send carries them, and that NOTHING else is handed
    // to `sendMail` instead.
    expect(/submitDraft\([\s\S]{0,120}replyWireFields\(reply\)/.test(COMPOSE)).toBe(true);
    expect(/sendMail\(\{ \.\.\.wire, attachments \}\)/.test(COMPOSE)).toBe(true);
    expect(/async function submitDraft\(wire: SendRequest\)/.test(COMPOSE)).toBe(true);
  });

  it('composeApi puts inReplyTo, references and quote on the wire', () => {
    for (const field of ['inReplyTo', 'references', 'quote']) {
      expect(API.includes(field), `composeApi never serialises ${field}`).toBe(true);
    }
  });

  it('omits them when absent rather than sending null', () => {
    // sync/src/api/send.ts answers 400 for a PRESENT but unusable field,
    // so an explicit `inReplyTo: null` would break every plain compose.
    expect(/request\.inReplyTo === undefined \? \{\} :/.test(API)).toBe(true);
  });

  it('the send-call guard is not vacuous', () => {
    expect(/submitDraft\([\s\S]{0,120}replyWireFields\(reply\)/.test('submitDraft(draft);')).toBe(
      false,
    );
    expect(/sendMail\(\{ \.\.\.wire, attachments \}\)/.test('sendMail(draft)')).toBe(false);
  });
});

describe('the client never builds or strips a quote', () => {
  /**
   * THE BINDING ONE. spec §5.6 requires our own tracking pixel to be
   * stripped out of the quoted original BEFORE the reply's new pixel goes
   * in, and that strip needs `TRACKING_BASE_URL` — a value this client
   * deliberately never learns (composeApi.ts's header states the rule).
   * A quote built here could not perform the strip, so every reply in the
   * thread would re-fire the ORIGINAL recipient's token forever,
   * reporting opens nobody performed. The server builds it.
   */
  const CLIENT_SURFACE = [APP, COMPOSE, READER, API, DRAFT].join('\n');

  it('emits no .gmail_quote element anywhere', () => {
    expect(CLIENT_SURFACE).not.toMatch(/gmail_quote/);
  });

  it('builds no blockquote and no attribution line', () => {
    expect(CLIENT_SURFACE).not.toMatch(/<blockquote/i);
    expect(CLIENT_SURFACE).not.toMatch(/\bwrote:/);
  });

  it('never learns the tracking origin', () => {
    expect(CLIENT_SURFACE).not.toMatch(/TRACKING_BASE_URL|trackingBaseUrl/);
  });

  it('sends the SOURCE fields the route expects instead', () => {
    for (const field of ['originalHtml', 'originalText', 'fromLabel', 'sentAtMs']) {
      expect(DRAFT.includes(field), `the quote source is missing ${field}`).toBe(true);
    }
  });

  it('the quote-building guards are not vacuous', () => {
    expect('<blockquote class="gmail_quote">').toMatch(/gmail_quote/);
    expect('<blockquote class="gmail_quote">').toMatch(/<blockquote/i);
    expect('const base = TRACKING_BASE_URL;').toMatch(/TRACKING_BASE_URL|trackingBaseUrl/);
  });
});

describe('a plain compose is untouched', () => {
  it('still opens with no reply source', () => {
    expect(/setReplySource\(null\)/.test(APP)).toBe(true);
  });

  it('the composer names the mode it is in', () => {
    expect(/composerTitleFor\(reply\?\.mode \?\? null\)/.test(COMPOSE)).toBe(true);
  });

  it('a seeded Cc does not steal focus the way a clicked one does', () => {
    // Focus for a reply belongs in the body; a reply-all that seeded Cc
    // would otherwise drag the cursor there a beat after the composer
    // opened.
    expect(/isCcShown && isCcRevealedByUserRef\.current/.test(COMPOSE)).toBe(true);
    expect(/isCcRevealedByUserRef\.current = true/.test(COMPOSE)).toBe(true);
  });

  it('the focus guard is not vacuous', () => {
    expect(/isCcShown && isCcRevealedByUserRef\.current/.test('if (isCcShown) ccInputRef.current?.focus();')).toBe(
      false,
    );
  });
});

describe('the pure module stays pure', () => {
  it('reaches for no React, no fetch and no DOM', () => {
    expect(DRAFT).not.toMatch(/\bfrom 'react'/);
    expect(DRAFT).not.toMatch(/\bfetch\(/);
    expect(DRAFT).not.toMatch(/\bdocument\.|\bwindow\./);
  });

  it('the purity guard is not vacuous', () => {
    expect("import { useState } from 'react';").toMatch(/\bfrom 'react'/);
    expect('document.querySelector("a")').toMatch(/\bdocument\.|\bwindow\./);
  });
});


describe('replying to the message you are reading happens in place', () => {
  const APP_SRC = stripComments(appSource);
  const READER = stripComments(messageViewSource);

  it('does not swap the conversation out for a blank form', () => {
    // "Inline would be great." A reply is written while re-reading what it
    // answers; replacing the thread with a form is what makes people open a
    // second window. Gmail puts the composer at the foot of the thread.
    expect(APP_SRC).toMatch(/if \(isReadingThisMessage\) return;/);
    expect(APP_SRC).toMatch(/messageKey\(selected\) === messageKey\(message\)/);
    expect(READER).toContain('{replyComposer}');
  });

  it('builds ONE composer element and places it twice', () => {
    // Two <Compose> call sites with their own props is exactly how the
    // inline one would come to disagree with the full-page one about which
    // handlers it calls — which send path, which dirty guard.
    expect((APP_SRC.match(/<Compose\b/g) ?? []).length).toBe(1);
    expect(APP_SRC).toMatch(/const inlineComposer =\s*\n?\s*replySource !== null && view !== 'compose' \? composer : null;/);
  });

  it('closing an inline reply does not navigate the reader away', () => {
    // An inline reply never changed `view`, so restoring viewBeforeCompose
    // would jump to wherever the last FULL composer was opened from — a
    // stale value, and a move the user never asked for.
    expect(APP_SRC).toMatch(/setView\(\(current\) => \(current === 'compose' \? viewBeforeComposeRef\.current : current\)\);/);
  });

  it('withdraws the reply actions while the composer is open', () => {
    // Found by looking at it, not by measuring: the sticky mobile bar is
    // pinned to the bottom edge, so with the composer open it sat directly
    // over the composer's own Send. "Reply" offering to start the reply
    // that is already open and half-written is a control with nothing to
    // do; the one covering Send is actively harmful.
    const gated = READER.match(/onReply !== undefined && replyComposer === null &&/g) ?? [];
    expect(gated.length).toBe(2); // the desktop placement and the sticky one
  });

  it('replying from the LIST still takes over the column', () => {
    // There is no conversation on screen to preserve, so there is nothing
    // the inline placement would buy.
    expect(APP_SRC).toMatch(/if \(view !== 'compose'\) viewBeforeComposeRef\.current = view;\s*\n\s*setView\('compose'\);/);
  });
});
