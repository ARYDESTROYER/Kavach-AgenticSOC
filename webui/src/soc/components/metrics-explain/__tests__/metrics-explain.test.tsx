/**
 * Round 16 WP12: dashboard figures explained.
 *
 * The builders print the real counts and the server's figures exactly; the timing
 * explanation reads the cases behind a median once, lists them in a sheet with the
 * median rows marked, and says so when a list cannot check the figure (truncated,
 * hidden by scope, withheld, or a figure that moved). The KPI tile explain slot wraps
 * only a tile that is not itself a button. Hostile case values render literally (#9).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DASH } from '@/lib/format';
import type { MetricExplainResponse } from '@/lib/types-metrics-explain';
import type { StatBlock } from '@/soc/pages/Metrics.posture.api';

const { explainMock } = vi.hoisted(() => ({ explainMock: vi.fn() }));
vi.mock('@/lib/api-metrics-explain', () => ({ getMetricExplain: explainMock }));

import { KpiTile } from '@/soc/components/KpiTile';
import { agreementContext, metricsReadAt, operationalMttr } from '@/soc/pages/Metrics';
import type { Metrics } from '@/lib/types';

import {
  deciderSteps,
  nounFor,
  rankLineOverRun,
  explainAgreement,
  explainAlertReduction,
  explainCount,
  explainKpiShare,
  explainTiming,
  linkFromHash,
  TIMING_DEFINITIONS,
  TIMING_FORMULA,
} from '../builders';
import { medianRanks } from '../SamplesSheet';
import { TimingExplain } from '../TimingExplain';

const BLOCK: StatBlock = { p50: 20, p90: 52.7, mean: 26.5, max: 62, count: 4, available: true, reason: '' };

function response(overrides: Partial<MetricExplainResponse> = {}): MetricExplainResponse {
  return {
    metric: 'mttr',
    kind: 'timing',
    unit: 'minutes',
    window_hours: 24,
    window: 'the last 24 hours',
    generated_at: '2026-11-25T12:00:00Z',
    population: 'Cases created in the last 24 hours that are resolved or closed now.',
    population_size: 6,
    headline: 'p50',
    value: 20,
    available: true,
    reason: '',
    stat: BLOCK,
    sample_count: 4,
    visible_count: 4,
    hidden_by_scope: 0,
    samples: [4, 9, 31, 62].map((m, i) => ({
      case_id: `c${i}`,
      case_number: i === 2 ? '<img src=x onerror=alert(1)>' : `CASE-${i}`,
      status: 'closed',
      value: m,
      minutes: m,
      start_at: '2026-11-25T10:00:00Z',
      end_at: '2026-11-25T11:00:00Z',
      start_anchor: 'created_at',
      anchor: 'status_history',
      decided_by: i % 2 ? 'analyst' : 'agent',
    })),
    samples_offset: 0,
    samples_truncated: false,
    samples_order: 'minutes_ascending',
    samples_withheld: '',
    truncated: false,
    store_total: 6,
    fetched: 6,
    by_decider: {
      agent: { p50: 17.5, p90: 29.3, mean: 17.5, max: 31, count: 2, available: true, reason: '' },
      analyst: { p50: 35.5, p90: 56.7, mean: 35.5, max: 62, count: 2, available: true, reason: '' },
    },
    ...overrides,
  };
}

describe('metric explanation builders', () => {
  it('prints a share with the real counts and who divided it', () => {
    const e = explainKpiShare({
      metric: 'fp_rate',
      title: 'FP rate',
      numerator: 312,
      denominator: 1204,
      numeratorLabel: 'false positive verdicts',
      denominatorLabel: 'verdicted cases',
      window: 'the last 7 days',
      dividedBy: 'console',
    })!;
    expect(e.summary).toBe('312 false positive verdicts of 1,204 verdicted cases = 25.9%, the last 7 days.');
    expect(e.steps.map((s) => `${s.expression} = ${s.result}`)).toEqual(['312 / 1,204 = 0.2591', '0.2591 x 100 = 25.9%']);
    expect(e.provenanceNote).toMatch(/^The Console divided two counts/);
    expect(explainKpiShare({ ...base(), numerator: 0, denominator: 0 })!.summary).toMatch(/no share/);
  });

  it('prints a count with its window and the Alert reduction arithmetic', () => {
    const c = explainCount({ metric: 'case_count', title: 'Total cases', value: 1204, noun: 'cases', window: 'the last 24 hours', summary: 's', formula: 'f' })!;
    expect(c.display).toBe('1,204');
    expect(c.inputs.map((i) => i.value)).toEqual(['1,204', 'the last 24 hours']);
    expect(explainCount({ metric: 'x', title: 'x', value: undefined, noun: 'x', window: 'w', summary: 's', formula: 'f' })).toBeNull();
    const r = explainAlertReduction(48210, 312, 'the last 24 hours')!;
    expect(r.summary).toBe('1 - 312 cases / 48,210 alerts = 99.4%, the last 24 hours.');
    expect(explainAlertReduction(10, 20, 'w')).toBeNull();
  });

  it('explains a median with p50, p90, mean, the count and who closed the cases', () => {
    const e = explainTiming({
      metric: 'mttr',
      title: 'Time to resolve',
      block: BLOCK,
      window: 'the last 24 hours',
      definition: TIMING_DEFINITIONS.mttr,
      samples: [4, 9, 31, 62],
      byDecider: response().by_decider,
    })!;
    expect(e.summary).toBe('Median (p50) 20m over 4 cases in the last 24 hours; p90 53m, mean 27m.');
    expect(e.steps[0]).toMatchObject({ label: 'p50', result: '20 minutes' });
    expect(e.steps[0].expression).toContain('9 + 0.5 x (31 - 9)');
    expect(e.steps.slice(-2).map((s) => `${s.label}: ${s.expression}, ${s.result}`)).toEqual([
      'Closed by the AI agent: 2 cases, median 18m',
      'Closed by a person: 2 cases, median 36m',
    ]);
    expect(e.caveats.join(' ')).toMatch(/last decider/);
    // The formula is arithmetic; the clock's definition is prose and sits with the provenance.
    expect(e.formula).toBe(TIMING_FORMULA);
    expect(e.provenanceNote).toBe(`${TIMING_DEFINITIONS.mttr} Computed by the server from each case's own timestamps.`);
    const unmeasured = explainTiming({ metric: 'mtta', title: 'MTTA', block: { ...BLOCK, available: false, p50: DASH, count: 0, reason: 'no case has been acknowledged yet' }, window: 'w', definition: 'd' })!;
    expect(unmeasured.summary).toBe('MTTA is not measured for w: no case has been acknowledged yet.');
  });

  it('names the agreement population and says no rate when nothing was graded (D10)', () => {
    const e = explainAgreement({ agreement_rate: 0.5, agreement_signals: 3, agreement_agreed: 1, agreement_partial: 1, agreement_disagreed: 1, graded_cases: 1 }, 'all time')!;
    expect(e.summary).toBe('(1 agreed + 0.5 x 1 partial) / 3 grade entries = 50%, all time.');
    expect(e.caveats[0]).toMatch(/Partial counts as half/);
    const none = explainAgreement({ agreement_rate: null, agreement_signals: 0 }, 'all time')!;
    expect(none.display).toBe('Not measured');
    expect(agreementContext({ graded_cases: 2, agreement_signals: 3 } as unknown as Metrics['feedback'], 'all time')).toBe('3 assessed grades, all time');
  });

  it('reads the Analytics MTTR as the lifecycle median, keeping the mean for an older server', () => {
    const modern = operationalMttr({ mttr_minutes: 50, resolved_count: 4, mttr_lifecycle: BLOCK } as unknown as Metrics);
    expect(modern.value).toBe('20m');
    expect(modern.help).toMatch(/^Median \(p50\)/);
    const legacy = operationalMttr({ mttr_minutes: 50, resolved_count: 4 } as unknown as Metrics);
    expect(legacy.value).toBe('50m');
    expect(legacy.help).toMatch(/^Mean time/);
  });

  it('turns a Console hash into a link and lists decider steps only for groups with cases', () => {
    expect(linkFromHash('Open', '#/cases?status=open&window=24')).toEqual({ label: 'Open', route: 'cases', params: { status: 'open', window: '24' } });
    expect(deciderSteps(undefined)).toEqual([]);
    expect(medianRanks(4)).toEqual([1, 2]);
    expect(medianRanks(5)).toEqual([2]);
  });
});

/*
 * WP12 review: more than 200 samples list only the run around the median, so the rank
 * lines must read the ranks of ALL the samples (from `samples_offset`). Reading the
 * ranks inside the listed run printed a median and a p90 that differ from the figure.
 */
