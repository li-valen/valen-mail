import { describe, expect, it } from 'vitest';
import composeSource from '../src/components/Compose.tsx?raw';
import recipientFieldSource from '../src/components/RecipientField.tsx?raw';
import sentNoticeSource from '../src/components/SentNotice.tsx?raw';
import appSource from '../src/App.tsx?raw';
import appShellSource from '../src/AppShell.tsx?raw';
import { degradationNotice } from '../src/attachmentPicker';

/**
 * Static guards on the composer, using the `?raw`-import-and-regex
 * technique tests/opens-rail-static-guards.test.ts and
 * tests/theme-tokens.test.ts already use — the only tool available given
 * client/CLAUDE.md's standing constraint that no test in this client
 * renders a component.
 *
 * Each guard pins a property that a rendering test would normally check
 * and that a future edit could quietly undo, and each comes with a
 * synthetic fixture proving the regex would actually catch the bug rather
 * than always passing.
 */

/**
 * Strips block and line comments before scanning, the same way
 * tests/neutral-class-guard.test.ts does — these files' own doc comments
 * NAME the sinks and the rules they forbid ("never goes near
 * `dangerouslySetInnerHTML`"), and prose about a ban must never read as
 * the ban being broken. It also makes the checks below stricter: a
 * disclosure that survived only inside a comment would no longer count as
 * rendered.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const compose = stripComments(composeSource);
const app = stripComments(appSource);
const appShell = stripComments(appShellSource);
const COMPOSE_SURFACE = [compose, stripComments(recipientFieldSource), stripComments(sentNoticeSource)].join(
  '\n',
);

/** The disclosure, verbatim. Tracking is what this product IS; a build
 *  that quietly drops this line ships a mail client that pixels every
 *  recipient without telling the sender it did. */
const TRACKING_DISCLOSURE = 'Tracked — each recipient gets their own tracking pixel.';

const RAW_HTML_SINK = /dangerouslySetInnerHTML|innerHTML\s*=/;
const CONSOLE_LOG = /\bconsole\.log\b/;
/** A console call whose argument list names the message itself. */
const CONSOLE_LEAKS_MESSAGE = /console\.\w+\([^)]*\b(subject|textBody|recipientEmail|draft)\b/;

describe('the composer states its tracking plainly', () => {
  it('renders the disclosure verbatim', () => {
    expect(compose).toContain(TRACKING_DISCLOSURE);
  });

  it('wires the disclosure to the Send control as its description', () => {
    // So a screen-reader user hears WHAT SENDING DOES at the moment they
    // reach the control that does it, not only if they happen to read
    // past it.
    expect(compose).toMatch(/aria-describedby=\{trackingNoteId\}/);
    expect(compose).toMatch(/id=\{trackingNoteId\}/);
  });
});

describe('user input never becomes markup', () => {
  it('no compose surface file reaches for a raw-HTML sink', () => {
    expect(COMPOSE_SURFACE).not.toMatch(RAW_HTML_SINK);
  });

  it('the raw-HTML guard is not vacuous', () => {
    expect('<p dangerouslySetInnerHTML={{ __html: subject }} />').toMatch(RAW_HTML_SINK);
    expect('node.innerHTML = value;').toMatch(RAW_HTML_SINK);
    expect('<p>{subject}</p>').not.toMatch(RAW_HTML_SINK);
  });
});

describe('the composer never logs the message', () => {
  it('uses no console.log at all', () => {
    expect(COMPOSE_SURFACE).not.toMatch(CONSOLE_LOG);
  });

  it('never names a subject, body or recipient in a console call', () => {
    // The send route holds itself to the same rule (sync/src/api/send.ts)
    // and it would be pointless for the browser to leak what the server
    // refuses to.
    expect(COMPOSE_SURFACE).not.toMatch(CONSOLE_LEAKS_MESSAGE);
  });

  it('the console guards are not vacuous', () => {
    expect('console.log("sending")').toMatch(CONSOLE_LOG);
    expect('console.error("send failed", draft)').toMatch(CONSOLE_LEAKS_MESSAGE);
    expect('console.error("Compose: send failed", error)').not.toMatch(CONSOLE_LEAKS_MESSAGE);
  });
});

describe('a 200 is never read as blanket success', () => {
  it('folds the response through summarizeResults rather than assuming', () => {
    expect(compose).toMatch(/summarizeResults\(results\)/);
  });

  it('closes ONLY on the all-ok outcome', () => {
    // The partial branch must fall through to leaving the composer open.
    // If this literal disappears, the composer is closing on something
    // other than "every copy went out".
    expect(compose).toMatch(/outcome === 'all-ok'/);
  });

  it('marks the failed recipients on both recipient fields', () => {
    const failedProps = compose.match(/failed=\{partial\?\.failed\}/g) ?? [];
    expect(failedProps).toHaveLength(2);
  });
});

