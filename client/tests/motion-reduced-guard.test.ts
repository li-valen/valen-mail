import { describe, expect, it } from 'vitest';

import packageJson from '../package.json';

/**
 * THE GUARD: no component may animate without a reduced-motion path.
 *
 * Plan 7's Global Constraints require one, and the failure this catches is
 * quiet by nature — an animation with no reduced path looks perfect on
 * every machine except the one belonging to the person it makes ill. It
 * cannot be caught by review either, because the omission is an absence:
 * there is nothing in the diff to notice.
 *
 * WHY A SOURCE SCAN AND NOT A RENDER TEST. This suite never mounts a
 * component (client/CLAUDE.md's standing constraint), so "does this
 * component respect the preference at runtime?" is not answerable here.
 * What IS answerable, and is very nearly as strong, is "does every file
 * that reaches for the motion library also reach for the preference?" —
 * because src/motion/variants.ts is built so that obtaining variants
 * REQUIRES passing the answer in. A file that imports `motion/react` and
 * never mentions `useReducedMotion` cannot have gone through that door.
 *
 * TWO ACCEPTED ANSWERS, both genuine:
 *
 *  - `useReducedMotion(` — the per-component path. The component reads the
 *    preference and hands it to a `*VariantsFor(isReduced)` builder, which
 *    returns a pair whose two ends are identical. This is the one every
 *    animated component uses.
 *  - `reducedMotion=` — the `<MotionConfig reducedMotion="user">` root in
 *    src/main.tsx, which makes `motion` itself refuse transform animation
 *    for such a viewer. Accepted only for the file that DECLARES it;
 *    it is a backstop, not a substitute, because `"user"` suppresses
 *    transforms and not opacity.
 *
 * The last test in this file proves the checker can fail, against a
 * fixture that imports the motion library and does neither.
 */

