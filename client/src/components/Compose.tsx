import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import { Loader2, Paperclip, Send, X } from 'lucide-react';

import { ApiError } from '../api';
import { getIdentities, identityIdForAccount, primaryIdentityId, sendMail } from '../composeApi';
import type { Identity, SendAttachment, SendRequest } from '../composeApi';
import {
  attachmentError,
  base64FromDataUrl,
  contentTypeFor,
  degradationNotice,
  formatFileSize,
  mergePicked,
  totalBytes,
  willDegradeTracking,
  withoutPickedAt,
} from '../attachmentPicker';
import type { PickedFile } from '../attachmentPicker';
import {
  composerTitleFor,
  initialFocusFor,
  isDraftDirty,
  quoteNoticeFor,
  replyWireFields,
  seedReplyDraft,
} from '../replyDraft';
import type { ReplySource, SeededDraft } from '../replyDraft';
import { Panel, Settle } from '../motion';
import ComposeOutcome from './ComposeOutcome';
import RecipientField from './RecipientField';
import { includesRecipient, mergeRecipients, parseRecipients } from './composeRecipients';
import { CHIP_BASE, CHIP_NEUTRAL, CHIP_REMOVE, CHIP_SECONDARY } from './chip';
import { validateCompose } from './composeValidation';
import type { ComposeDraft, ComposeErrors } from './composeValidation';
import { describeSendFailure, summarizeResults } from './composeResults';
import type { ResultSummary, SendFailure } from './composeResults';
import { Alert, AlertDescription } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { cn } from '../ui/cn';
import { TOUCH_HEIGHT } from '../ui/touchTarget';

/**
 * The composer: pick an account, name some recipients, write plain text,
 * send one tracked copy per person.
 *
 * SURFACE — A FULL MAIN-COLUMN VIEW, NOT A DIALOG, and the reason is that
 * this shell already has exactly one idiom for "this replaces the content
 * column" (MessageView.tsx) and no idiom at all for an overlay. There is
 * no Dialog atom, no portal and no focus trap anywhere under src/, and
 * Plunk's own Dialog is Radix-backed — a new dependency, which Task 4
 * forbids. Hand-rolling a trap instead would be ~150 lines of roving
 * focus, scroll locking and inert-background bookkeeping that this
 * client's suite could not verify at all, because no test here renders a
 * component. As a view it inherits the shell's responsive column for
 * free, which is what makes 400px work without a second layout, and the
 * shell's own `<h1>` announces "New message" because `compose` is a
 * ViewId (see AppShell.tsx).
 *
 * NOTHING IS TRUSTED FROM THE 200. POST /api/send answers 200 even when
 * some copies failed, with the per-recipient truth in `results`. All-ok
 * closes the composer and confirms in the shell; a PARTIAL failure keeps
 * this open and marks the addresses that did not go out, because closing
 * on a half-sent message would tell the user something false about mail
 * they cannot take back. ./composeResults.ts holds that fold.
 *
 * XSS: every recipient address and the subject are user input echoed back
 * into results and error copy, and every one of them is rendered as a
 * text child. Nothing in this file goes near `dangerouslySetInnerHTML`,
 * an `href`, or a `style` string.
 *
 * A11Y: every field is labelled; focus moves to To on open and back to
 * the sidebar's Compose button on close (App.tsx holds that ref); Esc
 * closes, with a confirm whenever there is anything to lose; chips are
 * removable by keyboard (RecipientField.tsx). The composer needs no focus
 * trap precisely BECAUSE it is a view — there is no background behind it
 * that focus must be kept out of.
 */

/** Shared with App.tsx, which asks the same question when a sidebar click
 *  would navigate away from an unsent draft. One prompt, one wording. */
export const DISCARD_DRAFT_PROMPT = 'Discard this draft? What you have written will be lost.';

/**
 * The product, in one line, at the moment it matters. Not a footnote and
 * not a settings toggle: the user is told plainly, right beside Send,
 * what sending through Valen Mail does that sending through Gmail does not.
 */
