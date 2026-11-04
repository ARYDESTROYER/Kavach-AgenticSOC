import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, it } from 'vitest';

import { ComparisonMetric, MetricDefinition } from '../ComparisonMetric';

expect.extend(toHaveNoViolations);

const DEFINITION = {
  formula: '(agreed + 0.5 × partial) / graded cases',
  numerator: 'Agreed cases plus half-weighted partial agreements.',
  denominator: 'Closed cases carrying an analyst assessment.',
  eligibility: 'Cases graded during the selected reporting window.',
  caveats: [
    'Small samples can move sharply day to day.',
    'Agreement measures analyst alignment, not incident recall.',
  ],
} as const;

describe('ComparisonMetric', () => {
  it('reuses the KPI delta grammar and adds prior, sample, and sufficient status', () => {
    render(
      <ComparisonMetric
        label="Agreement rate"
        value="92%"
        prior="84%"
        delta={{ value: 8, label: '+8 pp' }}
        goodDirection="up"
        sample={{ count: 48, label: 'graded cases' }}
        status="sufficient"
        testId="agreement"
      />,
    );

    const region = screen.getByRole('region', { name: 'Agreement rate comparison metric' });
    expect(region).toHaveClass('border-y', 'border-border/70', 'bg-transparent');
    expect(region.className).not.toMatch(/rounded|shadow|bg-card/);
    const metricBody = screen.getByTestId('kpi-agreement-metric');
    expect(metricBody).toHaveClass('h-auto', 'min-h-0');
    expect(metricBody).not.toHaveClass('h-full');
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('84%')).toBeInTheDocument();
    expect(screen.getByText('48 graded cases')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Sufficient sample');

    // Direction + judgement remain owned by KpiTile, not reimplemented here.
    const delta = screen.getByRole('img', { name: 'changed up by +8 pp, improved' });
    expect(delta).toHaveClass('text-success-text');
  });

  it('keeps a measured value visible while explicitly warning that its sample is insufficient', () => {
    render(
      <ComparisonMetric
        label="Correction rate"
        value="18%"
        prior="12%"
        delta={{ value: 6, label: '+6 pp' }}
        goodDirection="down"
        sample={4}
        status="insufficient"
      />,
    );

    expect(screen.getByText('18%')).toBeInTheDocument();
    expect(screen.getByText('4 samples')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Insufficient sample');
    expect(screen.getByRole('status')).toHaveClass('text-warning-text');
    expect(screen.getByRole('img', { name: 'changed up by +6 pp, worse' })).toBeInTheDocument();
  });

  it('renders an honest unavailable state and suppresses a stale value and delta', () => {
    render(
      <ComparisonMetric
        label="Missed escalation proxy"
        value="91%"
        prior="89%"
        delta={{ value: 2, label: '+2 pp' }}
        status="unavailable"
      />,
    );

    expect(screen.queryByText('91%')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^changed/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable');
  });

  it('distinguishes a still-collecting cohort from an unavailable benchmark', () => {
    const { rerender } = render(
      <ComparisonMetric
        label="True-positive alert yield"
        value="8.0%"
        prior="7.5%"
        delta={{ value: 0.5, label: '+0.5 pp' }}
        sample={{ count: 6, label: 'eligible alerts' }}
        status="collecting"
        statusReason="The current complete-day window has not reached 20 eligible alerts."
      />,
    );

    expect(screen.getByText('8.0%')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Collecting evidence');
    expect(screen.getByText(/has not reached 20 eligible alerts/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^changed/)).not.toBeInTheDocument();

    rerender(
      <ComparisonMetric
        label="Estimated analyst time saved"
        value="4h 10m"
        prior="3h 45m"
        status="unavailable"
        statusReason="No comparable human-closed cases yet."
      />,
    );

    expect(screen.queryByText('4h 10m')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable');
    expect(screen.getByText('No comparable human-closed cases yet.')).toBeInTheDocument();
  });

  it('keeps not-applicable distinct from unavailable and suppresses stale measurements', () => {
    render(
      <ComparisonMetric
        label="Estimated analyst time saved"
        value="4h 10m"
        prior="3h 45m"
        delta={{ value: 11, label: '+11%' }}
        status="not_applicable"
        statusReason="No agent-handled cases were eligible in this window."
      />,
    );

    expect(screen.queryByText('4h 10m')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Not applicable');
    expect(screen.getByText(/No agent-handled cases/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^changed/)).not.toBeInTheDocument();
  });

  it('includes the structured definition trigger without adding card chrome or animation', () => {
    render(
      <ComparisonMetric
        label="Agreement rate"
        value="92%"
        prior="84%"
        sample={48}
        status="sufficient"
        definition={DEFINITION}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'How Agreement rate is measured' });
    expect(trigger).toHaveClass('motion-reduce:transition-none');
    expect(trigger.className).not.toMatch(/shadow|animate-/);
  });
});

describe('ComparisonMetric type (Round 14, SPEC §3.1)', () => {
  const MONO = /(^|\s)font-mono(\s|$)/;

  it.each(['standalone', 'integrated'] as const)(
    'sets the prior and sample figures in the body face with tabular figures, never truncated (%s)',
    (variant) => {
      render(
        <ComparisonMetric
          label="Agreement rate"
          value="92%"
          prior="84%"
          sample={{ count: 1248, label: 'graded cases' }}
          status="sufficient"
          statusReason="Every graded case in the window counts."
          variant={variant}
        />,
      );
      const prior = screen.getByText('84%');
      expect(prior.className).not.toMatch(MONO);
      expect(prior).toHaveClass('tabular-nums', 'whitespace-nowrap');
      expect(prior).not.toHaveClass('truncate');
      const sample = screen.getByText(`${(1248).toLocaleString()} graded cases`);
      expect(sample.className).not.toMatch(MONO);
      expect(sample).toHaveClass('tabular-nums', 'text-xs');
      expect(sample).not.toHaveClass('truncate');
      // Stat context is 12 px or larger (ui-standard: 11 px is for badges, ticks and times).
      expect(screen.getByText('Every graded case in the window counts.')).toHaveClass('text-xs');
      const region = screen.getByRole('region', { name: 'Agreement rate comparison metric' });
      expect(region.innerHTML).not.toMatch(/font-mono|text-2xs/);
    },
  );
});

describe('MetricDefinition', () => {
  it('opens a persistent Radix surface by keyboard and exposes every definition field', async () => {
    const user = userEvent.setup();
    render(<MetricDefinition metric="Agreement rate" {...DEFINITION} />);

    const trigger = screen.getByRole('button', { name: 'How Agreement rate is measured' });
    trigger.focus();
    await user.keyboard('{Enter}');

    const surface = await screen.findByRole('dialog', {
      name: 'Agreement rate metric definition',
    });
    expect(surface).toBeInTheDocument();
    expect(screen.getByText(DEFINITION.formula)).toBeInTheDocument();
    // Sentence-case labels in the body face: no tracked capitals, nothing below 12 px.
    const labels = ['Metric definition', 'Formula', 'Numerator', 'Denominator', 'Eligibility', 'Caveats'];
    for (const label of labels) {
      const node = within(surface).getByText(label);
      expect(node.className, label).not.toMatch(/uppercase|tracking-|text-2xs/);
      expect(node).toHaveClass('text-xs', 'font-medium');
    }
    // The formula is the one code-like value, so it alone keeps the identifier face.
    expect(within(surface).getByText(DEFINITION.formula)).toHaveClass('font-mono', 'text-xs');
    expect(screen.getByText(DEFINITION.numerator)).toBeInTheDocument();
    expect(screen.getByText(DEFINITION.denominator)).toBeInTheDocument();
    expect(screen.getByText(DEFINITION.eligibility)).toBeInTheDocument();
    for (const caveat of DEFINITION.caveats) {
      expect(screen.getByText(caveat)).toBeInTheDocument();
    }

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('opens by pointer/touch activation and passes an accessibility smoke check', async () => {
    const user = userEvent.setup();
    render(<MetricDefinition metric="Agreement rate" {...DEFINITION} />);

    await user.click(screen.getByRole('button', { name: 'How Agreement rate is measured' }));
    expect(
      await screen.findByRole('dialog', { name: 'Agreement rate metric definition' }),
    ).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('keeps a phone gutter and scrolls instead of running past the screen', async () => {
    const user = userEvent.setup();
    render(<MetricDefinition metric="Agreement rate" {...DEFINITION} />);

    await user.click(screen.getByRole('button', { name: 'How Agreement rate is measured' }));
    const surface = await screen.findByRole('dialog', { name: 'Agreement rate metric definition' });
    // Never taller than the room Radix measures beside the trigger (minus the 16 px
    // collision padding): a long definition scrolls inside the popover.
    expect(surface).toHaveClass('max-h-[var(--radix-popover-content-available-height)]', 'overflow-y-auto');
    // Never wider than the screen less a 16 px gutter on each side.
    expect(surface).toHaveClass('w-[min(24rem,calc(100vw-2rem))]');
  });
});
