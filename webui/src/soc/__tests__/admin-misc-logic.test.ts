/**
 * Round-6 admin-misc batch — regression specs for the pure logic fixes.
 *
 *  - Roles `draftFromRow`           — data-loss guard (edit/clone must not blank a role).
 *  - NotificationBell `severityDot` — severity dot uses the SEVERITY axis, not brand/status.
 *  - Knowledge `computeImportCanSubmit` — enable guard matches what submit() indexes.
 *  (Memory's `mergePendingTag` flush was retired in the Round 12 polish: a submit with
 *  pending tag text now stops and asks, see TagInput.pending.test.tsx.)
 */
import { describe, it, expect } from 'vitest';

import { draftFromRow } from '../pages/Roles';
import { severityDot } from '../components/NotificationBell';
import { computeImportCanSubmit } from '../pages/Knowledge';

describe('Roles draftFromRow — RBAC data-loss guard', () => {
  const matrix = {
    tier1_plus: { cases: ['read', 'write'], sources: ['read'] },
  };

  it('uses the full cached custom definition when it is present', () => {
    const row = {
      name: 'tier1_plus',
      builtin: false,
      description: 'desc',
      resourceCount: 2,
      custom: {
        name: 'tier1_plus',
        description: 'desc',
        inherits: ['analyst_tier1'],
        grants: { cases: ['close'] },
        denies: { sources: ['manage'] },
      },
    };
    const d = draftFromRow(row, matrix);
    expect(d.grants).toEqual({ cases: ['close'] });
    expect(d.denies).toEqual({ sources: ['manage'] });
    expect(d.inherits).toEqual(['analyst_tier1']);
    expect(d.description).toBe('desc');
  });

  it('seeds grants from the resolved matrix when the raw definition is absent (never blank)', () => {
    // The bug: a fresh page load has no cached `custom`, so the old code seeded an
    // empty draft and a save wiped the role. Now grants come from matrix[name].
    const row = {
      name: 'tier1_plus',
      builtin: false,
      description: '',
      resourceCount: 2,
      custom: undefined,
    };
    const d = draftFromRow(row, matrix);
    expect(d.grants).toEqual({ cases: ['read', 'write'], sources: ['read'] });
    expect(Object.keys(d.grants).length).toBeGreaterThan(0);
    expect(d.name).toBe('tier1_plus');
  });

  it('returns a deep copy so editing the draft never mutates the source matrix', () => {
    const row = {
      name: 'tier1_plus',
      builtin: false,
      description: '',
      resourceCount: 2,
      custom: undefined,
    };
    const d = draftFromRow(row, matrix);
    d.grants.cases.push('close');
    expect(matrix.tier1_plus.cases).toEqual(['read', 'write']);
  });
});

describe('NotificationBell severityDot — SEVERITY axis tokens', () => {
  it('maps each severity to its severity token (not the status/brand axis)', () => {
    expect(severityDot('critical')).toBe('bg-critical');
    expect(severityDot('high')).toBe('bg-high'); // was bg-warning (status axis)
    expect(severityDot('medium')).toBe('bg-medium'); // was bg-primary (blue → read as low)
    expect(severityDot('low')).toBe('bg-low'); // was unhandled → grey
    expect(severityDot('info')).toBe('bg-info');
  });

  it('is case-insensitive and falls back to neutral for unknown/empty', () => {
    expect(severityDot('HIGH')).toBe('bg-high');
    expect(severityDot('bogus')).toBe('bg-muted-foreground/50');
    expect(severityDot('')).toBe('bg-muted-foreground/50');
    expect(severityDot(null)).toBe('bg-muted-foreground/50');
    expect(severityDot(undefined)).toBe('bg-muted-foreground/50');
  });
});

describe('Knowledge computeImportCanSubmit — enable guard matches submit()', () => {
  it('gates on queueValid while files are queued (blocks an oversized queued file)', () => {
    expect(
      computeImportCanSubmit({ batching: true, queueValid: true, hasPasted: true, tooBig: false, submitting: false }),
    ).toBe(true);
    // oversized queued file → queueValid false → disabled even though pasted text is small
    expect(
      computeImportCanSubmit({ batching: true, queueValid: false, hasPasted: true, tooBig: false, submitting: false }),
    ).toBe(false);
  });

  it('gates on pasted text when not batching (a valid batch is not blocked by oversized paste)', () => {
    expect(
      computeImportCanSubmit({ batching: false, queueValid: false, hasPasted: true, tooBig: false, submitting: false }),
    ).toBe(true);
    expect(
      computeImportCanSubmit({ batching: false, queueValid: true, hasPasted: true, tooBig: true, submitting: false }),
    ).toBe(false);
    expect(
      computeImportCanSubmit({ batching: false, queueValid: false, hasPasted: false, tooBig: false, submitting: false }),
    ).toBe(false);
  });

  it('is always false while submitting', () => {
    expect(
      computeImportCanSubmit({ batching: true, queueValid: true, hasPasted: true, tooBig: false, submitting: true }),
    ).toBe(false);
  });
});

