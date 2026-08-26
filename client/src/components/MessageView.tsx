import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { ArrowLeft, Forward, Reply, ReplyAll } from 'lucide-react';
import { getThread } from '../api';
import type { InboxMessage } from '../api';
import type { MoveDestination } from '../mailboxActions';
import type { ReplyMode } from '../replyDraft';
import { targetFor } from '../messageLoader';
import { messagePrefetcher } from '../messagePrefetch';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { Panel } from '../motion';
import ThreadMessage from './ThreadMessage';
import MessageActionsMenu from './MessageActionsMenu';
import { useMessageBody } from './useMessageBody';
import { messageKey } from './messageBody';
import { TOUCH_HEIGHT } from '../ui/touchTarget';

/**
 * The reading view: the thing an email client must do, and the one the
 * user asked for repeatedly ("the emails are still not openable").
 *
 * Replaces the list in the main content column rather than opening beside
 * it — one column at every width, full width on a phone, no split pane to
 * starve either side at 400px. App.tsx keeps the list MOUNTED but hidden
 * behind it, which is what makes "Back" instant and lossless: no refetch,
 * no lost pages, and the scroll position (and keyboard focus) restored to
 * the row that was opened.
 *
 * TWO INDEPENDENT FAILURE DOMAINS, deliberately not collapsed into one:
 *
 *  1. The message itself — a failure here is the whole view, so it gets an
 *     in-place Alert with a retry, never a modal, and Back still works.
 *  2. Thread context — secondary. A thread fetch that fails logs and
 *     renders nothing at all; a message must never fail to open because
 *     the conversation around it could not be listed.
 *
 * THERE USED TO BE A THIRD: remote images, blocked per message behind a
 * "Load remote images" bar. The user removed it — "remove the dont load
 * images thing i dont care if people can track me with the pixels" — so
 * mail now renders the way the sender built it, first time. See
 * components/messageBody.ts's `contentSecurityPolicyFor` for the full
 * note, including why this changes the PRIVACY posture and leaves the XSS
 * boundary (`IFRAME_SANDBOX`: no allow-scripts, no allow-same-origin)
 * exactly where it was.
 *
 * SECURITY. `parsed.html` is the sender's markup, unsanitised on purpose
 * all the way from sync/src/api/message.ts. It reaches the DOM through
 * exactly one path — `srcDocFor` into the `srcDoc` of the sandboxed
 * iframe below — and this file contains no `dangerouslySetInnerHTML`.
 * Every other attacker-controlled string here (subject, sender name,
 * filename, mime type) is a JSX text child, which React escapes.
 */


/* `messageFor` and `LoadState` moved to ./useMessageBody.ts along with the
   fetch itself — every message in a thread now owns its own load. */

interface MessageHeaderProps {
  readonly message: InboxMessage;
  /** Where the reader's opening focus lands. Passed down rather than
   *  found with a `querySelector` from above, now that there is no card
   *  wrapping the header to hang a ref on. */
  readonly headingRef: Ref<HTMLHeadingElement>;
}

/**
 * Subject, sender, recipients and full timestamp — all read from the
 * INBOX ROW, never from the parsed response, even though the parsed
 * response carries the same four fields.
 *
 * The row is already in hand when the reader mounts, so the header paints
 * on the first frame and never reflows when the body arrives; both
 * sources agree (sync normalises headers the same way on both paths); and
 * one source means there is no second place for the two to drift apart.
 * The parsed response is used for exactly what the row cannot supply: the
 * body and the attachment list.
 */
function MessageHeader({ message, headingRef }: MessageHeaderProps) {
  // SUBJECT ONLY NOW. This used to carry the sender, the recipients and the
  // date as well, which was right while the reader showed one message and
  // wrong once it shows a conversation: a subject belongs to the THREAD and
  // appears once, while sender/recipients/date belong to each message and
  // now sit on its own header in the stack (./ThreadMessage.tsx).
  //
  // No card and no rule under it — *"Try to remove the outline borders where
  // possible makes it look janky."* Whitespace and type hierarchy carry the
  // separation. This is also where the phishing boundary moved to, and it
  // did not weaken: see MessageBodyContent's BodyFrame note.
  return (
    <header className="px-1">
      {/* tabIndex -1 so focus can be moved here when the reader opens: the
          reader replaces the list in place, so without this a screen reader
          would be left announcing from wherever the vanished row used to be. */}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold text-neutral-900 dark:text-foreground sm:text-lg"
      >
        {message.subject || '(no subject)'}
      </h2>
    </header>
  );
}




