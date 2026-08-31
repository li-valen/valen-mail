import { describe, it, expect } from 'vitest';
import readStateSource from '../src/components/ReadState.tsx?raw';
import openEventsSource from '../src/components/openEvents.ts?raw';
// Task 7.6 renamed OpensRail.tsx -> OpensView.tsx when the opens rail
// became a page the sidebar navigates to. Task V1 then restored an
// OpensRail.tsx (a distinct file, beside the Inbox at desktop widths) and
// extracted the markup both it and OpensView.tsx render into
// OpensFeed.tsx — that extraction is why OpensFeed.tsx joins the scanned
// surface below and OpensRail.tsx does not: OpensView.tsx and
// OpensRail.tsx are now thin wrappers that never touch an event field or
// import an icon directly, so scanning their source would be vacuous;
// OpensFeed.tsx is the one file that actually renders open events now.
// The forbidden-pattern list itself is untouched.
import opensViewSource from '../src/components/OpensView.tsx?raw';
import opensFeedSource from '../src/components/OpensFeed.tsx?raw';

/**
 * Static guards on the two hard bans client/DESIGN.md §5.1 states for
 * this component set, using the same `?raw`-import-and-regex technique
 * tests/theme-tokens.test.ts already uses to check a stylesheet — the
 * only tool available given client/CLAUDE.md's standing constraint that
 * no test in this plan renders a component, which rules out an
 * automated "inspect the rendered DOM" check.
 *
 *   1. `deviceClass`/`os` never render (they are present on `OpenEvent`
 *      and an implementer will be tempted; DESIGN.md's own verification
 *      checklist item is "`deviceClass` and `os` appear nowhere in the
 *      rendered DOM").
 *   2. No checkmark glyph, in any lucide-react variant, ever appears —
 *      "the checkmark is the lie this product exists to refuse."
 *
 * Each includes a synthetic-fixture test proving the regex itself would
 * actually catch the bug it exists to catch, not just always pass.
 */

const SOURCE = `${readStateSource}\n${openEventsSource}\n${opensViewSource}\n${opensFeedSource}`;

/**
 * The COMPONENTS — everything except openEvents.ts, which is now the single
 * sanctioned reader of `deviceClass`/`os`.
 *
 * DESIGN.md §5.1's ban was absolute until 2026-08-30 and is now narrowed: the
 * fields may reach the UI, but only through `readerFor()`, which returns a
 * sentence that stays honest when nothing was reported. Keeping the ban on
 * the COMPONENTS is what preserves the property the original was protecting —
 * no component can render a raw platform string, so `unknown` can never be
 * painted as though it were a device.
 */
const COMPONENT_SOURCE = `${readStateSource}\n${opensViewSource}\n${opensFeedSource}`;

const DEVICE_CLASS_ACCESS = /\.deviceClass\b/;
const OS_FIELD_ACCESS = /\.os\b/;
const CHECKMARK_ICON_IMPORT = /\bCheck(Circle2?|Square)?\b|\bBadgeCheck\b/;

describe('OpensView/OpensFeed/ReadState source — read-state hard bans', () => {
  it('no COMPONENT reads event.deviceClass', () => {
    expect(COMPONENT_SOURCE).not.toMatch(DEVICE_CLASS_ACCESS);
  });

  it('no COMPONENT reads event.os', () => {
    expect(COMPONENT_SOURCE).not.toMatch(OS_FIELD_ACCESS);
  });

  it('exactly one module is allowed to read them, and it is the honest one', () => {
    // The narrowing has to be a channel, not a hole: if a second module could
    // read these, "unknown" would eventually get rendered as a device
    // somewhere. openEvents.ts reads them solely to build `readerFor`'s
    // sentence, which names the absence rather than printing it.
    expect(openEventsSource).toMatch(DEVICE_CLASS_ACCESS);
    expect(openEventsSource).toContain('a proxy that reported no device');
  });

  it('never imports a checkmark-shaped lucide-react icon', () => {
    expect(SOURCE).not.toMatch(CHECKMARK_ICON_IMPORT);
  });
});

describe('the guards themselves (not vacuous)', () => {
  it('flags a snippet that renders event.deviceClass', () => {
    const buggy = 'return <span>{event.deviceClass}</span>;';
    expect(buggy).toMatch(DEVICE_CLASS_ACCESS);
  });

  it('flags a snippet that renders event.os', () => {
    const buggy = 'return <span>{event.os}</span>;';
    expect(buggy).toMatch(OS_FIELD_ACCESS);
  });

  it('flags an import of a checkmark icon', () => {
    const buggy = "import { CheckCircle } from 'lucide-react';";
    expect(buggy).toMatch(CHECKMARK_ICON_IMPORT);
  });

  it('does not false-positive on an unrelated ".os"-containing word', () => {
    // "across" and "most" contain the letters o-s but never as a
    // property-access suffix — the regex requires a preceding literal
    // dot, which prose text never has.
    expect('across the most common case').not.toMatch(OS_FIELD_ACCESS);
  });
});
