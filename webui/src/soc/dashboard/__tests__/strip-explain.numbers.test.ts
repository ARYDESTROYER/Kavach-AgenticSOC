/**
 * Round 16 numbers review (numbers-without-explanation, explain-coverage-uneven): every
 * measured figure on the Executive summary and Detection and data health strips opens its
 * inputs, with the real counts, and a cell with no figure has no explanation.
 */
import { describe, expect, it } from 'vitest';

import type { DashboardReader } from '../DashboardDataProvider';
import { kpiStripCells, type KpiStripBinding } from '../kpi-bindings';
import type { KpiCellResult } from '../widgets/kpi-eval';
import { stripCellExplanation, type StripCellView } from '../widgets/strip';

const NOISE = {
  stages: [
    { key: 'ingested', total: 167 },
    { key: 'cases', total: 38 },
  ],
  counters: { available: true, incomplete: false },
};
const AUTO_CLOSE = { current: { auto_closed: 45, decided: 77, rate: 0.584, available: true } };

const read: DashboardReader = ((req: { key: string }) => {
  const data = req.key === 'noise' ? NOISE : req.key === 'autoClose' ? AUTO_CLOSE : {};
  return { loading: false, data, error: null };
}) as unknown as DashboardReader;

function cell(group: 'executive' | 'detection' | 'operations', id: string): KpiStripBinding {
  const binding = kpiStripCells(group).find((b) => b.cell === id);
  if (!binding) throw new Error(`no cell ${id}`);
  return binding;
}

function measured(value: number, text: string, extra: Partial<KpiCellResult> = {}): KpiCellResult {
  return { status: 'value', value, text, qualifier: null, reason: null, share: null, ...extra };
}

function view(binding: KpiStripBinding, result: KpiCellResult | null, gate: StripCellView['gate'] = 'ok'): StripCellView {
  return { binding, gate, result };
}

describe('strip cell explanations', () => {
  it('Closed by the AI agent divides by the decided cases', () => {
    const exp = stripCellExplanation(view(cell('executive', 'closed_by_agent'), measured(45, '45', { share: 0.584 })), read, 'last 7 days');
    expect(exp?.summary).toBe('45 closed by the AI agent of 77 decided cases = 58.4%, the last 7 days.');
  });

  it('Alert reduction prints 1 - cases / alerts with the counts', () => {
    const exp = stripCellExplanation(view(cell('detection', 'alert_reduction'), measured(77.2, '77%')), read, 'last 24 hours');
    expect(exp?.summary).toBe('1 - 38 cases / 167 alerts = 77.2%, the last 24 hours.');
  });

  it('a count names what it counts and its window', () => {
    const exp = stripCellExplanation(view(cell('executive', 'cases'), measured(38, '38')), read, 'last 7 days');
    expect(exp?.summary).toBe('38 cases, the last 7 days. Cases created in the window.');
    const sources = stripCellExplanation(view(cell('detection', 'sources_reporting'), measured(5, '5')), read, 'last 24 hours');
    expect(sources?.inputs[0]).toMatchObject({ label: 'Counted sources', value: '5' });
  });

  it('a count of sources or alerts never says it was counted over cases (review of XFNUM)', () => {
    for (const id of ['sources_reporting', 'alerts_ingested']) {
      const exp = stripCellExplanation(view(cell('detection', id), measured(5, '5')), read, 'last 24 hours');
      expect(exp?.provenanceNote, id).toBe('Counted by the server for this window.');
      expect(exp?.provenanceNote, id).not.toContain('cases');
    }
    // A count of cases keeps the case wording.
    const cases = stripCellExplanation(view(cell('executive', 'cases'), measured(38, '38')), read, 'last 7 days');
    expect(cases?.provenanceNote).toBe('Counted by the server over the cases in the window.');
  });

  it('a stock measured now is not limited by the time range', () => {
    const exp = stripCellExplanation(view(cell('detection', 'silent_sources'), measured(1, '1')), read, 'last 24 hours');
    expect(exp?.inputs.find((i) => i.key === 'window')).toMatchObject({ value: 'right now', source: 'Not limited by the time range above' });
    expect(exp?.provenanceNote).not.toContain('in the window');
  });

  it('SLA breached says which rule counts a case, a stock measured now', () => {
    const exp = stripCellExplanation(view(cell('operations', 'sla_breached'), measured(10, '10')), read, 'last 24 hours');
    expect(exp?.summary).toBe('10 cases, right now. Open cases past their response target.');
    expect(exp?.caveats.join(' ')).toContain('A case whose priority has no target is not counted.');
  });

  it('Events per minute names the server rule and prints no arithmetic it cannot reproduce', () => {
    const exp = stripCellExplanation(view(cell('detection', 'events_per_minute'), measured(1.23, '1.23')), read, 'last 24 hours');
    expect(exp?.summary).toContain('1.23 events per minute, the last 24 hours');
    expect(exp?.steps).toEqual([]);
  });

  it('a cell with no figure, an approximation or no access has no explanation', () => {
    const binding = cell('executive', 'cases');
    expect(stripCellExplanation(view(binding, null), read, 'last 7 days')).toBeNull();
    expect(stripCellExplanation(view(binding, { ...measured(0, ''), status: 'not_measured', value: null }), read, 'last 7 days')).toBeNull();
    expect(stripCellExplanation(view(binding, measured(38, '38'), 'denied'), read, 'last 7 days')).toBeNull();
    const rate = cell('detection', 'alert_reduction');
    expect(stripCellExplanation(view(rate, measured(77.2, '77%', { qualifier: 'about', reason: 'Part of the window was not counted.' })), read, 'last 24 hours')).toBeNull();
  });

  it('a lower-bound count explains what it counts and why it is a floor (FXD1 board-figures-unexplained)', () => {
    // The Detection strip's "at least 167" alerts: the counters missed part of the window.
    const reason = 'Alert counting started part way through this window.';
    const exp = stripCellExplanation(
      view(cell('detection', 'alerts_ingested'), measured(167, '167', { qualifier: 'at least', reason })),
      read,
      'last 24 hours',
    );
    expect(exp?.display).toBe('at least 167');
    expect(exp?.summary).toBe(`At least 167 alerts, the last 24 hours: a lower bound. ${reason}`);
    expect(exp?.inputs[0]).toMatchObject({ label: 'Counted alerts', value: '167' });
    // The reason is said once, in the summary; the caveat says what it means (review fix).
    expect(exp?.caveats).toEqual(['The true figure can be higher.']);
    expect([exp?.summary, ...(exp?.caveats ?? [])].join(' ').split(reason)).toHaveLength(2);
  });
});
