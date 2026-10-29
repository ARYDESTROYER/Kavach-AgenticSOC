import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/ui/tooltip';
import {
  AgentOperationalOutcomes,
  SourceCoverageGuidance,
  TuningOutcomeContext,
  asSentence,
  outcomeWindowCaption,
  type AgentImprovementEvidenceWithOutcomes,
  type OutcomePeriod,
} from '../AgentOperationalOutcomes';
import { evidence, outcomes } from './agent-outcome-fixtures';

expect.extend(toHaveNoViolations);

function renderOutcome(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('AgentOperationalOutcomes', () => {
  it('renders exact backend outcome fields and the true period-comparison contract', async () => {
    const view = renderOutcome(<AgentOperationalOutcomes evidence={evidence()} />);

    const panel = screen.getByRole('region', { name: 'Operational outcomes' });
    expect(screen.getByRole('heading', { level: 2, name: 'Operational outcomes' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Outcome trend period' })).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed-positive case share').length).toBeGreaterThan(0);
    expect(screen.getByText('Observed elapsed-time difference')).toBeInTheDocument();
    expect(screen.getByText('Alerts after clustering / day')).toBeInTheDocument();
    expect(screen.getByText('AI processing cost / case')).toBeInTheDocument();

    const timeMetric = screen.getByTestId('comparison-outcome-observed_time_saved');
    expect(timeMetric).toHaveTextContent('11 min faster / case');
    expect(timeMetric).toHaveTextContent('48 eligible closures');
    const costMetric = screen.getByTestId('comparison-outcome-recorded_case_cost');
    expect(costMetric).toHaveTextContent('$0.610');
    expect(costMetric).toHaveTextContent('40 costed cases');
    const volumeMetric = screen.getByTestId('comparison-outcome-alert_volume');
    expect(volumeMetric).toHaveTextContent('91 / day');
    expect(
      screen.getAllByText(/no defensible alert-level outcome lineage/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/not measured labor/).length).toBeGreaterThan(0);
    expect(screen.getByText('7,763 · 92.4%')).toBeInTheDocument();
    expect(screen.getByText(/Model spend only; no labor cost is inferred/)).toBeInTheDocument();
    expect(screen.getByText(/does not prove causation/)).toBeInTheDocument();
    expect(screen.getByText(/No composite score or causal claim/)).toBeInTheDocument();
    // The caption names the window; the line under it gives the days, without repeating it.
    expect(within(panel).getByText('last 7 complete UTC days against the 7 before')).toBeInTheDocument();
    expect(screen.getByTestId('operational-outcomes-windows').textContent).toBe(
      'Current Jul 21 to 27, 2026; prior Jul 14 to 20, 2026',
    );

    const agreement = screen.getByRole('listitem', {
      name: 'Analyst-reported agreement period trend',
    });
    expect(agreement).toHaveTextContent('84.0%');
    fireEvent.click(screen.getByRole('radio', { name: 'Rolling 28 days' }));
    expect(agreement).toHaveTextContent('88.0%');
    expect(timeMetric).toHaveTextContent('23 min faster / case');
    expect(costMetric).toHaveTextContent('$0.730');
    expect(volumeMetric).toHaveTextContent('72 / day');
    // Days in words, inclusive, with the exclusive end already subtracted; the caption
    // follows the period switch.
    expect(within(panel).getByText('last 28 complete UTC days against the 28 before')).toBeInTheDocument();
    expect(within(panel).queryByText('last 7 complete UTC days against the 7 before')).toBeNull();
    expect(screen.getByTestId('operational-outcomes-windows').textContent).toBe(
      'Current Jun 30 to Jul 27, 2026; prior Jun 2 to 29, 2026',
    );
    // The trend check keeps the full line.
    expect(screen.getByText('Current Jun 30 to Jul 27, 2026; prior Jun 2 to 29, 2026; complete UTC days')).toBeInTheDocument();

    expect(screen.getByText('Evidence by system layer')).toBeInTheDocument();
    expect(screen.getByText('AI verdict quality')).toBeInTheDocument();
    expect(screen.getByText('Workflow speed')).toBeInTheDocument();
    expect(screen.getByText('Alert handling')).toBeInTheDocument();
    expect(screen.getByText(/Not measured as improvement: upstream alert generation/)).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('puts the period switch in the panel title row, beside the title', () => {
    renderOutcome(<AgentOperationalOutcomes evidence={evidence()} />);
    const titleRow = screen
      .getByRole('heading', { level: 2, name: 'Operational outcomes' })
      .closest('[data-panel-title-row]');
    expect(titleRow).not.toBeNull();
    expect(titleRow).toContainElement(screen.getByRole('radiogroup', { name: 'Outcome trend period' }));
  });

  it('shows the four headline comparisons as one strip on the panel, with no framed cells', () => {
    renderOutcome(<AgentOperationalOutcomes evidence={evidence()} />);
    const strip = screen.getByTestId('operational-outcomes-strip');
    const tiles = Array.from(strip.children);
    expect(tiles.map((tile) => tile.getAttribute('data-testid'))).toEqual([
      'comparison-outcome-confirmed_positive_case_rate',
      'comparison-outcome-observed_time_saved',
      'comparison-outcome-alert_volume',
      'comparison-outcome-recorded_case_cost',
    ]);
    // The strip grammar: rules only between tiles, no frame, no cell fill and no
    // hairline grid of 1px gaps over a border colour.
    expect(strip.closest('[data-kpi-grid-frame="panel"]')).not.toBeNull();
    for (const tile of tiles) {
      expect(tile.className).not.toMatch(/(^|\s)(bg-background|bg-card|rounded|shadow)/);
      expect(tile.className).not.toMatch(/(^|\s)border(\s|$)/);
    }
    expect(strip.className).not.toMatch(/gap-px|bg-border/);
    // One tile a row on a phone-width strip (each tile carries five to seven lines), two
    // from 28rem, four on a wide strip; the base two-column class is replaced, not added.
    expect(strip).toHaveClass('grid-cols-1', '@[28rem]:grid-cols-2', 'md:@[40rem]:grid-cols-4');
    expect(strip).not.toHaveClass('grid-cols-2');
    // Each tile spans two rows of the strip's grid (subgrid), so the figure blocks share one
    // height per strip row and the evidence lines under them start level.
    for (const tile of tiles) {
      expect(tile).toHaveClass('row-span-2', 'grid', 'grid-rows-subgrid');
      expect(tile.children).toHaveLength(2);
      expect(tile.children[1]).toHaveAttribute('data-outcome-tile-details');
    }
  });

  it('names a change that rounds to zero minutes in words', () => {
    const flat = evidence();
    flat.period_comparisons!.week_over_week.outcomes.observed_time_saved.delta.minutes_per_case = 0.02;
    renderOutcome(<AgentOperationalOutcomes evidence={flat} />);
    const tile = screen.getByTestId('comparison-outcome-observed_time_saved');
    expect(within(tile).getByRole('img', { name: 'No change' })).toHaveTextContent('No change');
    expect(tile).not.toHaveTextContent(/0\.0 min/);
  });

  it('can share its period with the host (controlled)', () => {
    const seen: string[] = [];
    function Host() {
      const [period, setPeriod] = React.useState<OutcomePeriod>('month_over_month');
      return (
        <AgentOperationalOutcomes
          evidence={evidence()}
          period={period}
          onPeriodChange={(next) => {
            seen.push(next);
            setPeriod(next);
          }}
        />
      );
    }
    renderOutcome(<Host />);
    expect(screen.getByRole('radio', { name: 'Rolling 28 days' })).toBeChecked();
    expect(screen.getByTestId('comparison-outcome-observed_time_saved')).toHaveTextContent('23 min faster / case');
    fireEvent.click(screen.getByRole('radio', { name: 'Week over week' }));
    expect(seen).toEqual(['week_over_week']);
    expect(screen.getByRole('radio', { name: 'Week over week' })).toBeChecked();
    expect(screen.getByTestId('comparison-outcome-observed_time_saved')).toHaveTextContent('11 min faster / case');
  });

  it('writes server reasons as whole sentences, never spliced fragments', () => {
    const collecting = evidence();
    const week = collecting.period_comparisons!.week_over_week.outcomes;
    week.observed_time_saved.status = 'insufficient_evidence';
    week.observed_time_saved.reason = 'requires at least 10 human-owned and 10 agent closures';
    week.observed_time_saved.current.observed_difference_minutes_per_case = 0;
    week.tuning_context.status = 'insufficient_evidence';
    week.tuning_context.reason = 'no threshold changes were recorded in either reporting window';
    week.tuning_context.current.applied_changes = 0;
    week.alert_volume.status = 'insufficient_evidence';
    week.alert_volume.reason = 'durable counters cover only part of the requested reporting windows';
    week.alert_volume.after_clustering_direction = 'insufficient_evidence';
    week.tuning_context.cooccurring_after_clustering_direction = 'insufficient_evidence';
    const view = renderOutcome(<AgentOperationalOutcomes evidence={collecting} />);
    const text = view.container.textContent ?? '';

    expect(text).not.toMatch(/observed No/);
    expect(text).not.toMatch(/insufficient evidence after-clustering/i);
    // No sentence starts lowercase, and none runs into the next without a full stop.
    expect(text).not.toMatch(/\. [a-z]/);
    expect(
      screen.getByText(/Agent-closed and human-owned cases showed no observed closure-time difference\. Requires at least 10 human-owned and 10 agent closures\. Closure cohorts are unmatched/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^No threshold changes were recorded in either reporting window\. After-clustering volume could not be compared\. Threshold tuning is downstream/),
    ).toBeInTheDocument();
    // The tile's own reason line reads as a sentence.
    expect(within(screen.getByTestId('comparison-outcome-observed_time_saved')).getByText(
      'Requires at least 10 human-owned and 10 agent closures.',
    )).toBeInTheDocument();
  });

  it('uses sentence case and proportional Inter figures: no capitals, no monospace', () => {
    const view = renderOutcome(<AgentOperationalOutcomes evidence={evidence()} />);
    expect(view.container.querySelector('.uppercase')).toBeNull();
    expect(view.container.querySelector('[class*="tracking-wider"]')).toBeNull();
    expect(view.container.querySelector('[class*="font-mono"]')).toBeNull();
    // No word typed in capitals (the old micro-labels read "CASE OUTCOMES").
    expect(view.container.textContent ?? '').not.toMatch(/\b[A-Z]{5,}\b/);
    // Figures set as tabular numerals.
    expect(screen.getByText('7,763 · 92.4%')).toHaveClass('tabular-nums');
    // Every section heading is sentence case, nested under the panel title.
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'What supports these movements',
      'Evidence by system layer',
      'Trend check',
    ]);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Case outcomes',
      'Closure timing',
      'Alert path',
      'AI processing cost',
      'AI verdict quality',
      'Workflow speed',
      'Alert handling',
    ]);
  });

  it('folds the supporting rows while the page holds them, and keeps the strip on view', async () => {
    const view = renderOutcome(
      <AgentOperationalOutcomes evidence={evidence()} detailsHidden detailsId="outcome-rows" />,
    );
    const rows = document.getElementById('outcome-rows');
    expect(rows).not.toBeNull();
    expect(rows).toHaveAttribute('hidden');
    // No display utility, so the attribute keeps it out of the layout.
    expect(rows!.className).not.toMatch(/(^|\s)(flex|grid|block)(\s|$)/);
    for (const name of ['What supports these movements', 'Evidence by system layer', 'Trend check']) {
      expect(screen.queryByRole('heading', { name })).toBeNull();
      expect(within(rows!).getByText(name)).toBeInTheDocument();
    }
    // The headline strip and the period switch stay.
    expect(screen.getByTestId('operational-outcomes-strip')).toBeVisible();
    expect(screen.getByRole('radiogroup', { name: 'Outcome trend period' })).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();

    view.rerender(
      <TooltipProvider>
        <AgentOperationalOutcomes evidence={evidence()} detailsHidden={false} detailsId="outcome-rows" />
      </TooltipProvider>,
    );
    expect(document.getElementById('outcome-rows')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('heading', { level: 3, name: 'Trend check' })).toBeInTheDocument();
  });

  it('keeps a missing human-owned closure benchmark unavailable instead of inventing zero', () => {
    const unavailable = evidence();
    const timing = unavailable.period_comparisons!.week_over_week.outcomes.observed_time_saved;
    timing.status = 'unavailable';
    timing.reason =
      'Manual benchmark unavailable — no eligible human-owned closed cases in this period.';
    timing.current.status = 'unavailable';
    timing.current.reason = timing.reason;
    timing.current.human_owned_closure_p50_minutes = null;
    timing.current.observed_difference_minutes_per_case = null;
    timing.current.estimated_total_minutes_saved = null;
    timing.current.human_owned_closure_count = 0;

    renderOutcome(<AgentOperationalOutcomes evidence={unavailable} />);

    const comparison = screen.getByTestId('comparison-outcome-observed_time_saved');
    const currentValue = screen.getByTestId('kpi-outcome-observed_time_saved-metric');
    expect(comparison).toHaveTextContent('Unavailable');
    expect(comparison).toHaveTextContent(/no eligible human-owned closed cases/);
    expect(currentValue).toHaveTextContent('—');
    expect(currentValue).not.toHaveTextContent('0 min');
  });

  it('does not relabel a slower agent-closed cohort as time avoided', () => {
    const slower = evidence();
    const timing = slower.period_comparisons!.week_over_week.outcomes.observed_time_saved;
    timing.current.observed_difference_minutes_per_case = -12;
    timing.current.observed_aggregate_elapsed_difference_minutes = -240;
    timing.current.estimated_total_minutes_saved = null;
    timing.delta.minutes_per_case = -4;

    renderOutcome(<AgentOperationalOutcomes evidence={slower} />);

    expect(screen.getByTestId('comparison-outcome-observed_time_saved')).toHaveTextContent(
      '12 min slower / case',
    );
    expect(screen.getByText('4h slower aggregate')).toBeInTheDocument();
    expect(screen.queryByText(/4h estimated avoided/)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /changed down by .*worse/ })).toBeInTheDocument();
  });

  it('omits the additive outcome surface for an older backend', () => {
    const older = { outcomes: undefined } as AgentImprovementEvidenceWithOutcomes;
    const view = renderOutcome(<AgentOperationalOutcomes evidence={older} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('renders a compact non-causal tuning context row', () => {
    renderOutcome(<TuningOutcomeContext outcomes={outcomes()} />);

    const section = screen.getByRole('region', {
      name: 'Downstream volume around threshold tuning',
    });
    expect(section).toHaveTextContent('1,200');
    expect(section).toHaveTextContent('140');
    expect(section).toHaveTextContent('2 applied');
    expect(section).toHaveTextContent(/not model fine-tuning/);
    expect(section).toHaveTextContent(/does not establish causation/);
  });

  it('qualifies unreadable tuning and volume evidence without favorable zeroes', () => {
    const unavailable = outcomes();
    unavailable.alert_volume.status = 'unavailable';
    unavailable.alert_volume.reason = 'Durable counters could not be read.';
    unavailable.tuning_context.status = 'unavailable';
    unavailable.tuning_context.reason = 'The threshold-tuning ledger could not be read.';

    renderOutcome(<TuningOutcomeContext outcomes={unavailable} />);

    const section = screen.getByRole('region', {
      name: 'Downstream volume around threshold tuning',
    });
    expect(section).toHaveTextContent('Unavailable');
    expect(section).toHaveTextContent('Durable counters could not be read.');
    expect(section).toHaveTextContent('threshold-tuning ledger could not be read');
    expect(section).not.toHaveTextContent('2 applied');
  });
});

describe('SourceCoverageGuidance', () => {
  it('labels absent source-gap evidence as a long-term objective, not a recommendation', () => {
    const view = renderOutcome(<SourceCoverageGuidance evidence={evidence()} />);

    // One panel, titled once: no inner heading repeating the panel title, no nested frame.
    const panel = screen.getByRole('region', { name: 'Evidence coverage' });
    expect(panel).toHaveAttribute('data-testid', 'agent-coverage-guidance');
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Evidence coverage']);
    expect(within(panel).getByText('suggestions, not diagnosis')).toBeInTheDocument();
    expect(view.container.querySelector('[class*="border-dashed"], [class*="border-y"]')).toBeNull();
    expect(screen.getByText('Long-term objective')).toBeInTheDocument();
    expect(screen.getByText(/Coverage recommendation unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/does not persist validated source-gap/)).toBeInTheDocument();
    expect(screen.getByText(/governed coverage model/)).toBeInTheDocument();
  });

  it('renders bounded future evidence-backed items as suggestions rather than diagnoses', () => {
    const ready = evidence();
    ready.outcomes!.source_guidance = {
      status: 'ready',
      reason: '',
      long_term_objective: true,
      required_evidence: 'Governed aggregate evidence.',
      items: [
        {
          id: 'dns-egress',
          telemetry_kind: 'outbound_dns',
          title: 'Add outbound DNS telemetry',
          rationale: 'Three aggregate triage gaps lacked destination-domain evidence.',
          affected_context: 'Rare beaconing alerts',
          evidence_gap_count: 3,
        },
      ],
    };

    renderOutcome(<SourceCoverageGuidance evidence={ready} />);

    expect(screen.getByText('Add outbound DNS telemetry')).toBeInTheDocument();
    // Said once, in the panel caption, for every item.
    expect(screen.getByText('suggestions, not diagnosis')).toBeInTheDocument();
    expect(screen.getByText('3 aggregate evidence gaps')).toBeInTheDocument();
  });
});

describe('outcome copy helpers', () => {
  it('turns a reason fragment into one sentence', () => {
    expect(asSentence('requires at least 10 closures')).toBe('Requires at least 10 closures.');
    expect(asSentence('  Already a sentence.  ')).toBe('Already a sentence.');
    expect(asSentence('Is it?')).toBe('Is it?');
    expect(asSentence('')).toBe('');
    expect(asSentence(undefined)).toBe('');
  });

  it('captions the window from the days it spans', () => {
    expect(
      outcomeWindowCaption(
        { start: '2026-07-21', end_exclusive: '2026-07-28' },
        { start: '2026-06-23', end_exclusive: '2026-07-21' },
      ),
    ).toBe('last 7 complete UTC days against the 28 before');
    expect(
      outcomeWindowCaption(
        { start: '2026-07-21', end_exclusive: '2026-07-28', days: 7 },
        { start: '2026-07-14', end_exclusive: '2026-07-21', days: 7 },
      ),
    ).toBe('last 7 complete UTC days against the 7 before');
    expect(
      outcomeWindowCaption({ start: 'bad', end_exclusive: 'bad' }, { start: 'bad', end_exclusive: 'bad' }),
    ).toBe('complete UTC days');
  });
});
