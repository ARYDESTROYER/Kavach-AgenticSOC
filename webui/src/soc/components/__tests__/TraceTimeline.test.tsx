/**
 * TraceTimeline — error-state coverage (Round-6 finding: adopt the shared LoadError).
 *
 * Pins that the timeline's failure state uses the shared `LoadError` primitive (the ONE
 * reusable load-failure panel) rather than a hand-rolled Alert+Button, and that the
 * error message is coerced through `errorMessage()` so a non-Error rejection still
 * surfaces its real message instead of a generic fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { TraceTimeline } from '../TraceTimeline';
import { ApiError } from '@/lib/api';
import { DASH } from '@/lib/format';

describe('TraceTimeline — error state (shared LoadError)', () => {
  it('renders the shared LoadError title + message and wires Retry', () => {
    const onRetry = vi.fn();
    render(<TraceTimeline data={null} error={new Error('backend exploded')} onRetry={onRetry} />);

    expect(screen.getByText('Could not load the timeline')).toBeInTheDocument();
    expect(screen.getByText('backend exploded')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('surfaces an ApiError detail via errorMessage() (not the generic fallback)', () => {
    // The old hand-rolled block used `error instanceof Error ? error.message : 'Something
    // went wrong.'`; an ApiError carrying the backend `detail` now surfaces it verbatim.
    render(<TraceTimeline data={null} error={new ApiError(500, 'timeline index unavailable')} />);
    expect(screen.getByText('timeline index unavailable')).toBeInTheDocument();
    // No Retry button when onRetry is omitted (LoadError contract).
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('TraceTimeline: the decision step labels (Round 14, SPEC §3.1)', () => {
  it('names the policy clause and each decision fact in sentence case at 12 px', () => {
    const decision = {
      id: 'span-9',
      case_id: 'case-1',
      step_index: 9,
      kind: 'decision' as const,
      name: 'decide',
      ts: '2026-10-28T10:00:00Z',
      latency_ms: null,
      cost: null,
      tokens: null,
      trusted: true,
      summary: 'Closed as a false positive under the auto-close policy.',
      payload_ref: {
        deterministic: true,
        verdict: 'false_positive',
        confidence: 0.94,
        risk_score: 18,
        decision_status: 'auto_closed',
        policy_clause: { verdict_class: 'false_positive', auto_closable: true, min_confidence: 0.9, max_risk_score: 40 },
      },
    };
    const { container } = render(
      <TraceTimeline data={{ case_id: 'case-1', spans: [decision], total: 1, totals: { cost: 0, tokens: 0 } }} />,
    );
    const step = screen.getByTestId('trace-decision-step');
    for (const label of ['Policy clause evaluated', 'Verdict', 'Confidence', 'Risk score', 'Result']) {
      const node = within(step).getByText(label);
      expect(node, label).toHaveClass('text-xs', 'font-medium');
      expect(node.className, label).not.toMatch(/uppercase|tracking-|text-\[/);
    }
    expect(container.innerHTML).not.toMatch(/text-\[(?:0?\.\d+rem|\d+px)\]/);
  });
});

describe('TraceTimeline: AI spend withheld without cost:view (Round 14 second acceptance pass, roles-11)', () => {
  const span = {
    id: 'span-1',
    case_id: 'case-1',
    step_index: 1,
    kind: 'router' as const,
    name: 'route',
    ts: '2026-10-28T10:00:00Z',
    latency_ms: 120,
    cost: null,
    tokens: null,
    trusted: true,
    summary: 'Routed to the investigator.',
    payload_ref: {},
  };
  const withheld = { case_id: 'case-1', spans: [span], total: 1, totals: { cost: null, tokens: null } };

  it('shows no cost badge and no dash when the server withholds the totals', () => {
    render(<TraceTimeline data={withheld} />);
    expect(screen.getByText('1 step')).toBeInTheDocument();
    expect(screen.queryByText(DASH)).toBeNull();
    expect(screen.queryByText(/tokens$/)).toBeNull();
  });

  it('shows no cost line in the case manager layout', () => {
    render(<TraceTimeline data={withheld} presentation="case-manager" />);
    expect(screen.queryByText(/^cost /)).toBeNull();
    expect(screen.queryByText(/tokens$/)).toBeNull();
  });

  it('still shows the recorded cost to a cost:view holder', () => {
    render(<TraceTimeline data={{ ...withheld, totals: { cost: 0.0123, tokens: 420 } }} presentation="case-manager" />);
    expect(screen.getByText(/^cost \$0\.0123$/)).toBeInTheDocument();
    expect(screen.getByText('420 tokens')).toBeInTheDocument();
  });
});