interface ReplyActionsProps {
  readonly onReply: (mode: ReplyMode) => void;
  /** False until the body has loaded. The reply needs the PARSED message
   *  — its html to quote and its Message-ID to thread — so a click before
   *  then would open a composer that could neither quote nor thread. */
  readonly isReady: boolean;
  /** Placement, supplied by the caller. The component is rendered twice —
   *  see the note on placement above — and this is the ONLY difference
   *  between the two, which is what keeps them from drifting. */
  readonly className?: string;
}

/**
 * Reply, Reply all, Forward — the three actions Plan 9 exists to make
 * reachable, and the last thing that was still sending the user back to
 * Gmail.
 *
 * **A FLOATING BAR BELOW `lg:`, IN THE FLOW ABOVE IT.** The user, beside
 * Gmail on a phone: *"Move reply and reply all to the bottom as hovers."*
 *
 * This comment used to argue the opposite, and the argument was sound
 * about the thing it was arguing against: Gmail's DESKTOP puts these at
 * the end of the message, which is fine for a three-line note and useless
 * for the 3000px newsletters this reader routinely shows, because the
 * primary action ends up a scroll away from the moment the user decides
 * to take it.
 *
 * A FIXED bar is not that. It is pinned to the viewport, so it is visible
 * at every scroll position and every message length — the property the old
 * placement was protecting — while giving back the ~60px it was spending
 * at the top of a 393px screen, which is what the user actually noticed.
 * Gmail's own iOS app does exactly this, and for the same reason.
 *
 * Above `lg:` it stays in the flow where it was. A window that is 900px
 * tall does not need its actions welded to the bottom edge, and a floating
 * bar over a desktop reading column is chrome for a problem that width
 * does not have.
 *
 * `AppShell` reserves the height this occupies while a message is open —
 * see its `isReading`. Space and bar are decided by the same flag there,
 * because a bar with no space covers the last line of every message.
 *
 * **`sticky`, NOT `fixed`, AND THAT IS NOT A STYLE PREFERENCE.** `fixed`
 * was tried first and silently did not work: the reader sits inside a
 * `motion` wrapper that leaves `transform: matrix(1, 0, 0, 1, 0, 0)` on the
 * element after its entrance animation, and ANY transform — including an
 * identity one — makes that ancestor the containing block for fixed
 * descendants. The bar was therefore pinned to the top of a 6000px panel
 * rather than to the viewport. It measured correctly at the bottom of the
 * scroll (`top: 688`, inside the viewport, which is what made it look
 * right) and sat at `top: 5665` at the top of the same message. `sticky`
 * resolves against the scroll container instead and is unaffected by
 * transformed ancestors.
 *
 * The mobile copy therefore renders LAST in the panel, after the body and
 * the attachments: a sticky element keeps its place in the flow, so
 * rendering it above the body would have cost the same ~60px at the top
 * that moving it was meant to give back.
 *
 * DISABLED RATHER THAN ABSENT while the body loads. Rendering them late
 * would move the message down under the user's eyes exactly as it became
 * readable; disabling them costs a moment on a slow fetch and never
 * reflows.
 */
function ReplyActions({ onReply, isReady, className }: ReplyActionsProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button variant="outline" size="sm" className={TOUCH_HEIGHT} disabled={!isReady} onClick={() => onReply('reply')} aria-keyshortcuts="r">
        <Reply aria-hidden="true" />
        Reply
      </Button>
      <Button
        variant="ghost"
        size="sm" className={TOUCH_HEIGHT}
        disabled={!isReady}
        onClick={() => onReply('replyAll')}
        aria-keyshortcuts="a"
      >
        <ReplyAll aria-hidden="true" />
        Reply all
      </Button>
      <Button
        variant="ghost"
        size="sm" className={TOUCH_HEIGHT}
        disabled={!isReady}
        onClick={() => onReply('forward')}
        aria-keyshortcuts="f"
      >
        <Forward aria-hidden="true" />
        Forward
      </Button>
    </div>
  );
}

