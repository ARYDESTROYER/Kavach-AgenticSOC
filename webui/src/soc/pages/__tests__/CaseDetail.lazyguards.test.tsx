/**
 * CaseDetail — lazy-load guards, threat reset, staleness guard, and error routing
 * (Round-6 findings #0/#3/#9/#10).
 *
 * CaseDetail is a large sheet with heavy prop/api coupling, so — like
 * CaseDetail.tabs.test.tsx / CaseDetail.live.test.tsx — these are STATIC assertions on
 * the orchestrator source (the load-bearing wiring), not a full mount.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(__dirname, '..', 'CaseDetail.tsx'), 'utf8');
const reinvestigateSrc = readFileSync(
  path.resolve(__dirname, '..', '..', 'investigations', 'ReinvestigateDialog.tsx'),
  'utf8',
);

/** Slice from the first occurrence of `needle` to the next `end` (exclusive). */
function slice(text: string, needle: string, end: string): string {
  const i = text.indexOf(needle);
  expect(i, `expected to find "${needle}"`).toBeGreaterThan(-1);
  const j = text.indexOf(end, i + needle.length);
  return text.slice(i, j === -1 ? text.length : j);
}

describe('CaseDetail — lazy-tab retry-storm guards (#0)', () => {
  it('every lazy-tab load effect also guards on its error state (no infinite refetch)', () => {
    // On failure the loader sets an error and leaves data null while loading flips back
    // to false; without `!error` the `data === null && !loading` guard re-fires forever.
    expect(src).toContain('timeline === null && !timelineLoading && !timelineError');
    expect(src).toContain('thread === null && !threadLoading && !threadError');
    expect(src).toContain('rationale === null && !rationaleLoading && !rationaleError');
    expect(src).toContain('threat === null && !threatLoading && !threatError');
  });
});

describe('CaseDetail — threat context reset (#3)', () => {
  it('the per-case reset effect clears the threat payload so the tab refetches', () => {
    const resetEffect = slice(src, 'Reset all per-case lazy state', 'void loadCase();');
    expect(resetEffect).toContain('setThreat(null)');
    expect(resetEffect).toContain('setThreatError(null)');
  });
});

describe('CaseDetail — stale-response guard (#10)', () => {
  it('tracks the active case id and drops results from a superseded case', () => {
    expect(src).toContain('activeIdRef');
    expect(src).toContain('activeIdRef.current = id');
    // Each id-keyed loader bails when the case changed mid-flight (8 loaders).
    const bails = (src.match(/activeIdRef\.current !== id/g) || []).length;
    expect(bails).toBeGreaterThanOrEqual(8);
  });
});

describe('CaseDetail — action/reinvestigate/export error routing (#9)', () => {
  it('mutations use a toast, so the case-load banner is not mislabelled', () => {
    expect(src).toContain('The action could not be completed.');
    // The reinvestigation's own failures are the Reinvestigate dialog's (Round 16, WP01).
    expect(reinvestigateSrc).toContain('The reinvestigation could not be started.');
    expect(src).toContain('<ReinvestigateDialog');
    expect(src).toContain('The export could not be generated.');
    // `setError(e)` is now ONLY the case-load failure surface (loadCase); the banner
    // title "Could not load case" is therefore always accurate.
    expect((src.match(/setError\(e\)/g) || []).length).toBe(1);
    expect(src).toContain('Could not load case');
  });
});
