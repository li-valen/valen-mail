import { TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import type { ResultSummary, SendFailure } from './composeResults';

/**
 * What the composer says when a send did not simply work.
 *
 * TWO DIFFERENT KINDS OF BAD NEWS, kept apart on purpose:
 *
 *  - **A partial send** — the request succeeded and some copies did not.
 *    This is the case POST /api/send answers 200 for, and the one the
 *    composer must stay open for. The copy has to do a job no status code
 *    can: stop the user pressing Send again on the same list, because
 *    everyone it already reached would get the message twice, each with
 *    a second tracking pixel.
 *  - **A refused or unknown send** — ./composeResults.ts has already
 *    decided whether Postbox may claim nothing went out, so this just
 *    renders the sentence it produced.
 *
 * Every address the partial case is about is marked in the recipient
 * fields themselves (Compose.tsx passes `partial.failed` to both), which
 * is why this block names counts rather than listing addresses — the
 * chips are the "which".
 *
 * Renders nothing at all when there is nothing to report.
 */
interface ComposeOutcomeProps {
  readonly partial: ResultSummary | null;
  readonly failure: SendFailure | null;
  /** Narrows the recipient fields to just the copies that failed, so a
   *  retry cannot double-send to the people already reached. */
  readonly onDropSentRecipients: () => void;
}

export default function ComposeOutcome({
  partial,
  failure,
  onDropSentRecipients,
}: ComposeOutcomeProps) {
  if (partial === null && failure === null) return null;

  return (
    <>
      {partial !== null && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" className="h-4 w-4" />
          <AlertDescription className="space-y-2">
            <p>
              Sent to {partial.sentCount} of {partial.sentCount + partial.failedCount}.{' '}
              {partial.failedCount === 1 ? 'One copy' : `${partial.failedCount} copies`} did not go
              out — the addresses still marked in red above. Everyone else already has the message,
              so sending again as-is would reach them twice.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onDropSentRecipients}>
              Remove the ones that were sent
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {failure !== null && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" className="h-4 w-4" />
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
