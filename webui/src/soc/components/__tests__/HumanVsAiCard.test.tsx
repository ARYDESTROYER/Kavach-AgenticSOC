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
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
    const box = within(chart).getByRole('img', {
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