export interface MessageViewProps {
  /** The inbox row that was opened. Supplies the header and every path
   *  segment the body and attachment requests are built from. */
  readonly message: InboxMessage;
  /**
   * The rows either side of this one, in list order — prefetched on open
   * because people read down a list (see ../messagePrefetch.ts).
   *
   * Optional and defaulting to none: the reader is also reachable from a
   * thread row and from the opens rail, where there is no surrounding
   * list to be adjacent IN, and guessing one there would be a fetch spent
   * on a neighbour the user cannot even see.
   */
  readonly neighbours?: readonly InboxMessage[];
  /** The list's shared "now", threaded through to the thread rows so a
   *  row reads the same here as it does in the list. */
  readonly now: Date;
  readonly onBack: () => void;
  /**
   * What Back says it returns to. Defaults to the Inbox, which is where
   * every reader opened from a mail list goes.
   *
   * A prop rather than a fixed string because the reader is no longer
   * reached only from the Inbox: components/FollowupView.tsx opens it
   * over the follow-up queue and Back returns THERE, so a hardcoded
   * "Back to inbox" would name a destination the control does not go to.
   * Small, and exactly the kind of small the rest of this product refuses
   * to ship — a label that is wrong is a label the reader stops trusting.
   */
  readonly backLabel?: string;
  /** Whether this message is starred, already resolved through App.tsx's
   *  optimistic overrides (../components/messageFlags.ts's
   *  `resolveStar`) — so a star set one keystroke ago draws the same as
   *  one the last sync brought down. */
  readonly isStarred?: boolean;
  /** Stars or unstars this message. The SAME handler `s` runs, so the
   *  button and the shortcut cannot diverge — and the button is what
   *  makes the feature reachable without a keyboard. */
  readonly onToggleStar?: () => void;
  /**
   * Opens the composer on this message. Same handler `r`/`a`/`f` run, for
   * the same reason `onToggleStar` is shared: one behaviour with two ways
   * in, rather than two implementations that agree today.
   *
   * Optional because the reader is also reachable from the opens rail,
   * where App.tsx has nothing to reply WITH until the row resolves to a
   * message.
   */
  readonly onReply?: (mode: ReplyMode) => void;
  /**
   * Archive / Move to Trash, shared with the list rows and the keyboard
   * for the same reason `onToggleStar` is: one behaviour with three ways
   * in, rather than three implementations that agree today.
   *
   * Omitted where the action makes no sense for the surface — nothing
   * passes it today from a list the message did not come from — in which
   * case the two controls are simply absent rather than present and
   * inert.
   */
  readonly onMailboxMove?: (destination: MoveDestination) => void;
}