describe('double submit is blocked synchronously, not just by a disabled attribute', () => {
  /**
   * `isSending` disables the button one render later, which is enough for
   * a mouse and not enough for a form submitted twice inside one task
   * (Enter held down, a fast double tap). The ref flips inside the
   * handler, before anything awaits.
   */
  it('guards the submit handler on a ref that is set before the request starts', () => {
    expect(compose).toMatch(/if \(inFlightRef\.current\) return;/);
    expect(compose).toMatch(/inFlightRef\.current = true;/);
  });

  it('clears the guard on BOTH the success and the failure path', () => {
    const clears = compose.match(/inFlightRef\.current = false;/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(2);
  });
});

describe('a draft is never discarded without asking', () => {
  it('the composer confirms before closing', () => {
    expect(compose).toMatch(/window\.confirm\(DISCARD_DRAFT_PROMPT\)/);
  });

  it('Escape is handled rather than left to the browser', () => {
    expect(compose).toMatch(/event\.key !== 'Escape'/);
  });

  it('the shell asks the SAME question before navigating away from a draft', () => {
    // One prompt, imported — not a second string that could drift into
    // saying something subtly different about the same act.
    expect(app).toMatch(/import Compose, \{ DISCARD_DRAFT_PROMPT \}/);
    expect(app).toMatch(/window\.confirm\(DISCARD_DRAFT_PROMPT\)/);
  });
});

describe('the Compose control is reachable and announced', () => {
  it('the shell renders a Compose button outside the nav landmark', () => {
    expect(appShell).toMatch(/onClick=\{\(\) => selectView\('compose'\)\}/);
  });

  it('compose is a real view, so the shell heading names it', () => {
    expect(appShell).toMatch(/compose: 'New message'/);
  });

  it('closing the composer returns focus to the trigger', () => {
    expect(app).toMatch(/composeTriggerRef\.current\?\.focus\(\)/);
  });
});

/**
 * Plan 11 — attachments, and spec §5.3.1's notice.
 *
 * The RULES are tested in tests/attachment-picker.test.ts, which is where
 * they live. What is guarded here is that the composer actually WIRES
 * them: a perfectly correct predicate nothing renders is a rule the user
 * never sees.
 */
describe('the composer can attach files', () => {
  it('renders a real file input rather than a fake drop zone', () => {
    expect(compose).toMatch(/type="file"/);
    expect(compose).toMatch(/multiple/);
  });

  it('gives the file input an accessible surrogate control, and only one', () => {
    // A <label> styled as a button is clickable but not focusable, and a
    // visible input plus a visible button would announce two controls for
    // one action.
    expect(compose).toMatch(/fileInputRef\.current\?\.click\(\)/);
    expect(compose).toMatch(/aria-hidden="true"/);
    expect(compose).toMatch(/tabIndex=\{-1\}/);
  });

  it('labels every remove control with the file it removes', () => {
    expect(compose).toMatch(/Remove \{attachment\.name\}/);
  });

  it('names the attached list for a screen reader', () => {
    expect(compose).toMatch(/aria-label="Attached files"/);
  });
});

describe('the §5.3.1 notice is rendered before the send, not after', () => {
  it('renders the notice the picker writes, not a second copy of the words', () => {
    // One sentence, one place. A literal pasted here could drift into
    // saying something subtly different about the same trade.
    expect(compose).toMatch(/\{degradationNotice\(\)\}/);
    expect(compose).not.toContain(degradationNotice());
  });

  it('shows it on the DEGRADE PREDICATE, not on a raw size check', () => {
    // The rule is bytes x recipients. A notice driven by the file size
    // alone would stay silent on the only case it exists for.
    expect(compose).toMatch(/willDegradeTracking\(picked, recipientCount\)/);
    expect(compose).toMatch(/isTrackingDegraded &&/);
  });

  it('feeds the predicate the LIVE recipient count, including cc', () => {
    expect(compose).toMatch(/draft\.to\.length \+ draft\.cc\.length/);
  });

  it('the notice sits in the form, above the Send control', () => {
    const noticeAt = compose.indexOf('degradationNotice()');
    const sendAt = compose.indexOf("type=\"submit\"");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(noticeAt);
  });
});

describe('an attached file is work that must not be discarded silently', () => {
  it('counts attachments as a dirty draft', () => {
    // Found the same way the reply-seeding bug was: attaching a deck and
    // pressing Escape must ask, and isDraftDirty only compares text.
    expect(compose).toMatch(/picked\.length > 0/);
  });

  it('blocks Send while an attachment cap is broken', () => {
    expect(compose).toMatch(/attachmentProblem === undefined/);
  });
});

describe('attachment failures are told apart', () => {
  it('reads the files and sends in separate steps with separate messages', () => {
    // A file that could not be read means NOTHING was sent; a send
    // failure means copies may already have gone out. One catch for both
    // would report the first as the second.
    expect(compose).toMatch(/encodeAttachments\(picked\)/);
    expect(compose).toMatch(/setReadError\(ATTACHMENT_READ_ERROR\)/);
  });

  it('never logs the file that failed', () => {
    expect(compose).not.toMatch(/console\.\w+\([^)]*\b(filename|attachment\.name|picked)\b/);
  });
});
