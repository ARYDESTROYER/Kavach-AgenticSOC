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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { checkContrast } from '../../../../scripts/gate-contrast.mjs';
import { HumanVsAiCard, HUMAN_VS_AI_HELP, type HumanVsAiPoint } from '../HumanVsAiCard';
import { CloseAttributionChart, bucketRangeLabel } from '../CloseAttributionChart';
import { token } from '../palette';

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

  it('gives the trend a fill box with a floor, and never stretches the no-series line', () => {
    // The chart used to be pinned at `height={122}` inside a stretched flex column, so
    // every spare pixel of the cell became dead space under it. It now FILLS
    // (`MultiSeriesTrend fill` → `absolute inset-0`), which needs exactly two things from
    // this wrapper and both are asserted here because jsdom has no layout engine and the
    // resulting HEIGHT is therefore not assertable at all:
    //   `relative`        — the positioned ancestor `inset-0` resolves against;
    //   `min-h-[122px]`   — the floor, without which a flex item with no free space
    //                       collapses to zero (the real case on every load tick where
    //                       this card is the row's only child, and below `xl`);
    //   `xl:min-h-[160px]` — the raised floor the two relocated prose lines paid for. It
    //                       binds only where nothing stretches the card, and `xl` is
    //                       exactly where this card is one narrow column beside the flow
    //                       diagram — the width at which the chart was starved. Asserted
    //                       WITH the base floor, never instead of it: dropping either one
    //                       collapses a different case.
    const { rerender } = render(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={SERIES}
        windowLabel="last 24 hours · 1h buckets"
      />,
    );
    const chart = screen.getByTestId('human-vs-ai-chart');
    expect(chart).toHaveClass('relative', 'min-h-[122px]', 'xl:min-h-[160px]', 'flex-1');

    // …and the chart INSIDE it is really in fill mode. jsdom cannot measure the resulting
    // height — `src/test/setup.ts` says so, and that is honest — but the MODE is fully
    // assertable, and the mode is the whole change: `fill` renders the chart box as
    // `absolute inset-0` with NO inline height, which is the difference between sizing to
    // this cell and sizing to a constant. Without this pair, reverting `fill` back to
    // `height={122}` — the exact dead-space regression this card exists to fix — passes
    // every gate in the repo.
    //
    // The labelled figure is a `group`, not an `img`, since the stacked-column rebuild:
    // it is now ONE keyboard stop with arrow-key navigation and a live region, and `img`
    // would make all of that presentational. Same figure, same name, same fill contract.
    const box = within(chart).getByRole('group', {
      name: /closed by the agent versus by a human/i,
    });
    expect(box).toHaveClass('absolute', 'inset-0');
    expect(box.style.height).toBe('');

    // …and the empty arm does NOT take `flex-1`: one line of text stretched to fill the
    // cell opened a gap three times the size of the one the chart used to leave.
    rerender(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={null}
        windowLabel="last 24 hours · 1h buckets"
      />,
    );
    expect(screen.getByTestId('human-vs-ai-no-series')).not.toHaveClass('flex-1');
  });

  it('passes an unmeasured bucket through as a GAP, never as a zero', () => {
    render(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={SERIES}
        windowLabel="last 24 hours · 1h buckets"
      />,
    );
    // The chart is stacked columns now, not three lines, so "a gap in each line" becomes
    // its column equivalent: the null bucket is drawn as an explicitly UNMEASURED column
    // (a hatched band, no bar segments at all) — never as a zero-height bar, which is
    // what a recharts stack would have drawn after coercing its `null` to 0.
    const slots = screen.getAllByTestId('human-vs-ai-slot');
    expect(slots).toHaveLength(3);
    const gap = slots[1];
    expect(gap).toHaveAttribute('data-state', 'unmeasured');
    expect(gap).not.toHaveAttribute('data-state', 'zero');
    expect(within(gap).getByTestId('human-vs-ai-unmeasured')).toBeInTheDocument();
    expect(gap.querySelectorAll('[data-segment]')).toHaveLength(0);
    // …while the measured buckets either side are real bars, and all three series are
    // plotted (3/1/0 then 2/1/1 — the residual appears where it is non-zero).
    for (const measured of [slots[0], slots[2]]) {
      expect(measured).toHaveAttribute('data-state', 'measured');
      expect(within(measured).queryByTestId('human-vs-ai-unmeasured')).toBeNull();
    }
    const plotted = new Set(
      Array.from(document.querySelectorAll('[data-segment]')).map((n) => n.getAttribute('data-segment')),
    );
    expect(plotted).toEqual(new Set(['ai', 'human', 'system']));
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

  it('keeps the #3 advisory reachable after it left the card face', async () => {
    // The always-visible "Advisory only — the agent recommends; the deterministic case
    // manager decides" paragraph was removed from the card at the operator's request. It
    // is a RELOCATION, not a deletion, and this is the spec that says so: the sentence
    // survives verbatim in HUMAN_VS_AI_HELP, and `alwaysPopover` makes the (?) a POPOVER
    // trigger — reached below by click and by Enter. A Radix tooltip never opens on touch,
    // which is why the length heuristic is not relied on; that the flag (and not the
    // heuristic) is what forces the popover is pinned separately, with short text where the
    // two disagree, in `HelpTip.test.tsx`.
    render(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={SERIES}
        windowLabel="last 24 hours · 1h buckets"
      />,
    );
    const card = screen.getByTestId('human-vs-ai');
    expect(within(card).queryByText(/never influences that/i)).toBeNull();

    const trigger = screen.getByRole('button', { name: 'About Human vs AI attribution' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      /the agent recommends; the deterministic case manager decides/i,
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(/never influences that/i);

    // KEYBOARD too, not just pointer — the comment above claims Enter reaches it, so prove
    // it rather than asserting a click and describing four input methods.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toHaveTextContent(/never influences that/i);
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

  it('RELOCATES the two face prose lines rather than deleting them', () => {
    // Two static lines came off the face to give the chart its height back. Neither may
    // simply vanish, and this is the guard that says so — the card's own suite, because
    // the page-level file cannot open the popover the copy landed in.
    render(
      <HumanVsAiCard
        totals={{ ai: 5, human: 2, system: 1, closed: 8 }}
        series={SERIES}
        windowLabel="last 24 hours · 1h buckets"
        alertsIngested={125}
      />,
    );
    const card = screen.getByTestId('human-vs-ai');

    // 1. The subtitle. Off the visible face, but STILL describing the region to assistive
    //    tech from an `sr-only` node INSIDE the section — never an IDREF at the popover,
    //    which Radix portals with no `forceMount` and would dangle while closed.
    const describedBy = card.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = card.querySelector(`#${CSS.escape(describedBy!)}`);
    expect(description).not.toBeNull();
    expect(description).toHaveClass('sr-only');
    expect(description).toHaveTextContent(/How this window’s cases were closed\./i);
    // …and its full form, with the denominator it names, is in the help.
    expect(HUMAN_VS_AI_HELP).toMatch(/How this window’s cases were closed, as a share of closed cases\./i);

    // 2. The alerts caveat. The numeral keeps a POPULATION word on the face, because a
    //    bare count beside a case cohort reads as part of it; the clause that says which
    //    population moved to the help.
    const alerts = within(card).getByTestId('human-vs-ai-alerts');
    expect(alerts).toHaveTextContent('125 alerts ingested');
    expect(alerts).not.toHaveTextContent(/ingest-hour tally/i);
    expect(HUMAN_VS_AI_HELP).toMatch(/ingest-hour tally, not this case cohort/i);

    // 3. The chart's ONLY axis caption stays on the face, bare. It is stated nowhere else
    //    and cannot be inferred from the bars, so it did not travel with the prose.
    expect(within(card).getByText('last 24 hours · 1h buckets')).toBeInTheDocument();
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

/**
 * Four buckets that exercise every column state: a full 2/1/1 stack, an UNMEASURED bucket
 * (the agent band is null), a measured ZERO, and the newest, still-filling bucket.
 */
const RICH: HumanVsAiPoint[] = [
  {
    x: '05:00', start: '2026-07-01T05:00:00.000Z', end: '2026-07-01T06:00:00.000Z',
    ai: 2, human: 1, system: 1, closed: 4, newCases: 6, sentToHuman: 1, fpRate: 50, alerts: 40,
  },
  {
    x: '06:00', start: '2026-07-01T06:00:00.000Z', end: '2026-07-01T07:00:00.000Z',
    ai: null, human: 0, system: 0, closed: 0, newCases: 3, sentToHuman: 0, fpRate: null, alerts: null,
  },
  {
    x: '07:00', start: '2026-07-01T07:00:00.000Z', end: '2026-07-01T08:00:00.000Z',
    ai: 0, human: 0, system: 0, closed: 0, newCases: 2, sentToHuman: 0, fpRate: 0, alerts: 12,
  },
  {
    x: '08:00', start: '2026-07-01T08:00:00.000Z', end: '2026-07-01T09:00:00.000Z',
    ai: 0, human: 3, system: 0, closed: 3, newCases: 5, sentToHuman: 2, fpRate: 33.3, alerts: 55,
    inProgress: true,
  },
];

function renderRich(extra: Partial<React.ComponentProps<typeof HumanVsAiCard>> = {}) {
  return render(
    <HumanVsAiCard
      totals={{ ai: 2, human: 4, system: 1, closed: 7 }}
      series={RICH}
      windowLabel="last 24 hours · 1h buckets"
      {...extra}
    />,
  );
}

const figure = () =>
  screen.getByRole('group', { name: /closed by the agent versus by a human/i });
const tip = () => screen.getByTestId('human-vs-ai-tooltip');
const tipText = (id: string) => within(tip()).getByTestId(`human-vs-ai-tooltip-${id}`).textContent;

describe('CloseAttributionChart — stacked columns', () => {
  it('stacks AI agent on the baseline, then Human, then System, at true heights', () => {
    renderRich();
    const svg = figure().querySelector('svg')!;
    const baseline = Number(svg.getAttribute('data-baseline'));
    const plotTop = Number(svg.getAttribute('data-plot-top'));
    const yMax = Number(svg.getAttribute('data-y-max'));
    // Tallest stack is 4 → clean ticks 0 / 2 / 4, each a 1px solid hairline above 0.
    expect(screen.getAllByTestId('human-vs-ai-y-tick').map((t) => t.textContent)).toEqual(['0', '2', '4']);
    expect(yMax).toBe(4);
    const grid = screen.getAllByTestId('human-vs-ai-gridline');
    expect(grid).toHaveLength(2);
    for (const g of grid) {
      expect(g).toHaveAttribute('height', '1');
      expect(g).toHaveAttribute('fill', token('border'));
    }
    const scale = (baseline - plotTop) / yMax;

    const [first] = screen.getAllByTestId('human-vs-ai-slot');
    const segs = Array.from(first.querySelectorAll<SVGElement>('[data-segment]'));
    // DOM (paint) order is baseline-up, and the colours are the card's band tokens.
    expect(segs.map((s) => s.getAttribute('data-segment'))).toEqual(['ai', 'human', 'system']);
    expect(segs.map((s) => s.getAttribute('fill'))).toEqual([
      token('chart-1'),
      token('chart-2'),
      token('chart-8'),
    ]);
    const box = (s: SVGElement) => ({ y: Number(s.getAttribute('data-y')), h: Number(s.getAttribute('data-h')) });
    const [ai, human, system] = segs.map(box);
    // AI agent sits ON the baseline, square there.
    expect(ai.y + ai.h).toBe(baseline);
    // Each segment's top is placed from the cumulative count (2, 3, 4), so the stack
    // height is the true total…
    expect(ai.y).toBe(Math.round(baseline - 2 * scale));
    expect(human.y).toBe(Math.round(baseline - 3 * scale));
    expect(system.y).toBe(Math.round(baseline - 4 * scale));
    // …and the 1px surface gap is an INSET taken from the upper segment, not a stroke.
    expect(human.y + human.h).toBe(ai.y - 1);
    expect(system.y + system.h).toBe(human.y - 1);
    for (const s of segs) expect(s.getAttribute('stroke')).toBeNull();
    // Only the TOPMOST non-zero segment carries the rounded top (a path); the rest are
    // plain rects.
    expect(segs.map((s) => s.tagName.toLowerCase())).toEqual(['rect', 'rect', 'path']);

    // A Human-only bucket: its one segment is both on the baseline and the rounded top.
    const last = screen.getAllByTestId('human-vs-ai-slot')[3];
    const only = Array.from(last.querySelectorAll<SVGElement>('[data-segment]'));
    expect(only.map((s) => [s.getAttribute('data-segment'), s.tagName.toLowerCase()])).toEqual([
      ['human', 'path'],
    ]);
    expect(box(only[0]).y + box(only[0]).h).toBe(baseline);
  });

  it('keeps a single close visible beside a tall bar (2px floor)', () => {
    render(
      <CloseAttributionChart
        points={[{ x: '05:00', ai: 100, human: 1, system: 0 }]}
        bands={[
          { key: 'ai', label: 'AI agent', color: token('chart-1') },
          { key: 'human', label: 'Human', color: token('chart-2') },
          { key: 'system', label: 'System', color: token('chart-8') },
        ]}
        ariaLabel="Cases closed by the agent versus by a human"
      />,
    );
    const human = document.querySelector('[data-segment="human"]')!;
    // 1 of 101 would round to under a pixel; the floor keeps it a visible 2px mark.
    expect(Number(human.getAttribute('data-h'))).toBe(2);
    expect(document.querySelector('[data-segment="system"]')).toBeNull();
  });

  it('marks an unmeasured bucket as unmeasured and a measured zero as zero — never the same', () => {
    renderRich();
    const [, unmeasured, zero] = screen.getAllByTestId('human-vs-ai-slot');
    expect(unmeasured).toHaveAttribute('data-state', 'unmeasured');
    expect(within(unmeasured).getByTestId('human-vs-ai-unmeasured').getAttribute('fill')).toMatch(
      /^url\(#hva-hatch-/,
    );
    expect(unmeasured.querySelectorAll('[data-segment]')).toHaveLength(0);
    expect(zero).toHaveAttribute('data-state', 'zero');
    expect(within(zero).queryByTestId('human-vs-ai-unmeasured')).toBeNull();
    expect(zero.querySelectorAll('[data-segment]')).toHaveLength(0);
  });

  it('draws the newest, still-filling bucket at reduced opacity', () => {
    renderRich();
    const slots = screen.getAllByTestId('human-vs-ai-slot');
    expect(slots[3]).toHaveAttribute('data-in-progress', 'true');
    expect(slots[3]).toHaveAttribute('opacity', '0.6');
    for (const s of slots.slice(0, 3)) {
      expect(s).not.toHaveAttribute('data-in-progress');
      expect(s).toHaveAttribute('opacity', '1');
    }
    // A translucent bar would let the hairlines show THROUGH it, so the gridlines are
    // masked out under that bar — and only that bar.
    const mask = document.querySelector('mask')!;
    const holes = mask.querySelectorAll('rect[fill="black"]');
    expect(holes).toHaveLength(1);
    const bar = slots[3].querySelector('[data-segment]')!;
    expect(holes[0].getAttribute('y')).toBe(bar.getAttribute('data-y'));
    for (const line of screen.getAllByTestId('human-vs-ai-gridline')) {
      expect(line.parentElement).toHaveAttribute('mask', `url(#${mask.id})`);
    }
  });

  it('says so in words when nothing closed in the whole window', () => {
    render(
      <HumanVsAiCard
        totals={{ ai: 0, human: 0, system: 0, closed: 0 }}
        series={RICH.map((p) => ({ ...p, ai: 0, human: 0, system: 0, closed: 0, inProgress: false }))}
        windowLabel="last 24 hours · 1h buckets"
      />,
    );
    expect(screen.getByTestId('human-vs-ai-all-zero')).toHaveTextContent('No cases closed in this window.');
    // Baseline and time labels stay; no scale is invented for an empty window.
    expect(screen.getByTestId('human-vs-ai-baseline')).toBeInTheDocument();
    expect(screen.getAllByTestId('human-vs-ai-x-tick').length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId('human-vs-ai-y-tick')).toHaveLength(0);
    expect(screen.queryAllByTestId('human-vs-ai-gridline')).toHaveLength(0);
  });

  it('states once, on the card face, that the bucket times are UTC', () => {
    renderRich();
    const card = screen.getByTestId('human-vs-ai');
    expect(within(card).getAllByText(/times in UTC/)).toHaveLength(1);
    // The x labels themselves stay the short UTC form the caller supplied.
    expect(screen.getAllByTestId('human-vs-ai-x-tick').map((t) => t.textContent)).toEqual([
      '05:00',
      '06:00',
      '07:00',
      '08:00',
    ]);
  });

  it('withholds every numeral while stale — no scale, no tooltip, no table — but keeps the frame', async () => {
    renderRich({ stale: true });
    const fig = figure();
    expect(fig).toHaveAttribute('aria-busy', 'true');
    expect(fig).not.toHaveAttribute('tabindex');
    expect(screen.queryAllByTestId('human-vs-ai-y-tick')).toHaveLength(0);
    expect(screen.queryAllByTestId('human-vs-ai-gridline')).toHaveLength(0);
    expect(screen.queryByTestId('human-vs-ai-table')).toBeNull();
    // The marks stay (dimmed) so the card does not jump when the fresh payload lands.
    const slots = screen.getAllByTestId('human-vs-ai-slot');
    expect(slots[0]).toHaveAttribute('opacity', '0.35');
    fireEvent.mouseMove(fig, { clientX: 60 });
    expect(screen.queryByTestId('human-vs-ai-tooltip')).toBeNull();
  });
});

describe('CloseAttributionChart — hover/focus breakdown and keyboard', () => {
  it('is ONE tab stop that opens the newest bucket’s breakdown on keyboard focus', async () => {
    const user = userEvent.setup();
    renderRich({ truncated: true });
    const fig = figure();
    expect(fig).toHaveAttribute('tabindex', '0');
    // Nothing inside the plot takes focus of its own (Chartability: one stop, then arrows).
    expect(fig.querySelectorAll('[tabindex], button, a, input')).toHaveLength(0);
    // Its instructions are attached to it.
    const describedBy = fig.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)).toHaveTextContent(/arrow keys/i);

    await user.tab(); // the (?) help
    await user.tab(); // the chart
    expect(fig).toHaveFocus();
    expect(screen.getByTestId('human-vs-ai-focus-ring')).toBeInTheDocument();

    // Header: the full UTC range + "In progress"; then the closed total.
    expect(tipText('range')).toBe('Jul 1, 08:00–09:00 UTC');
    expect(tipText('progress')).toBe('In progress');
    expect(tipText('closed-value')).toBe('3');
    // One row per closer TOP→BOTTOM in stack order — zero rows INCLUDED.
    const text = tip().textContent ?? '';
    expect(text.indexOf('System')).toBeLessThan(text.indexOf('Human'));
    expect(text.indexOf('Human')).toBeLessThan(text.indexOf('AI agent'));
    expect([tipText('system-value'), tipText('human-value'), tipText('ai-value')]).toEqual(['0', '3', '0']);
    expect([tipText('system-share'), tipText('human-share'), tipText('ai-share')]).toEqual(['0%', '100%', '0%']);
    // Context from the SAME bucket, each population named.
    expect(tipText('arrived-value')).toBe('5');
    expect(tipText('arrived-label')).toBe('arrived, incl. policy-closed');
    expect(tipText('sent-value')).toBe('2');
    expect(tipText('sent-label')).toBe('sent to human');
    expect(tipText('fp-value')).toBe('33%');
    expect(tipText('fp-label')).toBe('false positive rate');
    expect(tipText('alerts-value')).toBe('55');
    expect(tipText('alerts-label')).toBe('alerts ingested (not cases)');
    // A bounded window makes every count a lower bound, and the tooltip says so.
    expect(tipText('bound')).toMatch(/lower bounds/i);

    // Tab leaves the chart in one press.
    await user.tab();
    expect(fig).not.toHaveFocus();
    expect(screen.queryByTestId('human-vs-ai-tooltip')).toBeNull();
  });

  it('never derives "arrived − closed": the context rows are exactly the bucket’s own fields', async () => {
    const user = userEvent.setup();
    renderRich();
    await user.tab();
    await user.tab();
    await user.keyboard('{Home}');
    expect(tipText('range')).toBe('Jul 1, 05:00–06:00 UTC');
    expect(within(tip()).queryByTestId('human-vs-ai-tooltip-progress')).toBeNull();
    const values = Array.from(
      tip().querySelectorAll('[data-testid$="-value"]'),
    ).map((n) => [n.getAttribute('data-testid')!.replace('human-vs-ai-tooltip-', ''), n.textContent]);
    // closed, three closers, then arrived / sent / fp / alerts — and nothing else. 6 − 4
    // would be "2 still open", which policy-closed arrivals make untrue.
    expect(values).toEqual([
      ['closed-value', '4'],
      ['system-value', '1'],
      ['human-value', '1'],
      ['ai-value', '2'],
      ['arrived-value', '6'],
      ['sent-value', '1'],
      ['fp-value', '50%'],
      ['alerts-value', '40'],
    ]);
    expect(tip()).not.toHaveTextContent(/open/i);
    // No lower-bound note on an unbounded window.
    expect(within(tip()).queryByTestId('human-vs-ai-tooltip-bound')).toBeNull();
  });

  it('moves with ←/→/Home/End, says "not measured" for a null bucket, and Esc dismisses', async () => {
    const user = userEvent.setup();
    renderRich();
    await user.tab();
    await user.tab();
    const fig = figure();
    expect(fig).toHaveFocus();
    expect(tipText('range')).toBe('Jul 1, 08:00–09:00 UTC'); // starts at the newest

    await user.keyboard('{Home}');
    expect(tipText('range')).toBe('Jul 1, 05:00–06:00 UTC');
    await user.keyboard('{ArrowLeft}'); // clamps at the first bucket
    expect(tipText('range')).toBe('Jul 1, 05:00–06:00 UTC');

    await user.keyboard('{ArrowRight}');
    expect(tipText('range')).toBe('Jul 1, 06:00–07:00 UTC');
    // The unmeasured bucket says so — never "0 closed".
    expect(tipText('closed-value')).toBe('—');
    expect(tipText('closed-label')).toBe('closed, not measured');
    expect(tipText('ai-value')).toBe('—');
    expect(tipText('fp-reason')).toBe('no verdicted case');
    expect(tipText('alerts-reason')).toBe('not recorded');

    await user.keyboard('{ArrowRight}');
    expect(tipText('range')).toBe('Jul 1, 07:00–08:00 UTC');
    // A measured zero IS a zero, with no share invented for an empty denominator.
    expect(tipText('closed-value')).toBe('0');
    expect([tipText('system-share'), tipText('human-share'), tipText('ai-share')]).toEqual(['', '', '']);

    await user.keyboard('{End}');
    expect(tipText('range')).toBe('Jul 1, 08:00–09:00 UTC');
    await user.keyboard('{ArrowRight}'); // clamps at the last bucket
    expect(tipText('range')).toBe('Jul 1, 08:00–09:00 UTC');

    // The focus ring follows the active slot.
    const ring = screen.getByTestId('human-vs-ai-focus-ring');
    const lastSlot = screen.getAllByTestId('human-vs-ai-slot')[3];
    const band = lastSlot.querySelector('[data-segment]')!;
    const ringX = Number(ring.getAttribute('x'));
    const ringW = Number(ring.getAttribute('width'));
    const barX = Number(band.getAttribute('x') ?? NaN);
    // (the Human-only bar is a path; its x is the path's first coordinate)
    const pathX = Number((band.getAttribute('d') ?? '').match(/^M([\d.]+),/)?.[1]);
    const x = Number.isFinite(barX) ? barX : pathX;
    expect(x).toBeGreaterThan(ringX);
    expect(x).toBeLessThan(ringX + ringW);

    // Esc hides the breakdown but keeps focus; the next arrow brings it back.
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('human-vs-ai-tooltip')).toBeNull();
    expect(fig).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tipText('range')).toBe('Jul 1, 07:00–08:00 UTC');
  });

  it('announces each keyboard move through a polite live region', async () => {
    const user = userEvent.setup();
    renderRich();
    const live = screen.getByTestId('human-vs-ai-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toBeEmptyDOMElement();
    await user.tab();
    await user.tab();
    await user.keyboard('{Home}');
    expect(live).toHaveTextContent(
      'Jul 1, 05:00–06:00 UTC: 4 closed. AI agent 2, Human 1, System 1.',
    );
    await user.keyboard('{ArrowRight}');
    expect(live).toHaveTextContent('Jul 1, 06:00–07:00 UTC: close attribution not measured.');
    await user.keyboard('{End}');
    expect(live).toHaveTextContent(/^Jul 1, 08:00–09:00 UTC, in progress: 3 closed\./);
  });

  it('opens on hover over the WHOLE slot, highlights it, and stays dismissible', async () => {
    renderRich();
    const fig = figure();
    const svg = fig.querySelector('svg')!;
    const width = Number(svg.getAttribute('width'));
    // The slot geometry the chart itself uses: gutter x0, then four equal slots.
    const firstSlotBand = () => screen.queryByTestId('human-vs-ai-active-band');
    const gutter = 15; // ceil(1 char × 6.6) + 8 for a "4" top tick
    const slot = (width - gutter) / 4;

    // High in the plot, far above the short bar, still opens slot 0.
    fireEvent.mouseMove(fig, { clientX: gutter + slot * 0.5, clientY: 10 });
    expect(tipText('range')).toBe('Jul 1, 05:00–06:00 UTC');
    expect(firstSlotBand()).toBeInTheDocument();
    // Hover is not keyboard focus: no focus ring.
    expect(screen.queryByTestId('human-vs-ai-focus-ring')).toBeNull();

    fireEvent.mouseMove(fig, { clientX: gutter + slot * 2.9, clientY: 150 });
    expect(tipText('range')).toBe('Jul 1, 07:00–08:00 UTC');

    // Esc dismisses a hover tooltip without moving the pointer (WCAG 1.4.13)…
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('human-vs-ai-tooltip')).toBeNull();
    // …it stays dismissed while the pointer stays on that slot…
    fireEvent.mouseMove(fig, { clientX: gutter + slot * 2.5, clientY: 120 });
    expect(screen.queryByTestId('human-vs-ai-tooltip')).toBeNull();
    // …and a new slot brings it back.
    fireEvent.mouseMove(fig, { clientX: gutter + slot * 1.5, clientY: 120 });
    expect(tipText('range')).toBe('Jul 1, 06:00–07:00 UTC');

    // Hovering the tooltip itself keeps it open (WCAG 1.4.13 hoverable)…
    fireEvent.mouseLeave(fig);
    fireEvent.mouseEnter(tip());
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByTestId('human-vs-ai-tooltip')).toBeInTheDocument();
    // …and leaving both closes it.
    fireEvent.mouseLeave(tip());
    await waitFor(() => expect(screen.queryByTestId('human-vs-ai-tooltip')).toBeNull());
  });

  it('lists every bucket in a visually hidden table', () => {
    renderRich();
    const table = screen.getByTestId('human-vs-ai-table');
    expect(table).toHaveClass('sr-only');
    expect(within(table).getByText(/UTC/, { selector: 'caption' })).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Bucket',
      'Closed',
      'System',
      'Human',
      'AI agent',
      'Arrived, incl. policy-closed',
      'Sent to human',
      'False positive rate',
      'Alerts ingested (not cases)',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(RICH.length);
    const cells = rows.map((r) =>
      Array.from(r.querySelectorAll('th, td')).map((c) => c.textContent),
    );
    expect(cells[0]).toEqual(['Jul 1, 05:00–06:00 UTC', '4', '1', '1', '2', '6', '1', '50%', '40']);
    expect(cells[1]).toEqual([
      'Jul 1, 06:00–07:00 UTC',
      'not measured',
      '0',
      '0',
      'not measured',
      '3',
      '0',
      'no verdicted case',
      'not recorded',
    ]);
    expect(cells[3][0]).toBe('Jul 1, 08:00–09:00 UTC (in progress)');
  });

  it('names a bucket that ends at midnight on its own day', () => {
    expect(
      bucketRangeLabel({ x: '18:00', start: '2026-07-01T18:00:00.000Z', end: '2026-07-02T00:00:00.000Z' }),
    ).toBe('Jul 1, 18:00–24:00 UTC');
    // No parseable start: the caller's short UTC label, said to be UTC.
    expect(bucketRangeLabel({ x: '18:00' })).toBe('18:00 UTC');
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
