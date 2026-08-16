/**
 * NoiseFunnel contract tests.
 *
 * Simple is the polished, direct-labelled full flow: its first two mixed-unit conversions
 * are real filled ribbons with a disclosed compressed display scale, then case ribbons
 * conserve the backend's case-unit splits. Detailed is deliberately a compatibility view
 * of the exact Testing renderer: 640x220 stretched geometry, overlapping outcome fan,
 * loss annotations, and the complete evidence rail. Open cases stays separate lifecycle
 * context in Simple.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import { NoiseFunnel, deriveFunnel, ribbonPath } from '../NoiseFunnel';
import { NoiseLineageView } from '../NoiseLineage';
import type { NoiseLineage, NoiseReduction } from '@/lib/types';

expect.extend(toHaveNoViolations);

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function setReducedMotion(matches: boolean): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

function fixture(overrides: Partial<NoiseReduction> = {}): NoiseReduction {
  return {
    window_hours: 24,
    generated_at: '2026-07-05T00:00:00Z',
    bands: ['critical', 'high', 'medium', 'low', 'info'],
    stages: [
      {
        key: 'ingested',
        label: 'Ingested',
        source: 'counters',
        deterministic: true,
        total: 1000,
        by_severity: { critical: 50, high: 150, medium: 300, low: 400, info: 100 },
      },
      {
        key: 'clustered',
        label: 'Clustered',
        source: 'counters',
        deterministic: true,
        total: 220,
        by_severity: { critical: 40, high: 60, medium: 70, low: 40, info: 10 },
      },
      {
        key: 'cases',
        label: 'Cases opened',
        source: 'cases',
        deterministic: false,
        total: 40,
        by_severity: { critical: 8, high: 12, medium: 12, low: 6, info: 2 },
      },
      {
        key: 'auto_cleared',
        label: 'Auto-cleared',
        source: 'cases',
        deterministic: true,
        total: 25,
        by_severity: { high: 7, medium: 12, low: 4, info: 2 },
      },
      {
        key: 'escalated',
        label: 'Escalated',
        source: 'cases',
        deterministic: true,
        total: 15,
        by_severity: { critical: 8, high: 5, low: 2 },
      },
      {
        key: 'needs_human',
        label: 'Needs human',
        source: 'cases',
        deterministic: true,
        total: 5,
        by_severity: { high: 3, medium: 2 },
      },
      {
        key: 'closed',
        label: 'Closed by human',
        source: 'cases',
        deterministic: true,
        total: 7,
        by_severity: { high: 4, medium: 2, low: 1 },
      },
    ],
    drops: { suppressed: 12, ignored: 4 },
    reduction: { overall_pct: 96, human_reduction_pct: 87 },
    counters: { available: true, since: '2026-07-01T00:00:00Z', incomplete: false },
    cases_meta: { truncated: false, store_total: 40, fetched: 40 },
    ...overrides,
  };
}

function withStageTotals(totals: Record<string, number>): NoiseReduction {
  const data = fixture();
  data.stages = data.stages.map((stage) =>
    stage.key in totals ? { ...stage, total: totals[stage.key] } : stage,
  );
  return data;
}

function lineageFixture(): NoiseLineage {
  return {
    window_hours: 24,
    generated_at: '2026-07-05T00:01:00Z',
    rows: [
      {
        case_id: 'case-lineage-1',
        display_id: 'CASE-000042',
        created_at: '2026-07-05T00:00:00Z',
        severity: 'critical',
        clustering: {
          available: true,
          cluster_id: '4cb33a5bf9d8d6880f',
          input_count: 2,
          input_refs: ['alert-a15bb2b03f10', 'alert-75536a9e82bc'],
          source_count: 1,
          source_breakdown: { entra: 2 },
          correlation: {
            mode: 'threshold',
            threshold: 2,
            observed_count: 2,
            window_seconds: 300,
            group_by: 'user',
            matched_rule: 'Impossible travel',
            reason: 'Two sign-ins matched inside the configured window.',
          },
        },
        outcome: {
          key: 'auto_cleared',
          label: 'Auto-cleared by AI',
          funnel_stage: 'auto_cleared',
          terminal: true,
          status: 'closed',
          verdict: 'FALSE_POSITIVE',
          disposition: 'false_positive',
          decision_by: 'agent',
        },
      },
    ],
    meta: {
      returned: 1,
      window_cases_in_fetched_page: 4,
      fetched_cases: 40,
      store_total: 40,
      limit: 12,
      truncated: true,
      store_truncated: false,
    },
    limitations:
      'Rows are a bounded newest-case sample. Alert references are stable one-way identifiers.',
  };
}

function graph(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector<SVGSVGElement>('[data-testid="noise-flow-band"] svg');
  expect(svg).not.toBeNull();
  return svg!;
}

function directLabel(container: HTMLElement, key: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[data-flow-label="${key}"]`);
  expect(button).not.toBeNull();
  return button!;
}

describe('NoiseFunnel', () => {
  it('defaults to Simple and draws the full alert-to-cluster-to-case flow edge to edge', () => {
    const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);

    expect(screen.getByTestId('noise-simple-view')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Noise reduction view' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Simple' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Detailed' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.queryByTestId('noise-reduction-summary')).toBeNull();

    const svg = graph(view.container);
    expect(svg).toHaveAttribute('viewBox', '0 0 800 184');
    expect(svg).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet');
    expect(svg.querySelector('[data-context-node-key="ingested"]')).toHaveAttribute('x', '10');
    expect(svg.querySelector('[data-node-key="closed"]')).toHaveAttribute('x', '788');
    const conversionRibbons = Array.from(
      svg.querySelectorAll<SVGPathElement>('[data-edge-kind="conversion"]'),
    );
    expect(
      conversionRibbons.map((ribbon) => [
        ribbon.dataset.sourceStage,
        ribbon.dataset.targetStage,
      ]),
    ).toEqual([
      ['ingested', 'clustered'],
      ['clustered', 'cases'],
    ]);
    conversionRibbons.forEach((ribbon) => {
      expect(ribbon.getAttribute('d')).toMatch(/Z$/);
      expect(ribbon).not.toHaveAttribute('fill', 'none');
      expect(Number(ribbon.dataset.sourceHeight)).toBeGreaterThan(0);
      expect(Number(ribbon.dataset.targetHeight)).toBeGreaterThan(0);
    });
    expect(view.container.querySelectorAll('[data-flow-label]')).toHaveLength(5);
    expect(screen.getAllByText('Alerts ingested').length).toBeGreaterThan(0);
    expect(screen.getAllByText('After clustering').length).toBeGreaterThan(0);
  });

  it('uses compressed conversion thickness and conserves every same-unit case ribbon', () => {
    const view = render(<NoiseFunnel data={fixture()} animate={false} />);
    const svg = graph(view.container);
    const conversions = Array.from(
      svg.querySelectorAll<SVGPathElement>('[data-edge-kind="conversion"]'),
    );
    expect(conversions).toHaveLength(2);
    expect(conversions.map((edge) => Number(edge.dataset.value))).toEqual([220, 40]);
    const height = (selector: string) =>
      Number(svg.querySelector<SVGRectElement>(selector)?.getAttribute('height'));
    const ingestedHeight = height('[data-context-node-key="ingested"]');
    expect(height('[data-context-node-key="clustered"]') / ingestedHeight).toBeCloseTo(
      Math.sqrt(220 / 1000),
      6,
    );
    expect(height('[data-node-key="cases"]') / ingestedHeight).toBeCloseTo(
      Math.sqrt(40 / 1000),
      6,
    );

    const ribbons = Array.from(
      svg.querySelectorAll<SVGPathElement>('[data-edge-kind="conserved"]'),
    );
    expect(ribbons).toHaveLength(4);
    expect(
      ribbons.map((ribbon) => [
        ribbon.dataset.sourceStage,
        ribbon.dataset.targetStage,
        Number(ribbon.dataset.value),
      ]),
    ).toEqual([
      ['cases', 'auto_cleared', 25],
      ['cases', 'escalated', 15],
      ['escalated', 'closed', 7],
      ['escalated', 'escalated_remaining', 8],
    ]);
    expect(ribbons.filter((ribbon) => ribbon.dataset.sourceStage === 'cases')).toHaveLength(2);
    expect(
      ribbons
        .filter((ribbon) => ribbon.dataset.sourceStage === 'cases')
        .reduce((sum, ribbon) => sum + Number(ribbon.dataset.value), 0),
    ).toBe(40);
    expect(
      ribbons
        .filter((ribbon) => ribbon.dataset.sourceStage === 'escalated')
        .reduce((sum, ribbon) => sum + Number(ribbon.dataset.value), 0),
    ).toBe(15);
    expect(svg.querySelector('[data-source-stage="cases"][data-target-stage="closed"]')).toBeNull();
    expect(svg.querySelectorAll('linearGradient, filter')).toHaveLength(0);
    ribbons.forEach((ribbon) => {
      expect(ribbon).toHaveAttribute('vector-effect', 'non-scaling-stroke');
      expect(ribbon.style.fillOpacity).toBe('var(--noise-ribbon-opacity)');
      expect(Number(ribbon.dataset.sourceHeight)).toBeCloseTo(
        Number(ribbon.dataset.targetHeight),
        8,
      );
    });
  });

  it('makes node heights proportional only inside each same-unit split', () => {
    const view = render(<NoiseFunnel data={fixture()} animate={false} />);
    const height = (key: string) =>
      Number(
        view.container
          .querySelector<SVGRectElement>(`[data-node-key="${key}"]`)
          ?.getAttribute('height'),
      );

    expect(height('auto_cleared') / height('cases')).toBeCloseTo(25 / 40, 6);
    expect(height('escalated') / height('cases')).toBeCloseTo(15 / 40, 6);
    expect(height('closed') / height('escalated')).toBeCloseTo(7 / 15, 6);
    expect(height('escalated_remaining') / height('escalated')).toBeCloseTo(8 / 15, 6);
    for (const node of graph(view.container).querySelectorAll('[data-node-key]')) {
      expect(node).toHaveAttribute('rx', '0');
    }
  });

  it('keeps policy closes as their own conserved case branch in both views', async () => {
    const user = userEvent.setup();
    const data = fixture();
    data.stages = [
      ...data.stages.map((stage) =>
        stage.key === 'escalated' ? { ...stage, total: 9 } : stage,
      ),
      {
        key: 'policy_closed',
        label: 'Closed by analyst policy',
        source: 'cases',
        deterministic: true,
        total: 6,
        by_severity: { medium: 4, low: 2 },
      },
    ];
    const view = render(<NoiseFunnel data={data} animate={false} variant="flat" />);
    const simpleSvg = graph(view.container);
    const funnel = screen.getByTestId('noise-funnel');
    const topologyId = funnel.getAttribute('aria-describedby');

    expect(screen.queryByTestId('noise-flow-integrity')).toBeNull();
    expect(document.getElementById(topologyId!)).toHaveTextContent(
      /Auto-cleared, optional analyst-policy closes, and Escalated partition opened cases/i,
    );
    expect(simpleSvg.querySelector('[data-node-key="policy_closed"]')).toBeInTheDocument();
    const caseBranches = Array.from(
      simpleSvg.querySelectorAll<SVGPathElement>(
        '[data-edge-kind="conserved"][data-source-stage="cases"]',
      ),
    );
    expect(
      caseBranches.map((ribbon) => [ribbon.dataset.targetStage, Number(ribbon.dataset.value)]),
    ).toEqual([
      ['auto_cleared', 25],
      ['policy_closed', 6],
      ['escalated', 9],
    ]);
    expect(caseBranches.reduce((sum, ribbon) => sum + Number(ribbon.dataset.value), 0)).toBe(40);

    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    const detailedSvg = graph(view.container);
    expect(
      detailedSvg.querySelector(
        '[data-source-stage="cases"][data-target-stage="policy_closed"]',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Closed by analyst policy').length).toBeGreaterThan(0);
  });

  it('restores the exact Testing presentation when toggled to Detailed', async () => {
    const user = userEvent.setup();
    const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);

    await user.click(screen.getByRole('radio', { name: 'Detailed' }));

    expect(screen.queryByTestId('noise-simple-view')).toBeNull();
    const detailed = screen.getByTestId('noise-detailed-view');
    expect(detailed).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Detailed' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(detailed).toHaveTextContent(/Reduced by\s*96%/i);
    expect(detailed).toHaveTextContent(
      /1,000 events ingested\s*→\s*7 cases closed by a human/i,
    );
    const legacyBand = within(detailed).getByTestId('noise-flow-band');
    expect(legacyBand).toHaveClass('hidden', 'h-36', 'lg:block', 'lg:h-44');
    const legacySvg = legacyBand.querySelector('svg');
    expect(legacySvg).toHaveAttribute('viewBox', '0 0 640 220');
    expect(legacySvg).toHaveAttribute('preserveAspectRatio', 'none');
    expect(within(detailed).getByTestId('noise-stage-rail')).toHaveClass(
      'grid-cols-2',
      'sm:grid-cols-3',
      'lg:grid-cols-6',
    );
    expect(
      Array.from(legacySvg!.querySelectorAll<SVGPathElement>('[data-noise-ribbon]'), (ribbon) => [
        ribbon.dataset.sourceStage,
        ribbon.dataset.targetStage,
      ]),
    ).toEqual([
      ['ingested', 'clustered'],
      ['clustered', 'cases'],
      ['cases', 'auto_cleared'],
      ['cases', 'escalated'],
      ['cases', 'closed'],
    ]);
    expect(
      legacySvg!.querySelector('[data-source-stage="escalated"][data-target-stage="closed"]'),
    ).toBeNull();
    expect(legacySvg!.querySelectorAll('linearGradient, filter')).toHaveLength(0);
    expect(within(detailed).getByText('−780 · 78% filtered')).toBeInTheDocument();
    expect(within(detailed).getByText('−180 · 82% filtered')).toBeInTheDocument();
    expect(detailed).toHaveTextContent('12 suppressed · 4 ignored removed before clustering');
    expect(within(detailed).queryByTestId('noise-flow-refresh-sweep')).toBeNull();
    expect(within(detailed).queryByTestId('noise-open-cases')).toBeNull();
  });

  it('preserves the chosen mode through collapse and full-screen inspection', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue(lineageFixture());
    const onToggleHidden = vi.fn();
    const view = render(
      <NoiseFunnel
        data={fixture()}
        animate={false}
        variant="flat"
        expandable
        lineageLoader={loader}
        onToggleHidden={onToggleHidden}
      />,
    );

    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    view.rerender(
      <NoiseFunnel
        data={fixture()}
        animate={false}
        variant="flat"
        expandable
        lineageLoader={loader}
        hidden
        onToggleHidden={onToggleHidden}
      />,
    );
    expect(screen.queryByRole('radiogroup', { name: 'Noise reduction view' })).toBeNull();
    view.rerender(
      <NoiseFunnel
        data={fixture()}
        animate={false}
        variant="flat"
        expandable
        lineageLoader={loader}
        onToggleHidden={onToggleHidden}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Detailed' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Expand noise reduction flow' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('h-[min(92dvh,960px)]', 'w-[min(96dvw,1800px)]');
    const expanded = within(dialog).getByRole('group', {
      name: 'Expanded noise reduction funnel',
    });
    expect(within(expanded).getByTestId('noise-detailed-view')).toBeInTheDocument();
    expect(within(expanded).getByTestId('noise-flow-band')).toHaveClass('h-44');
    expect(within(expanded).getByTestId('noise-flow-band').querySelector('svg')).toHaveAttribute(
      'viewBox',
      '0 0 640 220',
    );
    expect(within(expanded).getByRole('radio', { name: 'Detailed' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await screen.findByText('cluster-4cb33a5bf9d8')).toBeInTheDocument();
    expect(loader).toHaveBeenCalledWith(24, 12);

    await user.click(within(expanded).getByRole('radio', { name: 'Simple' }));
    expect(within(expanded).getByTestId('noise-simple-view')).toBeInTheDocument();
    expect(within(expanded).getByTestId('noise-flow-band')).toHaveClass('h-[400px]');
    expect(view.container.querySelector('[data-testid="noise-simple-view"]')).not.toBeNull();
  });

  it('keeps Open cases separate, actionable, and absent from Sankey topology', async () => {
    const user = userEvent.setup();
    const onOpenCasesClick = vi.fn();
    const view = render(
      <NoiseFunnel
        data={fixture()}
        animate={false}
        openCases={{ count: 3 }}
        onOpenCasesClick={onOpenCasesClick}
      />,
    );

    const open = screen.getByTestId('noise-open-cases');
    expect(open).toHaveAccessibleName(/3 open cases.*review active cases/i);
    expect(open).toHaveTextContent('3 open cases');
    expect(open).toHaveTextContent('Review');
    await user.click(open);
    expect(onOpenCasesClick).toHaveBeenCalledTimes(1);
    expect(graph(view.container).querySelector('[data-node-key="open"]')).toBeNull();
    expect(graph(view.container).querySelector('[data-target-stage="open"]')).toBeNull();
    expect(directLabel(view.container, 'escalated_remaining')).toHaveAccessibleName(
      /not analyst-closed: 8 cases.*not the open cases count/i,
    );
  });

  it('labels bounded Open counts as lower bounds and renders a quiet clear state', () => {
    const view = render(
      <NoiseFunnel data={fixture()} animate={false} openCases={{ count: 12.9, partial: true }} />,
    );
    expect(screen.getByTestId('noise-open-cases')).toHaveTextContent('≥12 open cases');
    expect(screen.getByTestId('noise-open-cases')).toHaveAttribute('data-partial', 'true');

    view.rerender(<NoiseFunnel data={fixture()} animate={false} openCases={{ count: 0 }} />);
    expect(screen.getByTestId('noise-open-cases')).toHaveTextContent('0 open cases');
    expect(screen.getByTestId('noise-open-cases')).toHaveTextContent('Clear');

    view.rerender(<NoiseFunnel data={fixture()} animate={false} openCases={{ count: -1 }} />);
    expect(screen.queryByTestId('noise-open-cases')).toBeNull();
  });

  it('replays a one-shot matte sweep only for a new successful payload', () => {
    setReducedMotion(false);
    const view = render(<NoiseFunnel data={fixture()} animate />);
    const first = screen.getByTestId('noise-flow-refresh-sweep');
    expect(first).toHaveClass('noise-flow-refresh-sweep');
    expect(first.querySelectorAll('rect')).toHaveLength(2);
    expect(graph(view.container).querySelectorAll('linearGradient, filter')).toHaveLength(0);

    view.rerender(
      <NoiseFunnel data={fixture({ generated_at: '2026-07-05T00:00:05Z' })} animate />,
    );
    expect(screen.getByTestId('noise-flow-refresh-sweep')).not.toBe(first);

    fireEvent.focus(directLabel(view.container, 'closed'));
    expect(screen.queryByTestId('noise-flow-refresh-sweep')).toBeNull();
  });

  it('does not mount motion when disabled or reduced motion is requested', () => {
    const disabled = render(
      <NoiseFunnel data={fixture()} animate={false} openCases={{ count: 3 }} />,
    );
    expect(screen.queryByTestId('noise-flow-refresh-sweep')).toBeNull();
    expect(disabled.container.querySelector('.noise-open-cases-pulse')).toBeNull();
    disabled.unmount();

    setReducedMotion(true);
    const reduced = render(<NoiseFunnel data={fixture()} animate openCases={{ count: 3 }} />);
    expect(screen.queryByTestId('noise-flow-refresh-sweep')).toBeNull();
    expect(reduced.container.querySelector('.noise-open-cases-pulse')).toBeNull();
  });

  it('keeps the compatibility Detailed renderer free of the Simple refresh sweep', async () => {
    setReducedMotion(false);
    const user = userEvent.setup();
    render(<NoiseFunnel data={fixture()} animate />);
    expect(screen.getByTestId('noise-flow-refresh-sweep')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Detailed' }));

    expect(screen.queryByTestId('noise-flow-refresh-sweep')).toBeNull();
  });

  it('withholds proportional geometry when either conservation invariant fails', async () => {
    const user = userEvent.setup();
    const view = render(
      <NoiseFunnel
        data={withStageTotals({ cases: 41, auto_cleared: 25, escalated: 15 })}
        animate={false}
      />,
    );
    expect(screen.getByTestId('noise-flow-integrity')).toHaveTextContent(
      /Case outcomes do not reconcile/i,
    );
    expect(view.container.querySelectorAll('[data-edge-kind="conserved"]')).toHaveLength(0);
    expect(screen.getByTestId('noise-stage-rail')).not.toHaveClass('@[38rem]/noise:hidden');
    expect(screen.getAllByRole('button', { name: /^Cases opened:/i }).length).toBeGreaterThan(0);

    view.rerender(
      <NoiseFunnel
        data={withStageTotals({ cases: 40, auto_cleared: -1, escalated: 40, closed: 7 })}
        animate={false}
      />,
    );
    expect(screen.getByTestId('noise-flow-integrity')).toBeInTheDocument();
    expect(view.container.querySelectorAll('[data-edge-kind="conserved"]')).toHaveLength(0);

    view.rerender(
      <NoiseFunnel
        data={withStageTotals({ cases: 40, auto_cleared: 25, escalated: 15, closed: 16 })}
        animate={false}
      />,
    );
    expect(screen.getByTestId('noise-flow-integrity')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    expect(screen.getByTestId('noise-detailed-view')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Closed by human: 16 cases/i })).toBeInTheDocument();
  });

  it('omits zero-width branches instead of inventing visible bars', () => {
    const data = withStageTotals({
      cases: 40,
      auto_cleared: 40,
      escalated: 0,
      closed: 0,
    });
    const view = render(<NoiseFunnel data={data} animate={false} />);
    const svg = graph(view.container);
    expect(svg.querySelector('[data-node-key="escalated"]')).toBeNull();
    expect(svg.querySelector('[data-node-key="closed"]')).toBeNull();
    expect(svg.querySelector('[data-node-key="escalated_remaining"]')).toBeNull();
    expect(svg.querySelector('[data-target-stage="escalated"]')).toBeNull();
    expect(view.container.querySelector('[data-flow-label="escalated"]')).toBeNull();
  });

  it('focuses the whole relevant path and mutes sibling branches', () => {
    const view = render(<NoiseFunnel data={fixture()} animate={false} />);
    const ribbon = (source: string, target: string) =>
      graph(view.container).querySelector<SVGPathElement>(
        `[data-source-stage="${source}"][data-target-stage="${target}"]`,
      )!;

    fireEvent.focus(directLabel(view.container, 'closed'));
    expect(ribbon('ingested', 'clustered').style.fillOpacity).toBe('0.92');
    expect(ribbon('clustered', 'cases').style.fillOpacity).toBe('0.92');
    expect(ribbon('cases', 'escalated').style.fillOpacity).toBe('0.92');
    expect(ribbon('escalated', 'closed').style.fillOpacity).toBe('0.92');
    expect(ribbon('cases', 'auto_cleared').style.fillOpacity).toBe('0.14');
    expect(ribbon('escalated', 'escalated_remaining').style.fillOpacity).toBe('0.14');
    fireEvent.blur(directLabel(view.container, 'closed'));
    expect(ribbon('cases', 'auto_cleared').style.fillOpacity).toBe(
      'var(--noise-ribbon-opacity)',
    );
  });

  it('drills only real stages and leaves the synthetic remainder inspect-only', async () => {
    const user = userEvent.setup();
    const onStageClick = vi.fn();
    const view = render(
      <NoiseFunnel data={fixture()} animate={false} onStageClick={onStageClick} />,
    );

    await user.click(directLabel(view.container, 'escalated'));
    expect(onStageClick).toHaveBeenLastCalledWith('escalated');
    await user.click(directLabel(view.container, 'closed'));
    expect(onStageClick).toHaveBeenLastCalledWith('closed');
    const calls = onStageClick.mock.calls.length;
    await user.click(directLabel(view.container, 'escalated_remaining'));
    expect(onStageClick).toHaveBeenCalledTimes(calls);
  });

  it('keeps candidate volume as evidence and never inserts it into the path', async () => {
    const user = userEvent.setup();
    const data = fixture();
    data.stages = [
      ...data.stages.slice(0, 2),
      {
        key: 'candidate',
        label: 'Awaiting review',
        source: 'counters',
        deterministic: true,
        total: 120,
        by_severity: { medium: 60, low: 60 },
      },
      ...data.stages.slice(2),
    ];
    const view = render(<NoiseFunnel data={data} animate={false} />);

    expect(screen.getByTestId('noise-flow-annotations')).toHaveTextContent(
      /120 awaiting review.*side cohort from clustering/i,
    );
    expect(graph(view.container).querySelector('[data-target-stage="candidate"]')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    expect(screen.getByRole('button', { name: /^Awaiting review: 120 candidates/i }))
      .toBeInTheDocument();
  });

  it('discloses partial coverage without requiring Detailed or full screen', () => {
    render(
      <NoiseFunnel
        data={fixture({
          counters: {
            available: true,
            since: '2026-07-05T00:00:00Z',
            incomplete: true,
          },
        })}
        animate={false}
      />,
    );
    expect(screen.getByTestId('noise-coverage-warning')).toHaveTextContent(
      /Partial coverage.*cover only part of the selected window/i,
    );
  });

  it('degrades to case-only flow while counters warm up', async () => {
    const user = userEvent.setup();
    const data = fixture({
      counters: { available: false, since: null, incomplete: true },
      reduction: { overall_pct: '—', human_reduction_pct: '—' },
    });
    const view = render(<NoiseFunnel data={data} animate={false} />);

    expect(graph(view.container).querySelectorAll('[data-edge-kind="conversion"]')).toHaveLength(0);
    expect(view.container.querySelector('[data-context-node-key="ingested"]')).toBeNull();
    expect(deriveFunnel(data).mode).toBe('cases');
    expect(deriveFunnel(data).topTotal).toBe(40);
    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    expect(screen.getByTestId('noise-funnel-warming')).toHaveTextContent(/Counters warming up/i);
  });

  it('retains the backend stage semantics and excludes legacy tail rows', () => {
    const derived = deriveFunnel(fixture());
    expect(derived.rows.map((row) => row.key)).toEqual([
      'ingested',
      'clustered',
      'cases',
      'auto_cleared',
      'escalated',
      'closed',
    ]);
    expect(derived.rows.filter((row) => row.isOutcome).map((row) => row.key).sort()).toEqual([
      'auto_cleared',
      'closed',
      'escalated',
    ]);
    expect(derived.outcomeSum).toBe(47);
    expect(derived.rows.find((row) => row.key === 'closed')?.by_severity.high).toBe(4);
  });

  it('renders shared loading, empty, collapse, and retryable lineage states', () => {
    const onToggleHidden = vi.fn();
    const view = render(<NoiseFunnel data={null} loading />);
    expect(screen.getByRole('status', { name: 'Loading noise reduction flow' })).toBeInTheDocument();
    view.rerender(<NoiseFunnel data={null} loading={false} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(
      <NoiseFunnel
        data={fixture()}
        animate={false}
        hidden
        onToggleHidden={onToggleHidden}
      />,
    );
    expect(screen.queryByTestId('noise-simple-view')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show noise funnel' }));
    expect(onToggleHidden).toHaveBeenCalledTimes(1);

    const retry = vi.fn();
    view.rerender(
      <NoiseLineageView data={null} loading={false} error="Lineage unavailable" onRetry={retry} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Lineage unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('has no detectable accessibility violations in either view', async () => {
    const user = userEvent.setup();
    const view = render(
      <NoiseFunnel
        data={fixture()}
        animate={false}
        openCases={{ count: 3 }}
        onOpenCasesClick={vi.fn()}
      />,
    );
    expect(await axe(view.container)).toHaveNoViolations();
    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe('ribbonPath', () => {
  it('emits a closed horizontal cubic-Bezier ribbon', () => {
    expect(ribbonPath(0, 0, 10, 100, 20, 30)).toBe(
      'M0,0 C50,0 50,20 100,20 L100,30 C50,30 50,10 0,10 Z',
    );
    const path = ribbonPath(40, 5, 15, 200, 25, 45);
    expect(path.startsWith('M40,5 C120,5 120,25 200,25')).toBe(true);
    expect(path.endsWith('C120,45 120,15 40,15 Z')).toBe(true);
  });
});
