/**
 * The KPI binding honesty rules (Round 14, SPEC §4.4.3), one test per rule, plus the
 * shared Alert reduction rule: the board's strip cell and the Cyber Defence Center's
 * noise flow (`alertReductionOf`) call the same pure helper, so they cannot disagree.
 */
import { describe, it, expect } from 'vitest';

import { alertReduction } from '@/soc/components/alert-reduction';
import { alertReductionOf } from '@/soc/components/NoiseFunnel';
import { KPI_STRIP_BINDINGS, type KpiStripBinding } from '@/soc/dashboard/kpi-bindings';
import {
  bindingRequests,
  evaluateBinding,
  formatKpiValue,
  getPath,
  sentence,
  type KpiReader,
  type KpiSourceAnswer,
} from '@/soc/dashboard/widgets/kpi-eval';
import type { DashboardRequest } from '@/soc/dashboard/widgets/requests';

import { OPEN_BY_VERDICT, breakdown, group, noise, posture, sourcesHealth } from './dashboard-fixtures';

const NOW = Date.parse('2026-10-28T21:00:00Z');
const CTX = { windowHours: 24, nowMs: NOW };

function binding(groupName: string, cell: string): KpiStripBinding {
  const b = KPI_STRIP_BINDINGS.find((x) => x.group === groupName && x.cell === cell);
  if (!b) throw new Error(`no binding ${groupName}.${cell}`);
  return b;
}

/** A reader that answers by provider key (and by `kind:by` for breakdowns). */
function reader(answers: Record<string, unknown>, state: Partial<KpiSourceAnswer> = {}): KpiReader {
  return (req: DashboardRequest) => {
    const q = req.query as { kind?: string; by?: string } | undefined;
    const id = req.key === 'breakdown' ? `breakdown:${q?.kind ?? 'cases'}:${q?.by}` : req.key;
    return { loading: false, error: null, data: id in answers ? answers[id] : null, ...state };
  };
}

describe('rule 1: not measured, never 0', () => {
  it('a dash string is Not measured with the source reason, not a number', () => {
    const r = evaluateBinding(binding('executive', 'mttd_p50'), reader({
      posture: posture({
        lifecycle: { mttd_minutes: { p50: '\u2014', available: true, reason: 'no case has a first event time' } },
      }),
    }), CTX);
    expect(r.status).toBe('not_measured');
    expect(r.value).toBeNull();
    expect(r.text).toBe('');
    expect(r.reason).toBe('No case has a first event time.');
  });

  it('availableField false is Not measured even when a number is present', () => {
    // No SLA policy: the server reports 0 breached, which is not a measurement.
    const shift = { sla_aging: { enabled: false, totals: { breached: 0, open: 4 } } };
    const r = evaluateBinding(binding('operations', 'sla_breached'), reader({ shift }), CTX);
    expect(r.status).toBe('not_measured');
    expect(r.reason).toBe('No SLA policy is turned on.');
  });

  it('a missing field is Not measured with the cell default reason', () => {
    const r = evaluateBinding(binding('detection', 'events_per_minute'), reader({
      noise: noise({ events_per_min: null, events_per_min_reason: 'the counters started recently' }),
    }), CTX);
    expect(r.status).toBe('not_measured');
    // The server's own reason, made a sentence.
    expect(r.reason).toBe('The counters started recently.');
  });

  it('a measured zero stays a zero', () => {
    const r = evaluateBinding(binding('operations', 'new_cases'), reader({ posture: posture({ case_count: 0 }) }), CTX);
    expect(r).toMatchObject({ status: 'value', value: 0, text: '0', qualifier: null });
  });
});