const sources = import.meta.glob('../src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Strips block and line comments before scanning, so this file's own
 *  prose — and the long design notes throughout src/motion — cannot be
 *  mistaken for live code either way. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** True when the file actually pulls in the motion library. A type-only
 *  import does not count: `import type` is erased at build time and
 *  animates nothing. */
function importsMotion(source: string): boolean {
  return /^\s*import\s+(?!type\s)[^;]*from\s+['"]motion\/react['"]/m.test(source);
}

/** True when the file establishes a reduced-motion path — see the header
 *  for why exactly these two spellings are accepted. */
function handlesReducedMotion(source: string): boolean {
  return /\buseReducedMotion\s*\(/.test(source) || /\breducedMotion\s*=/.test(source);
}

interface Offense {
  readonly file: string;
}

function findOffenses(entries: Record<string, string>): readonly Offense[] {
  return Object.entries(entries)
    .map(([file, raw]) => ({ file, source: stripComments(raw) }))
    .filter(({ source }) => importsMotion(source) && !handlesReducedMotion(source))
    .map(({ file }) => ({ file }));
}

const animatedFiles = Object.entries(sources)
  .filter(([, raw]) => importsMotion(stripComments(raw)))
  .map(([file]) => file);

describe('every file that imports the motion library also handles prefers-reduced-motion', () => {
  it('finds source files to scan (the glob is not empty)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it('finds files that actually import motion (so the filter below is not vacuous)', () => {
    // If this ever drops to zero the guard passes trivially and means
    // nothing — which is precisely how a guard like this dies quietly.
    expect(animatedFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('leaves no animated file without a reduced-motion path', () => {
    expect(findOffenses(sources)).toEqual([]);
  });

  it('flags a file that imports motion and handles neither (proves the checker can fail)', () => {
    const buggy = [
      "import { motion } from 'motion/react';",
      'export function Buggy() {',
      "  return <motion.div animate={{ opacity: 1 }} initial={{ opacity: 0 }} />;",
      '}',
    ].join('\n');
    expect(findOffenses({ 'fixture/Buggy.tsx': buggy })).toEqual([{ file: 'fixture/Buggy.tsx' }]);
  });

  it('clears the same fixture once it reads the preference', () => {
    const fixed = [
      "import { motion, useReducedMotion } from 'motion/react';",
      'export function Fixed() {',
      '  const isReduced = useReducedMotion() ?? false;',
      '  return <motion.div animate={{ opacity: 1 }} initial={isReduced ? false : { opacity: 0 }} />;',
      '}',
    ].join('\n');
    expect(findOffenses({ 'fixture/Fixed.tsx': fixed })).toEqual([]);
  });

  it('clears a file that declares MotionConfig reducedMotion instead', () => {
    const root = [
      "import { MotionConfig } from 'motion/react';",
      'export const Root = () => <MotionConfig reducedMotion="user" />;',
    ].join('\n');
    expect(findOffenses({ 'fixture/Root.tsx': root })).toEqual([]);
  });

  it('ignores a type-only import — nothing erased at build time can animate', () => {
    const typeOnly = "import type { Variants } from 'motion/react';\nexport type X = Variants;";
    expect(findOffenses({ 'fixture/TypeOnly.ts': typeOnly })).toEqual([]);
  });

  it('is not fooled by a comment that merely mentions the hook', () => {
    const commentOnly = [
      "import { motion } from 'motion/react';",
      '// TODO: call useReducedMotion() here one day',
      'export const X = () => <motion.div />;',
    ].join('\n');
    expect(findOffenses({ 'fixture/CommentOnly.tsx': commentOnly })).toEqual([{ file: 'fixture/CommentOnly.tsx' }]);
  });

  it('is not fooled by a file that merely mentions the library in prose', () => {
    const prose = '/* This component deliberately avoids motion/react. */\nexport const X = 1;';
    expect(findOffenses({ 'fixture/Prose.ts': prose })).toEqual([]);
  });
});

describe('ONE motion layer', () => {
  const dependencies: Readonly<Record<string, string>> = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  it('declares `motion` as a real dependency', () => {
    // It was installed early, imported by nothing, and removed as a
    // zombie. It is back because it is now genuinely load-bearing —
    // shared-element layout animation for the sidebar pill is not
    // reproducible in CSS.
    expect(dependencies).toHaveProperty('motion');
  });

  it.each(['framer-motion', 'gsap', 'animejs', 'tw-animate-css', '@react-spring/web', 'popmotion'])(
    'does not also depend on %s',
    (name) => {
      expect(dependencies).not.toHaveProperty(name);
    },
  );

  it('no source file imports a second animation library', () => {
    const banned = /from\s+['"](framer-motion|gsap|animejs|@react-spring\/web|popmotion)['"]/;
    const offenders = Object.entries(sources)
      .filter(([, raw]) => banned.test(stripComments(raw)))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

describe('the surfaces Plan 7 named are actually wired up', () => {
  /** Path suffix -> what it must contain, so "I animated the sidebar"
   *  is a claim the suite can check rather than one the report makes. */
  const WIRED: ReadonlyArray<{ readonly file: string; readonly needle: RegExp; readonly what: string }> = [
    { file: 'src/AppShell.tsx', needle: /layoutId=/, what: 'sidebar selection pill (shared element)' },
    { file: 'src/AppShell.tsx', needle: /ease-drawer/, what: 'mobile drawer + scrim curve' },
    { file: 'src/App.tsx', needle: /<Settle key={view}/, what: 'view transition' },
    { file: 'src/components/InboxList.tsx', needle: /groupCount=/, what: 'inbox day-group cascade' },
    { file: 'src/components/OpensFeed.tsx', needle: /isNew \?/, what: 'only-new rail rows animate' },
    { file: 'src/components/MessageView.tsx', needle: /<Panel/, what: 'reader open' },
    { file: 'src/components/Compose.tsx', needle: /<Panel/, what: 'composer open' },
    { file: 'src/ui/Button.tsx', needle: /motion-safe:active:scale-/, what: 'button press feedback' },
    { file: 'src/components/MessageRow.tsx', needle: /active:bg-/, what: 'row press feedback' },
  ];

  it.each(WIRED)('$file carries the $what', ({ file, needle }) => {
    const entry = Object.entries(sources).find(([path]) => path.endsWith(file));
    expect(entry, `${file} not found in the glob`).toBeDefined();
    expect(stripComments(entry![1])).toMatch(needle);
  });

  it('the inbox skeleton is deliberately NOT animated', () => {
    // Instant, then smooth. The skeleton is what acknowledges the click;
    // fading it in delays that acknowledgement by exactly the length of
    // the fade. If a future change wraps the loading branch in a Settle
    // this fails, which is the point.
    const entry = Object.entries(sources).find(([path]) => path.endsWith('src/components/InboxList.tsx'));
    const source = stripComments(entry![1]);
    const loadingBranch = source.slice(
      source.indexOf("if (load.status === 'loading')"),
      source.indexOf("if (load.status === 'error')"),
    );
    expect(loadingBranch.length).toBeGreaterThan(100);
    expect(loadingBranch).not.toMatch(/<Settle|<Panel|motion\./);
  });
});
