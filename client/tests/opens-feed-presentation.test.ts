import { describe, it, expect } from 'vitest';
import opensFeedSource from '../src/components/OpensFeed.tsx?raw';
import readStateSource from '../src/components/ReadState.tsx?raw';
import { readStateFor } from '../src/components/ReadState';

/**
 * Rendered-output coverage for task V1b (the Superhuman/Mailspring restyle
 * of the opens feed's rows), for the one claim tests/opens-rail.test.ts's
 * `formatOpenRowSentence`/`selfCountLine` tests can't make on their own:
 * that OpensFeed.tsx and ReadState.tsx actually STOPPED reading the fields
 * that used to carry the deleted copy onto the screen, and actually DO
 * wire the mark's tone to something a stylesheet/test can hook.
 *
 * client/CLAUDE.md's standing constraint — no test in this plan renders a
 * component — rules out mounting `<OpensFeed/>` and inspecting the DOM,
 * so this uses the exact `?raw`-import-and-regex technique
 * tests/opens-rail-static-guards.test.ts already established for the same
 * reason. Unlike that file's two PERMANENT hard bans (deviceClass/os,
 * checkmark icons — untouched by this task), the bans here are specific to
 * V1b's rewrite: they assert what changed, not a standing rule for every
 * future restyle.
 *
 * Every regex here is deliberately narrower than a plain substring search
 * for words like "MPP" or "details" — this file's OWN doc comments (and
 * OpensFeed.tsx's/ReadState.tsx's) legitimately mention those words in
 * prose when explaining what was removed. Each pattern instead targets the
 * property-access or tag-open SHAPE that only appears in real code
 * (`copy.headline`, `<details>` as markup, `dangerouslySetInnerHTML=`),
 * and the last `describe` block below proves each one is not vacuous by
 * running it against a literal snapshot of the pre-V1b markup it replaced.
 */

const NO_OLD_COPY_SOURCES = /copy\.(headline|sub|meta)|state\.(token|label)|displayToken/;
const DETAILS_TAG = /<details[\s>]/;
const SUMMARY_TAG = /<summary[\s>]/;
const CHEVRON_DOWN = /ChevronDown/;
const DANGEROUS_HTML_PROP = /dangerouslySetInnerHTML\s*=/;
const BADGE_TAG = /<Badge[\s>]/;
const TONE_ATTRIBUTE_WIRING = /data-tone=\{state\.tone\}/;

describe('OpensFeed.tsx — the deleted copy has no path back onto the screen', () => {
  it('never reads copy.headline/sub/meta, state.token/label, or displayToken', () => {
    expect(opensFeedSource).not.toMatch(NO_OLD_COPY_SOURCES);
  });

  it('no longer renders a details/summary disclosure or its ChevronDown toggle', () => {
    expect(opensFeedSource).not.toMatch(DETAILS_TAG);
    expect(opensFeedSource).not.toMatch(SUMMARY_TAG);
    expect(opensFeedSource).not.toMatch(CHEVRON_DOWN);
  });

  it('never uses dangerouslySetInnerHTML — subject/recipientEmail are attacker-influenced and render as JSX text only', () => {
    expect(opensFeedSource).not.toMatch(DANGEROUS_HTML_PROP);
  });
});

describe('ReadState.tsx — the mark no longer wraps a token-carrying Badge', () => {
  it('never renders {displayToken}, {state.token}, {state.label}, or a <Badge> tag', () => {
    expect(readStateSource).not.toMatch(/\{displayToken\}|\{state\.token\}|\{state\.label\}/);
    expect(readStateSource).not.toMatch(BADGE_TAG);
  });
});

describe('the mark differs by tone — the one surviving visual distinction', () => {
  it('`readStateFor` resolves open and mpp to different tones (confirmed vs. unknown)', () => {
    expect(readStateFor('open').tone).toBe('confirmed');
    expect(readStateFor('mpp').tone).toBe('unknown');
    expect(readStateFor('open').tone).not.toBe(readStateFor('mpp').tone);
  });

  it('ReadState.tsx wires that tone onto a `data-tone` DOM attribute on the mark', () => {
    expect(readStateSource).toMatch(TONE_ATTRIBUTE_WIRING);
  });
});

describe('the guards above are not vacuous — each fails against the pre-V1b markup it replaced', () => {
  // Literal snapshots of the exact JSX task V1 shipped (git show
  // 2364c61:client/src/components/OpensFeed.tsx and ReadState.tsx),
  // trimmed to the lines each regex above cares about.
  const PRE_V1B_CONFIRMED_ROW = `
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm text-neutral-900">{copy.headline}</span>
      <span className="block truncate font-mono text-xs text-neutral-500">{copy.meta}</span>
    </span>
  `;
  const PRE_V1B_DISCLOSURE = `
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
      </summary>
    </details>
  `;
  const PRE_V1B_READ_STATE_BADGE = `
    <Badge variant={state.tone === 'confirmed' ? 'success' : 'neutral'} title={fullTokenTitle}>
      <StateMark classification={classification} />
      {displayToken}
    </Badge>
  `;
  const DANGEROUS_HTML_USAGE_EXAMPLE = '<div dangerouslySetInnerHTML={{ __html: subject }} />';

  it('the copy./state.token/label/displayToken ban flags the old confirmed-row markup', () => {
    expect(PRE_V1B_CONFIRMED_ROW).toMatch(NO_OLD_COPY_SOURCES);
  });

  it('the details/summary/ChevronDown ban flags the old disclosure markup', () => {
    expect(PRE_V1B_DISCLOSURE).toMatch(DETAILS_TAG);
    expect(PRE_V1B_DISCLOSURE).toMatch(SUMMARY_TAG);
    expect(PRE_V1B_DISCLOSURE).toMatch(CHEVRON_DOWN);
  });

  it('the dangerouslySetInnerHTML ban flags real JSX usage of the prop', () => {
    expect(DANGEROUS_HTML_USAGE_EXAMPLE).toMatch(DANGEROUS_HTML_PROP);
  });

  it('the Badge/displayToken ban flags the old ReadState markup', () => {
    expect(PRE_V1B_READ_STATE_BADGE).toMatch(/\{displayToken\}/);
    expect(PRE_V1B_READ_STATE_BADGE).toMatch(BADGE_TAG);
  });

  // The false-positive check this file's own bans have to survive: both
  // source files legitimately mention "MPP", "details", "Badge" and
  // "dangerouslySetInnerHTML" in backtick-quoted prose explaining what was
  // removed. A naive substring ban (rather than the tag/property-access
  // -shaped regexes above) would fail the moment someone documented that.
  it('does not false-positive on this codebase\'s own prose mentions of the removed markup', () => {
    expect(opensFeedSource).toMatch(/dangerouslySetInnerHTML/); // named in prose
    expect(opensFeedSource).not.toMatch(DANGEROUS_HTML_PROP); // never used as a prop
    expect(readStateSource.toLowerCase()).toMatch(/badge/); // named in prose (Plunk's Badge atom)
    expect(readStateSource).not.toMatch(BADGE_TAG); // never opened as a tag
  });
});
