/**
 * posture.format — deltaView interpretation (Round-6 sign-flip fix).
 *
 * The KpiTile redesign (bug #2) made the delta ARROW follow the SIGN of `value` and the
 * COLOR follow the separate `goodDirection` prop. deltaView must therefore return the
 * TRUE signed change (no pre-flip), so a rising metric yields a positive value + "+N%"
 * label and a falling metric a negative value + "-N%" label — the arrow can no longer
 * contradict its own label.
 */
import { describe, it, expect } from 'vitest';

import {
  deltaView,
  kpiLabel,
  LIFECYCLE_METRICS,
  type LifecycleMetricKey,
} from '../posture.format';
import type { CompareBlock } from '../Metrics.posture.api';

const block = (delta_pct: CompareBlock['delta_pct']): CompareBlock => ({
  value: 1,
  prev: 1,
  delta_pct,
});

describe('deltaView', () => {
  it('returns the TRUE signed value for a rise (positive) — arrow matches label', () => {
    const dv = deltaView(block(20));
    expect(dv.value).toBe(20);
    expect(dv.label).toBe('+20%');
    expect(dv.show).toBe(true);
  });

  it('returns the TRUE signed value for a fall (negative) — arrow matches label', () => {
    const dv = deltaView(block(-10));
    expect(dv.value).toBe(-10);
    expect(dv.label).toBe('-10%');
    expect(dv.show).toBe(true);
  });

  it('does NOT flip the sign for lower-is-better metrics (goodDirection now owns color)', () => {
    // A falling FP-rate used to return value:+10 (flipped) with a "-10%" label; now the
    // value tracks the label sign so the arrow points down for a real drop.
    const dv = deltaView(block(-10));
    expect(Math.sign(dv.value ?? 0)).toBe(Math.sign(-10));
  });

  it('hides a zero delta', () => {
    expect(deltaView(block(0)).show).toBe(false);
  });

  it('marks a "new" (prior-zero) growth as shown but with NO numeric value (no arrow)', () => {
    const dv = deltaView(block(null));
    expect(dv.label).toBe('new');
    expect(dv.show).toBe(true);
    expect(dv.value).toBeUndefined();
  });

  it('draws no badge when there is no comparison', () => {
    expect(deltaView(undefined).show).toBe(false);
    expect(deltaView(block('—')).show).toBe(false);
  });
});

describe('LIFECYCLE_METRICS (honest MTTA / MTTR / Dwell copy)', () => {
  const KEYS: LifecycleMetricKey[] = ['mtta', 'mttr', 'dwell'];

  it('exposes exactly the three lifecycle keys', () => {
    expect(Object.keys(LIFECYCLE_METRICS).sort()).toEqual([...KEYS].sort());
  });

  it('every entry has a non-empty label, sub and help', () => {
    for (const key of KEYS) {
      const c = LIFECYCLE_METRICS[key];
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.sub.length).toBeGreaterThan(0);
      expect(c.help.length).toBeGreaterThan(0);
    }
  });

  it('uses the honest acronym labels + plain-English subs', () => {
    expect(LIFECYCLE_METRICS.mtta.label).toBe('MTTA');
    expect(LIFECYCLE_METRICS.mttr.label).toBe('MTTR');
    expect(LIFECYCLE_METRICS.dwell.label).toBe('Dwell');
    expect(LIFECYCLE_METRICS.mtta.sub).toBe('Time to acknowledge');
    expect(LIFECYCLE_METRICS.mttr.sub).toBe('Time to resolve');
    expect(LIFECYCLE_METRICS.dwell.sub).toBe('Time to first response');
  });

  it('never labels dwell as the dishonest "MTTD" (DECISIONS #2)', () => {
    // No label may claim mean-time-to-detect; dwell must read as first-response, and
    // its help disambiguates from detection latency explicitly.
    for (const key of KEYS) {
      expect(LIFECYCLE_METRICS[key].label).not.toBe('MTTD');
    }
    // Round 16 rewrote the help in plain words (a person's first response; automatic
    // closes not counted), so the phrases are unhyphenated; the claim is the same.
    expect(LIFECYCLE_METRICS.dwell.help.toLowerCase()).toContain('time to first response');
    expect(LIFECYCLE_METRICS.dwell.help.toLowerCase()).toContain('not time to detect');
    expect(LIFECYCLE_METRICS.dwell.help.toLowerCase()).toContain('by a person');
  });

  it('help copy is grounded in the real lifecycle intervals', () => {
    expect(LIFECYCLE_METRICS.mtta.help.toLowerCase()).toContain('acknowledgement');
    expect(LIFECYCLE_METRICS.mttr.help.toLowerCase()).toContain('terminal');
    expect(LIFECYCLE_METRICS.dwell.help.toLowerCase()).toContain('response');
  });

  it('kpiLabel returns the short label for each key', () => {
    expect(kpiLabel('mtta')).toBe('MTTA');
    expect(kpiLabel('mttr')).toBe('MTTR');
    expect(kpiLabel('dwell')).toBe('Dwell');
    for (const key of KEYS) {
      expect(kpiLabel(key)).toBe(LIFECYCLE_METRICS[key].label);
    }
  });
});