describe('timing rank lines over a truncated list', () => {
  // 251 samples of 1..251 minutes: p50 is rank 125 (126 minutes), p90 rank 225 (226).
  const all = Array.from({ length: 251 }, (_, i) => i + 1);
  const big: StatBlock = { p50: 126, p90: 226, mean: 126, max: 251, count: 251, available: true, reason: '' };
  // The server lists 200 rows starting at rank 26 (`_select_rows`).
  const offset = 26;
  const listed = all.slice(offset, offset + 200);

  it('prints the median of all the samples, not of the listed run', () => {
    const e = explainTiming({
      metric: 'mttr', title: 'MTTR', block: big, window: 'w', definition: 'd',
      samples: listed, sampleCount: 251, samplesOffset: offset,
    })!;
    const p50 = e.steps.find((step) => step.label === 'p50')!;
    expect(p50.expression).toBe('rank 0.5 x (251 - 1) = 125, the value at that rank');
    expect(p50.result).toBe('126 minutes');
    const p90 = e.steps.find((step) => step.label === 'p90')!;
    expect(p90.expression).toBe('rank 0.9 x (251 - 1) = 225, the value at that rank');
    expect(p90.result).toBe('226 minutes');
    expect(e.caveats[0]).toBe('The list holds ranks 27 to 226 of 251, the cases around the median.');
  });

  it('leaves out a percentile whose ranks are not listed, and says so', () => {
    const n = 401;
    const run = Array.from({ length: 200 }, (_, i) => 101 + i + 1);
    const e = explainTiming({
      metric: 'mtta', title: 'MTTA', block: { ...big, count: n, p50: 201 }, window: 'w', definition: 'd',
      samples: run, sampleCount: n, samplesOffset: 101,
    })!;
    expect(e.steps.map((step) => step.label)).toEqual(['p50']);
    expect(e.steps[0].result).toBe('201 minutes');
    expect(e.caveats).toContain('The p90 ranks fall outside the listed cases, so its line is not shown.');
    expect(rankLineOverRun('p50', 0.5, run, 300, n)).toBeNull();
  });

  it('names where an all-time window comes from', () => {
    const e = explainTiming({
      metric: 'mttr', title: 'MTTR', block: BLOCK, window: 'all time', definition: 'd',
      windowSource: 'Every case analysed, whatever the time range above',
    })!;
    expect(e.inputs.find((input) => input.key === 'window')).toMatchObject({
      value: 'all time',
      source: 'Every case analysed, whatever the time range above',
    });
  });
});

