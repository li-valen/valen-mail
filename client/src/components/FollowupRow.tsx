import { CircleDashed, CornerUpLeft, Mail, MailOpen } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { EngagementState, FollowupRow as FollowupRowData } from '../api';
import { engagementCopy, formatRecipients } from '../followupCopy';
import type { FollowupTone } from '../followupCopy';
import { cn } from '../ui/cn';
import { formatRelativeTime } from './openEvents';
import { ROW_FOCUS } from './MessageRow';

/**
 * One row of the follow-up queue.
 *
 * LED BY THE STATE, NOT THE DATE, and that inversion is the whole point
 * of this view. Every other mail client puts the timestamp where the eye
 * lands first; here the first thing in the row — at both breakpoints — is
 * "Opened 3×, no reply", and the time is the last, smallest, quietest
 * thing on the line. A queue is sorted by what needs doing, so it should
 * read that way too.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL. Each of the five states gets its own
 * silhouette as well as its own words, for the same reason
 * ./ReadState.tsx's marks do: colour alone fails for colour-blind readers
 * and is the lazy answer. The two states §7A.2 insists must not be
 * conflated — "no opens recorded" and "we cannot tell" — differ in all
 * three channels: different sentence, different glyph, and only their
 * tone is shared.
 *
 * TWO LAYOUTS, one component, the same split ./MessageRow.tsx uses.
 * Below `lg:` the row is borderless and fluid with no ground of its own,
 * per the user's mobile direction; above it the row is a full-bleed slice
 * of a divided card. The classes are lifted from MessageRow so the two
 * lists feel like one product, including `ROW_FOCUS`, imported rather
 * than copied.
 *
 * NO MEASUREMENT CAVEATS ANYWHERE. There is no explanatory tooltip, no
 * disclosure, no footnote about why a signal is missing — the user asked
 * for the Superhuman/Mailspring treatment and got it. What is known is
 * shown; what is not known says so in three words and stops.
 */

/** One silhouette per STATE, not per tone: the two quiet states must be
 *  distinguishable from each other, not merely from the loud ones.
 *  Deliberately no tick, tickbox or verified badge anywhere in this map —
 *  that mark is the lie this product exists to refuse, and
 *  tests/followup-copy.test.ts enforces its absence mechanically. */
const STATE_MARKS: Readonly<Record<EngagementState, LucideIcon>> = {
  'opened-repeatedly': MailOpen,
  'opened-no-reply': MailOpen,
  'never-opened': Mail,
  unverifiable: CircleDashed,
  'opened-replied': CornerUpLeft,
};

/**
 * The lead's colour AND weight, per tone.
 *
 * `waiting` reuses the green ./ReadState.tsx established as "a person
 * really read this" — these rows ARE the confirmed-read ones, so a second
 * colour for the same fact would be a second vocabulary. One step darker
 * than that mark's `green-600`, because this is TEXT carrying the row's
 * meaning rather than a small decorative glyph: `green-700` measures
 * 4.8:1 against white where `green-600` measures 3.2:1, and 3.2 is not a
 * ratio body text may sit at. The dark half is unchanged at `green-400`
 * (11.4:1 against the dark ground), which was already picked for a vivid
 * confirmed state.
 *
 * THE OTHER TWO RECEDE BY WEIGHT, NOT BY CONTRAST, and that is the
 * correction this file's first draft needed. Grading `quiet` and
 * `resolved` as two neutral SHADES put the least important label at
 * `neutral-400` — 2.6:1 against white, which is fine for the small
 * decorative mark ReadState.tsx uses it for and not fine for a word
 * someone has to read. It also collapsed in dark mode, where both shades
 * resolve to the same `muted-foreground` token and the distinction simply
 * vanished. Same colour at a readable ratio, three weights, and the
 * hierarchy now survives both palettes.
 */
const TONE_CLASSES: Readonly<Record<FollowupTone, string>> = {
  waiting: 'font-semibold text-green-700 dark:text-green-400',
  quiet: 'font-medium text-neutral-500 dark:text-muted-foreground',
  resolved: 'font-normal text-neutral-500 dark:text-muted-foreground',
};

export interface FollowupRowProps {
  readonly row: FollowupRowData;
  /** One "now" for the whole render, resolved by the view — relative
   *  times must not creep forward row by row. */
  readonly now: number;
  readonly onOpen: (row: FollowupRowData) => void;
}

export default function FollowupRow({ row, now, onOpen }: FollowupRowProps) {
  const copy = engagementCopy(row.state, row.openCount);
  const Mark = STATE_MARKS[row.state] ?? CircleDashed;
  const tone = TONE_CLASSES[copy.tone];
  const recipients = formatRecipients(row.recipients);
  const subject = row.subject ?? '(no subject)';
  const when = formatRelativeTime(row.sentAtMs, now);

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row)}
        className={cn(
          'block w-full cursor-pointer touch-manipulation text-left text-sm transition-colors',
          'rounded-xl hover:bg-neutral-50 active:bg-neutral-100 dark:hover:bg-accent dark:active:bg-accent',
          'lg:rounded-none',
          ROW_FOCUS,
        )}
      >
        {/* ── below lg: two lines, borderless and fluid ─────────────── */}
        <span className="flex items-start gap-3 px-3 py-2.5 lg:hidden">
          <Mark className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className={cn('min-w-0 flex-1 truncate', tone)}>{copy.lead}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-500 dark:text-muted-foreground">
                {when}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-neutral-700 dark:text-foreground">
              {subject}
            </span>
            <span className="mt-0.5 block truncate text-xs text-neutral-500 dark:text-muted-foreground">
              {recipients}
            </span>
          </span>
        </span>

        {/* ── lg and up: one line, state first, time last ───────────── */}
        <span className="hidden h-11 w-full items-center gap-3 px-4 lg:flex">
          <Mark className={cn('h-4 w-4 shrink-0', tone)} aria-hidden="true" />
          <span className={cn('w-44 shrink-0 truncate', tone)}>{copy.lead}</span>
          <span className="w-44 shrink-0 truncate text-neutral-700 dark:text-muted-foreground">
            {recipients}
          </span>
          <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-muted-foreground">
            {subject}
          </span>
          <span className="w-20 shrink-0 whitespace-nowrap text-right font-mono text-xs tabular-nums text-neutral-500 dark:text-muted-foreground">
            {when}
          </span>
        </span>
      </button>
    </li>
  );
}
