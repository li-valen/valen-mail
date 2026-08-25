import { describe, it, expect } from 'vitest';
import readStateSource from '../src/components/ReadState.tsx?raw';
import openEventsSource from '../src/components/openEvents.ts?raw';
// Task 7.6 renamed OpensRail.tsx -> OpensView.tsx when the opens rail
// became a page the sidebar navigates to. The scanned surface is the same
// three files; the forbidden-pattern list below is untouched.
import opensViewSource from '../src/components/OpensView.tsx?raw';

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

const SOURCE = `${readStateSource}\n${openEventsSource}\n${opensViewSource}`;

const DEVICE_CLASS_ACCESS = /\.deviceClass\b/;
const OS_FIELD_ACCESS = /\.os\b/;
const CHECKMARK_ICON_IMPORT = /\bCheck(Circle2?|Square)?\b|\bBadgeCheck\b/;

describe('OpensRail/ReadState source — DESIGN.md §5.1 hard bans', () => {
  it('never reads event.deviceClass', () => {
    expect(SOURCE).not.toMatch(DEVICE_CLASS_ACCESS);
  });

  it('never reads event.os', () => {
    expect(SOURCE).not.toMatch(OS_FIELD_ACCESS);
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
