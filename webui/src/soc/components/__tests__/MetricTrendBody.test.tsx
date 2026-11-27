/**
 * MetricTrendBody — the column trend every KPI hover card and drill-down panel states.
 *
 * It replaced a smoothed sparkline that plotted MEASURED points only, evenly spaced, so a
 * window with four measured buckets out of twenty-five drew one swooping curve with no
 * time axis under it. These cases pin what the columns promise instead: every bucket in
 * its own slot, unmeasured never drawn as zero, a measured zero still a mark, and a
 * readout that names the bucket being read.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { MetricTrendBody, bucketWhen } from '../MetricHoverTrend';

const pct = (n: number) => `${n}%`;

function columns() {
  return screen.getByTestId('metric-trend-columns');
}

describe('MetricTrendBody — one column per bucket', () => {
  const POINTS = [
    { label: '2026-10-06T01:00:00Z', value: 100 },
    { label: '2026-10-06T02:00:00Z', value: null },
    { label: '2026-10-06T03:00:00Z', value: 0 },
    { label: '2026-10-06T04:00:00Z', value: 50 },
    { label: '2026-10-06T05:00:00Z', value: null },
  ];

  it('keeps every bucket in its slot and never draws an unmeasured one as zero', () => {
    render(
      <MetricTrendBody metric="False positive rate" points={POINTS} windowLabel="last 5 hours" format={pct} />,
    );
    const rects = Array.from(columns().querySelectorAll('rect[data-state]'));
    expect(rects.map((r) => r.getAttribute('data-state'))).toEqual([
      'measured',
      'unmeasured',
      'zero',
      'measured',
      'unmeasured',
    ]);
    // The slot is the bucket's position in TIME: column 4 sits at x = 3 slots, not at
    // "the third measured point".
    expect(Number(rects[3].getAttribute('x'))).toBeGreaterThan(Number(rects[2].getAttribute('x')));
    expect(Number(rects[3].getAttribute('x'))).toBe(31.5);
    // A measured zero is a visible hairline in the series colour, an unmeasured bucket a
    // muted floor tick — two different marks for two different facts.
    expect(rects[2].getAttribute('fill')).toBe(rects[0].getAttribute('fill'));
    expect(rects[1].getAttribute('fill')).not.toBe(rects[0].getAttribute('fill'));
    expect(screen.getByText('3 of 5 buckets measured.')).toBeInTheDocument();
  });

  it('states first, peak and latest, and names the trend for assistive tech', () => {
    render(
      <MetricTrendBody metric="False positive rate" points={POINTS} windowLabel="last 5 hours" format={pct} />,
    );
    expect(screen.getByText('first 100%')).toBeInTheDocument();
    expect(screen.getByText('peak 100%')).toBeInTheDocument();
    expect(screen.getByText('latest 50%')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'False positive rate trend: first 100%, latest 50%' })).toBe(
      columns(),
    );
  });

  it('reads out the latest MEASURED bucket by default, and the pointed one on hover', () => {
    render(
      <MetricTrendBody metric="False positive rate" points={POINTS} windowLabel="last 5 hours" format={pct} />,
    );
    const readout = screen.getByTestId('metric-trend-readout');
    // The trailing bucket is unmeasured, so the default is the one before it.
    expect(readout).toHaveTextContent('Oct 6, 04:00 UTC');
    expect(readout).toHaveTextContent('50%');

    const svg = columns();
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 48, right: 100, bottom: 48, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // jsdom has no PointerEvent with coordinates, so a MouseEvent carries the type.
    const move = (clientX: number) =>
      fireEvent(svg, new MouseEvent('pointermove', { clientX, bubbles: true }));
    move(30); // slot 1 of 5: unmeasured
    expect(readout).toHaveTextContent('Oct 6, 02:00 UTC');
    expect(within(readout).getByText('not measured')).toBeInTheDocument();
    move(5); // slot 0
    expect(readout).toHaveTextContent('100%');
    fireEvent.pointerLeave(svg);
    expect(readout).toHaveTextContent('Oct 6, 04:00 UTC');
  });

  it('draws nothing at all below two measured buckets', () => {
    render(
      <MetricTrendBody
        metric="MTTD · daily mean"
        points={[
          { label: '2026-10-05', value: 3 },
          { label: '2026-10-06', value: null },
        ]}
        windowLabel="per UTC day · 2 days"
      />,
    );
    expect(screen.getByText('No trend data yet.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByTestId('metric-trend-readout')).toBeNull();
  });
});

describe('bucketWhen', () => {
  it('states an instant in UTC, a date as a day, and anything else verbatim', () => {
    expect(bucketWhen('2026-10-06T05:00:00Z')).toBe('Oct 6, 05:00 UTC');
    expect(bucketWhen('2026-10-06T00:00:00Z')).toBe('Oct 6, 00:00 UTC');
    expect(bucketWhen('2026-10-05')).toBe('Oct 5');
    expect(bucketWhen('week 41')).toBe('week 41');
    expect(bucketWhen('')).toBe('');
  });
});