const TRACKING_NOTE = 'Tracked — each recipient gets their own tracking pixel.';

const RECIPIENT_HINT = 'Separate addresses with a comma or a space.';

/** Shown when the browser could not hand over a file the user picked — a
 *  file moved or deleted between picking and sending is the usual cause. */
const ATTACHMENT_READ_ERROR = 'Valen Mail could not read one of these files. Remove it and try again.';

/** One picked file, with the browser's own `File` kept alongside the
 *  plain shape ../attachmentPicker.ts works on. The `File` never reaches
 *  that module — it is pure, and a `File` is not. */
interface PickedAttachment extends PickedFile {
  readonly file: File;
}

/**
 * Reads one file into base64.
 *
 * `readAsDataURL` rather than `readAsArrayBuffer` + a hand-rolled
 * encoder: the browser already knows how to base64 a file, and the only
 * part that needs judgement — pulling the payload out of the data URL,
 * including the empty-file case — is ../attachmentPicker.ts's
 * `base64FromDataUrl`, which is tested.
 *
 * Rejects rather than resolving with a partial value. An attachment the
 * recipient cannot open is worse than a send that did not happen.
 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('unreadable'));
    reader.onload = () => {
      const encoded = typeof reader.result === 'string' ? base64FromDataUrl(reader.result) : null;
      if (encoded === null) reject(new Error('unreadable'));
      else resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

/** Every picked file, as the route takes them. One rejection fails the
 *  whole send — there is no partial attach. */
function encodeAttachments(
  files: readonly PickedAttachment[],
): Promise<readonly SendAttachment[]> {
  return Promise.all(
    files.map(async (picked) => ({
      filename: picked.name,
      contentType: contentTypeFor(picked.type),
      contentBase64: await readAsBase64(picked.file),
    })),
  );
}

/** Nothing is wrong until the user has actually tried to send. */
const NO_ERRORS: ComposeErrors = {};

interface ComposeProps {
  /**
   * Absent for a plain "New message"; present when the composer was
   * opened by Reply, Reply all or Forward.
   *
   * STABLE FOR THE LIFETIME OF THE COMPOSER. App.tsx holds it in state
   * and mounts this component fresh each time the composer opens, which
   * is what lets the seeding effect below depend on it without ever
   * re-running over a draft the user has started writing.
   */
  readonly reply?: ReplySource;
  readonly onClose: () => void;
  /** Called ONLY when every copy went out; the shell renders the
   *  confirmation, because this component is gone by then. */
  readonly onSent: (summary: ResultSummary) => void;
  /** Reports whether closing would lose work, so the shell can guard its
   *  own navigation with the same question Esc asks here. */
  readonly onDirtyChange: (isDirty: boolean) => void;
}

type IdentityLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly message: string };

/** Names the status, never the response body. */
function identityErrorFor(error: unknown): string {
  if (error instanceof ApiError) {
    return `The sync service answered ${error.status}. Valen Mail could not load your sending accounts.`;
  }
  return 'Valen Mail could not reach the sync service to load your sending accounts.';
}

