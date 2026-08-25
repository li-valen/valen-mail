import { useEffect, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { getThread } from '../api';
import type { InboxMessage } from '../api';
import { Card } from '../ui/Card';
import MessageRow from './MessageRow';
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
  const currentKey = messageKey(message);
  const [others, setOthers] = useState<readonly InboxMessage[]>([]);

  useEffect(() => {
    if (threadId === null || threadId === '') {
      setOthers([]);
      return;
    }
    let cancelled = false;

    getThread(threadId).then(
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
  }, [threadId, currentKey]);

  if (others.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-muted-foreground">
        <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
        Also in this thread ({others.length})
      </h3>
      <Card>
        <ul className="divide-y divide-neutral-100 dark:divide-border">
          {others.map((other) => (
            <MessageRow key={messageKey(other)} message={other} now={now} onOpen={onOpen} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