describe('rule 2: partial flags', () => {
  it('a count reads at least N with the flag reason', () => {
    const r = evaluateBinding(binding('operations', 'new_cases'), reader({
      posture: posture({ window_covered: false, window_coverage_reason: 'the case scan stopped at 5,000 rows' }),
    }), CTX);
    expect(r).toMatchObject({ status: 'value', value: 38, qualifier: 'at least' });
    expect(r.reason).toBe('The case scan stopped at 5,000 rows.');
  });

  it('a non-count figure reads about N', () => {
    const r = evaluateBinding(binding('executive', 'mttr_p50'), reader({
      posture: posture({ window_covered: false, window_coverage_reason: '' }),
    }), CTX);
    expect(r.status).toBe('value');
    expect(r.qualifier).toBe('about');
    expect(r.reason).toBe('Part of the window could not be read.');
  });

  it('alert counters covering part of the window say so', () => {
    const r = evaluateBinding(binding('detection', 'alerts_ingested'), reader({
      noise: noise({ counters: { available: true, incomplete: true } as never }),
    }), CTX);
    expect(r).toMatchObject({ value: 1670, qualifier: 'at least', reason: 'The alert counters cover only part of this window.' });
  });

  it('the open stock is a lower bound when the fetch was incomplete', () => {
    const r = evaluateBinding(binding('operations', 'open_now'), reader({
      posture: posture({ open_now: { count: 120, complete: false, reason: 'only the newest 5,000 cases were read' } }),
    }), CTX);
    expect(r).toMatchObject({ value: 120, qualifier: 'at least', reason: 'Only the newest 5,000 cases were read.' });
  });
});

describe('rule 3: shares only when numeric', () => {
  const b = binding('executive', 'closed_by_agent');
  it('shows the share when it is a finite number', () => {
    const r = evaluateBinding(b, reader({ autoClose: { current: { available: true, auto_closed: 31, rate: 0.82, decided: 38 } } }), CTX);
    expect(r).toMatchObject({ status: 'value', value: 31, share: 0.82 });
  });
  it('leaves the share out when the server sends its dash', () => {
    const r = evaluateBinding(b, reader({ autoClose: { current: { available: true, auto_closed: 31, rate: '\u2014' } } }), CTX);
    expect(r.share).toBeNull();
    expect(r.value).toBe(31);
  });
  it('is Not measured when too few cases were decided', () => {
    const r = evaluateBinding(b, reader({ autoClose: { current: { available: false, auto_closed: 0, reason: 'too few decided cases' } } }), CTX);
    expect(r.status).toBe('not_measured');
    expect(r.reason).toBe('Too few decided cases.');
  });
});

