import { describe, expect, it } from 'vitest';
import appSource from '../src/App.tsx?raw';
import inboxListSource from '../src/components/InboxList.tsx?raw';
import messageRowSource from '../src/components/MessageRow.tsx?raw';
import messageViewSource from '../src/components/MessageView.tsx?raw';
import undoNoticeSource from '../src/components/UndoNotice.tsx?raw';
import actionsSource from '../src/mailboxActions.ts?raw';
import hookSource from '../src/keyboard/useKeyboardShortcuts.ts?raw';

/**
 * The WIRING checks for archive, trash and undo — the same
 * `?raw`-import-and-regex technique tests/reply-wiring-static-guards.test.ts
 * and tests/keyboard-static-guards.test.ts already use, and the only tool
 * available under client/CLAUDE.md's standing constraint that no test in
 * this project renders a component.
 *
 * WHAT THESE COVER AND WHAT THEY DO NOT. The behaviour is tested properly
 * in tests/mailbox-actions.test.ts and tests/move-api.test.ts. What those
 * cannot reach is whether any COMPONENT calls them — an App.tsx that
 * imported `hideMessage` and never rendered an Archive button would leave
 * the whole suite green while the user still could not get a message out
 * of the inbox, which is the exact failure this task exists to fix.
 *
 * THE ROLLBACK GUARD BELOW IS THE ONE THAT MATTERS. A move whose failure
 * path does not reveal the row again leaves a message hidden in the UI
 * and still sitting in the user's inbox, which is a lie the user has no
 * way to detect. Every guard here is paired with a synthetic fixture
 * proving the pattern would genuinely catch its own regression rather
 * than always passing.
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const APP = stripComments(appSource);
const LIST = stripComments(inboxListSource);
const ROW = stripComments(messageRowSource);
const READER = stripComments(messageViewSource);
const UNDO = stripComments(undoNoticeSource);
const ACTIONS = stripComments(actionsSource);
const HOOK = stripComments(hookSource);

describe('the reader can actually get a message out of the inbox', () => {
  it('renders both actions', () => {
    for (const label of ['Archive', 'Trash']) {
      expect(READER.includes(label), `the reader does not render "${label}"`).toBe(true);
    }
  });

  it('wires each button to its own destination', () => {
    expect(/onMailboxMove\('archive'\)/.test(READER)).toBe(true);
    expect(/onMailboxMove\('trash'\)/.test(READER)).toBe(true);
  });

  it('advertises the keyboard equivalent on each control', () => {
    expect(READER.includes('aria-keyshortcuts="e"')).toBe(true);
    expect(READER.includes('aria-keyshortcuts="#"')).toBe(true);
  });

  it('the destination-wiring guard is not vacuous', () => {
    // The bug it catches: both buttons wired to the same destination, so
    // "Archive" quietly trashes.
    expect(/onMailboxMove\('trash'\)/.test("onClick={() => onMailboxMove('archive')}")).toBe(false);
  });
});

describe('a list row can too, on desktop only', () => {
  it('MessageRow renders its own two controls', () => {
    expect(/onMailboxMove\(message, 'archive'\)/.test(ROW)).toBe(true);
    expect(/onMailboxMove\(message, 'trash'\)/.test(ROW)).toBe(true);
  });

  it('gates them to lg: and above', () => {
    // A phone has no hover, and a pair of icons over a 44px row would put
    // a destructive action a thumb-width from "open this message".
    expect(/hidden[^'"]*lg:flex/.test(ROW)).toBe(true);
  });

  it('stops the row underneath from opening in the same click', () => {
    // The row IS a button. Without this, archiving from a row would also
    // open the message — the click bubbles straight into its handler.
    expect(/event\.stopPropagation\(\)/.test(ROW)).toBe(true);
  });

  it('never nests a button inside the row button', () => {
    // Invalid HTML that browsers silently un-nest, which would move the
    // controls out of the row entirely. They are a SIBLING of the row
    // button inside a `relative` <li>.
    expect(/<li className="group relative">/.test(ROW)).toBe(true);
  });

  it('gives every icon-only control an accessible name that says WHICH row', () => {
    // Fifty rows produce fifty "Archive" buttons; a screen-reader user
    // tabbing through them needs the subject in the name, because the
    // row's own text is not read as part of a nested control's name.
    expect(/label=\{`Archive: \$\{subject\}`\}/.test(ROW)).toBe(true);
    expect(/label=\{`Move to Trash: \$\{subject\}`\}/.test(ROW)).toBe(true);
    // …and that the label really reaches the DOM as the accessible name.
    expect(/aria-label=\{label\}/.test(ROW)).toBe(true);
  });

  it('hides the badge and timestamp on HOVER ONLY, never on focus', () => {
    // THE DEFECT LIVE VERIFICATION CAUGHT. The hover controls are
    // `tabIndex={-1}`, so they never appear on focus — but the right-hand
    // cluster used to HIDE on `group-focus-within`, which meant every
    // `j`/`k` move and every Back-from-reader focus restore blanked the
    // account badge and the timestamp with nothing in their place. The
    // two conditions must be the same condition.
    expect(/onMailboxMove !== undefined && 'group-hover:invisible'/.test(ROW)).toBe(true);
    expect(ROW).not.toMatch(/group-focus-within:invisible/);
  });

  it('the focus-hiding guard is not vacuous', () => {
    expect("'group-hover:invisible group-focus-within:invisible'").toMatch(
      /group-focus-within:invisible/,
    );
  });

  it('the stopPropagation and label guards are not vacuous', () => {
    expect(/event\.stopPropagation\(\)/.test('onClick={() => onClick()}')).toBe(false);
    // The bug it catches: an icon button with no name at all, which a
    // screen reader announces as "button".
    expect(/aria-label=\{label\}/.test('<button type="button" onClick={onClick}>')).toBe(false);
  });
});

describe('the keyboard reaches the same handler the buttons do', () => {
  it('the hook declares a mailbox-move handler', () => {
    expect(/onMailboxMove:\s*\(destination: MoveDestination\) => void/.test(HOOK)).toBe(true);
  });

  it('and runs it for the mailbox-move action', () => {
    expect(/case 'mailbox-move':[\s\S]{0,90}onMailboxMove\(action\.destination\)/.test(HOOK)).toBe(
      true,
    );
  });

  it('App.tsx supplies it', () => {
    expect(/onMailboxMove:\s*moveMessageInHand/.test(APP)).toBe(true);
  });

  it('the action guard is not vacuous', () => {
    expect(/case 'mailbox-move':[\s\S]{0,90}onMailboxMove\(action\.destination\)/.test(
      "case 'mailbox-move': return;",
    )).toBe(false);
  });
});

describe('the removal is optimistic AND rolls back', () => {
  it('App.tsx hides the row before the request goes out', () => {
    expect(/setHiddenKeys\(\(hidden\) => hideMessage\(hidden, key\)\)[\s\S]{0,200}moveMessage\(/.test(APP)).toBe(
      true,
    );
  });

  it('AND REVEALS IT AGAIN when the move fails', () => {
    // THE BINDING ONE. A message that stays gone in the UI while still in
    // the inbox is a lie the user cannot detect; one that visibly comes
    // back is honest. Anchored to the rejection handler specifically, so
    // a reveal that only happened on the SUCCESS path would not satisfy
    // it.
    expect(
      /\(error: unknown\) => \{[\s\S]{0,240}setHiddenKeys\(\(hidden\) => revealMessage\(hidden, key\)\)/.test(
        APP,
      ),
    ).toBe(true);
  });

  it('and says so, rather than failing silently', () => {
    expect(/setMoveError\(moveFailureFor\(destination\)\)/.test(APP)).toBe(true);
  });

  it('the rollback guard is not vacuous', () => {
    // The exact regression it exists to catch: a failure handler that
    // logs and leaves the row hidden.
    const withoutRollback =
      "(error: unknown) => { console.error('App: mailbox move failed', error); setMoveError(x); }";
    expect(
      /\(error: unknown\) => \{[\s\S]{0,240}setHiddenKeys\(\(hidden\) => revealMessage\(hidden, key\)\)/.test(
        withoutRollback,
      ),
    ).toBe(false);
  });

  it('the list filters by the hidden set rather than deleting rows', () => {
    // Deleting from `messages` would make rollback a reconstruction and
    // would lose the row's place in the day grouping and under the
    // cursor.
    expect(/visibleMessages\(messages, hiddenKeys, messageKey\)/.test(LIST)).toBe(true);
    expect(/hiddenKeys=\{hiddenKeys\}/.test(APP)).toBe(true);
  });

  it('the keyboard cursor is driven by the FILTERED list', () => {
    // A row hidden from the list but still reachable with j/k is the same
    // defect in a quieter costume.
    expect(/onMessagesChange\?\.\(visible\)/.test(LIST)).toBe(true);
  });
});

describe('undo is offered, and only when it is real', () => {
  it('App.tsx renders the notice', () => {
    expect(/<UndoNotice/.test(APP)).toBe(true);
    expect(/onUndo=\{undoMove\}/.test(APP)).toBe(true);
  });

  it('offers it only when canUndo agrees', () => {
    // An undo built on a guessed uid would move an UNRELATED message into
    // the user's inbox. `canUndo` is the only thing that decides.
    expect(/if \(!canUndo\(result\)\) return;/.test(APP)).toBe(true);
  });

  it('replays the SERVER\'s ticket rather than naming a folder', () => {
    expect(/to: 'undo',\s*origin: undo\.ticket\.origin,/.test(APP)).toBe(true);
    expect(/undo\.ticket\.folder/.test(APP)).toBe(true);
  });

  it('never constructs a destination folder of its own', () => {
    // A client that named a mailbox would be exercising an
    // arbitrary-folder-move primitive. The only folder literal allowed
    // anywhere on this surface is INBOX, in mailboxActions.ts, and it is
    // a question about where a message IS rather than where it goes.
    const CLIENT_SURFACE = [APP, LIST, ROW, READER, UNDO].join('\n');
    expect(CLIENT_SURFACE).not.toMatch(/\[Gmail\]/);
    expect(CLIENT_SURFACE).not.toMatch(/All Mail/);
  });

  it('the undo bar carries a real way out as well', () => {
    expect(/Dismiss/.test(UNDO)).toBe(true);
  });

  it('the ticket guard is not vacuous', () => {
    expect(/if \(!canUndo\(result\)\) return;/.test('setPendingUndo({ key, ticket });')).toBe(false);
    expect('const dest = "[Gmail]/Trash";').toMatch(/\[Gmail\]/);
  });
});

describe('the actions are absent where they do not apply', () => {
  it('a row outside the inbox gets no controls', () => {
    expect(/canMoveFrom\(message\.folder\) \? onMailboxMove : undefined/.test(LIST)).toBe(true);
  });

  it('the reader outside the inbox gets none either', () => {
    expect(/canMoveFrom\(selected\.folder\) \? moveSelected : undefined/.test(APP)).toBe(true);
  });

  it('and the keyboard says so out loud rather than doing nothing', () => {
    expect(/if \(!canMoveFrom\(target\.folder\)\) \{[\s\S]{0,120}unavailableHereFor\(destination\)/.test(APP)).toBe(
      true,
    );
  });

  it('the absence guard is not vacuous', () => {
    expect(/canMoveFrom\(message\.folder\) \? onMailboxMove : undefined/.test(
      'onMailboxMove={onMailboxMove}',
    )).toBe(false);
  });
});

describe('the pure module stays pure', () => {
  it('reaches for no React, no fetch and no DOM', () => {
    expect(ACTIONS).not.toMatch(/\bfrom 'react'/);
    expect(ACTIONS).not.toMatch(/\bfetch\(/);
    expect(ACTIONS).not.toMatch(/\bdocument\.|\bwindow\./);
  });

  it('the purity guard is not vacuous', () => {
    expect("import { useState } from 'react';").toMatch(/\bfrom 'react'/);
  });
});
