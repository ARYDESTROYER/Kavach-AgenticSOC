/**
 * Agent effectiveness folds the operational supporting rows with its other details
 * (Round 14, audit finding AN9).
 *
 * While the headline is still collecting evidence, the page opens on the headline and the
 * operational outcomes strip; "What supports these movements", "Evidence by system layer"
 * and the trend check fold into the one Show details disclosure with the comparisons,
 * evidence quality and the daily evidence. Once the headline can speak, nothing folds.
 *
 * Fully offline: the data call and Agent health are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAgentImprovement: vi.fn(),
    diagnosticsHealth: vi.fn(),
    autoCloseHealth: vi.fn(),
  },
}));

vi.mock('@/soc/components/HealthDiagnostics', () => ({
  HealthDiagnostics: () => <section data-testid="analytics-health-diagnostics" />,
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: apiMock };
});

import type { AgentImprovementEvidence } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { AgentEffectivenessPage } from '../AgentEffectiveness';
import { resetAnalyticsWindow } from '../analytics-shared';
import { evidence as outcomeEvidence } from '@/soc/components/__tests__/agent-outcome-fixtures';

const DEFINITION = {
  formula: 'aggregate formula',
  numerator: 'eligible outcomes',
  denominator: 'eligible cases',
  eligibility: 'complete UTC days',
  caveats: 'Observed outcomes only.',
};

function metric(label: string, unit: 'ratio' | 'minutes', good: 'up' | 'down') {
  const side = { value: null, available: false, status: 'insufficient_evidence', reason: 'Too few grades.', sample_count: 4, minimum_sample: 20 };
  return { label, unit, good_direction: good, current: side, baseline: side, delta: {}, direction: 'insufficient_evidence', definition: DEFINITION };
}

/** The page's evidence: a still-collecting headline, with the operational outcomes. */
function pageEvidence(state: AgentImprovementEvidence['headline']['state']): AgentImprovementEvidence {
  const operational = outcomeEvidence();
  return {
    ...operational,
    generated_at: '2026-07-28T00:00:00Z',
    synthetic: false,
    headline: {
      state,
      reason: 'Complete comparable cohorts are required before declaring improvement.',
      improving_signals: 0,
      regressing_signals: 0,
      guardrails_ready: false,
      comparable_mix_coverage: 0,
      minimum_comparable_mix_coverage: 0.8,
      composite_score: null,
      signal_domains: { analyst_grade_quality: state, human_review_turnaround: state },
    },
    metrics: {
      analyst_reported_verdict_agreement: metric('Analyst-reported verdict agreement', 'ratio', 'up'),
      material_analyst_correction_rate: metric('Material analyst correction rate', 'ratio', 'down'),
      human_review_turnaround: metric('Human review turnaround', 'minutes', 'down'),
    },
    guardrails: {
      confirmed_false_negative_rate: {
        status: 'insufficient_evidence', minimum_sample: 20,
        current: { value: null, confirmed_positive_count: 0, missed_positive_count: 0 },
        baseline: { value: null, confirmed_positive_count: 0, missed_positive_count: 0 },
        material_increase_threshold: 0.01, breached: null,
        definition: 'Missed confirmed positives divided by confirmed positives.',
      },
      reopen_after_agent_close_rate: {
        status: 'insufficient_evidence', minimum_sample: 20,
        current: { candidate_agent_terminal_decisions: 0, eligible_agent_terminal_decisions: 0, right_censored_decisions: 0, human_reopens: 0, rate: null, follow_up_hours: 24 },
        baseline: { candidate_agent_terminal_decisions: 0, eligible_agent_terminal_decisions: 0, right_censored_decisions: 0, human_reopens: 0, rate: null, follow_up_hours: 24 },
        material_increase_threshold: 0.02, breached: null,
        caveat: 'Only complete 24-hour follow-up windows are eligible.',
      },
    },
    case_mix: {
      dimensions: ['source', 'severity'], minimum_per_stratum: 5,
      baseline_total: 0, current_total: 0, baseline_covered: 0, current_covered: 0,
      comparable_mix_coverage: 0, baseline_mix_coverage: 0, current_mix_coverage: 0,
      comparable_strata: 0, baseline_only_strata: 0, current_only_strata: 0,
      suppressed_strata: 0, adjusted_baseline_agreement: null,
      adjusted_current_agreement: null, adjusted_baseline_correction_rate: null,
      adjusted_current_correction_rate: null,
    },
    daily_points: [],
    exclusions: {},
    provenance: { truncated: false, store_total: 0, fetched: 0, aggregate_only: true, case_ids_included: false, billing: 'none', decision_authority: 'reporting_only' },
  } as unknown as AgentImprovementEvidence;
}

function renderPage() {
  return render(
    <TooltipProvider>
      <AgentEffectivenessPage />
    </TooltipProvider>,
  );
}

