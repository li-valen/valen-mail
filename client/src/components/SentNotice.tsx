import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { sentNoticeMessage } from './composeResults';
import type { ResultSummary } from './composeResults';

/**
 * The confirmation for a send where every copy went out.
 *
 * It lives in the SHELL rather than in Compose.tsx because the composer
 * closes on success — a confirmation rendered inside it would appear and
 * vanish in the same frame. App.tsx holds it until dismissed, beside the
 * inbox the user lands back on.
 *
 * `role="status"` (overriding ui/Alert.tsx's `role="alert"`, which
 * spreads caller props last): this is the successful outcome of something
 * the user just did, not an error interrupting them, so it is announced
 * politely rather than assertively.
 *
 * Dismissible for the same reason App.tsx's SessionError is — a banner
 * that cannot be removed takes prime space in the content column
 * permanently.
 */
interface SentNoticeProps {
  readonly summary: ResultSummary;
  readonly onDismiss: () => void;
}

export default function SentNotice({ summary, onDismiss }: SentNoticeProps) {
  return (
    <Alert variant="success" role="status" className="mb-6">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span className="min-w-[12rem] flex-1">{sentNoticeMessage(summary.sentCount)}</span>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );
}