export default function Compose({ reply, onClose, onSent, onDirtyChange }: ComposeProps) {
  const [identities, setIdentities] = useState<readonly Identity[]>([]);
  const [identityLoad, setIdentityLoad] = useState<IdentityLoad>({ status: 'loading' });
  const [identityId, setIdentityId] = useState('');

  const [to, setTo] = useState<readonly string[]>([]);
  const [toPending, setToPending] = useState('');
  const [cc, setCc] = useState<readonly string[]>([]);
  const [ccPending, setCcPending] = useState('');
  const [isCcShown, setCcShown] = useState(false);

  const [subject, setSubject] = useState('');
  /** What the reply was seeded WITH, so `isDraftDirty` can tell the
   *  user's edits from this module's own pre-fill. Null until the
   *  identities land, and for a plain compose forever. */
  const [seed, setSeed] = useState<SeededDraft | null>(null);
  const [textBody, setTextBody] = useState('');

  const [picked, setPicked] = useState<readonly PickedAttachment[]>([]);
  /** Monotonic, so a React key stays stable across removals — two files
   *  can share a name, and an index key would re-associate the chips
   *  around a removal. */
  const pickedIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const [isSending, setSending] = useState(false);
  // Errors are shown only after a send has been attempted, and are
  // DERIVED from the draft rather than frozen at that moment — so fixing
  // a highlighted address clears its message on the next keystroke
  // instead of leaving stale red text until the user presses Send again
  // to find out it is already fine.
  const [hasAttemptedSend, setAttemptedSend] = useState(false);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [partial, setPartial] = useState<ResultSummary | null>(null);

  const toInputRef = useRef<HTMLInputElement | null>(null);
  const ccInputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * The real double-submit guard. `isSending` disables the button one
   * render later, which is enough for a mouse but not for a form that can
   * be submitted twice inside a single task (Enter held down, a synthetic
   * event, a fast double tap on a phone). A ref flips synchronously,
   * inside the handler, before anything can await.
   */
  const inFlightRef = useRef(false);
  /** True once the user has clicked "Add Cc" — see the focus effect
   *  below for why a seeded Cc must not be treated the same way. */
  const isCcRevealedByUserRef = useRef(false);

  const titleId = useId();
  const identityFieldId = useId();
  const subjectFieldId = useId();
  const bodyFieldId = useId();
  const toFieldId = useId();
  const ccFieldId = useId();
  const trackingNoteId = useId();

  /**
   * Loads the sending identities AND, for a reply, seeds the draft from
   * them — one effect, because the two are the same act.
   *
   * THE SEED CANNOT HAPPEN BEFORE THE IDENTITIES LAND. Reply-all has to
   * remove every address of the user's OWN from the recipient list, and
   * the identity list is the only place this client learns what those
   * are (`AccountSummary` carries an id and a count, not an email). A
   * seed that ran on mount would therefore run with an empty
   * own-address list and copy the user on their own reply — the exact
   * misfire ../replyDraft.ts exists to prevent.
   *
   * It runs at most ONCE per composer, and the composer is mounted fresh
   * every time it opens (App.tsx renders it behind `view === 'compose'`),
   * so there is no path on which this overwrites something the user has
   * typed. The identity fetch is one request against an in-memory config
   * and resolves before anyone has finished reading the subject line.
   */
  useEffect(() => {
    let cancelled = false;
    getIdentities().then(
      (loaded) => {
        if (cancelled) return;
        setIdentities(loaded);
        setIdentityLoad({ status: 'ready' });

        if (reply === undefined) {
          setIdentityId(primaryIdentityId(loaded));
          return;
        }

        // Spec 7B: a reply sends FROM the account that received it.
        setIdentityId(identityIdForAccount(reply.accountId, loaded));
        const seeded = seedReplyDraft(
          reply,
          loaded.map((identity) => identity.email),
        );
        setSeed(seeded);
        setTo(seeded.to);
        setCc(seeded.cc);
        setSubject(seeded.subject);
        // Only ever revealed, never hidden: a Cc the user opened by hand
        // before this landed must not close under them.
        if (seeded.isCcShown) setCcShown(true);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error('Compose: could not load sending identities', error);
        setIdentityLoad({ status: 'error', message: identityErrorFor(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reply]);

  // The composer REPLACES the list in place, so the browser moves focus
  // nowhere on its own — without this a keyboard user is left focused on
  // a button that is no longer rendered.
  //
  // WHICH FIELD depends on what is already filled in, and the decision is
  // ../replyDraft.ts's rather than this file's: a reply arrives with its
  // recipients and subject already written, so landing in To would make
  // the user tab past two filled fields to reach the empty one. A plain
  // compose and a forward both open in To. The tracking note is wired to
  // Send as its description either way, so nobody reaches the send
  // control without hearing what sending does.
  //
  // Runs on mount, BEFORE the identities land — the choice depends only
  // on the mode, so it needs nothing the network has to supply.
  useEffect(() => {
    if (initialFocusFor(reply?.mode ?? null) === 'body') bodyRef.current?.focus();
    else toInputRef.current?.focus();
  }, [reply]);

  // Revealing Cc and then leaving focus where it was would make the click
  // look like it did nothing.
  //
  // ONLY FOR A CLICK, THOUGH. A reply-all seeds Cc from the original
  // message, and focus for a reply belongs in the body (above); letting
  // the seed fire this would drag the cursor into Cc a beat after the
  // composer opened, which reads as the app grabbing the keyboard.
  useEffect(() => {
    if (isCcShown && isCcRevealedByUserRef.current) ccInputRef.current?.focus();
  }, [isCcShown]);

  /**
   * The draft as it stands, with both half-typed tails folded in.
   *
   * Used by BOTH the submit path and the discard check, which is the
   * point: a user who types an address and clicks Send without pressing
   * Enter first must not send to nobody, and a user who types one and
   * hits Esc must still be asked before it is thrown away.
   */
  const draft = useMemo(
    (): ComposeDraft => ({
      identityId,
      to: mergeRecipients(to, parseRecipients(toPending)),
      cc: mergeRecipients(cc, parseRecipients(ccPending)),
      subject,
      textBody,
    }),
    [identityId, to, toPending, cc, ccPending, subject, textBody],
  );

  // Memoized because it walks the whole body once (UTF-8 byte length) and
  // this runs on every keystroke in a field that can hold 100 KB.
  const validation = useMemo(() => validateCompose(draft), [draft]);
  const errors = hasAttemptedSend ? validation.errors : NO_ERRORS;

  /**
   * The attachment state, all three parts of it.
   *
   * `attachmentProblem` is shown IMMEDIATELY rather than waiting for a
   * send attempt, unlike the field errors above: picking an eleventh file
   * is a deliberate act with an instant, visible consequence, and holding
   * the reason back until Send would leave the button disabled with no
   * explanation beside it.
   *
   * `isTrackingDegraded` is spec §5.3.1, and it is deliberately computed
   * from the LIVE recipient count — adding a sixth person to a message
   * that was fine with five is exactly when the notice needs to appear.
   */
  const recipientCount = draft.to.length + draft.cc.length;
  const attachmentProblem = useMemo(() => attachmentError(picked), [picked]);
  const attachedBytes = useMemo(() => totalBytes(picked), [picked]);
  const isTrackingDegraded = useMemo(
    // Suppressed while an attachment is over a hard cap: that send cannot
    // happen at all, so telling the user what its tracking would look like
    // is noise stacked on top of the thing they actually have to fix.
    // Found in the browser, with both alerts on screen at once.
    () => attachmentProblem === undefined && willDegradeTracking(picked, recipientCount),
    [attachmentProblem, picked, recipientCount],
  );

  /**
   * A reply opens with its recipients and subject already filled in, so
   * "is there anything in these fields?" reports an untouched reply as
   * dirty and puts a native confirm in front of a user who typed nothing.
   * Found by opening a forward in the running app and pressing Escape.
   * ../replyDraft.ts's `isDraftDirty` compares against what was SEEDED.
   */
  // An attached file is work too. Without `|| picked.length > 0` a user
  // who attached a deck and pressed Escape would lose it with no prompt —
  // ../replyDraft.ts's `isDraftDirty` only compares the text fields.
  const isDirty = isDraftDirty(draft, seed) || picked.length > 0;
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const requestClose = useCallback((): void => {
    // A send in flight is not a draft to discard; it is an operation to
    // let finish, so the user learns what happened to it.
    if (inFlightRef.current) return;
    if (isDirty && !window.confirm(DISCARD_DRAFT_PROMPT)) return;
    onClose();
  }, [isDirty, onClose]);

  function handleFilesPicked(event: ChangeEvent<HTMLInputElement>): void {
    const chosen: readonly PickedAttachment[] = Array.from(event.target.files ?? []).map(
      (file) => {
        pickedIdRef.current += 1;
        return {
          id: `picked-${pickedIdRef.current}`,
          name: file.name,
          // DECODED bytes, which is what File.size already is. The wire
          // carries base64 at 4/3 this size; the budget is measured here.
          size: file.size,
          type: file.type,
          file,
        };
      },
    );
    setPicked((current) => mergePicked(current, chosen));
    setReadError(null);
    // Cleared so picking the SAME file again still fires a change event —
    // otherwise removing a file and re-adding it silently does nothing.
    event.target.value = '';
  }

  function removeAttachment(index: number): void {
    setPicked((current) => withoutPickedAt(current, index));
    setReadError(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    requestClose();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (inFlightRef.current) return;

    // Flush both tails into visible chips, so what is validated is what
    // the user can see. `draft` already folded them in, which is why an
    // address typed but never confirmed with Enter still gets sent to
    // rather than silently dropped.
    setTo(draft.to);
    setToPending('');
    setCc(draft.cc);
    setCcPending('');

    setAttemptedSend(true);
    setFailure(null);
    setReadError(null);
    if (!validation.isValid || attachmentProblem !== undefined) return;

    inFlightRef.current = true;
    setSending(true);
    setPartial(null);

    // The reply fields ride ALONGSIDE the validated draft rather than
    // inside it: ./composeValidation.ts checks what the user can edit,
    // and none of these three is editable. `replyWireFields` bundles all
    // of them so this call cannot carry the threading and forget the
    // quote, or the other way round.
    void submitDraft(reply === undefined ? draft : { ...draft, ...replyWireFields(reply) });
  }

  /**
   * Reads the files, then sends.
   *
   * Two awaits with two distinct failure meanings, which is why this is
   * not one `.then` chain: a file that could not be read means NOTHING
   * was sent and the user should fix the attachment, while a send failure
   * means copies may already have gone out (./composeResults.ts's
   * `describeSendFailure` is what decides how to say so). Collapsing them
   * would report an unreadable file as a possibly-half-sent message.
   */
  async function submitDraft(wire: SendRequest): Promise<void> {
    let attachments: readonly SendAttachment[];
    try {
      attachments = await encodeAttachments(picked);
    } catch {
      inFlightRef.current = false;
      setSending(false);
      // The error is discarded rather than logged: a FileReader error can
      // quote the file it failed on, and the filename is the user's.
      console.error('Compose: an attached file could not be read');
      setReadError(ATTACHMENT_READ_ERROR);
      return;
    }

    try {
      const results = await sendMail({ ...wire, attachments });
      inFlightRef.current = false;
      setSending(false);
      const summary = summarizeResults(results);
      if (summary.outcome === 'all-ok') {
        onSent(summary);
        onClose();
        return;
      }
      setPartial(summary);
    } catch (error: unknown) {
      inFlightRef.current = false;
      setSending(false);
      // ../composeApi.ts's thrown message is the path and the status,
      // nothing else — this cannot leak a recipient or a subject.
      console.error('Compose: send failed', error);
      setFailure(describeSendFailure(error));
    }
  }

  /** After a partial failure, drops everyone whose copy DID go out, so
   *  pressing Send again cannot deliver the message twice to them. */
  function keepOnlyFailed(failedAddresses: readonly string[]): void {
    const keep = (addresses: readonly string[]): readonly string[] =>
      addresses.filter((address) => includesRecipient(failedAddresses, address));
    setTo(keep(to));
    setCc(keep(cc));
  }

  // Walks the message body once (UTF-8 byte length) to decide whether the
  // quote fits, so it is memoised against a body that can be 90 KB.
  const quoteNotice = useMemo(() => quoteNoticeFor(reply), [reply]);

  const isLoadingIdentities = identityLoad.status === 'loading';
  const canSend =
    !isSending &&
    identityLoad.status === 'ready' &&
    identities.length > 0 &&
    attachmentProblem === undefined;

  return (
    // PLAN 7 TASK 2 — the composer arrives on the same curve and at the
    // same distance as the reader (src/motion/Panel.tsx): they are the
    // two surfaces that replace the whole content column, so they should
    // not enter differently. Its EXIT is the incoming view's entrance —
    // closing the composer changes `view`, and App.tsx's view swap
    // animates whatever comes back — so there is nothing to animate here
    // on the way out.
    <Panel>
      <section aria-labelledby={titleId} onKeyDown={handleKeyDown}>
      <Card>
        <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-border sm:px-6 sm:py-4">
          <h2 id={titleId} className="text-base font-semibold">
            {composerTitleFor(reply?.mode ?? null)}
          </h2>
          <Button type="button" variant="ghost" size="sm" className={TOUCH_HEIGHT} onClick={requestClose} disabled={isSending}>
            Cancel
          </Button>
        </header>

        <form onSubmit={handleSubmit} noValidate className="space-y-4 p-4 sm:p-6">
          {identityLoad.status === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>{identityLoad.message}</AlertDescription>
            </Alert>
          )}

          {identityLoad.status === 'ready' && identities.length === 0 && (
            <Alert variant="warning">
              <AlertDescription>
                No sending accounts are configured, so Valen Mail cannot send anything yet.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={identityFieldId}>Send from</Label>
            <Select
              id={identityFieldId}
              value={identityId}
              disabled={isSending || isLoadingIdentities || identities.length === 0}
              aria-invalid={errors.identityId !== undefined}
              onChange={(event) => setIdentityId(event.target.value)}
            >
              {isLoadingIdentities && <option value="">Loading accounts…</option>}
              {identities.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {identity.isPrimary ? `${identity.email} (primary)` : identity.email}
                </option>
              ))}
            </Select>
            {errors.identityId !== undefined && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {errors.identityId}
              </p>
            )}
          </div>

          <RecipientField
            id={toFieldId}
            label="To"
            addresses={to}
            pending={toPending}
            onChange={(next, pending) => {
              setTo(next);
              setToPending(pending);
            }}
            failed={partial?.failed}
            error={errors.to}
            hint={RECIPIENT_HINT}
            isDisabled={isSending}
            inputRef={toInputRef}
            placeholder="name@example.com"
          />

          {isCcShown ? (
            <RecipientField
              id={ccFieldId}
              label="Cc"
              addresses={cc}
              pending={ccPending}
              onChange={(next, pending) => {
                setCc(next);
                setCcPending(pending);
              }}
              failed={partial?.failed}
              error={errors.cc}
              isDisabled={isSending}
              inputRef={ccInputRef}
              placeholder="name@example.com"
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm" className={TOUCH_HEIGHT}
              disabled={isSending}
              onClick={() => {
                isCcRevealedByUserRef.current = true;
                setCcShown(true);
              }}
            >
              Add Cc
            </Button>
          )}

          {errors.recipients !== undefined && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {errors.recipients}
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={subjectFieldId}>Subject</Label>
            <Input
              id={subjectFieldId}
              value={subject}
              disabled={isSending}
              aria-invalid={errors.subject !== undefined}
              onChange={(event) => setSubject(event.target.value)}
              // A single-submit-button form submits on Enter in any text
              // input — which here would mean an unfinished message going
              // out the moment someone finishes typing a subject and
              // reaches for the next field by habit. Enter moves to the
              // body instead, so Send is reachable only by Send.
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                bodyRef.current?.focus();
              }}
            />
            {errors.subject !== undefined && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {errors.subject}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={bodyFieldId}>Message</Label>
            <Textarea
              id={bodyFieldId}
              ref={bodyRef}
              rows={12}
              value={textBody}
              disabled={isSending}
              aria-invalid={errors.textBody !== undefined}
              onChange={(event) => setTextBody(event.target.value)}
            />
            {errors.textBody !== undefined && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {errors.textBody}
              </p>
            )}
          </div>

          {/* ATTACHMENTS. A real <input type="file"> does the work; the
              Button is its accessible surrogate, because a <label>
              styled as a button is clickable but not focusable, and a
              bare file input cannot be styled to match anything else on
              this form. The input is taken out of the tab order and
              hidden from the accessibility tree so there is exactly ONE
              control announced here, not two.

              Fluid at every width: the row wraps rather than gaining a
              second layout, and the chips wrap with it, so nothing here
              is gated to `lg:`. Attaching a file on a phone is not a
              desktop affordance. */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={handleFilesPicked}
              />
              <Button
                type="button"
                variant="outline"
                size="sm" className={TOUCH_HEIGHT}
                disabled={isSending}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip aria-hidden="true" />
                Attach files
              </Button>
              {picked.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {picked.length === 1 ? '1 file' : `${picked.length} files`} ·{' '}
                  {formatFileSize(attachedBytes)}
                </p>
              )}
            </div>

            {picked.length > 0 && (
              <ul aria-label="Attached files" className="flex flex-wrap items-center gap-1.5">
                {picked.map((attachment, index) => (
                  <li key={attachment.id}>
                    <span className={cn(CHIP_BASE, CHIP_NEUTRAL)}>
                      {/* Filenames are user input rendered as a text
                          child, like every address chip beside them —
                          nothing here goes near a raw-HTML sink. */}
                      <span className="truncate">{attachment.name}</span>
                      <span className={CHIP_SECONDARY}>{formatFileSize(attachment.size)}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(index)}
                        disabled={isSending}
                        className={CHIP_REMOVE}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">Remove {attachment.name}</span>
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {attachmentProblem !== undefined && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {attachmentProblem}
              </p>
            )}
            {readError !== null && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {readError}
              </p>
            )}
          </div>

          {isTrackingDegraded && (
            /* SPEC §5.3.1 / §7A.2 — said BEFORE the send, while the user
               can still drop a file or a recipient. An Alert rather than
               the quiet muted line below it because this is a decision,
               not a footnote: what the message can tell them afterwards
               is about to change.

               `<Settle>` because of WHEN it appears: mid-compose, in
               answer to the file the user just attached, with the form
               already on screen around it. Every other banner in this app
               settles in for exactly that reason (see App.tsx's), and
               this was the one that punched into the layout between two
               frames — which reads as the form having jumped rather than
               as the app answering. */
            <Settle>
              <Alert variant="warning">
                <AlertDescription>{degradationNotice()}</AlertDescription>
              </Alert>
            </Settle>
          )}

          {quoteNotice !== null && (
            /* Quiet, and stated where the user is looking when they
               finish writing. The quote itself is assembled server-side
               (../replyDraft.ts's header), so there is nothing here to
               preview — only the promise that it will be there, or the
               admission that it will not. */
            <p className="text-xs text-muted-foreground">{quoteNotice}</p>
          )}

          <ComposeOutcome
            partial={partial}
            failure={failure}
            onDropSentRecipients={() => keepOnlyFailed(partial?.failed ?? [])}
          />

          <footer className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <p id={trackingNoteId} className="text-xs text-muted-foreground">
              {TRACKING_NOTE}
            </p>
            <Button type="submit" className={TOUCH_HEIGHT} disabled={!canSend} aria-busy={isSending} aria-describedby={trackingNoteId}>
              {isSending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Send aria-hidden="true" />
              )}
              {isSending ? 'Sending…' : 'Send'}
            </Button>
          </footer>
        </form>
      </Card>
      </section>
    </Panel>
  );
}
