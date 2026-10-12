/**
 * Rules-FE adapter spec (Round-5 G6 · R2/R3).
 *
 * The adapter is the ONLY place the UI `RuleForm` is reshaped into the existing wire
 * keys (`RuleDefinition`/`CorrelationRule`/`RuleMatch`, `AutomationRule`,
 * `BaselineConfig`). Proving the mapping is deterministic + lossless-on-round-trip is
 * how we keep `case_manager.decide()` byte-identical (#3): the editor only ever emits
 * these exact wire shapes.
 */
import { describe, it, expect } from 'vitest';

import {
  anomalyToBaseline,
  baselineToAnomaly,
  caseAutomationToWire,
  detectionMatchToWire,
  modeForN,
  wireToCaseAutomation,
  wireToDetectionMatch,
} from '../adapter';
import { newRuleForm } from '../constants';
import type { RuleForm } from '../types';

describe('modeForN (correlation mode derivation)', () => {
  it('n=1 → every, n>1 → threshold, explicit never preserved', () => {
    expect(modeForN(1)).toBe('every');
    expect(modeForN(5)).toBe('threshold');
    expect(modeForN(9, 'never')).toBe('never');
  });
});

describe('detectionMatchToWire — form → RuleDefinition', () => {
  const base = () => {
    const f = newRuleForm('detection_match') as Extract<RuleForm, { tier: 'detection_match' }>;
    f.about.name = 'ssh-bruteforce';
    f.about.description = 'many failed logins';
    f.predicates = [{ field: 'rule.id', op: 'equals', value: '5710' }];
    f.threshold = { groupBy: 'ip', n: 5, windowSeconds: 120, mode: 'threshold' };
    return f;
  };

  it('maps the FIRST predicate to the single wire `match` + threshold to `correlation`', () => {
    const wire = detectionMatchToWire(base());
    expect(wire).not.toBeNull();
    expect(wire!.name).toBe('ssh-bruteforce');
    expect(wire!.match).toEqual({ field: 'rule.id', op: 'equals', value: '5710' });
    expect(wire!.correlation).toEqual({
      mode: 'threshold',
      n: 5,
      window_seconds: 120,
      group_by: 'ip',
    });
    expect(wire!.enabled).toBe(true);
    expect(wire!.priority).toBe(100);
  });

  it('an `exists` op emits a null value on the wire', () => {
    const f = base();
    f.predicates = [{ field: 'rule.tags', op: 'exists', value: 'ignored' }];
    const wire = detectionMatchToWire(f);
    expect(wire!.match).toEqual({ field: 'rule.tags', op: 'exists', value: null });
  });

  it('n=1 derives correlation mode `every` (a simple match rule)', () => {
    const f = base();
    f.threshold = { groupBy: 'user', n: 1, windowSeconds: 60, mode: 'every' };
    const wire = detectionMatchToWire(f);
    expect(wire!.correlation!.mode).toBe('every');
    expect(wire!.correlation!.n).toBe(1);
  });

  it('refuses to emit an unnamed or predicate-less rule (returns null)', () => {
    const f = base();
    f.about.name = '   ';
    expect(detectionMatchToWire(f)).toBeNull();

    const g = base();
    g.predicates = [{ field: '', op: 'equals', value: 'x' }];
    expect(detectionMatchToWire(g)).toBeNull();
  });

  it('round-trips wire → form → wire losslessly for the fields the wire carries', () => {
    const wire = detectionMatchToWire(base())!;
    const form = wireToDetectionMatch(wire);
    const again = detectionMatchToWire(form)!;
    expect(again.name).toBe(wire.name);
    expect(again.match).toEqual(wire.match);
    expect(again.correlation).toEqual(wire.correlation);
    expect(again.enabled).toBe(wire.enabled);
    expect(again.priority).toBe(wire.priority);
  });

  it('round-trips hidden compatibility metadata without advertising it as executable', () => {
    const original = {
      ...detectionMatchToWire(base())!,
      mitre: ['T1110', 'T1078'],
      schedule: { interval_seconds: 300, lookback_seconds: 45 },
      suppression: {
        by: ['source.ip', 'user.name'],
        scope: 'per_window' as const,
        window_seconds: 600,
        missing_field: 'keep' as const,
      },
    };

    const form = wireToDetectionMatch(original);
    expect(form.about.mitre).toEqual(original.mitre);
    expect(form.schedule).toEqual({ intervalSeconds: 300, lookbackSeconds: 45 });
    expect(form.suppression).toEqual({
      by: ['source.ip', 'user.name'],
      scope: 'per_window',
      windowSeconds: 600,
      missingField: 'keep',
    });

    const again = detectionMatchToWire(form)!;
    expect(again.mitre).toEqual(original.mitre);
    expect(again.schedule).toEqual(original.schedule);
    expect(again.suppression).toEqual(original.suppression);
  });
});