describe('rule 4: breakdowns', () => {
  const awaiting = binding('operations', 'awaiting_decision');

  it('F4: Awaiting a decision counts open cases by AI verdict, group Needs human', () => {
    const [req] = bindingRequests(awaiting);
    expect(req).toEqual({ key: 'breakdown', window: 'all', query: { by: 'verdict', status_group: 'open' } });
    const r = evaluateBinding(awaiting, reader({ 'breakdown:cases:verdict': OPEN_BY_VERDICT }), CTX);
    expect(r).toMatchObject({ status: 'value', value: 13, text: '13', qualifier: null });
  });

  it('an absent group is 0 only when nothing was cut', () => {
    const none = breakdown({ by: 'verdict', groups: [group('FALSE_POSITIVE', 4)] });
    expect(evaluateBinding(awaiting, reader({ 'breakdown:cases:verdict': none }), CTX)).toMatchObject({ value: 0, status: 'value' });
    const cut = breakdown({ by: 'verdict', groups: [group('FALSE_POSITIVE', 4)], other: { count: 3, groups: 1, calls: null, cost_usd: null } });
    const r = evaluateBinding(awaiting, reader({ 'breakdown:cases:verdict': cut }), CTX);
    expect(r.status).toBe('not_measured');
    expect(r.reason).toMatch(/cut from the answer/);
  });

  it('a partial breakdown is a lower bound with its reason', () => {
    const partial = breakdown({ by: 'verdict', partial: true, partial_reason: 'one shard did not answer', groups: [group('NEEDS_HUMAN', 7)] });
    expect(evaluateBinding(awaiting, reader({ 'breakdown:cases:verdict': partial }), CTX)).toMatchObject({
      value: 7,
      qualifier: 'at least',
      reason: 'One shard did not answer.',
    });
  });

  it('the unassigned group is the null key', () => {
    const b = breakdown({ by: 'assignee', groups: [group('alice', 3), group(null, 5)] });
    expect(evaluateBinding(binding('operations', 'unassigned'), reader({ 'breakdown:cases:assignee': b }), CTX).value).toBe(5);
  });

  it('a sum over every group is a lower bound while other.count is above 0', () => {
    const sum = binding('executive', 'confirmed_threats');
    const exact = breakdown({ by: 'severity', groups: [group('high', 4, { analyst_tp: 2 }), group('low', 9, { analyst_tp: 1 })] });
    expect(evaluateBinding(sum, reader({ 'breakdown:cases:severity': exact }), CTX)).toMatchObject({ value: 3, qualifier: null });
    const cut = breakdown({ ...exact, groups: exact.groups, other: { count: 6, groups: 2, calls: null, cost_usd: null } });
    expect(evaluateBinding(sum, reader({ 'breakdown:cases:severity': cut }), CTX)).toMatchObject({ value: 3, qualifier: 'at least' });
  });

  it('a ratio shows only when both sums are exact and the denominator is above 0', () => {
    const ratio = binding('cost_budget', 'spend_per_case');
    const spend = breakdown({
      kind: 'usage',
      by: 'surface',
      groups: [
        group('investigate', 0, { cost_usd: 3, calls: 9 }),
        group('chat', 0, { cost_usd: 50, calls: 4 }),
      ],
    });
    const cases = breakdown({ by: 'severity', groups: [group('high', 4, { verdicted: 4 }), group('low', 2, { verdicted: 2 })] });
    const ok = evaluateBinding(ratio, reader({ 'breakdown:usage:surface': spend, 'breakdown:cases:severity': cases }), CTX);
    // Chat spend is left out: $3 over 6 investigated cases.
    expect(ok).toMatchObject({ status: 'value', value: 0.5 });
    const none = breakdown({ by: 'severity', groups: [] });
    expect(evaluateBinding(ratio, reader({ 'breakdown:usage:surface': spend, 'breakdown:cases:severity': none }), CTX)).toMatchObject({
      status: 'not_measured',
      reason: 'No case was investigated in the window.',
    });
    const partial = breakdown({ ...cases, groups: cases.groups, partial: true, partial_reason: 'the scan stopped early' });
    expect(evaluateBinding(ratio, reader({ 'breakdown:usage:surface': spend, 'breakdown:cases:severity': partial }), CTX).status).toBe(
      'not_measured',
    );
  });
});

