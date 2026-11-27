/**
 * ActiveRiskIndex — Round-7 W0.3 coverage.
 *
 * The ONE Command-Center risk instrument (#1): a compact caption + a (?) HelpTip and a
 * RiskGauge over the mean deterministic risk of the currently OPEN cases, degrading to
 * an honest DASH "no open cases" placeholder when there is nothing open to gauge.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ActiveRiskIndex, MIN_GAUGE_SIZE, MAX_GAUGE_SIZE } from '../ActiveRiskIndex';
import { ACTIVE_RISK_HELP_TEXT, activeRiskHelpText } from '../riskCopy';

/** jsdom reports `clientWidth === 0`; mock it to exercise the responsive-sizing path. */
function mockClientWidth(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => px,
  });
}

afterEach(() => {
  // Restore jsdom's real (0) clientWidth so other tests/files aren't affected.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 0,
  });
});

/** Read the rendered gauge bowl width off RiskGauge's own `.relative` sizing div. */
function gaugeBowlWidth(container: HTMLElement): number {
  const bowl = container.querySelector('.relative') as HTMLElement;
  return Number(bowl.style.width.replace('px', ''));
}

describe('ActiveRiskIndex (#1 Command-Center risk instrument)', () => {
  it('renders the RiskGauge with the score when there are open cases (count > 0)', () => {
    render(<ActiveRiskIndex score={62} count={7} />);

    // The caption + HelpTip head the instrument.
    expect(screen.getByText(/active risk index/i)).toBeInTheDocument();

    // The gauge renders (role="img" with a titled value) and shows the score.
    const gauge = screen.getByRole('img');
    expect(gauge).toBeInTheDocument();
    expect(gauge.textContent).toContain('62');

    // No empty placeholder when there are open cases.
    expect(screen.queryByTestId('active-risk-empty')).toBeNull();
  });

  it('renders a DASH "no open cases" placeholder (not a zero gauge) when count is 0', () => {
    render(<ActiveRiskIndex score={0} count={0} />);

    const empty = screen.getByTestId('active-risk-empty');
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toContain('—'); // DASH
    expect(empty.textContent?.toLowerCase()).toContain('no open cases');

    // The gauge is NOT drawn (no misleading zero arc).
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('degrades to the placeholder when count is omitted or the score is null', () => {
    // count undefined → treated as no open cases.
    const { rerender } = render(<ActiveRiskIndex score={40} />);
    expect(screen.getByTestId('active-risk-empty')).toBeInTheDocument();

    // A positive count but a null score also degrades (nothing to gauge).
    rerender(<ActiveRiskIndex score={null} count={3} />);
    expect(screen.getByTestId('active-risk-empty')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('always exposes the explanatory HelpTip affordance', () => {
    render(<ActiveRiskIndex score={62} count={7} />);
    // Long copy (>80 chars) opens as a Popover; the trigger is accessibly labelled.
    expect(
      screen.getByRole('button', { name: /what the active risk index means/i }),
    ).toBeInTheDocument();
  });

  it('words the help with the weights in force and explains the gauge from its metric (WP16)', async () => {
    const weights = { volume: 0, velocity: 0, reputation: 1, diversity: 0, asset_criticality: 0 };
    const { container } = render(<ActiveRiskIndex score={62} count={7} weights={weights} />);
    fireEvent.click(screen.getByRole('button', { name: /what the active risk index means/i }));
    expect(await screen.findByText(activeRiskHelpText(weights))).toBeInTheDocument();
    expect(activeRiskHelpText(weights)).toContain('Reputation 100% (heaviest)');
    const wrap = container.querySelector('[data-metric-explain="active_risk_index"]');
    expect(wrap).not.toBeNull();
    expect(wrap?.querySelector('[role="img"]')).not.toBeNull();
  });

  it('ACTIVE_RISK_HELP_TEXT is long enough to open the HelpTip Popover (>80 chars)', () => {
    // Guards the HelpTip Popover branch (usePopover fires when text.length > 80) so the
    // affordance is a focusable Popover, not a bare Tooltip.
    expect(ACTIVE_RISK_HELP_TEXT.length).toBeGreaterThan(80);
    // The band-cut ladder is documented in the copy (Round-7 W0.3 requirement).
    expect(ACTIVE_RISK_HELP_TEXT).toContain('Critical ≥74');
  });
});

describe('responsive gauge sizing (bug #5)', () => {
  it('falls back to a clamped default size when unmeasured (jsdom/no layout)', () => {
    const { container } = render(<ActiveRiskIndex score={62} count={7} />);
    // default `size` prop is 180, already inside [MIN_GAUGE_SIZE, MAX_GAUGE_SIZE].
    expect(gaugeBowlWidth(container)).toBe(180);
  });

  it('grows the gauge toward MAX_GAUGE_SIZE on a wide card, never past the cap', () => {
    mockClientWidth(600);
    const { container } = render(<ActiveRiskIndex score={62} count={7} />);
    expect(gaugeBowlWidth(container)).toBe(MAX_GAUGE_SIZE);
  });

  it('floors the gauge at MIN_GAUGE_SIZE on a very narrow card', () => {
    mockClientWidth(40);
    const { container } = render(<ActiveRiskIndex score={62} count={7} />);
    expect(gaugeBowlWidth(container)).toBe(MIN_GAUGE_SIZE);
  });

  it('tracks a mid-range measured width 1:1 inside the clamp band', () => {
    const mid = Math.round((MIN_GAUGE_SIZE + MAX_GAUGE_SIZE) / 2);
    mockClientWidth(mid);
    const { container } = render(<ActiveRiskIndex score={62} count={7} />);
    expect(gaugeBowlWidth(container)).toBe(mid);
  });
});

describe('vertical space usage (bug #5)', () => {
  it('the content wrapper stretches and centers (flex-1 + justify-center)', () => {
    render(<ActiveRiskIndex score={62} count={7} />);
    const content = screen.getByTestId('active-risk-content');
    expect(content.className).toContain('flex-1');
    expect(content.className).toContain('justify-center');
  });

  it('shows the open-case count + escalation-threshold mini-legend', () => {
    render(<ActiveRiskIndex score={62} count={7} />);
    expect(screen.getByText(/7 open cases/i)).toBeInTheDocument();
    expect(screen.getByText(/escalates ≥74/i)).toBeInTheDocument();
  });

  it('singularizes the mini-legend for exactly one open case', () => {
    render(<ActiveRiskIndex score={62} count={1} />);
    expect(screen.getByText(/1 open case\b/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 open cases/i)).toBeNull();
  });
});
