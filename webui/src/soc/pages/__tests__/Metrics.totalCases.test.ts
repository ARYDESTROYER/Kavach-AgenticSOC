/**
 * Metrics — the "Total cases (all time)" sub-line (Round 12 review).
 *
 * `counts_exact` goes false when ANY breakdown (status × verdict, or disposition) could not
 * be counted, while `total_cases` is still the store's exact COUNT. The bound must follow
 * the total itself: an exact 15 is never "a lower bound counted from 10".
 */
import { describe, expect, it } from 'vitest';

import { populationCaption, statusSplit, totalCasesSub } from '../Metrics';
import type { Metrics } from '@/lib/types';

const base = (patch: Partial<Metrics>): Metrics =>
  ({ total_cases: 15, ...patch }) as unknown as Metrics;

describe('totalCasesSub', () => {
  it('calls an exact total exact when only the disposition breakdown is partial', () => {
    // The backend probe's own shape: disposition scan failed, store not truncated.
    expect(
      totalCasesSub(
        base({
          counts_exact: false,
          counts_note: 'the case counts by disposition could not be read',
          store_total: 15,
          fetched: 10,
          truncated: true,
        }),
      ),
    ).toBe('Exact · disposition breakdown partial');
  });

  it('never calls an untruncated store a lower bound ("newest 82 of 82")', () => {
    expect(
      totalCasesSub(
        base({
          total_cases: 82,
          counts_exact: false,
          counts_note: 'the case counts by status and verdict are incomplete',
          store_total: 82,
          fetched: 82,
          truncated: false,
        }),
      ),
    ).toBe('Exact · status and verdict breakdowns partial');
  });

  it('names both partial breakdowns when both failed', () => {
    expect(
      totalCasesSub(
        base({
          counts_exact: false,
          counts_note:
            'the case counts by status and verdict could not be read; the case counts by disposition could not be read',
          store_total: 15,
        }),
      ),
    ).toBe('Exact · status, verdict and disposition breakdowns partial');
  });

  it('is a lower bound only when the total is below the store count', () => {
    expect(
      totalCasesSub(base({ total_cases: 10, counts_exact: false, store_total: 15, fetched: 10, truncated: true })),
    ).toBe('Lower bound · counted from the newest 10 of 15');
  });

  it('is a lower bound when, without a store count, the total is exactly the truncated read', () => {
    expect(
      totalCasesSub(base({ total_cases: 10, counts_exact: false, fetched: 10, truncated: true })),
    ).toBe('Lower bound · not every case could be counted');
  });

  it('keeps the plain wording for a fully exact payload and says nothing for an older server', () => {
    expect(totalCasesSub(base({ counts_exact: true, store_total: 15 }))).toBe('Every case in the store');
    expect(totalCasesSub(base({}))).toBeUndefined();
  });
});

describe('statusSplit (Round 14, §4.9.4: resolved or closed against active)', () => {
  it('splits the server status breakdown into terminal and active', () => {
    expect(
      statusSplit(base({ by_status: { new: 1, investigating: 2, resolved: 2, closed: 3 } })),
    ).toEqual({ terminal: 5, active: 3 });
  });

  it('matches status names case-insensitively and ignores unusable counts', () => {
    expect(
      statusSplit(
        base({ by_status: { Closed: 4, NEW: 1, broken: Number.NaN, negative: -2 } as unknown as Record<string, number> }),
      ),
    ).toEqual({ terminal: 4, active: 1 });
  });

  it('is null when the server reported no breakdown, never total minus a count', () => {
    expect(statusSplit(base({ by_status: {} }))).toBeNull();
    expect(statusSplit(base({}))).toBeNull();
  });
});

describe('populationCaption', () => {
  it('says "all time" when every case was analysed', () => {
    expect(populationCaption(base({ truncated: false, fetched: 15, store_total: 15 }))).toBe('all time');
    expect(populationCaption(base({}))).toBe('all time');
  });

  it('names the newest cases analysed out of a truncated read', () => {
    expect(populationCaption(base({ truncated: true, fetched: 5000, store_total: 12000 }))).toBe(
      'newest 5,000 of 12,000 cases',
    );
    expect(populationCaption(base({ truncated: true, fetched: 5000 }))).toBe('newest 5,000 cases');
  });
});
