/**
 * TimelinePanel: the clean "what happened" narrative (task 5 split).
 *
 * The Timeline tab now holds ONLY the six-stage <StageTimeline> narrative: no AI
 * assessment, no DecisionCard, no ReAct trace (those moved to <InvestigationPanel>).
 * Verifies the "what happened" header + the stage story render, and that the
 * loading/error states pass through.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { TimelinePanel } from '../TimelinePanel';
import type { TimelineStagesResponse } from '@/soc/pages/CaseDetail.api';

expect.extend(toHaveNoViolations);

const STAGES: TimelineStagesResponse = {
  case_id: 'c1',
  total: 1,
  stages: [
    {
      id: 'input',
      kind: 'input',
      label: 'Alert received',
      status: 'done',
      deterministic: false,
      headline: 'Six alerts from Lab Elastic',
      state: {},
      steps: [],
    },
  ],
};

/** Mirrors the backend's fixed input → correlate → risk → triage → investigate → decide order. */
const LIVE_SIX_STAGE_STORY: TimelineStagesResponse = {
  case_id: 'case-2026-00892',
  total: 6,
  stages: [
    {
      id: 'input',
      kind: 'input',
      label: 'Alert ingested',
      status: 'done',
      deterministic: false,
      ts: '2026-07-20T10:42:01Z',
      headline: 'Initial signal received from AWS CloudTrail.',
      state: { severity_band: 'critical', severity_source: 'source_asserted' },
      steps: [
        {
          kind: 'tool',
          label: 'Source details',
          body: 'origin: 198.51.100.45\nidentity: svc-data-sync\n<script>escape()</script>',
          trusted: false,
          ts: '2026-07-20T10:42:01Z',
        },
      ],
    },
    {
      id: 'correlate',
      kind: 'correlate',
      label: 'Agent correlated data',
      status: 'done',
      deterministic: true,
      ts: '2026-07-20T10:42:15Z',
      headline: 'The source IP matched a known Tor exit node.',
      state: {},
      steps: [],
    },
    {
      id: 'risk',
      kind: 'risk',
      label: 'Anomalous activity detected',
      status: 'done',
      deterministic: true,
      ts: '2026-07-20T10:45:33Z',
      headline: 'Data transfer volume deviated significantly from baseline.',
      state: { risk_score: 92 },
      steps: [],
    },
    {
      id: 'triage',
      kind: 'triage',
      label: 'Triage routed',
      status: 'done',
      deterministic: false,
      ts: '2026-07-20T10:45:40Z',
      headline: 'The case passed the cost gate and was routed for investigation.',
      state: {},
      steps: [],
    },
    {
      id: 'investigate',
      kind: 'investigate',
      label: 'Investigation completed',
      status: 'done',
      deterministic: false,
      ts: '2026-07-20T10:45:58Z',
      headline: 'The investigator found evidence consistent with exfiltration.',
      state: { verdict: 'true_positive', confidence: 0.94 },
      steps: [],
    },
    {
      id: 'decide',
      kind: 'decide',
      label: 'Decision finalized',
      status: 'done',
      deterministic: true,
      ts: '2026-07-20T10:46:00Z',
      headline: 'The deterministic case manager escalated the case.',
      state: { risk_score: 92, verdict: 'true_positive', confidence: 0.94 },
      steps: [],
    },
  ],
};

describe('TimelinePanel: the "what happened" narrative', () => {
  it('renders the stage story, leaving its "What happened" heading to the Overview section', () => {
    render(
      <TimelinePanel
        stages={STAGES}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );
    expect(screen.getByText('Six alerts from Lab Elastic')).toBeInTheDocument();
    // Round 15 (D8.3): the Overview's "What happened" section owns the heading.
    expect(screen.queryByText('What happened')).toBeNull();
  });

  it('does NOT render the AI assessment / decision / trace (those live on Investigation)', () => {
    render(
      <TimelinePanel
        stages={STAGES}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );
    expect(screen.queryByText('AI assessment')).toBeNull();
    expect(screen.queryByText('Deterministic decision')).toBeNull();
    expect(screen.queryByRole('button', { name: /full agent trace/i })).toBeNull();
  });

  it('passes a loading state through to the stage timeline (skeleton)', () => {
    render(
      <TimelinePanel
        stages={null}
        stagesLoading
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );
    // The stage body shows the loading state (no story).
    expect(screen.getByText('Loading timeline')).toBeInTheDocument();
    expect(screen.queryByText('Six alerts from Lab Elastic')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <TimelinePanel
        stages={STAGES}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders the live six-stage story in order and opens Investigation from the trace CTA', () => {
    const onOpenInvestigation = vi.fn();
    const { container } = render(
      <TimelinePanel
        stages={LIVE_SIX_STAGE_STORY}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
        onOpenInvestigation={onOpenInvestigation}
      />,
    );

    const panel = container.querySelector(
      '[data-case-panel="timeline"][data-presentation="case-manager"]',
    );
    expect(panel).not.toBeNull();

    const stageHeadings = within(panel as HTMLElement)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(stageHeadings).toEqual([
      'Alert ingested',
      'Agent correlated data',
      'Anomalous activity detected',
      'Triage routed',
      'Investigation completed',
      'Decision finalized',
    ]);

    fireEvent.click(screen.getByRole('button', { name: /view deterministic trace/i }));
    expect(onOpenInvestigation).toHaveBeenCalledTimes(1);
  });

  it('keeps backend source material fenced in a CodeBlock', () => {
    const { container } = render(
      <TimelinePanel
        stages={LIVE_SIX_STAGE_STORY}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
      />,
    );

    const raw = screen.getByText(/origin: 198\.51\.100\.45/);
    expect(raw.tagName).toBe('CODE');
    expect(raw).toHaveTextContent('<script>escape()</script>');
    expect(container.querySelector('script')).toBeNull();
  });

  it('has no axe violations with the live story and its trace link', async () => {
    const { container } = render(
      <TimelinePanel
        stages={LIVE_SIX_STAGE_STORY}
        stagesLoading={false}
        stagesError={null}
        onRetryStages={vi.fn()}
        onOpenInvestigation={vi.fn()}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