describe('caseAutomationToWire — form → AutomationRule', () => {
  it('maps conditions/action/payload + About id/priority/enabled', () => {
    const f = newRuleForm('case_automation') as Extract<RuleForm, { tier: 'case_automation' }>;
    f.about.enabled = true;
    f.about.priority = 50;
    f.automation = {
      conditions: { verdict: 'true_positive', min_risk: 70 },
      action: 'tag',
      payload: { tags: ['watchlist'] },
    };
    const wire = caseAutomationToWire(f, 'rule-abc');
    expect(wire).toEqual({
      id: 'rule-abc',
      enabled: true,
      priority: 50,
      conditions: { verdict: 'true_positive', min_risk: 70 },
      action: 'tag',
      payload: { tags: ['watchlist'] },
    });
  });

  it('shows a single API-written `tag` in the Tags list the editor edits, and saves it as `tags`', () => {
    // The engine applies `tags`, else the single `tag`/`value` (engine/case_tags.py
    // automation_tags). The editor edits `tags` only, so a single tag must show there
    // rather than as an empty field that hides what the rule applies.
    const form = wireToCaseAutomation({
      id: 'legacy-tag',
      action: 'tag',
      conditions: {},
      payload: { tag: ' auto-triaged ' },
    });
    expect(form.automation.payload).toEqual({ tags: ['auto-triaged'] });
    expect(caseAutomationToWire(form, 'legacy-tag').payload).toEqual({ tags: ['auto-triaged'] });
    // A listed `tags` wins and is left as is; other actions are untouched.
    expect(
      wireToCaseAutomation({ id: 'x', action: 'tag', payload: { tags: ['a'], tag: 'b' } }).automation.payload,
    ).toEqual({ tags: ['a'], tag: 'b' });
    expect(
      wireToCaseAutomation({ id: 'y', action: 'notify', payload: { value: 'v' } }).automation.payload,
    ).toEqual({ value: 'v' });
  });

  it('round-trips wire → form → wire (id preserved via the caller)', () => {
    const original = {
      id: 'rule-1',
      enabled: false,
      priority: 100,
      conditions: { status: 'escalated' },
      action: 'notify' as const,
      payload: { channel_id: 'slack' },
    };
    const form = wireToCaseAutomation(original);
    const again = caseAutomationToWire(form, original.id);
    expect(again).toEqual(original);
  });
});

describe('anomaly <-> baseline', () => {
  it('writes only the owned baseline fields and preserves the rest (deep-merge friendly)', () => {
    const f = newRuleForm('detection_anomaly') as Extract<RuleForm, { tier: 'detection_anomaly' }>;
    f.about.enabled = true;
    f.anomaly = { groupBy: 'ip', sensitivity: 4.2, warmupMultiplier: 2, seasonality: 'hour_of_day' };
    const next = anomalyToBaseline(f, { half_life_days: 7, tdigest_compression: 100 });
    expect(next.enabled).toBe(true);
    expect(next.modified_z_threshold).toBe(4.2);
    expect(next.warmup_multiplier).toBe(2);
    expect(next.seasonality).toBe('hour_of_day');
    // untouched sibling fields survive
    expect(next.half_life_days).toBe(7);
    expect(next.tdigest_compression).toBe(100);
  });

  it('seeds a form from an existing baseline block', () => {
    const form = baselineToAnomaly({
      enabled: true,
      modified_z_threshold: 3.0,
      warmup_multiplier: 4,
      seasonality: 'day_of_week',
    });
    expect(form.tier).toBe('detection_anomaly');
    expect(form.about.enabled).toBe(true);
    expect(form.anomaly.sensitivity).toBe(3.0);
    expect(form.anomaly.warmupMultiplier).toBe(4);
    expect(form.anomaly.seasonality).toBe('day_of_week');
  });
});
