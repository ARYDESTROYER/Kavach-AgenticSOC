/**
 * BaselineGauge — Round-4 Wave-5 coverage.
 *
 * Pins the load-bearing facts:
 *   1. the "baseline warming up (n/target)" state is VISIBLE (so "improves over time"
 *      is auditable) — a warming bucket shows "Warming up" + n/target obs, a warm one
 *      shows "Warm";
 *   2. the per-signature card renders the signature as PLAIN TEXT (#9) — any markup in
 *      a source-derived signature appears literally, never as live DOM;
 *   3. the stats overview surfaces signature/bucket counts + warm buckets + seasonality;
 *   4. an unseen signature (found=false) degrades to a renderable shell (no crash).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  BaselineWarmupGauge,
  BaselineSignatureCard,
  BaselineStatsOverview,
} from '../BaselineGauge';
import type { BaselineSignature, BaselineStats } from '@/soc/Baseline.api';

const SIGNATURE: BaselineSignature = {
  signature: 'sig::brute_force::10.0.0.5',
  found: true,
  warmup_target: 504,
  buckets: 3,
  warm_buckets: 2,
  seasonality: 'hour_of_week',
  series: [
    { bucket: 0, n: 504, target: 504, warm: true, progress: 1, p50: 12, p95: 40, p99: 88 },
    { bucket: 1, n: 504, target: 504, warm: true, progress: 1, p50: 9, p95: 30, p99: 61 },
    { bucket: 2, n: 120, target: 504, warm: false, progress: 120 / 504, p50: 4, p95: 11, p99: 20 },
  ],
};

const STATS: BaselineStats = {
  enabled: true,
  signature_count: 7,
  total_buckets: 21,
  warm_buckets: 14,
  warmup_target: 504,
  seasonality: 'hour_of_week',
  half_life_days: 14,
  modified_z_threshold: 3.5,
  sketch_version: 1,
  signatures: [
    { signature: 'sig::a', buckets: 3, warm_buckets: 3, max_samples: 600, fully_warm: true },
    { signature: 'sig::b', buckets: 3, warm_buckets: 1, max_samples: 200, fully_warm: false },
  ],
};

describe('BaselineWarmupGauge (n/target visibility)', () => {
  it('shows a "Warming up" badge + the n/target observation count while warming', () => {
    render(<BaselineWarmupGauge n={120} target={504} />);
    expect(screen.getByText('Warming up')).toBeInTheDocument();
    // The audit-critical "n / target obs" caption is present.
    expect(screen.getByText(/120 \/ 504 obs/)).toBeInTheDocument();
  });

  it('shows a "Warm" badge once n >= target', () => {
    render(<BaselineWarmupGauge n={504} target={504} />);
    expect(screen.getByText('Warm')).toBeInTheDocument();
    expect(screen.queryByText('Warming up')).toBeNull();
  });

  it('accepts a custom `unit` so aggregate cards read "buckets warm", not "obs"', () => {
    render(<BaselineWarmupGauge n={2} target={3} unit="buckets warm" />);
    expect(screen.getByText(/2 \/ 3 buckets warm/)).toBeInTheDocument();
    // The default "obs" suffix must NOT appear when a unit is supplied.
    expect(screen.queryByText(/2 \/ 3 obs/)).toBeNull();
  });

  it('drives the warm fill via the Progress `variant` (bg-success indicator), not a [&>div] override', () => {
    const { container } = render(<BaselineWarmupGauge n={504} target={504} />);
    // warm → success variant → the indicator fill carries bg-success directly.
    expect(container.querySelector('.bg-success')).not.toBeNull();
    // and it no longer relies on the arbitrary child-selector override.
    expect(container.innerHTML).not.toContain('[&>div]:bg-success');
  });

  it('uses the default (primary) fill while still warming', () => {
    const { container } = render(<BaselineWarmupGauge n={100} target={504} />);
    expect(container.querySelector('.bg-success')).toBeNull();
    expect(container.querySelector('.bg-primary')).not.toBeNull();
  });
});

describe('BaselineSignatureCard', () => {
  it('renders the source-derived signature as plain text (#9) + the buckets-warm gauge', () => {
    render(<BaselineSignatureCard data={SIGNATURE} />);
    // Signature is a plain text node (verbatim, not parsed as markup).
    expect(screen.getByText('sig::brute_force::10.0.0.5')).toBeInTheDocument();
    // "2 of 3 buckets warm" gauge label surfaces the warm-up progress.
    expect(screen.getByText(/2 of 3 buckets warm/)).toBeInTheDocument();
    // The aggregate gauge counts BUCKETS, not observations — no "/ 3 obs" mislabel.
    expect(screen.queryByText(/\/ 3 obs/)).toBeNull();
    // p50/p95/p99 read-out labels are present.
    expect(screen.getByText('p50')).toBeInTheDocument();
    expect(screen.getByText('p95')).toBeInTheDocument();
    expect(screen.getByText('p99')).toBeInTheDocument();
  });

  it('does NOT inject markup from a hostile signature (#9)', () => {
    const hostile: BaselineSignature = { ...SIGNATURE, signature: '<img src=x onerror=alert(1)>' };
    const { container } = render(<BaselineSignatureCard data={hostile} />);
    // The literal string is rendered; no <img> element escaped the fence.
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('degrades to a renderable shell for an unseen signature (found=false)', () => {
    const empty: BaselineSignature = {
      signature: 'sig::never-seen',
      found: false,
      warmup_target: 504,
      buckets: 0,
      warm_buckets: 0,
      seasonality: 'hour_of_week',
      series: [],
    };
    render(<BaselineSignatureCard data={empty} />);
    expect(screen.getByText('sig::never-seen')).toBeInTheDocument();
    expect(screen.getByText(/No baseline recorded/i)).toBeInTheDocument();
  });

  it('renders embedded (CaseDetail) without the standalone card title', () => {
    render(<BaselineSignatureCard data={SIGNATURE} embedded />);
    expect(screen.getByText('Anomaly baseline')).toBeInTheDocument();
    expect(screen.queryByText('Signature baseline')).toBeNull();
  });
});

describe('BaselineStatsOverview', () => {
  it('surfaces signature/bucket counts, warm buckets and seasonality', () => {
    render(<BaselineStatsOverview stats={STATS} />);
    expect(screen.getByText('Signatures')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Warm buckets')).toBeInTheDocument();
    // "of 21 (67%)" sub-line proves warm-vs-total is shown.
    expect(screen.getByText(/of 21 \(67%\)/)).toBeInTheDocument();
    // Seasonality humanized.
    expect(screen.getAllByText(/Hour of week/i).length).toBeGreaterThan(0);
  });
});

describe('BaselineGauge on the Round 14 grammar (BL2, BL4, F13)', () => {
  it('uses no text under 11px and no tracked capitals', () => {
    const { container } = render(
      <>
        <BaselineSignatureCard data={SIGNATURE} />
        <BaselineSignatureCard data={SIGNATURE} embedded />
        <BaselineStatsOverview stats={STATS} />
      </>,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/text-\[(?:[0-9]|10)px\]/);
    expect(html).not.toMatch(/uppercase/);
    expect(container.textContent ?? '').not.toContain('—');
  });

  it('renders the overview as a KpiStrip of counts with seasonality as context text', () => {
    render(<BaselineStatsOverview stats={STATS} />);
    const strip = screen.getByRole('group', { name: 'Baseline summary' });
    expect(strip).toHaveAttribute('data-kpi-strip', 'compact');
    expect(strip.textContent).not.toMatch(/Seasonality/);
    expect(screen.getByText('Baseline on')).toBeInTheDocument();
    expect(screen.getByText('observations per bucket')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Overall warm-up' })).toHaveClass('surface-panel');
    expect(screen.getByTestId('baseline-context')).toHaveTextContent(/Seasonality Hour of week/);
  });

  it('draws the standalone signature view as a panel, not a nested card', () => {
    render(<BaselineSignatureCard data={SIGNATURE} />);
    const panel = screen.getByRole('region', { name: 'Signature baseline' });
    expect(panel).toHaveClass('surface-panel');
    expect(screen.getByText('Warming')).toBeInTheDocument();
    expect(screen.getByText('p95 over the season')).toBeInTheDocument();
  });
});
