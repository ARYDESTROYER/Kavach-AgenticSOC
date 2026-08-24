/**
 * HumanVsAiCard — component-level contract.
 *
 * The page-level guards live in `soc/__tests__/overview.humanvsai.test.tsx`; this file
 * pins the pieces the card owns on its own: the three labelled bands (the residual
 * always among them), the last-writer disclosure, and the null-as-GAP series contract
 * — a bucket with no measurement must reach the chart as `null`, never as a 0 that
 * would draw a confident line through missing evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { checkContrast } from '../../../../scripts/gate-contrast.mjs';
import { HumanVsAiCard, HUMAN_VS_AI_HELP, type HumanVsAiPoint } from '../HumanVsAiCard';

const SERIES: HumanVsAiPoint[] = [
  { x: '05:00', ai: 3, human: 1, system: 0 },
  // A bucket the backend could not measure: a GAP in every line, not three zeros.
  { x: '06:00', ai: null, human: null, system: null },
  { x: '07:00', ai: 2, human: 1, system: 1 },
];

describe('HumanVsAiCard', () => {
  it('names all three bands — the residual is never folded into either side', () => {
    render(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={SERIES}
        windowLabel="last 24 hours · 1h buckets"
      />,
    );
    const card = screen.getByTestId('human-vs-ai');
    expect(within(card).getByRole('heading', { name: 'Human vs AI', level: 2 })).toBeInTheDocument();
    expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('AI agent')).toBeInTheDocument();
    expect(within(within(card).getByTestId('human-vs-ai-human')).getByText('Human')).toBeInTheDocument();
    const residual = within(card).getByTestId('human-vs-ai-system');
    expect(within(residual).getByText('System')).toBeInTheDocument();
    // The short label is truncated by design, so the full meaning rides along.
    expect(within(residual).getByText('System')).toHaveAttribute(
      'title',
      'System routing or no recorded decider (unattributed)',
    );
    // 5 / 2 / 1 of 8 closed → 63 + 25 + 12 = 100 (largest remainder).
    const pcts = ['ai', 'human', 'system'].map((b) =>
      Number(
        within(within(card).getByTestId(`human-vs-ai-${b}`))
          .getByText(/^\d+%$/)
          .textContent!.replace('%', ''),
      ),
    );
    expect(pcts).toEqual([63, 25, 12]);
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('passes an unmeasured bucket through as a GAP, never as a zero', () => {
    const { container } = render(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={SERIES}
        windowLabel="last 24 hours · 1h buckets"
      />,
    );
    // recharts draws one <path> per line; a null point breaks the path into segments
    // rather than dipping it to the axis. Three real series are plotted.
    const lines = container.querySelectorAll('.recharts-line');
    expect(lines).toHaveLength(3);
    for (const line of Array.from(lines)) {
      const d = line.querySelector('.recharts-line-curve')?.getAttribute('d') ?? '';
      // A gap shows up as a second move command; a fabricated 0 would produce one
      // continuous path with no break at all.
      expect(d.split('M').length - 1).toBeGreaterThan(1);
    }
  });

  it('discloses the last-writer caveat in its help affordance', () => {
    render(
      <HumanVsAiCard totals={null} series={null} windowLabel="last 7 days · 6h buckets" />,
    );
    expect(
      screen.getByRole('button', { name: 'About Human vs AI attribution' }),
    ).toBeInTheDocument();
    expect(HUMAN_VS_AI_HELP).toMatch(
      /records the LAST decider on a case, not proof of who did the work/i,
    );
    expect(HUMAN_VS_AI_HELP).toMatch(/acknowledges or re-tags moves into the human share/i);
  });

  it('shows the caller-supplied reason (and em dashes) when attribution is unavailable', () => {
    render(
      <HumanVsAiCard
        totals={null}
        unavailableReason="Close attribution is unavailable for this window."
        series={null}
        windowLabel="last 24 hours"
      />,
    );
    const card = screen.getByTestId('human-vs-ai');
    expect(within(card).getByTestId('human-vs-ai-unavailable')).toHaveTextContent(
      'Close attribution is unavailable for this window.',
    );
    expect(within(card).getAllByText('—')).toHaveLength(6); // three counts + three shares
    expect(within(card).getByTestId('human-vs-ai-no-series')).toBeInTheDocument();
  });

  it('withholds the previous window\u2019s counts while a new window is in flight', () => {
    // Regression: `usePosture` is stale-while-revalidate, so on a range change the
    // partition still describes the OLD window while `windowLabel` already names the
    // NEW one. Publishing those counts under that label is a mislabel; the card shows
    // an em-dash/loading state instead until the fresh payload lands.
    render(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={SERIES}
        windowLabel="last 7 days · 6h buckets"
        stale
      />,
    );
    const card = screen.getByTestId('human-vs-ai');
    expect(within(card).getAllByText('—')).toHaveLength(6); // three counts + three shares
    for (const stale of ['5', '2', '1', '63%', '25%', '12%']) {
      expect(within(card).queryByText(stale)).toBeNull();
    }
    // The state is NAMED, not silently blank, and it is distinct from "unavailable".
    expect(within(card).getByTestId('human-vs-ai-stale')).toHaveTextContent(
      /Loading this window/i,
    );
    expect(within(card).queryByTestId('human-vs-ai-unavailable')).toBeNull();
  });

  it('keeps the counts but drops the shares on a bounded sample', () => {
    render(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={SERIES}
        windowLabel="last 24 hours · 1h buckets"
        truncated
      />,
    );
    const card = screen.getByTestId('human-vs-ai');
    expect(within(within(card).getByTestId('human-vs-ai-ai')).getByText('5')).toBeInTheDocument();
    expect(within(card).getAllByText('—')).toHaveLength(3); // shares only
    expect(within(card).getByText(/bounded sample, shares unavailable/i)).toBeInTheDocument();
  });
});

describe('HumanVsAiCard — contrast (WCAG AA in BOTH themes)', () => {
  const SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../HumanVsAiCard.tsx'),
    'utf8',
  );

  it('never dims a sized text class with an alpha modifier', () => {
    // Regression: the advisory (#3) line and the ingest-population caveat — the two
    // honesty sentences this card exists to state — shipped as
    // `text-2xs text-muted-foreground/80`. Tailwind emits a real
    // `hsl(var(--muted-foreground)/0.8)`, which composites to ~3.8:1 light / ~4.2:1
    // dark on `--card`: below the 4.5:1 AA bar for 11px text in BOTH themes. The token
    // at FULL strength clears it, so no sized text may carry an alpha modifier.
    const offenders = SOURCE.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(
        ({ line }) =>
          /\btext-(2xs|xs|sm|base|lg|xl|\dxl)\b/.test(line) &&
          /\btext-[a-z][a-z-]*\/\d{1,3}\b/.test(line),
      );
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  it('measures the full-strength muted token clearing the AA text bar in both themes', () => {
    // The gate's own math, so this is a MEASUREMENT of the fix, not a claim about it.
    const measured = checkContrast().results.filter(
      (r) => r.name === 'muted-foreground (text)',
    );
    expect(measured).toHaveLength(2); // light + dark
    for (const r of measured) {
      expect(r.bar).toBe(4.5);
      expect(r.ratio, `${r.theme}: ${r.ratio}`).toBeGreaterThanOrEqual(4.5);
      expect(r.pass).toBe(true);
    }
  });
});
