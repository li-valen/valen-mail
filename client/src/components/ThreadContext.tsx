import { useEffect, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { getThread } from '../api';
import type { InboxMessage } from '../api';
import { Card } from '../ui/Card';
import MessageRow from './MessageRow';
import { LIST_DIVIDERS, LIST_SURFACE } from './listSurface';
import { messageKey } from './messageBody';

interface ThreadContextProps {
  readonly message: InboxMessage;
  readonly now: Date;
  readonly onOpen: (message: InboxMessage) => void;
}

/**
 * The rest of the conversation, as collapsed rows under the message.
 *
 * Fetches on its own rather than through the parent so that its failure
 * mode is contained: a thread that cannot be listed renders NOTHING and
 * logs, exactly as the opens rail degrades, because the message is the
 * primary surface and must open whether or not its conversation can be
 * listed. Same rule as the rest of this app — a secondary panel never
 * takes the primary one down with it.
 *
 * Rows are `MessageRow`, the same component the inbox list uses, so the
 * button semantics, focus ring, unread weight and mobile reflow cannot
 * drift between the two places a message row appears. Clicking one opens
 * it in this same reader.
 */
export default function ThreadContext({ message, now, onOpen }: ThreadContextProps) {
  const threadId = message.thread_id;
  // Half of the thread's key, not a filter. Gmail allocates thread ids per
  // mailbox, so "thread T1" means nothing without the account that issued
  // it — and the open message always knows its own. Fetching without it
  // listed a DIFFERENT account's mail under this message, every row of it
  // clickable straight into the reader.
  const accountId = message.account_id;
  const currentKey = messageKey(message);
  const [others, setOthers] = useState<readonly InboxMessage[]>([]);

  useEffect(() => {
    if (threadId === null || threadId === '') {
      setOthers([]);
      return;
    }
    let cancelled = false;

    getThread(accountId, threadId).then(
      (messages) => {
        if (cancelled) return;
        setOthers(messages.filter((other) => messageKey(other) !== currentKey));
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('MessageView: thread context could not be loaded', error);
        setOthers([]);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [accountId, threadId, currentKey]);

  if (others.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-muted-foreground">
        <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
        Also in this thread ({others.length})
      </h3>
      {/* Borderless below `lg:`, exactly as the inbox list these rows
          come from — see ./listSurface.ts. Without this the thread was
          the one place a `MessageRow` still sat inside an outlined box on
          a phone. */}
      <Card className={LIST_SURFACE}>
        <ul className={LIST_DIVIDERS}>
          {others.map((other) => (
            <MessageRow key={messageKey(other)} message={other} now={now} onOpen={onOpen} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
