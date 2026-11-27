/**
 * CI wiring for the drill-down facet SHAPE checker.
 *
 * Same enforcement pattern `design-gates.test.ts` uses: the checker is a pure,
 * dependency-free node module that reads source off disk, and this file only asserts its
 * result so it runs inside the ordinary `vitest run` rather than only when someone
 * remembers to invoke a gate by hand. No logic is duplicated here.
 *
 * It closes a real blind spot in the repository's own guards: the baselined grep gate
 * walks `src/**\/*.tsx` only, so nothing inspects a `.ts` module at all, and nothing
 * anywhere inspects a file for a hard-coded product vocabulary.
 */
import { describe, it, expect } from 'vitest';

import { checkDrilldownFacetShape } from './drilldown-facet-shape';

describe('shape gate: the KPI drill-down derives its facet options', () => {
  it('names no severity band and no case status as a literal', () => {
    const { ok, problems, checked } = checkDrilldownFacetShape();
    // Surface the exact offenders in the failure message.
    expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
    expect(ok).toBe(true);
    // Guard against a vacuous sweep: a checker that read nothing, or that failed to
    // extract either vocabulary, would report "ok" while proving nothing at all.
    expect(checked.panelBytes).toBeGreaterThan(1000);
    expect(checked.severityBands.length).toBeGreaterThanOrEqual(3);
    expect(checked.statusTokens.length).toBeGreaterThanOrEqual(3);
  });
});