/*
 * WP12 review (WP06 carry-forward): the Analytics "Updated" stamp says when the server
 * read the all-time cases, not when the page settled, so a served 60 s copy never reads
 * "just now".
 */
describe('Analytics read time', () => {
  it('uses the server read time when it is older than now', () => {
    const now = Date.parse('2026-11-25T12:01:00Z');
    expect(metricsReadAt({ generated_at: '2026-11-25T12:00:00Z' }, now)).toBe('2026-11-25T12:00:00.000Z');
    // An older server sends no stamp, and a stamp from the future (clock skew) is not
    // trusted: the settle time stands in.
    expect(metricsReadAt({}, now)).toBe('2026-11-25T12:01:00.000Z');
    expect(metricsReadAt({ generated_at: '2026-11-25T12:05:00Z' }, now)).toBe('2026-11-25T12:01:00.000Z');
    expect(metricsReadAt({ generated_at: 'garbage' }, now)).toBe('2026-11-25T12:01:00.000Z');
  });
});

/* WP12 review: a count of one takes the singular noun. */
describe('share wording for a count of one', () => {
  it('says "1 false positive verdict of 1 verdicted case"', () => {
    const e = explainKpiShare({ ...base(), numerator: 1, denominator: 1, numeratorLabel: 'false positive verdicts', denominatorLabel: 'verdicted cases', window: 'the last 24 hours' })!;
    expect(e.summary).toBe('1 false positive verdict of 1 verdicted case = 100%, the last 24 hours.');
    expect(nounFor(1, 'open cases whose AI verdict is Needs human')).toBe('open case whose AI verdict is Needs human');
    expect(nounFor(1, 'agent-worked closes')).toBe('agent-worked close');
    expect(nounFor(2, 'verdicted cases')).toBe('verdicted cases');
    expect(nounFor(1, 'closed by the AI agent')).toBe('closed by the AI agent');
  });
});

