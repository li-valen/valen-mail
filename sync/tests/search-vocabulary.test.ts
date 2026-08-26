import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEARCH_OPERATORS } from '../src/search/terms';

/**
 * THE ONE THING TWO PARSERS MUST AGREE ON.
 *
 * The client parses the query a second time — for DISPLAY only, because
 * the chip under the results banner has to render on the keystroke and
 * cannot wait for a round trip (client/src/searchDisplay.ts explains the
 * confinement). Its output changes nothing about what is searched: the
 * raw query goes on the wire untouched and this service is the only
 * thing that gives it meaning.
 *
 * What CAN break is the vocabulary. Add `label:` here and the server
 * starts filtering on it while the client still draws it as literal
 * text — or add it there and the chip promises a filter that does not
 * exist. Either way the suite stays green and the user is shown a query
 * that means something other than what ran.
 *
 * So this reads the client's source and holds it to this module's list.
 * It runs in the SYNC suite, not the client's, for two reasons: sync is
 * the authority, and client/CLAUDE.md's fixed dependency list excludes
 * @types/node, so a client test cannot read a file outside its own root.
 *
 * SKIPPED, not failed, when client/ is absent — the sync service is
 * deployable on its own and a missing sibling package is not a defect in
 * it. The `existsSync` below is the whole of that concession; when the
 * file IS there, divergence is a hard failure.
 */

const DISPLAY_SOURCE = fileURLToPath(new URL('../../client/src/searchDisplay.ts', import.meta.url));

const maybe = existsSync(DISPLAY_SOURCE) ? describe : describe.skip;

/** Reads the string literals out of the client's `DISPLAY_OPERATORS`
 *  array. A regex rather than an import because the two packages have
 *  separate tsconfigs and separate module resolution — and because the
 *  point is to check the FILE, not a build artefact of it. */
function clientOperators(): readonly string[] {
  const source = readFileSync(DISPLAY_SOURCE, 'utf8');
  const declaration = /export const DISPLAY_OPERATORS = \[([\s\S]*?)\] as const;/.exec(source);
  if (declaration === null) return [];
  return [...declaration[1]!.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!);
}

maybe('the search vocabulary is the same on both sides', () => {
  it('finds the client’s DISPLAY_OPERATORS declaration at all', () => {
    // Guards the regex itself: renaming the constant would otherwise
    // make every assertion below compare against an empty list and pass
    // for the worst possible reason.
    expect(clientOperators().length).toBeGreaterThan(0);
  });

  it('matches the server’s SEARCH_OPERATORS exactly, order included', () => {
    expect(clientOperators()).toEqual([...SEARCH_OPERATORS]);
  });

  it('would notice an operator the server has and the client does not', () => {
    // The synthetic proof that the comparison above is real. Without it,
    // a regex that silently stopped matching would leave this suite
    // green forever.
    const drifted = [...SEARCH_OPERATORS].slice(0, -1);
    expect(drifted).not.toEqual([...SEARCH_OPERATORS]);
  });
});