export default function MessageView({
  message,
  neighbours = [],
  now,
  onBack,
  backLabel = 'Back to inbox',
  isStarred = false,
  onToggleStar,
  onReply,
  onMailboxMove,
}: MessageViewProps) {
  const accountId = message.account_id;
  const folder = message.folder;
  const uid = message.uid;


  // The subject heading, for the focus effect below. A direct ref now
  // that the card that used to wrap it (and that the old code reached
  // through with a `querySelector`) is gone.
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const { load } = useMessageBody(accountId, folder, uid);

  /**
   * THE REST OF THE CONVERSATION.
   *
   * Fetched here rather than inside a child because it decides the whole
   * shape of the reader now, not a panel underneath it. Its failure mode is
   * unchanged and deliberate: a thread that cannot be listed leaves
   * `thread` empty and the reader falls back to the single message it was
   * opened with, because the message is the primary surface and must open
   * whether or not its conversation can be listed.
   *
   * `account_id` is half the key, not a filter. Gmail allocates thread ids
   * per mailbox, so two of this user's accounts can and do hold the same
   * value for unrelated conversations; fetching without it once listed a
   * DIFFERENT account's mail under this message, every row clickable.
   */
  const [thread, setThread] = useState<readonly InboxMessage[]>([]);
  const threadId = message.thread_id;

  useEffect(() => {
    if (threadId === null || threadId === '') {
      setThread([]);
      return;
    }
    let cancelled = false;
    getThread(accountId, threadId).then(
      (messages) => {
        if (!cancelled) setThread(messages);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('MessageView: thread fetch failed', error);
        setThread([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountId, threadId]);

  /**
   * Which messages are open. Gmail opens the one you clicked and leaves the
   * rest closed, which is the only behaviour that makes a forty-message
   * thread usable — and, with `useMessageBody`'s `enabled` flag, the only
   * one that does not fetch forty bodies.
   *
   * Keyed by identity triple rather than by index so it survives the thread
   * arriving after the first paint, which it always does.
   */
  const openedKey = messageKey(message);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(
    () => new Set([openedKey]),
  );

  // A different message opened in this same component (same account and uid
  // in another folder, reachable from the stack) resets what is open.
  useEffect(() => {
    setExpandedKeys(new Set([openedKey]));
  }, [openedKey]);

  /** The stack, oldest first. Falls back to the opened message alone when
   *  the thread could not be listed or holds only this one. */
  const stack = thread.length > 1 ? thread : [message];

  /**
   * Warms the rows either side of this one. People read down a list, so
   * the next row is by a wide margin the most likely next open, and the
   * seconds spent reading THIS message are the free interval to spend on
   * it — see ../messagePrefetch.ts for the concurrency cap and for why
   * this is one row out and not ten.
   */
  useEffect(() => {
    const index = neighbours.findIndex(
      (row) => row.account_id === accountId && row.folder === folder && row.uid === uid,
    );
    if (index === -1) return;
    messagePrefetcher.prefetchAround(neighbours.map(targetFor), index);
  }, [neighbours, accountId, folder, uid]);

  // Focus lands on the subject when the reader opens, because the reader
  // REPLACES the list in place: there is no new page for the browser to
  // move focus to, so without this a keyboard or screen reader user is
  // left focused on a button that is no longer rendered. `preventScroll`
  // because App.tsx has already positioned the column for this view and
  // this must not fight it.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [accountId, folder, uid]);

  return (
    // PLAN 7 TASK 2 — the reader arrives. App.tsx keys this component on
    // the message, so opening a different one from the thread rows below
    // remounts and replays the entrance rather than swapping the body
    // underneath a stationary frame. There is no matching exit: see
    // src/motion/Panel.tsx for why Back is deliberately instant.
    <Panel className="space-y-4">
      {/* The reader's one chrome row: leave, get it out of the inbox, and
          star. Every control here is the same one the keyboard drives
          (`u`/Esc, `e`, `#`, `s`), wired to the same handlers, so there
          is one behaviour with two ways in rather than two
          implementations that agree today.

          NO `flex-wrap` any more, and that is the point of the change
          above: two controls fit one line at every width this app
          supports, so there is nothing left to wrap. */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" className={TOUCH_HEIGHT} onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {backLabel}
        </Button>

        {/* ONE control, at the right end of the same line as Back.
            Was three labelled buttons on a row of their own; at 393px that
            row could not share a line with Back (125 + 92 + 80 + 71 = 368px
            before gaps), so `flex-wrap` stacked them and the message began
            88px lower than it needed to. The user, beside Gmail: "Lets at a
            ... at the top right on the same level as back to inbox and have
            that contain archive trash and star instead of having that
            there."

            At EVERY width, not just below `lg:`. The request did not
            qualify, one implementation is easier to keep honest than two,
            and the shortcuts (`e`, `#`, `s`) still reach all three without
            opening anything. */}
        <MessageActionsMenu
          onMailboxMove={onMailboxMove}
          onToggleStar={onToggleStar}
          isStarred={isStarred}
        />
      </div>

      {/* NO CARD AROUND THE HEADER AND BODY any more. They were one
          bordered box split by a hairline; they are now two things
          separated by the `space-y-4` above — quiet chrome, then the
          message as its own raised sheet. See MessageHeader and BodyFrame
          for what replaced the border in each case, including why the
          gap under the header is load-bearing rather than decorative. */}
      <MessageHeader message={message} headingRef={headingRef} />

      {/* DESKTOP: where it has always been, above the body. A 900px-tall
          window does not need its actions welded to an edge. */}
      {onReply !== undefined && (
        <ReplyActions
          onReply={onReply}
          isReady={load.status === 'ready'}
          className="hidden px-1 lg:flex"
        />
      )}

      {/* THE CONVERSATION, oldest first, one scroll — not a message with a
          list of links to its siblings underneath. Each entry loads its own
          body only once opened; see ./ThreadMessage.tsx. */}
      <div className="space-y-2">
        {stack.map((entry) => {
          const key = messageKey(entry);
          return (
            <ThreadMessage
              key={key}
              message={entry}
              now={now}
              isExpanded={expandedKeys.has(key)}
              canCollapse={stack.length > 1}
              onToggle={() =>
                setExpandedKeys((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
          );
        })}
      </div>
      {/* PHONE: the same component, stuck to the bottom of the scrollport.
          Last in the panel because a sticky box keeps its space in the
          flow — placed above the body it would still cost the room at the
          top that this change exists to give back. */}
      {onReply !== undefined && (
        <ReplyActions
          onReply={onReply}
          isReady={load.status === 'ready'}
          className="sticky bottom-0 z-30 -mx-4 justify-center border-t border-neutral-200 bg-card px-4 pb-[calc(0.5rem+var(--safe-bottom))] pt-2 sm:-mx-6 dark:border-border lg:hidden"
        />
      )}
    </Panel>
  );
}
