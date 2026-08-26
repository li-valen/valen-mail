import { describe, expect, it } from 'vitest';
import appSource from '../src/App.tsx?raw';
import inboxListSource from '../src/components/InboxList.tsx?raw';
import messageRowSource from '../src/components/MessageRow.tsx?raw';
import messageViewSource from '../src/components/MessageView.tsx?raw';
import conversationsSource from '../src/conversations.ts?raw';
import followupViewSource from '../src/components/FollowupView.tsx?raw';
import threadContextSource from '../src/components/ThreadContext.tsx?raw';

/**
 * The WIRING checks for the collapsed list — the same
 * `?raw`-import-and-regex technique the other four guard suites use, and
 * the only tool available under client/CLAUDE.md's standing constraint
 * that no test in this project renders a component.
 *
 * WHAT THESE COVER AND WHAT THEY DO NOT. Every decision is tested
 * properly in tests/conversations.test.ts, against plain arrays. What
 * that cannot reach is whether the COMPONENT asks — a list that grouped
 * perfectly and then drew a row from the representative's own `flags`
 * would leave the whole suite green while an unread reply sat invisible
 * behind a row that looks read. Each guard below is paired with a
 * synthetic fixture proving the pattern would catch its own regression
 * rather than always passing.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const APP = stripComments(appSource);
const LIST = stripComments(inboxListSource);
const ROW = stripComments(messageRowSource);
const READER = stripComments(messageViewSource);
const CONVERSATIONS = stripComments(conversationsSource);
const FOLLOWUP = stripComments(followupViewSource);
const THREAD = stripComments(threadContextSource);

describe('the list asks the server for whole conversations', () => {
  it('fetches the conversation route rather than the message ones', () => {
    // Grouping a page of MESSAGES would give a count that grows on every
    // "Load more" — on this mailbox, a 40-message thread spread over 25
    // days would draw as "(1)" on page one.
    expect(/getConversationsPage/.test(LIST)).toBe(true);
    expect(/getInbox|getSearch/.test(LIST)).toBe(false);
  });

  it('uses ONE call for the list and the search, with q switching between them', () => {
    expect(/q: search === '' \? undefined : search/.test(LIST)).toBe(true);
  });

  it('keeps the generation-guarded Load more exactly as it was', () => {
    // The cursor now addresses the next CONVERSATION, but nothing about
    // how the client pages changed — same guard, same discard, same
    // functional append.
    expect(/resolveLoadMorePage\(selectionId, selectionRef\.current, page\)/.test(LIST)).toBe(true);
    expect(/setMessages\(\(previous\) => \[\.\.\.previous, \.\.\.resolution\.messages\]\)/.test(LIST)).toBe(
      true,
    );
    expect(/if \(!isCurrentSelection\(selectionId, selectionRef\.current\)\) return;/.test(LIST)).toBe(
      true,
    );
  });

  it('the route guard is not vacuous', () => {
    expect(/getInbox|getSearch/.test("return getInbox(request);")).toBe(true);
  });
});

describe('a row reads the WHOLE conversation, never just its newest message', () => {
  it('unread is “any member”, through the override-aware resolver', () => {
    // One unread among twelve read ones makes the conversation unread.
    // Reading `resolveUnread(representative, …)` instead hides new mail
    // behind a row that looks dealt with — and `resolveUnread` is what
    // keeps an optimistic mark-read visible in the same frame.
    expect(
      /isUnread=\{isConversationUnread\(conversation, \(member\) =>[\s\S]{0,120}resolveUnread\(member, seenOverrides, messageKey\(member\)\)/.test(
        LIST,
      ),
    ).toBe(true);
    expect(/return conversation\.messages\.some\(isUnreadOf\);/.test(CONVERSATIONS)).toBe(true);
  });

  it('the star and the paperclip are “any member” too', () => {
    expect(
      /isStarred=\{isConversationStarred\(conversation, \(member\) =>[\s\S]{0,120}resolveStar\(member, starOverrides, messageKey\(member\)\)/.test(
        LIST,
      ),
    ).toBe(true);
    expect(/hasAttachment=\{conversationHasAttachment\(conversation\)\}/.test(LIST)).toBe(true);
  });

  it('the sender column shows the participants when they differ', () => {
    expect(/senderLabel=\{participantsLabel\(conversation\)\}/.test(LIST)).toBe(true);
    // …and falls back to the row's own resolution when it is absent, so a
    // single-message row is unchanged from before this feature existed.
    expect(/const sender = senderLabel \?\? rowSender;/.test(ROW)).toBe(true);
  });

  it('the count is drawn from the module’s decision, not from a `> 1` in the JSX', () => {
    expect(/conversationCount=\{conversationCountLabel\(count\)\}/.test(LIST)).toBe(true);
    expect(/conversationAnnouncement=\{conversationCountAnnouncement\(count\)\}/.test(LIST)).toBe(
      true,
    );
    expect(/return count > 1 \? `\(\$\{count\}\)` : null;/.test(CONVERSATIONS)).toBe(true);
  });

  it('the count is a shrink-0 SIBLING of the sender, so truncation cannot eat it', () => {
    expect(
      /\{conversationCount !== null && \([\s\S]{0,400}shrink-0 tabular-nums/.test(ROW),
    ).toBe(true);
  });

  it('the row-reads-the-conversation guards are not vacuous', () => {
    expect(/hasAttachment=\{conversationHasAttachment\(conversation\)\}/.test(
      'hasAttachment={message.has_attach}',
    )).toBe(false);
    expect(/return conversation\.messages\.some\(isUnreadOf\);/.test(
      'return isUnreadOf(conversation.representative);',
    )).toBe(false);
    expect(/return count > 1 \? `\(\$\{count\}\)` : null;/.test('return `(${count})`;')).toBe(false);
  });
});

describe('the row keeps the design the user approved', () => {
  it('still two anatomies split at lg:, with the desktop one untouched', () => {
    expect(/hidden h-11 w-full items-center gap-3 px-4 lg:flex/.test(ROW)).toBe(true);
    expect(/w-40 shrink-0 truncate font-semibold text-neutral-900 dark:text-foreground/.test(ROW)).toBe(
      true,
    );
    expect(/flex items-start gap-3 px-3 py-2\.5 lg:hidden/.test(ROW)).toBe(true);
  });

  it('still borderless below lg:, with unread as WEIGHT and no tint', () => {
    expect(/const ROW_SELECTED =\s*\n?\s*'lg:bg-neutral-100/.test(ROW)).toBe(true);
    expect(/min-w-0 flex-1 truncate text-neutral-900 dark:text-foreground/.test(ROW)).toBe(true);
  });

  it('still one avatar per row, from the representative’s own sender', () => {
    // Deliberately NOT overridden with the participants label: the letter
    // and the colour belong to the newest sender, who the rest of the row
    // is about.
    expect(/const \{ sender: rowSender, subject, preview, initial, tone \} = rowLayoutFor\(message\);/.test(ROW)).toBe(
      true,
    );
  });
});

describe('day grouping, the cursor and the reader still work on rows', () => {
  it('groups by the REPRESENTATIVE’s date, so a row sits under a heading its time agrees with', () => {
    expect(
      /groupByDayOf\(conversations, \(conversation\) => conversation\.representative\.date, now\)/.test(
        LIST,
      ),
    ).toBe(true);
  });

  it('the roving tab stop is one per ROW, not one per message', () => {
    expect(/const first = conversations\[0\];/.test(LIST)).toBe(true);
    expect(/tabIndex=\{key === tabStopKey \? 0 : -1\}/.test(LIST)).toBe(true);
  });

  it('j/k walk the representatives', () => {
    // A cursor over every loaded message would spend thirty-nine presses
    // of `j` inside a forty-message conversation that draws as one row.
    expect(/const visibleMessages = useMemo\(\(\) => representativesOf\(conversations\)/.test(APP)).toBe(
      true,
    );
    expect(/listLength: visibleMessages\.length/.test(APP)).toBe(true);
    expect(/onSelect: moveCursor/.test(APP)).toBe(true);
  });

  it('the reader still opens one message and still lists the rest of the thread', () => {
    // "A collapsed conversation must still be openable to its individual
    // messages" is ThreadContext, which already existed and which this
    // task deliberately does not duplicate — there is no second thread
    // view anywhere in the client.
    expect(/<ThreadContext/.test(READER)).toBe(true);
    expect(/getThread\(threadId\)/.test(THREAD)).toBe(true);
    expect(/Also in this thread/.test(THREAD)).toBe(true);
    // The one place a thread is listed. A second component fetching
    // /api/thread would be the duplicate this asserts against.
    expect(/getThread/.test(LIST)).toBe(false);
    expect(/getThread/.test(APP)).toBe(false);
  });

  it('the reader’s neighbour prefetch reads the ROWS', () => {
    expect(/neighbours=\{visibleMessages\}/.test(APP)).toBe(true);
  });

  it('the opens registry is folded from EVERY member, not from the rows', () => {
    // A Recent-opens click names one message. Folding only the
    // representatives would answer "not in the synced window" about the
    // fourth reply in a conversation that is right there on screen.
    expect(/foldMessageIndex\(known, allMessagesOf\(next\)\)/.test(APP)).toBe(true);
  });

  it('the follow-up queue is left completely alone', () => {
    // A separate view with its own list, its own ranking and its own
    // reader. Nothing in this task touches it.
    expect(/conversation/i.test(FOLLOWUP)).toBe(false);
  });

  it('these guards are not vacuous', () => {
    expect(/const visibleMessages = useMemo\(\(\) => representativesOf\(conversations\)/.test(
      'const visibleMessages = useMemo(() => allMessagesOf(conversations), [conversations]);',
    )).toBe(false);
    expect(/foldMessageIndex\(known, allMessagesOf\(next\)\)/.test(
      'foldMessageIndex(known, representativesOf(next))',
    )).toBe(false);
  });
});

describe('the grouping module stays pure', () => {
  it('imports no React', () => {
    expect(/from 'react'/.test(CONVERSATIONS)).toBe(false);
    expect(/useState|useEffect|useMemo/.test(CONVERSATIONS)).toBe(false);
  });

  it('takes its per-message predicates as arguments rather than reaching for state', () => {
    // `resolveUnread`/`resolveStar` need App.tsx's optimistic overrides,
    // which this module must not know about — so the caller resolves and
    // this module owns only the word "some".
    expect(/resolveUnread|resolveStar|seenOverrides|starOverrides/.test(CONVERSATIONS)).toBe(false);
    expect(/isUnreadOf: \(message: InboxMessage\) => boolean/.test(CONVERSATIONS)).toBe(true);
  });
});
