/**
 * Round 12 settings search keywords (WP-GEN-B).
 *
 * The Round 12 settings must be findable by the words an operator types, in the Settings
 * rail filter and the Cmd-K palette alike (both call `searchJumpTargets`; the console
 * map that chat's "where do I change X?" answers read indexes the same keywords):
 *   - Remember me and how long a sign-in lasts → Security & access › Single sign-on &
 *     policy (the Session policy editor) and Account › Sessions & activity (Remembered
 *     badges, Expires column);
 *   - Reduce transparency → Account › Appearance & customization;
 *   - chat limits (Unlimited / Bounded) and the daily chat spending limit → General ›
 *     Chat assistant.
 * The prompt library is not a Settings section (it lives in the chat composer), so no
 * Settings section claims it: a search for it must not jump to an unrelated section.
 */
import { describe, expect, it } from 'vitest';

import { searchJumpTargets, sectionMatchesQuery, SECTION_META_BY_ID } from '../settings-sections-meta';

const allowAll = () => true;

function sectionsFor(query: string): string[] {
  return searchJumpTargets(query, allowAll)
    .filter((t) => !t.anchor)
    .map((t) => t.section);
}

const CASES: ReadonlyArray<[query: string, sections: readonly string[]]> = [
  ['remember me', ['security', 'sessions']],
  ['Remember me', ['security', 'sessions']],
  ['stay signed in', ['security', 'sessions']],
  ['keep me signed in', ['security']],
  ['session length', ['security']],
  ['session lifetime', ['security']],
  ['remembered', ['security', 'sessions']],
  ['reduce transparency', ['customization']],
  ['transparency', ['customization']],
  ['frosted glass', ['customization']],
  ['chat limits', ['chat_agent']],
  ['question limits', ['chat_agent']],
  ['per-question', ['chat_agent']],
  ['unlimited', ['chat_agent']],
  ['bounded', ['chat_agent']],
  ['spending limit', ['chat_agent']],
  ['daily limit', ['chat_agent']],
  ['chat budget', ['chat_agent']],
  ['animated logo', ['chat_agent']],
];

describe('Round 12 settings are findable by the words operators use', () => {
  for (const [query, expected] of CASES) {
    it(`"${query}" finds ${expected.join(' and ')}`, () => {
      const hits = sectionsFor(query);
      for (const id of expected) expect(hits).toContain(id);
      // The rail keeps the same sections visible for the same query.
      for (const id of expected) expect(sectionMatchesQuery(SECTION_META_BY_ID[id], query)).toBe(true);
    });
  }

  it('no Settings section claims the prompt library (it lives in the chat composer)', () => {
    expect(sectionsFor('prompt library')).toEqual([]);
    expect(sectionsFor('promptbook')).toEqual([]);
  });

  it('a section a role cannot open is never offered for these words', () => {
    // Single sign-on & policy needs settings:manage; Sessions & activity is ungated.
    const noSettings = (resource: string, action: string) => !(resource === 'settings' && action === 'manage');
    const hits = searchJumpTargets('remember me', noSettings).filter((t) => !t.anchor).map((t) => t.section);
    expect(hits).toContain('sessions');
    expect(hits).not.toContain('security');
  });
});