describe('rule 5: the shared Alert reduction rule', () => {
  const cell = binding('detection', 'alert_reduction');
  const cases: Array<[string, ReturnType<typeof noise>]> = [
    ['measured', noise()],
    ['tiny', noise({ stages: noise().stages.map((s) => (s.key === 'cases' ? { ...s, total: 1 } : s.key === 'ingested' ? { ...s, total: 1000 } : s)) })],
    ['counters warming up', noise({ counters: { available: false, incomplete: false } as never })],
    ['partial coverage', noise({ counters: { available: true, incomplete: true } as never })],
    ['truncated cases', noise({ cases_meta: { truncated: true, store_total: 9000, fetched: 5000 } as never })],
    ['nothing ingested', noise({ stages: noise().stages.map((s) => (s.key === 'ingested' ? { ...s, total: 0 } : s)) })],
    ['more cases than alerts', noise({ stages: noise().stages.map((s) => (s.key === 'cases' ? { ...s, total: 5000 } : s)) })],
  ];

  it.each(cases)('the strip cell and the noise flow agree (%s)', (_name, data) => {
    const shared = alertReduction(data);
    expect(alertReductionOf(data)).toEqual(shared);
    const r = evaluateBinding(cell, reader({ noise: data }), CTX);
    if (shared.value == null) {
      expect(r.status).toBe('not_measured');
      expect(r.reason).toBe(sentence(shared.reason ?? ''));
    } else {
      expect(r.status).toBe('value');
      expect(r.text).toBe(shared.text);
      expect(r.value).toBe(shared.value);
    }
  });

  it('reads 1 - cases / ingested, never the overall reduction', () => {
    const r = alertReduction(noise());
    // 56 cases from 1,670 alerts: 96.6%, rounded to a whole percent; overall_pct (94.6) is a different figure.
    expect(r.value).toBeCloseTo((1 - 56 / 1670) * 100, 5);
    expect(r.text).toBe('97%');
  });

  it('a real but tiny reduction never reads 0%', () => {
    const data = noise({ stages: noise().stages.map((s) => (s.key === 'cases' ? { ...s, total: 999 } : s.key === 'ingested' ? { ...s, total: 1000 } : s)) });
    expect(alertReduction(data).text).toBe('<1%');
  });

  it('withholds with a plain reason', () => {
    expect(alertReduction(null).reason).toBeTruthy();
    expect(alertReduction(noise({ counters: { available: false } as never })).reason).toBe('alert counters are still warming up');
    expect(alertReduction(noise({ counters: { available: true, incomplete: true } as never })).reason).toBe('partial coverage');
  });
});

describe('sources health counts', () => {
  it('counts enabled sources that reported inside the window, and the silent ones', () => {
    const data = sourcesHealth(NOW);
    expect(evaluateBinding(binding('detection', 'sources_reporting'), reader({ sourcesHealth: data }), CTX).value).toBe(1);
    expect(evaluateBinding(binding('detection', 'sources_reporting'), reader({ sourcesHealth: data }), { ...CTX, windowHours: 168 }).value).toBe(2);
    expect(evaluateBinding(binding('detection', 'silent_sources'), reader({ sourcesHealth: data }), CTX).value).toBe(1);
  });
});

describe('loading and failure', () => {
  const b = binding('operations', 'new_cases');
  it('waits while the first answer is loading', () => {
    expect(evaluateBinding(b, reader({}, { loading: true }), CTX).status).toBe('loading');
  });
  it('fails when the read failed with nothing held', () => {
    expect(evaluateBinding(b, reader({}, { error: new Error('503') }), CTX)).toMatchObject({
      status: 'error',
      reason: 'This figure could not be loaded.',
    });
  });
  it('still says it failed while the failed read is read again (until a read succeeds)', () => {
    // The provider keeps the last failure while it reads again, so the strip's failure
    // line and its Retry stay in place instead of turning back into a skeleton.
    expect(evaluateBinding(b, reader({}, { loading: true, error: new Error('503') }), CTX).status).toBe('error');
  });
});

describe('helpers', () => {
  it('getPath selects list items by a field', () => {
    expect(getPath(noise(), 'stages[key=cases].total')).toBe(56);
    expect(getPath(noise(), 'stages[key=missing].total')).toBeUndefined();
    expect(getPath(null, 'a.b')).toBeUndefined();
  });
  it('formats each kind of figure, a tiny share never as 0%', () => {
    expect(formatKpiValue(1234, 'count')).toBe('1,234');
    expect(formatKpiValue(0.04, 'percent')).toBe('<0.1%');
    expect(formatKpiValue(97.44, 'percent')).toBe('97.4%');
    expect(formatKpiValue(0.5, 'usd')).toMatch(/0\.50/);
  });
  it('every definition and label is plain sentence-case copy with no em dash', () => {
    for (const b of KPI_STRIP_BINDINGS) {
      for (const t of [b.label, b.definition]) {
        expect(t).not.toMatch(/[\u2013\u2014]/);
        expect(t.toLowerCase()).not.toContain('playbook');
      }
    }
  });
});
