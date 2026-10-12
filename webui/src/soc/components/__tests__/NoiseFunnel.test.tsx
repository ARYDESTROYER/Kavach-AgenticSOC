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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import {
  NoiseFunnel,
  deriveFunnel,
  parentStageKey,
  ribbonPath,
  stageShare,
} from '../NoiseFunnel';
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

/**
 * Open the funnel's disclosure popover and return its content.
 *
 * The share RULE ("each percentage is that stage's share of the stage it came from",
 * the baseline em dash) used to sit in the always-visible caption. It moved into a
 * popover, so these specs stopped being able to read it off the paragraph — and the
 * honest replacement is not to drop the assertion but to prove the sentence is still
 * REACHABLE. The trigger is a real button (click / Enter / Space), never a tooltip, so
 * this passes for pointer, keyboard and touch alike; a tooltip would have been a
 * regression dressed as a cleanup.
 */
async function openShareRule(): Promise<HTMLElement> {
  const disclosure = screen.getByTestId('noise-share-disclosure');
  const trigger = within(disclosure).getByRole('button', {
    name: /how to read these counts and percentages/i,
  });
  await userEvent.click(trigger);
  return screen.getByRole('dialog');
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
    // Round 12: the inline band scales (`h-[clamp(240px,18dvw,340px)]`) and the drawing
    // follows the MEASURED box height, so the viewBox can never letterbox inside it. jsdom
    // lays nothing out, so this is the pre-measurement fallback — the clamp's floor. The
    // measured path is pinned in "draws the inline flow at the measured band height".
    expect(svg).toHaveAttribute('viewBox', '0 0 800 240');
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

    // ONE label in both modes (Round 12): Detailed used to say "Expand" for the same
    // full-screen inspection Simple calls "Full screen".
    const fullScreen = screen.getByRole('button', { name: 'Open full-screen noise reduction flow' });
    expect(fullScreen).toHaveTextContent('Full screen');
    await user.click(fullScreen);
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

  it('returns focus to the Full screen button when the inspection closes (final review)', async () => {
    // The inspection opens from state, outside a DialogTrigger, so Radix had nothing to
    // refocus and focus fell to <body> on Escape and on the X (WCAG 2.4.3).
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue(lineageFixture());
    render(<NoiseFunnel data={fixture()} animate={false} variant="flat" expandable lineageLoader={loader} />);
    const trigger = screen.getByRole('button', { name: 'Open full-screen noise reduction flow' });

    // Keyboard: focus the trigger, Enter, then Escape.
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText('cluster-4cb33a5bf9d8')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);

    // The dialog's own Close (X) button.
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^close$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
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

  it('draws the inline flow at the measured band height, in the inline padding rhythm', () => {
    // Round 12: the band's CSS height is a clamp, so the drawing must follow the box it
    // resolved to. A 300px band used to flip to the full-screen padding (`height >= 300`)
    // and draw a SMALLER pipeline than a 296px one; the rhythm is now explicit.
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'noise-flow-band'
          ? DOMRect.fromRect({ width: 900, height: 300 })
          : DOMRect.fromRect({ width: 0, height: 0 });
      });
    try {
      const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
      const svg = graph(view.container);
      expect(svg).toHaveAttribute('viewBox', '0 0 900 300');
      // Inline rhythm: plotTop 34, plotBottom 290, node padding 24 → a 232px pipeline,
      // which the full ingested context node spans (the inspection rhythm would give 180).
      expect(svg.querySelector('[data-context-node-key="ingested"]')).toHaveAttribute('height', '232');
      expect(screen.getByTestId('noise-flow-band')).toHaveClass('h-[clamp(240px,18dvw,340px)]');
    } finally {
      spy.mockRestore();
    }
  });

  it('states alert reduction only over one fully measured window', () => {
    // 1 − cases ÷ alerts over the same window: the fixture opens 40 cases from 1000 alerts.
    const { unmount } = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
    const measured = screen.getByTestId('noise-alert-reduction');
    expect(measured).toHaveAttribute('data-measured', 'true');
    expect(measured).toHaveTextContent('Alert reduction96%');
    expect(measured).toHaveTextContent('1,000 alerts became 40 cases');
    unmount();

    // Counters that cover only part of the window cannot carry the ratio: an em dash and
    // the reason, never a percentage computed across two different populations.
    render(
      <NoiseFunnel
        data={fixture({ counters: { available: true, since: '2026-07-05T00:00:00Z', incomplete: true } })}
        animate={false}
        variant="flat"
      />,
    );
    const partial = screen.getByTestId('noise-alert-reduction');
    expect(partial).toHaveAttribute('data-measured', 'false');
    expect(partial).toHaveTextContent('Alert reduction—');
    expect(partial).toHaveTextContent(/Not measured: partial coverage\./);
  });

  it('withholds alert reduction while counters warm up or the case tally is partial', () => {
    const { unmount } = render(
      <NoiseFunnel
        data={fixture({ counters: { available: false, since: null, incomplete: true } })}
        animate={false}
      />,
    );
    expect(screen.getByTestId('noise-alert-reduction')).toHaveTextContent(
      /—Not measured: alert counters are still warming up\./,
    );
    unmount();
    render(
      <NoiseFunnel
        data={fixture({ cases_meta: { truncated: true, store_total: 900, fetched: 500 } })}
        animate={false}
      />,
    );
    expect(screen.getByTestId('noise-alert-reduction')).toHaveTextContent(
      /Not measured: case counts are partial for this window\./,
    );
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

describe('NoiseFunnel Simple-mode stage shares', () => {
  /** The compact share glyph rendered beside one Simple stage's count. */
  function shareText(container: HTMLElement, key: string): string {
    const node = container.querySelector(`[data-stage-share="${key}"]`);
    expect(node, `missing share for ${key}`).not.toBeNull();
    return node!.textContent!.trim();
  }

  it('prints every Simple stage as count plus its share of the stage it came from', () => {
    const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);

    // Conversion chips (mixed units) — clusters of alerts; the top stage is the baseline.
    expect(shareText(view.container, 'ingested')).toBe('· —');
    expect(shareText(view.container, 'clustered')).toBe('· 22%');
    // Flow labels — cases of clusters, then the conserved case split of Cases opened,
    // then human closure of Escalated. NEVER share-of-ingested, which would print 2-4%
    // for every outcome and hide the whole disposition story.
    expect(shareText(view.container, 'cases')).toBe('· 18%');
    expect(shareText(view.container, 'auto_cleared')).toBe('· 63%');
    expect(shareText(view.container, 'escalated')).toBe('· 38%');
    expect(shareText(view.container, 'closed')).toBe('· 47%');
    expect(shareText(view.container, 'escalated_remaining')).toBe('· 53%');

    // The conserved split still reads as a whole: 63 + 38 ≈ 100% of cases,
    // 47 + 53 = 100% of escalated (counts, not the rounded shares, are authoritative).
    expect(directLabel(view.container, 'auto_cleared')).toHaveTextContent('Auto-cleared by AI· 25· 63%');

    // Adding the share must NOT add a sixth flow label node.
    expect(view.container.querySelectorAll('[data-flow-label]')).toHaveLength(5);
  });

  it('names the denominator for screen readers on every Simple stage', () => {
    render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
    const label = (name: RegExp) => screen.getByRole('button', { name });

    expect(label(/^Alerts ingested: 1,000 alerts, the flow baseline/i)).toBeInTheDocument();
    expect(label(/^After clustering: 220 clusters, 22% of alerts ingested\./i)).toBeInTheDocument();
    expect(label(/^Cases opened: 40 cases, 18% of clusters\./i)).toBeInTheDocument();
    expect(label(/^Auto-cleared by AI: 25 cases, 63% of cases opened\./i)).toBeInTheDocument();
    expect(label(/^Escalated: 15 cases, 38% of cases opened\./i)).toBeInTheDocument();
    expect(label(/^Closed by human: 7 cases, 47% of escalated cases\./i)).toBeInTheDocument();
    expect(
      label(/^Not analyst-closed: 8 cases, 53% of escalated cases, equal to Escalated minus/i),
    ).toBeInTheDocument();
  });

  it('renders an em dash instead of a fabricated 0% when a denominator is missing', () => {
    const data = fixture({
      counters: { available: false, since: null, incomplete: true },
      reduction: { overall_pct: '—', human_reduction_pct: '—' },
    });
    const view = render(<NoiseFunnel data={data} animate={false} variant="flat" />);

    // Counters warming up: there is no clustered volume at all, so Cases opened has no
    // honest denominator. It must not read 0% and must not read 100%.
    expect(shareText(view.container, 'cases')).toBe('· —');
    expect(directLabel(view.container, 'cases')).toHaveAttribute(
      'aria-label',
      'Cases opened: 40 cases, share unavailable, no clusters counted in this window.',
    );
    // The conserved case split below it is still fully measurable.
    expect(shareText(view.container, 'auto_cleared')).toBe('· 63%');
    expect(shareText(view.container, 'closed')).toBe('· 47%');
  });

  it('derives parent-relative shares without ever inventing a percentage', () => {
    expect(parentStageKey('clustered')).toBe('ingested');
    expect(parentStageKey('cases')).toBe('clustered');
    expect(parentStageKey('auto_cleared')).toBe('cases');
    expect(parentStageKey('policy_closed')).toBe('cases');
    expect(parentStageKey('escalated')).toBe('cases');
    expect(parentStageKey('closed')).toBe('escalated');
    expect(parentStageKey('escalated_remaining')).toBe('escalated');
    expect(parentStageKey('ingested')).toBeNull();

    // A real measured zero keeps its 0%; a zero/absent/non-finite denominator does not.
    expect(stageShare('auto_cleared', 0, 40)).toMatchObject({ pct: 0, text: '0%' });
    expect(stageShare('closed', 3, 0)).toMatchObject({ pct: null, text: '—' });
    expect(stageShare('closed', 3, 0).sentence).toBe(
      'share unavailable, no escalated cases counted in this window',
    );
    expect(stageShare('cases', 4, null)).toMatchObject({ pct: null, text: '—' });
    expect(stageShare('cases', 4, Number.NaN)).toMatchObject({ pct: null, text: '—' });
    expect(stageShare('ingested', 1000, 1000)).toMatchObject({ pct: null, text: '—' });
    expect(stageShare('ingested', 1000, 1000).sentence).toMatch(/flow baseline/i);

    // Sub-half-percent cohorts stay visible instead of rounding away to 0%.
    const tiny = stageShare('auto_cleared', 1, 400);
    expect(tiny.text).toBe('<1%');
    expect(tiny.sentence).toBe('less than 1% of cases opened');
  });

  /** The percentage one aligned-rail chip actually prints beside its count. */
  function railShareText(chip: HTMLElement): string {
    const count = chip.querySelector('[data-testid="count-up"]');
    expect(count).not.toBeNull();
    return count!.nextElementSibling!.textContent!.trim();
  }

  it('prints Simple\'s one share rule on the narrow rail too, matching the disclosure', async () => {
    render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);

    // The two Simple surfaces are mutually exclusive: the flow band needs a >=38rem
    // container and the rail replaces it below that. Whatever a reader sees at their
    // width, it must obey the ONE rule the disclosure states.
    expect(screen.getByTestId('noise-flow-band')).toHaveClass('hidden', '@[38rem]/noise:block');
    const rail = screen.getByTestId('noise-stage-rail');
    expect(rail).toHaveClass('@[38rem]/noise:hidden');

    const chip = (name: RegExp) => within(rail).getByRole('button', { name });
    // Parent-relative, exactly like the graph labels — and the baseline is an em dash,
    // never the self-referential "100% of ingested" that contradicted the footnote.
    expect(railShareText(chip(/^Ingested: 1000 alerts, the flow baseline/i))).toBe('—');
    expect(railShareText(chip(/^Clustered: 220 clusters, 22% of alerts ingested$/i))).toBe('22%');
    expect(railShareText(chip(/^Cases opened: 40 cases, 18% of clusters$/i))).toBe('18%');
    expect(railShareText(chip(/^Auto-cleared: 25 cases, 63% of cases opened$/i))).toBe('63%');
    expect(railShareText(chip(/^Escalated: 15 cases, 38% of cases opened$/i))).toBe('38%');
    expect(railShareText(chip(/^Closed by human: 7 cases, 47% of escalated cases$/i))).toBe('47%');
    expect(within(rail).queryByText('100%')).toBeNull();
    expect(within(rail).queryByText(/of ingested/i)).toBeNull();

    // The surface-specific sentence stays INLINE and stays gated to the container that
    // renders it; the share RULE, which holds on both surfaces, moved to the popover.
    const disclosure = screen.getByTestId('noise-share-disclosure');
    const rule = await openShareRule();
    expect(rule).toHaveTextContent(
      /each percentage is that stage's share of the stage it came from/i,
    );
    expect(rule).toHaveTextContent(/first stage is the baseline, so it shows an em dash/i);
    expect(disclosure.querySelector('[data-disclosure-surface="flow"]')).toHaveClass(
      'hidden',
      '@[38rem]/noise:inline',
    );
    expect(disclosure.querySelector('[data-disclosure-surface="rail"]')).toHaveClass(
      '@[38rem]/noise:hidden',
    );
  });

  it('describes the flow band alone once it is the only rendered surface', async () => {
    render(<NoiseFunnel data={fixture()} animate={false} variant="flat" wideInspection />);

    // Wide inspection always draws the band and drops the rail entirely.
    expect(screen.getByTestId('noise-flow-band')).not.toHaveClass('hidden');
    expect(screen.getByTestId('noise-stage-rail')).toHaveClass('hidden');
    const disclosure = screen.getByTestId('noise-share-disclosure');
    expect(disclosure.querySelector('[data-disclosure-surface="flow"]')).not.toHaveClass('hidden');
    expect(disclosure.querySelector('[data-disclosure-surface="rail"]')).toBeNull();
    // The surface sentence stays inline, and it still NAMES the scale: a "compressed"
    // scale the reader cannot identify is not a disclosure. The rest is one click away.
    //
    // It now rides a persistent `√ scale` CHIP rather than a paragraph of face prose, so
    // both halves are pinned: the chip itself (the mark a sighted reader sees on an
    // unlabelled non-linear axis) and the full sentence it carries as its accessible name
    // — as real text content, which is why the disclosure still reads it. Asserting the
    // sentence alone would pass off any incidental text; asserting the chip alone would
    // let the sentence be dropped to a mouse-only `title`.
    const chip = within(disclosure).getByTestId('noise-scale-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent(/Filled ribbons show the alert .+ compressed \(√\) display scale\./i);
    expect(disclosure).toHaveTextContent(/Filled ribbons show the alert .+ compressed \(√\) display scale\./i);
    expect(await openShareRule()).toHaveTextContent(/Labels are the exact counts/i);
  });

  it('never claims ribbons when the graph is withheld and the rail is all there is', async () => {
    render(
      <NoiseFunnel
        data={withStageTotals({ cases: 41, auto_cleared: 25, escalated: 15 })}
        animate={false}
        variant="flat"
      />,
    );

    // Conservation failed → a status box replaces the graph and the rail shows at EVERY
    // width, so the ribbon sentence must be gone and the rail sentence ungated.
    expect(screen.getByTestId('noise-flow-integrity')).toBeInTheDocument();
    const rail = screen.getByTestId('noise-stage-rail');
    expect(rail).not.toHaveClass('@[38rem]/noise:hidden');
    const disclosure = screen.getByTestId('noise-share-disclosure');
    expect(disclosure.querySelector('[data-disclosure-surface="flow"]')).toBeNull();
    expect(disclosure.querySelector('[data-disclosure-surface="rail"]')).not.toHaveClass(
      '@[38rem]/noise:hidden',
    );
    expect(disclosure).not.toHaveTextContent(/Filled ribbons/i);
    // The rail surface's sentence was shortened to the label it always was — "Stage rail ·
    // flow order" — when the ribbon prose became a chip. It is asserted verbatim rather
    // than by a loose /rail/ so a future edit that deletes the surface entirely (the thing
    // the `data-disclosure-surface` class assertions above exist to prevent) still fails.
    expect(disclosure).toHaveTextContent(/Stage rail · flow order/i);
    // …and the ribbon chip is absent WITH the ribbons: there is no graph to explain.
    expect(within(disclosure).queryByTestId('noise-scale-chip')).toBeNull();
    expect(await openShareRule()).toHaveTextContent(/Labels are the exact counts/i);
    // The rail still obeys the stated rule, baseline em dash included.
    expect(
      railShareText(within(rail).getByRole('button', { name: /^Ingested: 1000 alerts/i })),
    ).toBe('—');
  });

  it('leaves the Detailed presentation and its share-of-ingested rail untouched', async () => {
    const user = userEvent.setup();
    const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
    await user.click(screen.getByRole('radio', { name: 'Detailed' }));

    // Detailed draws its own geometry: no Simple flow labels, no Simple share spans.
    expect(view.container.querySelectorAll('[data-flow-label]')).toHaveLength(0);
    expect(view.container.querySelectorAll('[data-stage-share]')).toHaveLength(0);
    // Its evidence rail keeps the funnel-top denominator it has always published.
    expect(
      screen.getByRole('button', { name: /^Auto-cleared: 25 cases, 3% of ingested/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Clustered: 220 clusters, 22% of ingested/i }),
    ).toBeInTheDocument();
  });

  it('shows the analyst-policy share against opened cases when the branch exists', () => {
    const data = fixture();
    data.stages = [
      ...data.stages.map((stage) => (stage.key === 'escalated' ? { ...stage, total: 9 } : stage)),
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

    // 25 auto-cleared + 6 policy-closed + 9 escalated = 40 opened cases.
    expect(shareText(view.container, 'auto_cleared')).toBe('· 63%');
    expect(shareText(view.container, 'policy_closed')).toBe('· 15%');
    expect(shareText(view.container, 'escalated')).toBe('· 23%');
    // Human closure is measured against Escalated, never against opened cases.
    expect(shareText(view.container, 'closed')).toBe('· 78%');
    // BOTH Simple surfaces (the graph label and the stage rail chip that replaces it at
    // narrow widths) announce the same parent-relative denominator.
    expect(
      screen.getAllByRole('button', {
        name: /^Closed by analyst policy: 6 cases, 15% of cases opened/i,
      }),
    ).toHaveLength(2);
  });
});

describe('NoiseFunnel stage numerals on a refresh (Round 12 review)', () => {
  /** A copy of the fixture whose ingested stage counts `total` alerts. */
  function withIngested(total: number): NoiseReduction {
    const data = fixture();
    data.stages = data.stages.map((stage) => (stage.key === 'ingested' ? { ...stage, total } : stage));
    return data;
  }

  /**
   * Every text `node` shows from now until it settles on `final`: a MutationObserver sees
   * each frame a count-up commits, so a tween shows up as values between the two totals.
   */
  async function textsUntil(node: HTMLElement, final: string, change: () => void): Promise<string[]> {
    const seen = [node.textContent ?? ''];
    const observer = new MutationObserver(() => {
      const text = node.textContent ?? '';
      if (seen[seen.length - 1] !== text) seen.push(text);
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    change();
    await waitFor(() => expect(node).toHaveTextContent(final), { timeout: 3000 });
    // Let any frame still in flight land before the record is read.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    observer.disconnect();
    return seen;
  }

  /** The ingested total on the stage rail (its first count). */
  function ingestedCount(): HTMLElement {
    return within(screen.getByTestId('noise-stage-rail')).getAllByTestId('count-up')[0];
  }

  it('counts the stage totals up by default (first load, window change)', async () => {
    setReducedMotion(false);
    const view = render(<NoiseFunnel data={withIngested(1000)} variant="flat" />);
    const node = ingestedCount();
    expect(node).toHaveTextContent('1000');
    const seen = await textsUntil(node, '1400', () =>
      view.rerender(<NoiseFunnel data={withIngested(1400)} variant="flat" />),
    );
    // The positive control: the observer DOES see a tween's intermediate frames.
    expect(seen.some((text) => text !== '1000' && text !== '1400')).toBe(true);
  });

  it('shows a refreshed stage total without counting up when rollNumerals is off', async () => {
    setReducedMotion(false);
    const view = render(<NoiseFunnel data={withIngested(1000)} variant="flat" rollNumerals={false} />);
    const node = ingestedCount();
    const seen = await textsUntil(node, '1400', () =>
      view.rerender(<NoiseFunnel data={withIngested(1400)} variant="flat" rollNumerals={false} />),
    );
    expect(seen).toEqual(['1000', '1400']);
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

/**
 * Round 12 polish 3 (tour 3): the flow is drawn only where its MEASURED labels fit the
 * MEASURED container. jsdom lays nothing out, so these specs give the panel, the band's
 * height probe and every label probe a size: a probe is sized from its own text (the
 * probe carries it as `data-t`, never as text content), 7 px a glyph on one line, the
 * wider line when stacked.
 */
describe('measured flow fit (tour 3: labels on the Escalated node at 656 px)', () => {
  const GLYPH = 7;
  function probeSize(element: HTMLElement): DOMRect {
    const texts = [element, ...element.querySelectorAll<HTMLElement>('[data-t]')]
      .map((el) => el.dataset.t ?? '')
      .filter(Boolean);
    const conversion = element.dataset.flowProbe === 'ingested' || element.dataset.flowProbe === 'clustered';
    if (conversion || element.dataset.flowForm === 'stack') {
      const lines = [texts[0], texts.slice(1).join(' ')];
      return DOMRect.fromRect({ width: Math.max(...lines.map((t) => t.length)) * GLYPH + 12, height: 40 });
    }
    return DOMRect.fromRect({ width: texts.join(' ').length * GLYPH + 12, height: 24 });
  }
  function layoutAt(panelWidth: number) {
    return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === 'noise-instrument-panel' || this.dataset.testid === 'noise-flow-band') {
        return DOMRect.fromRect({ width: panelWidth, height: 240 });
      }
      if (this.hasAttribute('data-flow-probe-height')) return DOMRect.fromRect({ width: 1, height: 240 });
      if (this.dataset.flowProbe) return probeSize(this);
      return DOMRect.fromRect({ width: 0, height: 0 });
    });
  }
  const band = () => screen.getByTestId('noise-flow-band');
  const rail = () => screen.getByTestId('noise-stage-rail');
  const surface = (name: 'flow' | 'rail') =>
    screen.getByTestId('noise-share-disclosure').querySelector(`[data-disclosure-surface="${name}"]`);

  it('keeps the container query while nothing has measured (no layout engine)', () => {
    render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
    expect(band()).not.toHaveAttribute('data-flow-fit', 'fits');
    expect(band()).toHaveAttribute('data-flow-fit', 'unmeasured');
    expect(band()).toHaveClass('hidden', '@[38rem]/noise:block');
    expect(rail()).toHaveClass('@[38rem]/noise:hidden');
  });

  it('draws the flow with one-line labels where they fit, and hides the rail', () => {
    const spy = layoutAt(1200);
    try {
      const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
      expect(band()).toHaveAttribute('data-flow-fit', 'fits');
      expect(band()).not.toHaveClass('hidden');
      expect(band()).not.toHaveClass('@[38rem]/noise:block');
      expect(rail()).toHaveClass('hidden');
      expect(surface('flow')).not.toHaveClass('hidden');
      expect(surface('rail')).toHaveClass('hidden');
      // The drawing is exactly as wide as the panel it was measured in.
      expect(graph(view.container)).toHaveAttribute('viewBox', '0 0 1200 240');
      for (const key of ['cases', 'auto_cleared', 'escalated', 'closed', 'escalated_remaining']) {
        expect(directLabel(view.container, key)).toHaveAttribute('data-label-form', 'line');
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('stacks the right-hand labels instead of laying them over the Escalated node', () => {
    const spy = layoutAt(800);
    try {
      const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
      expect(band()).toHaveAttribute('data-flow-fit', 'fits');
      const remaining = directLabel(view.container, 'escalated_remaining');
      expect(remaining).toHaveAttribute('data-label-form', 'stack');
      expect(directLabel(view.container, 'closed')).toHaveAttribute('data-label-form', 'stack');
      // Name over figures, and the same accessible name as the one-line label.
      expect(remaining.children[0]).toHaveTextContent(/^Not analyst-closed$/);
      expect(remaining.children[1]).toHaveTextContent(/^8· 53%$/);
      expect(remaining).toHaveAccessibleName(/^Not analyst-closed: 8 cases, 53% of escalated cases/);
    } finally {
      spy.mockRestore();
    }
  });

  it('lists the stages in the rail when even the stacked labels collide', () => {
    const spy = layoutAt(480);
    try {
      render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
      expect(band()).toHaveAttribute('data-flow-fit', 'collides');
      expect(band()).toHaveClass('hidden');
      expect(band()).not.toHaveClass('@[38rem]/noise:block');
      expect(rail()).not.toHaveClass('hidden');
      expect(rail()).not.toHaveClass('@[38rem]/noise:hidden');
      expect(surface('flow')).toHaveClass('hidden');
      expect(surface('rail')).not.toHaveClass('hidden');
      expect(surface('rail')).not.toHaveClass('@[38rem]/noise:hidden');
    } finally {
      spy.mockRestore();
    }
  });

  it('decides from the labels, not a rem threshold: 656 px fits small counts, not huge ones', () => {
    // Tour 3's 656 px column sat just over the old 38rem cut-off and drew a colliding flow.
    // The same width now fits the demo's counts (compactly) and refuses counts too wide.
    const spy = layoutAt(656);
    try {
      const small = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
      expect(band()).toHaveAttribute('data-flow-fit', 'fits');
      small.unmount();
      render(
        <NoiseFunnel
          data={withStageTotals({
            ingested: 123_456_789,
            clustered: 12_345_678,
            cases: 1_234_567,
            auto_cleared: 1_000_000,
            escalated: 234_567,
            closed: 123_456,
          })}
          animate={false}
          variant="flat"
        />,
      );
      expect(band()).toHaveAttribute('data-flow-fit', 'collides');
      expect(rail()).not.toHaveClass('hidden');
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Polish 3 re-verify: Full screen measured while its dialog's opening animation still
   * scaled everything to 95%. `getBoundingClientRect` reports that painted box, a
   * transform is not a resize, and the 1332 px panel was drawn 1266 px wide and
   * letterboxed while the labels, placed by percentage, drifted onto the node markers.
   * These layouts paint every box scaled while the layout sizes (`offsetWidth` /
   * `offsetHeight`, which ignore transforms) stay true.
   */
  function scaledLayoutAt(panelWidth: number, scale: number, bandHeight = 240) {
    const layout = (element: HTMLElement): { width: number; height: number } => {
      if (element.dataset.testid === 'noise-instrument-panel' || element.dataset.testid === 'noise-flow-band') {
        return { width: panelWidth, height: bandHeight };
      }
      if (element.hasAttribute('data-flow-probe-height')) return { width: 1, height: bandHeight };
      if (element.dataset.flowProbe) return probeSize(element);
      return { width: 0, height: 0 };
    };
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const { width, height } = layout(this);
        return DOMRect.fromRect({ width: width * scale, height: height * scale });
      }),
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return Math.round(layout(this).width);
      }),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return Math.round(layout(this).height);
      }),
    ];
    return { mockRestore: () => spies.forEach((spy) => spy.mockRestore()) };
  }
  const placedLabels = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('button[data-flow-label]')].map((label) => [
      label.dataset.flowLabel,
      label.dataset.labelForm,
      label.style.top,
      label.style.left || label.style.right,
    ]);

  it('measures layout sizes, so a scale transform never letterboxes the drawing', () => {
    let reference: ReturnType<typeof placedLabels>;
    const plain = layoutAt(1332);
    try {
      const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
      expect(graph(view.container)).toHaveAttribute('viewBox', '0 0 1332 240');
      reference = placedLabels(view.container);
      view.unmount();
    } finally {
      plain.mockRestore();
    }
    const scaled = scaledLayoutAt(1332, 0.95);
    try {
      const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
      expect(band()).toHaveAttribute('data-flow-fit', 'fits');
      // The painted panel is 1265.4 px; the drawing still follows the 1332 px layout box
      // and the 240 px band, not 95% of either.
      expect(graph(view.container)).toHaveAttribute('viewBox', '0 0 1332 240');
      // Every label measured at its layout size: the same forms in the same places.
      expect(placedLabels(view.container)).toEqual(reference);
    } finally {
      scaled.mockRestore();
    }
  });

  it('draws Full screen at the panel width while its dialog is still scaling in', () => {
    const scaled = scaledLayoutAt(1332, 0.95, 400);
    try {
      const view = render(<NoiseFunnel data={fixture()} animate={false} variant="flat" wideInspection />);
      expect(graph(view.container)).toHaveAttribute('viewBox', '0 0 1332 400');
      expect(band()).toHaveAttribute('data-flow-fit', 'fits');
    } finally {
      scaled.mockRestore();
    }
  });

  it('adds no text to the page or the accessibility tree for its measurements', () => {
    const spy = layoutAt(1200);
    try {
      render(<NoiseFunnel data={fixture()} animate={false} variant="flat" />);
      const probe = screen.getByTestId('noise-flow-probe');
      expect(probe).toHaveAttribute('aria-hidden', 'true');
      expect(probe).toHaveClass('invisible', 'absolute');
      expect(probe.textContent).toBe('');
      expect(probe.querySelector('[data-stage-share]')).toBeNull();
      // Every label text is still found exactly once.
      expect(screen.getAllByText('Not analyst-closed', { exact: false }).length).toBeGreaterThan(0);
      expect(
        within(screen.getByTestId('noise-flow-band')).getAllByText(/^Not analyst-closed/),
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