function base() {
  return {
    metric: 'm',
    title: 't',
    numerator: 1,
    denominator: 2,
    numeratorLabel: 'a',
    denominatorLabel: 'b',
    window: 'w',
    dividedBy: 'server' as const,
  };
}

describe('TimingExplain', () => {
  beforeEach(() => {
    explainMock.mockClear();
  });

  function mount(props: Partial<React.ComponentProps<typeof TimingExplain>> = {}) {
    return render(
      <TimingExplain metric="mttr" title="Time to resolve" block={BLOCK} windowHours={24} window="the last 24 hours" {...props}>
        20m
      </TimingExplain>,
    );
  }

  it('reads the cases once, adds the rank arithmetic and lists them with the median marked', async () => {
    explainMock.mockResolvedValue(response());
    const user = userEvent.setup();
    mount();
    const trigger = screen.getByRole('button', { name: /^20m ?, explain$/ });
    await user.click(trigger);
    const panel = await screen.findByTestId('explain-panel');
    expect(explainMock).toHaveBeenCalledWith('mttr', 24, expect.any(AbortSignal));
    await waitFor(() => expect(within(panel).getByTestId('explain-steps')).toHaveTextContent('9 + 0.5 x (31 - 9)'));
    await user.click(within(panel).getByRole('button', { name: 'Show all 4' }));
    const sheet = await screen.findByTestId('metric-samples-sheet');
    const rows = within(sheet).getAllByTestId('metric-sample-row');
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.hasAttribute('data-median'))).toHaveLength(2);
    // A hostile case number is a text node, never markup (#9).
    expect(within(sheet).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(within(rows[0]).getByText('4m (4 minutes)')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Longest first' }));
    expect(within(within(sheet).getAllByTestId('metric-sample-row')[0]).getByText('1h 2m (62 minutes)')).toBeInTheDocument();
    expect(explainMock).toHaveBeenCalledTimes(1);
  });

  it('says when the listed cases cannot check the figure', async () => {
    explainMock.mockResolvedValue(
      response({ hidden_by_scope: 1, visible_count: 3, samples_truncated: true, truncated: true, fetched: 5, store_total: 9, samples: response().samples.slice(0, 3) }),
    );
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /^20m ?, explain$/ }));
    const panel = await screen.findByTestId('explain-panel');
    await user.click(await within(panel).findByRole('button', { name: 'Show 3 of 3' }));
    const notes = await screen.findByTestId('metric-samples-notes');
    expect(notes).toHaveTextContent('1 of 4 cases are outside your data scope');
    expect(notes).toHaveTextContent('computed over the newest 5 of 9 cases');
  });

  it('withholds the rows without cases:read and notices a figure that moved', async () => {
    explainMock.mockResolvedValueOnce(response({ samples: [], samples_withheld: 'The cases behind this figure need the cases:read permission.' }));
    const user = userEvent.setup();
    const view = mount();
    await user.click(screen.getByRole('button', { name: /^20m ?, explain$/ }));
    expect(await screen.findByText('The cases behind this figure need the cases:read permission.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Show/ })).toBeNull();
    view.unmount();

    explainMock.mockResolvedValueOnce(response({ stat: { ...BLOCK, count: 5 } }));
    mount();
    await user.click(screen.getByRole('button', { name: /^20m ?, explain$/ }));
    expect(await screen.findByText('The figure changed since it was shown. Refresh to list its cases.')).toBeInTheDocument();
  });

  it('prints the rank lines of all the samples when only the run around the median is listed', async () => {
    const minutes = Array.from({ length: 200 }, (_, i) => 27 + i);
    explainMock.mockResolvedValue(
      response({
        stat: { p50: 126, p90: 226, mean: 126, max: 251, count: 251, available: true, reason: '' },
        sample_count: 251,
        visible_count: 251,
        samples_offset: 26,
        samples_truncated: true,
        samples: minutes.map((m, i) => ({ ...response().samples[0], case_id: `t${i}`, case_number: `CASE-T${i}`, value: m, minutes: m })),
      }),
    );
    const user = userEvent.setup();
    render(
      <TimingExplain metric="mttr" title="MTTR" block={{ p50: 126, p90: 226, mean: 126, max: 251, count: 251, available: true, reason: '' }} windowHours={24} window="the last 24 hours">
        2h 6m
      </TimingExplain>,
    );
    await user.click(screen.getByRole('button', { name: /^2h 6m ?, explain$/ }));
    const panel = await screen.findByTestId('explain-panel');
    await waitFor(() => expect(within(panel).getByTestId('explain-steps')).toHaveTextContent('rank 0.5 x (251 - 1) = 125'));
    expect(within(panel).getByTestId('explain-steps')).not.toHaveTextContent('(200 - 1)');
    await user.click(within(panel).getByRole('button', { name: 'Show 200 of 251' }));
    const sheet = await screen.findByTestId('metric-samples-sheet');
    // The sheet is wide enough on a desktop for every column (Decided by was clipped).
    expect(sheet.closest('[role="dialog"]')?.className).toContain('lg:max-w-5xl');
    const median = within(sheet).getAllByTestId('metric-sample-row').filter((r) => r.hasAttribute('data-median'));
    expect(median).toHaveLength(1);
    expect(median[0]).toHaveTextContent('126');
  });

  it('says so when the cases could not be read', async () => {
    explainMock.mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('The store could not be read')), 0)),
    );
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: /^20m ?, explain$/ }));
    expect(await screen.findByText('The cases behind this figure could not be read.')).toBeInTheDocument();
  });
});

describe('KpiTile explain slot', () => {
  it('wraps the numeral of a plain tile and leaves a button tile alone', () => {
    const wrap = (n: React.ReactNode) => <span data-testid="wrapped">{n}</span>;
    const { rerender } = render(<KpiTile label="MTTR" value="20m" explain={wrap} testId="mttr" />);
    expect(screen.getByTestId('wrapped')).toHaveTextContent('20m');
    rerender(<KpiTile label="MTTR" value="20m" explain={wrap} onClick={() => undefined} testId="mttr" />);
    expect(screen.queryByTestId('wrapped')).toBeNull();
  });
});