const SUPPORTING = ['What supports these movements', 'Evidence by system layer', 'Trend check'];

beforeEach(() => {
  apiMock.getAgentImprovement.mockReset();
});

afterEach(() => {
  cleanup();
  resetAnalyticsWindow();
});

describe('Agent effectiveness: the operational rows fold with the other details', () => {
  it('opens on the strip and folds the supporting rows while the headline is collecting', async () => {
    apiMock.getAgentImprovement.mockResolvedValue(pageEvidence('insufficient_evidence'));
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Show details' });
    const panel = screen.getByRole('region', { name: 'Operational outcomes' });
    // The headline comparisons and the period switch stay on the page.
    expect(within(panel).getByTestId('operational-outcomes-strip')).toBeVisible();
    expect(within(panel).getByRole('radiogroup', { name: 'Outcome trend period' })).toBeInTheDocument();
    for (const name of SUPPORTING) expect(screen.queryByRole('heading', { name })).toBeNull();

    // The one disclosure names both folded areas, and says what it holds.
    const controlled = (toggle.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
    expect(controlled).toHaveLength(2);
    for (const id of controlled) expect(document.getElementById(id)).toHaveAttribute('hidden');
    expect(within(panel).getByTestId('operational-outcomes-details').id).toBe(controlled[1]);
    // Every strip comparison of the fixture has a sufficient sample: the sentence must not
    // call the operational evidence still collecting, and says the rows fold all the same.
    const disclosure = screen.getByTestId('agent-effectiveness-details-toggle');
    expect(disclosure).toHaveTextContent(
      'Outcome comparisons, safety guardrails, evidence quality and the daily evidence are still collecting the minimum samples. The rows behind the operational outcomes are folded with them.',
    );
    expect(disclosure).not.toHaveTextContent('the evidence behind the operational outcomes');
    // Everything the button controls comes after it in the document (reading and focus
    // order), so showing it only adds content below the focused button.
    for (const id of controlled) {
      expect(toggle.compareDocumentPosition(document.getElementById(id)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(disclosure.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(toggle);
    const hide = screen.getByRole('button', { name: 'Hide details' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide).toHaveFocus();
    // Tab from the button reaches the revealed rows before anything after them.
    const revealed = within(panel).getByRole('heading', { level: 3, name: 'What supports these movements' });
    expect(hide.compareDocumentPosition(revealed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const id of controlled) expect(document.getElementById(id)).not.toHaveAttribute('hidden');
    for (const name of SUPPORTING) {
      expect(within(panel).getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    for (const name of SUPPORTING) expect(screen.queryByRole('heading', { name })).toBeNull();
  });

  it('names the operational evidence as collecting only while a strip comparison is', async () => {
    const page = pageEvidence('insufficient_evidence');
    // The default (week over week) strip has one comparison still collecting.
    const week = page.period_comparisons!.week_over_week.outcomes;
    week.observed_time_saved.status = 'insufficient_evidence';
    week.observed_time_saved.reason = 'requires at least 10 human-owned and 10 agent closures';
    apiMock.getAgentImprovement.mockResolvedValue(page);
    renderPage();
    await screen.findByRole('button', { name: 'Show details' });
    const disclosure = screen.getByTestId('agent-effectiveness-details-toggle');
    expect(disclosure).toHaveTextContent(
      'Outcome comparisons, the evidence behind the operational outcomes, safety guardrails, evidence quality and the daily evidence are still collecting the minimum samples. Show them to see what each one is waiting for.',
    );
    expect(disclosure).not.toHaveTextContent('folded with them');

    // The rolling 28 days strip has every comparison on a sufficient sample: the sentence
    // follows the period the panel shows.
    await userEvent.click(screen.getByRole('radio', { name: 'Rolling 28 days' }));
    expect(disclosure).not.toHaveTextContent('the evidence behind the operational outcomes');
    expect(disclosure).toHaveTextContent('The rows behind the operational outcomes are folded with them.');
  });

  it('folds nothing once the headline can speak', async () => {
    apiMock.getAgentImprovement.mockResolvedValue(pageEvidence('stable'));
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Operational outcomes' });
    expect(screen.queryByRole('button', { name: 'Show details' })).toBeNull();
    for (const name of SUPPORTING) {
      expect(within(panel).getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    expect(within(panel).getByTestId('operational-outcomes-details')).not.toHaveAttribute('hidden');
  });

  it('keeps one operational outcomes panel, titled once, with no nested panel', async () => {
    apiMock.getAgentImprovement.mockResolvedValue(pageEvidence('stable'));
    renderPage();
    await screen.findByRole('region', { name: 'Operational outcomes' });
    expect(screen.getAllByRole('heading', { name: 'Operational outcomes' })).toHaveLength(1);
    expect(screen.getAllByTestId('agent-operational-outcomes')).toHaveLength(1);
  });
});
