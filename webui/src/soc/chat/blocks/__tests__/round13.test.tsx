/**
 * Round 13 (SPEC-chat §5.1, T7, T8, T9, T14, T19, T29, T34) on rendered blocks:
 *   - every card carries its width; an entity pair spans the lane;
 *   - one scope line for the caption parts several cards repeat, each card keeping its
 *     other parts, while the expanded sheet, print and the data a card hands to Add to
 *     report keep the whole caption;
 *   - at rest the header shows only ⋯; Add to report shows on hover or focus, always
 *     while the block is in the report, and is the first action of ⋯;
 *   - a Brief states its window once; its infographic hero draws no inner frame;
 *   - the KPI gauge is no taller than its row and "not windowed" reads "Right now";
 *   - bar values sit right after the bar's end;
 *   - case references read as number then title, the internal id only as a tooltip;
 *   - status changes and decision reasons read as product words.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const announce = vi.fn();
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));

import AnswerBlocks from '../AnswerBlocks';
import { BlockCard } from '../BlockCard';
import { galleryBlock } from '../__fixtures__/gallery';
import { round12Block } from '../__fixtures__/round12';
import { briefHeading, briefTitle, reportLeafScope, reportScopeLine, reportWindow } from '../renderers/ReportView';
import { parseBlock } from '../schema';
import type { AnswerBlock, ReportBlock } from '../schema';

beforeEach(() => announce.mockClear());

const ASOF = '2026-10-17T11:13:20Z';

function kpis(id: string, caption: string, asOf: string | null = ASOF) {
  return parseBlock({
    id,
    type: 'kpi_group',
    provenance: 'code',
    artifact_kind: 'kpis',
    caption,
    as_of: asOf,
    items: [
      { key: 'a', label: `${id} A`, value: 1, unit: 'count' },
      { key: 'b', label: `${id} B`, value: 2, unit: 'count' },
    ],
  });
}

describe('block widths (§5.1)', () => {
  it('marks every card compact or wide, and an entity pair as one wide row', () => {
    const { container } = render(
      <AnswerBlocks blocks={[kpis('k', 'x'), galleryBlock('ioc'), galleryBlock('ioc'), galleryBlock('logon-heatmap')]} messageId="m1" />,
    );
    const root = screen.getByTestId('answer-blocks');
    const children = Array.from(root.children) as HTMLElement[];
    expect(children.map((el) => el.getAttribute('data-block-width'))).toEqual(['compact', 'wide', 'wide']);
    // Inside the pair each indicator is still a compact card.
    expect(Array.from(container.querySelectorAll('figure[data-block-type="entity"]')).map((f) => f.getAttribute('data-block-width'))).toEqual([
      'compact',
      'compact',
    ]);
  });
});

describe('shared scope line (T8)', () => {
  it('states the repeated parts once above the first card; each card keeps its own parts', () => {
    render(<AnswerBlocks blocks={[kpis('a', '44 cases · exact · last 24 hours'), kpis('b', '12 rules · exact · last 24 hours')]} messageId="m1" shareCaptions />);
    const root = screen.getByTestId('answer-blocks');
    const line = screen.getByTestId('answer-scope-line');
    expect(line).toHaveTextContent(/^exact · last 24 hours · as of 2026-10-17 11:13 UTC$/);
    expect(line).toHaveAttribute('data-scope-line');
    expect(line).toHaveClass('text-xs', 'text-muted-foreground');
    // Once, and just above the first card it speaks for.
    expect(screen.getAllByTestId('answer-scope-line')).toHaveLength(1);
    expect(root.firstElementChild).toBe(line);
    const [first, second] = screen.getAllByTestId('block-caption');
    // On screen: the card's own parts; for assistive tech: the whole caption.
    expect(first.querySelector('[aria-hidden]')).toHaveTextContent(/^44 cases$/);
    expect(first.querySelector('.sr-only')).toHaveTextContent('44 cases · exact · last 24 hours · as of 2026-10-17 11:13 UTC');
    expect(second.querySelector('[aria-hidden]')).toHaveTextContent(/^12 rules$/);
  });

  it('is off unless the host asks (a report panel shows blocks one by one)', () => {
    render(<AnswerBlocks blocks={[kpis('a', '44 cases · exact'), kpis('b', '12 rules · exact')]} messageId="m1" />);
    expect(screen.queryByTestId('answer-scope-line')).toBeNull();
    expect(screen.getAllByTestId('block-caption')[0]).toHaveTextContent(/^44 cases · exact · as of 2026-10-17 11:13 UTC$/);
  });

  it('keeps the whole caption in the expanded sheet', async () => {
    const user = userEvent.setup();
    render(<AnswerBlocks blocks={[kpis('a', '44 cases · exact'), kpis('b', '12 rules · exact')]} messageId="m1" shareCaptions />);
    await user.click(screen.getAllByTestId('block-menu-trigger')[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Expand' }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveTextContent('44 cases · exact · as of 2026-10-17 11:13 UTC');
  });

  it('keeps the whole caption in print, and never changes the block a card adds to the report', async () => {
    const user = userEvent.setup();
    render(<BlockCard block={kpis('a', '44 cases · exact')} index={0} staticMode sharedScope={{ line: 'exact', parts: ['exact'], asOf: null, members: [0] }} />);
    expect(screen.getByTestId('block-caption')).toHaveTextContent(/^44 cases · exact · as of 2026-10-17 11:13 UTC$/);
    // Add to report takes the block by id: its caption is untouched by the scope line.
    const add = vi.fn();
    const a = kpis('a', '44 cases · exact');
    render(<AnswerBlocks blocks={[a, kpis('b', '12 rules · exact')]} messageId="m2" shareCaptions canAddToReport onAddToReport={add} />);
    await user.click(screen.getAllByTestId('block-add-to-report')[0]);
    expect(add).toHaveBeenCalledWith('a');
    expect(a.caption).toBe('44 cases · exact');
  });
});

describe('block header at rest (T9)', () => {
  it('shows Add to report on hover or focus only, and always while the block is in the report', () => {
    render(
      <AnswerBlocks
        blocks={[galleryBlock('top-hosts'), galleryBlock('kpis')]}
        messageId="m1"
        canAddToReport
        onAddToReport={vi.fn()}
        inReport={new Set(['kpis'])}
      />,
    );
    const [hosts, kpisSlot] = screen.getAllByTestId('block-report-slot');
    expect(hosts).toHaveAttribute('data-visibility', 'hover');
    expect(hosts).toHaveClass('opacity-0', 'pointer-events-none', 'group-hover/block:opacity-100', 'group-focus-within/block:opacity-100');
    // Opacity, never `visibility`: the toggle stays in the tab order.
    expect(hosts).not.toHaveClass('invisible');
    expect(kpisSlot).toHaveAttribute('data-visibility', 'always');
    expect(kpisSlot).not.toHaveClass('opacity-0');
    for (const fig of screen.getAllByRole('figure')) expect(fig).toHaveClass('group/block');
  });

  it('makes Add to report the first action of ⋯, after the provenance line', async () => {
    const user = userEvent.setup();
    const add = vi.fn();
    render(<AnswerBlocks blocks={[galleryBlock('top-hosts')]} messageId="m1" canAddToReport onAddToReport={add} />);
    await user.click(screen.getByTestId('block-menu-trigger'));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('Add to report');
    await user.click(items[0]);
    expect(add).toHaveBeenCalledWith('top-hosts');
  });

  it('offers "Remove from report", and a full report’s reason, in the menu', async () => {
    const user = userEvent.setup();
    render(
      <AnswerBlocks
        blocks={[galleryBlock('top-hosts'), galleryBlock('kpis')]}
        messageId="m1"
        canAddToReport
        onAddToReport={vi.fn()}
        inReport={new Set(['kpis'])}
        addDisabledReason="Report is full (40 items)"
      />,
    );
    await user.click(screen.getAllByTestId('block-menu-trigger')[0]);
    const refused = within(await screen.findByRole('menu')).getByTestId('block-menu-report');
    expect(refused).toHaveAttribute('aria-disabled', 'true');
    expect(refused).toHaveTextContent('Report is full (40 items)');
    await user.keyboard('{Escape}');
    await user.click(screen.getAllByTestId('block-menu-trigger')[1]);
    expect(within(await screen.findByRole('menu')).getByTestId('block-menu-report')).toHaveTextContent(/^Remove from report$/);
  });
});

describe('a Brief states its window once (T29)', () => {
  const brief = (extra: Partial<ReportBlock>, caption = '39 cases · exact · last 7 days (since 11 Oct 2026)'): ReportBlock => {
    const base = galleryBlock('shift-brief') as ReportBlock;
    const leaf = { ...base.sections[1].blocks[0], caption, as_of: '2026-10-17T11:27:40Z' } as ReportBlock['sections'][number]['blocks'][number];
    return {
      ...base,
      title: 'Cases report, last 7 days',
      subtitle: 'last 7 days (since 11 Oct 2026)',
      scope: { sources: [], generated_at: '2026-10-17T11:27:00Z' },
      sections: [base.sections[0], { ...base.sections[1], blocks: [leaf] }],
      ...extra,
    } as ReportBlock;
  };

  it('folds a subtitle that is the figures’ window into the scope line, and drops it from the title', () => {
    const b = brief({});
    expect(reportWindow(b)).toEqual({ text: 'last 7 days (since 11 Oct 2026)', subtitleFolded: true, subtitleRest: null });
    expect(reportScopeLine(b)).toBe('Last 7 days (since 11 Oct 2026) · Generated 2026-10-17 11:27 UTC');
    expect(briefTitle(b)).toBe('Cases report');
    const scope = reportLeafScope(b);
    expect(scope?.parts).toEqual(['last 7 days (since 11 Oct 2026)']);
    expect(scope?.asOf).toBe('as of 2026-10-17 11:27 UTC');
  });

  it('renders "Brief: {title}", the scope line once, and leaf captions without the window or time', () => {
    render(<AnswerBlocks blocks={[brief({})]} messageId="m1" />);
    const fig = screen.getByRole('figure', { name: 'Brief: Cases report' });
    // No subtitle restating the window, and no "BRIEF" eyebrow.
    expect(within(fig).queryByText('last 7 days (since 11 Oct 2026)')).toBeNull();
    expect(fig).not.toHaveTextContent(/^BRIEF/);
    const captions = within(fig).getAllByTestId('block-caption');
    expect(captions[0]).toHaveTextContent(/^Last 7 days \(since 11 Oct 2026\) · Generated 2026-10-17 11:27 UTC$/);
    const leaf = captions[1];
    expect(leaf.querySelector('[aria-hidden]')).toHaveTextContent(/^39 cases · exact$/);
    expect((fig.textContent ?? '').split('last 7 days (since 11 Oct 2026)').length - 1).toBeLessThanOrEqual(1);
  });

  it('keeps a subtitle that says something else, and a title it cannot shorten', () => {
    const b = brief({ subtitle: 'Night shift handover', title: 'Last 7 days' }, '39 cases');
    expect(reportWindow(b)).toEqual({ text: null, subtitleFolded: false, subtitleRest: 'Night shift handover' });
    expect(briefTitle(b)).toBe('Last 7 days');
    render(<AnswerBlocks blocks={[b]} messageId="m1" />);
    expect(screen.getByText('Night shift handover')).toBeInTheDocument();
  });

  it('uses the scope’s own window label, folding a subtitle that only says it more precisely', () => {
    const b = brief({ scope: { window_label: 'last 7 days', sources: ['Wazuh'], generated_at: '2026-10-17T11:27:00Z' } });
    expect(reportWindow(b).text).toBe('last 7 days (since 11 Oct 2026)');
    expect(reportScopeLine(b)).toBe('Last 7 days (since 11 Oct 2026) · Sources: Wazuh · Generated 2026-10-17 11:27 UTC');
  });

  it('never states a model subtitle as the scope line, even when it starts with the window label (#9)', () => {
    // The subtitle is model text (ReportEnvelopeRequest); the label is the engine's.
    const b = brief(
      {
        subtitle: 'last 7 days (since 1 Oct 2026), all response targets met',
        scope: { window_label: 'last 7 days', sources: ['Wazuh'], generated_at: '2026-10-17T11:27:00Z' },
      },
      '39 cases · exact · last 7 days',
    );
    expect(reportWindow(b)).toEqual({
      text: 'last 7 days',
      subtitleFolded: false,
      subtitleRest: 'last 7 days (since 1 Oct 2026), all response targets met',
    });
    expect(reportScopeLine(b)).toBe('Last 7 days · Sources: Wazuh · Generated 2026-10-17 11:27 UTC');
    render(<AnswerBlocks blocks={[b]} messageId="m1" />);
    // The model's words stay on their own line, never in the code-written scope line.
    expect(screen.getByTestId('report-subtitle')).toHaveTextContent(/^last 7 days \(since 1 Oct 2026\), all response targets met$/);
    expect(screen.getAllByTestId('block-caption')[0]).not.toHaveTextContent('response targets');
  });

  it('folds a dated form of the label only when an engine caption says exactly that', () => {
    const scope = { window_label: 'last 7 days', sources: [], generated_at: '2026-10-17T11:27:00Z' };
    // A leaf caption carries the dated form word for word: folded.
    expect(reportWindow(brief({ scope })).subtitleFolded).toBe(true);
    // No caption says it (a model-made date): the label stays, the subtitle stays model text.
    const unconfirmed = brief({ scope }, '39 cases · exact · last 7 days');
    expect(reportWindow(unconfirmed)).toEqual({ text: 'last 7 days', subtitleFolded: false, subtitleRest: 'last 7 days (since 11 Oct 2026)' });
  });

  it('folds the window part of a subtitle like "Last shift · last 24 hours" when the leaves caption it', () => {
    const b = brief({ title: 'Shift brief', subtitle: 'Last shift · last 24 hours' }, '12 cases · exact · last 24 hours');
    expect(reportWindow(b)).toEqual({ text: 'last 24 hours', subtitleFolded: false, subtitleRest: 'Last shift' });
    expect(reportScopeLine(b)).toBe('Last 24 hours · Generated 2026-10-17 11:27 UTC');
    expect(reportLeafScope(b)?.parts).toEqual(['last 24 hours']);
    render(<AnswerBlocks blocks={[b]} messageId="m1" />);
    const fig = screen.getByRole('figure', { name: 'Shift brief' });
    expect(within(fig).getByTestId('report-subtitle')).toHaveTextContent(/^Last shift$/);
    const captions = within(fig).getAllByTestId('block-caption');
    expect(captions[1].querySelector('[aria-hidden]')).toHaveTextContent(/^12 cases · exact$/);
    // The window is on screen once (the sr-only full captions are for assistive tech).
    const onScreen = fig.cloneNode(true) as HTMLElement;
    onScreen.querySelectorAll('.sr-only').forEach((el) => el.remove());
    expect((onScreen.textContent ?? '').toLowerCase().split('last 24 hours').length - 1).toBe(1);
  });

  it('heads a Brief "Brief: {title}" unless its title already calls it a brief', () => {
    expect(briefHeading(brief({ title: 'Cases report' }))).toBe('Brief: Cases report');
    expect(briefHeading(brief({ title: 'Shift brief' }))).toBe('Shift brief');
    expect(briefHeading(brief({ title: 'Investigation brief: case 42' }))).toBe('Investigation brief: case 42');
    expect(briefHeading(brief({ title: 'Briefcase thefts' }))).toBe('Brief: Briefcase thefts');
  });

  it('draws the infographic hero without a frame of its own inside the card', () => {
    const { unmount } = render(<AnswerBlocks blocks={[round12Block('posture-infographic')]} messageId="m1" />);
    const hero = screen.getByTestId('infographic-hero');
    const grid = hero.querySelector('[role="list"]') as HTMLElement;
    expect(grid.closest('[class*="-mx-3"]')).not.toBeNull();
    unmount();
    // A Brief with no card around it (a report panel item) keeps the hero's closed frame.
    render(<AnswerBlocks blocks={[round12Block('posture-infographic')]} messageId="m2" bareCards />);
    const bare = screen.getByTestId('infographic-hero').querySelector('[role="list"]') as HTMLElement;
    expect(bare.closest('[class*="-mx-3"]')).toBeNull();
  });
});

describe('KPI tiles (T19)', () => {
  it('draws the gauge at 56 px and says "Right now" for a figure that is not windowed', () => {
    render(
      <AnswerBlocks
        blocks={[
          parseBlock({
            id: 'g',
            type: 'kpi_group',
            provenance: 'code',
            artifact_kind: 'kpis',
            items: [
              { key: 'r', label: 'Active Risk Index', value: 48, unit: 'score', display: 'gauge', context: 'not windowed' },
              { key: 'o', label: 'Open now', value: 37, unit: 'count', context: 'not windowed' },
            ],
          }),
        ]}
        messageId="m1"
      />,
    );
    // A decorative 56 px arc, exactly half as tall (butt caps end it on its baseline), so
    // its row is no taller than the figures' 26 px numeral line plus 2 px.
    const arc = screen.getByTestId('kpi-gauge-arc');
    expect(arc).toHaveAttribute('width', '56');
    expect(arc).toHaveAttribute('height', '28');
    expect(arc).toHaveAttribute('aria-hidden', 'true');
    expect(Array.from(arc.querySelectorAll('path')).every((p) => p.getAttribute('stroke-linecap') === 'butt')).toBe(true);
    // The figure is TEXT beside the arc (never an overlay under it), read as "48 of 100 High".
    const value = screen.getByTestId('kpi-gauge-value');
    expect(value).toHaveTextContent(/^48 of 100 High\/100$/);
    expect(value).toHaveClass('whitespace-nowrap', 'text-2xl');
    expect(value.closest('[data-testid="kpi-gauge-row"]')).toContainElement(arc);
    // The band word is stacked over "/100" beside the numeral; the context line holds only
    // the context, so the tile has the same three lines as its neighbours.
    expect(within(value).getByTestId('kpi-gauge-band-word')).toHaveTextContent(/^High$/);
    expect(screen.getByTestId('kpi-gauge-context')).toHaveTextContent(/^Right now$/);
    // Both figures that are not windowed (the gauge and "Open now") say "Right now".
    expect(screen.getAllByText('Right now')).toHaveLength(2);
    expect(screen.queryByText('not windowed')).toBeNull();
  });

  it('keeps a gauge tile to its neighbours’ three lines on a phone-width tile (review RV3)', () => {
    // At 390 a two-column strip gives each tile 169 px (145 px inside its padding): neither
    // "High · 20 active cases now" on the context line nor "48/100 High" on the figure
    // line fits there, and either wrap made the tile 16 px taller than a captioned figure.
    // jsdom has no layout, so this pins the structure that keeps the height; the heights
    // themselves (81 px against a captioned 81 px at 169 and 160 px tiles, every band and
    // "100") are measured in Chromium in the package's live check.
    render(
      <div>
        <AnswerBlocks
          blocks={[
            parseBlock({
              id: 'g',
              type: 'kpi_group',
              provenance: 'code',
              artifact_kind: 'kpis',
              items: [
                { key: 'r', label: 'Active Risk Index', value: 48, unit: 'score', display: 'gauge', context: '20 active cases now' },
                { key: 'c', label: 'Cases', value: 44, unit: 'count' },
                { key: 'o', label: 'Open now', value: 20, unit: 'count', context: 'not windowed' },
                { key: 'f', label: 'False-positive rate', value: 0.75, unit: 'ratio' },
              ],
            }),
          ]}
          messageId="m1"
        />
      </div>,
    );
    const tile = screen.getByTestId('kpi-gauge-row').closest('[role="listitem"]') as HTMLElement;
    // Exactly three lines, as a captioned figure: label, the figure row, the context.
    expect(Array.from(tile.children).map((el) => el.getAttribute('data-testid') ?? el.tagName)).toEqual([
      'SPAN',
      'kpi-gauge-row',
      'kpi-gauge-context',
    ]);
    const context = within(tile).getByTestId('kpi-gauge-context');
    expect(context).toHaveTextContent(/^20 active cases now$/);
    expect(context).not.toHaveTextContent(/High/);
    expect(context).toHaveClass('break-words', 'text-xs');
    // The figure row never wraps: the band word costs no width of its own (stacked over
    // "/100" in an inline block whose baseline is "/100"'s), and only the decorative arc
    // may narrow, from its bottom-left corner, on the narrowest tile with the widest figure.
    const row = within(tile).getByTestId('kpi-gauge-row');
    expect(row.className).not.toMatch(/\bflex-wrap\b/);
    expect(row).toHaveClass('min-w-0', 'items-end');
    const value = within(tile).getByTestId('kpi-gauge-value');
    expect(value).toHaveClass('shrink-0', 'whitespace-nowrap');
    const unit = within(tile).getByTestId('kpi-gauge-unit');
    expect(unit).toHaveClass('inline-block', 'leading-none', 'text-xs');
    expect(Array.from(unit.children).map((el) => el.textContent)).toEqual(['High', '/100']);
    expect(unit.lastElementChild).toHaveAttribute('aria-hidden', 'true');
    const arc = within(tile).getByTestId('kpi-gauge-arc');
    expect(arc).toHaveClass('min-w-0', 'shrink');
    expect(arc).not.toHaveClass('shrink-0');
    expect(arc).toHaveAttribute('preserveAspectRatio', 'xMinYMax meet');
    // The neighbour's caption is on the same kind of line (12 px, its own line under the numeral).
    const caption = screen.getByText('Right now').closest('[data-kpi-secondary]') as HTMLElement;
    expect(caption).toHaveClass('mt-1', 'block', 'text-xs');
    expect(context).toHaveClass('mt-1', 'block');
  });

  it('draws no arc share for a zero index and keeps the band word for every band', () => {
    const tile = (value: number) =>
      parseBlock({
        id: `g${value}`,
        type: 'kpi_group',
        provenance: 'code',
        artifact_kind: 'kpis',
        items: [{ key: 'r', label: 'Active Risk Index', value, unit: 'score', display: 'gauge' }],
      });
    const { unmount } = render(<AnswerBlocks blocks={[tile(0)]} messageId="m1" />);
    expect(screen.getByTestId('kpi-gauge-arc').querySelectorAll('path')).toHaveLength(1);
    // Without a context the band word still sits in the figure's line: no line of its own.
    expect(screen.getByTestId('kpi-gauge-row')).toContainElement(screen.getByTestId('kpi-gauge-band-word'));
    expect(screen.getByTestId('kpi-gauge-band-word')).toHaveTextContent(/^Low$/);
    expect(screen.queryByTestId('kpi-gauge-context')).toBeNull();
    unmount();
    render(<AnswerBlocks blocks={[tile(80)]} messageId="m2" />);
    expect(screen.getByTestId('kpi-gauge-arc').querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByTestId('kpi-gauge-band-word')).toHaveTextContent(/^Critical$/);
  });
});

describe('bar values (T34)', () => {
  it('draws the simple bar list with values after the bars (a small hbar)', () => {
    const block = parseBlock({
      id: 'h',
      type: 'chart',
      kind: 'hbar',
      provenance: 'code',
      artifact_kind: 'categories',
      unit: 'count',
      x: { kind: 'category', values: ['High', 'Medium', 'Low'] },
      series: [{ key: 's', label: 'Cases', values: [1, 3, 35] }],
    });
    render(<AnswerBlocks blocks={[block]} messageId="m1" />);
    const list = screen.getByTestId('chart-hbar-list');
    const rows = Array.from(list.querySelectorAll('[data-bar-row]')) as HTMLElement[];
    expect(rows).toHaveLength(3);
    const widths = rows.map((row) => (row.querySelector('[data-bar-fill]') as HTMLElement).style.width);
    // The longest bar takes the track less the value's room; the others scale to it.
    const factor = (w: string) => Number(/(?:^|\* |\()([0-9.]+) \*|\* ([0-9.]+)\)/.exec(w)?.slice(1).find(Boolean));
    for (const w of widths) expect(w).toContain('100% - 5ch');
    expect(factor(widths[2])).toBe(1);
    expect(factor(widths[0])).toBeCloseTo(1 / 35, 3);
    for (const row of rows) {
      const fill = row.querySelector('[data-bar-fill]') as HTMLElement;
      expect(fill.nextElementSibling).toHaveAttribute('data-bar-value');
    }
    expect(rows[2].querySelector('[data-bar-value]')).toHaveTextContent('35');
  });
});

describe('case references (T14)', () => {
  it('reads a case by number then title, with the internal id only as a tooltip', () => {
    const block = parseBlock({
      id: 'cl',
      type: 'case_list',
      provenance: 'code',
      artifact_kind: 'case_list',
      items: [
        { case_id: 'case-6b22d1999bf94f3a91c10ab2a23e6e7c', case_number: 'CASE-0042', title: 'Brute force on vpn-gw-2' },
        { case_id: 'case-0f5e', title: 'case-0f5e' },
      ],
    });
    render(<AnswerBlocks blocks={[block]} messageId="m1" />);
    const list = screen.getByTestId('block-case-list');
    const number = list.querySelector('[data-case-ref="number"]') as HTMLElement;
    expect(number).toHaveTextContent('CASE-0042');
    expect(number).toHaveClass('font-mono');
    expect(number).toHaveAttribute('title', 'case-6b22d1999bf94f3a91c10ab2a23e6e7c');
    // The title is whole; its host name never breaks at a hyphen (PW4-1: its own no-wrap span).
    const titleRef = list.querySelector('[data-case-ref="title"]') as HTMLElement;
    expect(titleRef.textContent).toBe('Brute force on vpn-gw-2');
    expect(Array.from(titleRef.querySelectorAll('[data-kept-token]'), (n) => n.textContent)).toEqual(['vpn-gw-2']);
    // The number never breaks at its hyphen: its own no-wrap span (a number longer than
    // 27 characters breaks where its line ends instead, third re-shoot review).
    expect(number.querySelector('[data-kept-token]')).toHaveTextContent('CASE-0042');
    expect(number.querySelector('[data-kept-token]')).toHaveClass('whitespace-nowrap');
    // With a number, the internal id is no longer a visible line under each row.
    expect(within(list).queryByText('case-6b22d1999bf94f3a91c10ab2a23e6e7c')).toBeNull();
    // A case with neither a number nor a title is named by its whole id, which wraps.
    const fallback = list.querySelector('[data-case-ref="id"]') as HTMLElement;
    expect(fallback).toHaveTextContent('case-0f5e');
    expect(fallback).toHaveClass('break-all');
    expect(fallback.className).not.toMatch(/truncate|max-w-/);
  });

  it('keeps rows with the same title apart by a visible short id while the server sends no case number', () => {
    // The real payload today: CaseListItem is strict and has no case_number (backend
    // agents/blocks.py), so every item is {case_id, title, ...}.
    const idA = 'case-7a10c3e2b54f4d0c9a8e11f2d3c4b5a6';
    const idB = 'case-91d04f7e2c3b4a5d8e6f70a1b2c3d4e5';
    const title = 'user:pnair \u2014 demo_impossible_travel on vpn-gw-1 from two countries';
    const block = parseBlock({
      id: 'cl2',
      type: 'case_list',
      provenance: 'code',
      artifact_kind: 'case_list',
      items: [
        { case_id: idA, title, severity: 'high', status: 'investigating' },
        { case_id: idB, title, severity: 'high', status: 'investigating' },
      ],
    });
    render(<AnswerBlocks blocks={[block]} messageId="m1" />);
    const list = screen.getByTestId('block-case-list');
    const rows = within(list).getAllByRole('listitem');
    const ids = rows.map((row) => row.querySelector('[data-case-ref="id"]') as HTMLElement);
    // Visible, muted, mono, middle-ellipsised; the full id in its tooltip and for assistive tech.
    expect(ids[0]).toHaveClass('font-mono', 'text-muted-foreground');
    expect(ids[0]).toHaveAttribute('title', idA);
    expect(ids[1]).toHaveAttribute('title', idB);
    expect(ids[0].querySelector('[aria-hidden]')).toHaveTextContent('case-7a10…b5a6');
    expect(ids[1].querySelector('[aria-hidden]')).toHaveTextContent('case-91d0…d4e5');
    expect(ids[0].querySelector('.sr-only')).toHaveTextContent(idA);
    // The two rows' accessible names differ, and the whole title stays on screen (it wraps).
    const links = within(list).getAllByRole('link');
    expect(links[0].textContent).not.toBe(links[1].textContent);
    expect(links[0]).toHaveClass('break-words');
    expect(links[0].className).not.toMatch(/truncate/);
    expect(rows[0].querySelector('[data-case-ref="title"]')?.textContent).toBe(title);
  });

  it('names an indicator’s related case by its title, with its id as a muted secondary', () => {
    render(<AnswerBlocks blocks={[galleryBlock('ioc')]} messageId="m1" />);
    const entity = screen.getByTestId('block-entity');
    expect(entity.querySelector('[data-case-ref="title"]')?.textContent).toBe('Brute force against vpn-gw-2');
    const id = entity.querySelector('[data-case-ref="id"]') as HTMLElement;
    expect(id).toHaveTextContent('case-1052');
    expect(id).toHaveClass('text-muted-foreground');
    expect(id.className).not.toMatch(/max-w-/);
    const link = id.closest('a') as HTMLElement;
    expect(link.className).not.toMatch(/truncate/);
  });
});

describe('status history words (T14)', () => {
  it('reads an answer saved before Round 14 in the same words a newer one stores, plain text', () => {
    const block = parseBlock({
      id: 'sh',
      type: 'timeline',
      provenance: 'code',
      artifact_kind: 'timeline',
      title: 'Status history',
      untrusted: true,
      events: [
        { at: '2026-10-17T10:00:00Z', label: 'open -> escalated', detail: 'by system: True positive routed to human: tp auto-close disabled.', kind: 'action' },
        { at: '2026-10-17T11:00:00Z', label: 'escalated -> resolved', detail: 'by alice: confirmed with the owner', kind: 'action' },
      ],
    });
    render(<AnswerBlocks blocks={[block]} messageId="m1" />);
    const timeline = screen.getByTestId('block-timeline');
    // One vocabulary (SPEC §4.6.3): never "Open → Escalated" beside a newer "Open to Escalated".
    const first = within(timeline).getByText('Open to Escalated');
    expect(first).not.toHaveClass('font-mono');
    expect(timeline).not.toHaveTextContent('→');
    expect(within(timeline).getByTestId('timeline-reason')).toHaveTextContent(
      /^Automatic close of a confirmed threat is off \(by the system\)$/,
    );
    // An analyst's own reason stays exactly as written, in the untrusted box.
    expect(within(timeline).getByText('by alice: confirmed with the owner')).toBeInTheDocument();
    expect(timeline).not.toHaveTextContent('open -> escalated');
  });

  it('reads the server words of a newer answer (Round 14) as plain text, never as code', () => {
    const block = parseBlock({
      id: 'sh14',
      type: 'timeline',
      provenance: 'code',
      artifact_kind: 'timeline',
      title: 'Status history',
      untrusted: true,
      events: [
        { at: '2026-10-17T10:00:00Z', label: 'Open to Escalated', detail: 'Automatic close of a confirmed threat is off (by the system)', kind: 'action' },
        { at: '2026-10-17T10:30:00Z', label: 'Created as New', detail: 'By the AI agent', kind: 'action' },
        { at: '2026-10-17T11:00:00Z', label: 'Escalated to Resolved', detail: 'confirmed with the owner (by alice)', kind: 'action' },
      ],
    });
    render(<AnswerBlocks blocks={[block]} messageId="m1" />);
    const timeline = screen.getByTestId('block-timeline');
    expect(within(timeline).getByText('Open to Escalated')).not.toHaveClass('font-mono');
    expect(within(timeline).getByText('Escalated to Resolved')).not.toHaveClass('font-mono');
    const reasons = within(timeline).getAllByTestId('timeline-reason').map((el) => el.textContent);
    expect(reasons).toEqual(['Automatic close of a confirmed threat is off (by the system)', 'By the AI agent']);
    // An analyst's own reason (and a person's name) stays untrusted, in the code box.
    const own = within(timeline).getByText('confirmed with the owner (by alice)');
    expect(own.closest('pre')).not.toBeNull();
  });

  it('reads a detail as an engine reason only on a status move, never on another timeline', () => {
    // An audit timeline (`chat_tools/ops.py`): "<action> by <actor>" over an untrusted
    // result summary. A summary that copies an engine template word for word is still
    // source text, so it stays fenced as written, never shown as Console prose.
    const template =
      'Closed automatically as a false positive: confidence 0.99 at or above 0.8, risk 1 at or below 20; objection window 30 minutes (by the AI agent)';
    const block = parseBlock({
      id: 'audit',
      type: 'timeline',
      provenance: 'code',
      artifact_kind: 'timeline',
      title: 'Audit timeline',
      untrusted: true,
      events: [
        { at: '2026-10-17T10:00:00Z', label: 'decision by agent', detail: template, kind: 'action' },
        { at: '2026-10-17T10:05:00Z', label: 'triage by system', detail: 'by system: True positive routed to human: tp auto-close disabled.', kind: 'action' },
      ],
    });
    render(<AnswerBlocks blocks={[block]} messageId="m1" />);
    const timeline = screen.getByTestId('block-timeline');
    expect(within(timeline).queryByTestId('timeline-reason')).toBeNull();
    const fenced = within(timeline).getByText(template);
    expect(fenced.closest('pre')).not.toBeNull();
    expect(within(timeline).getByText('by system: True positive routed to human: tp auto-close disabled.').closest('pre')).not.toBeNull();
    // The labels stay as written, in the untrusted mono face.
    expect(within(timeline).getByText(/decision by agent/)).toHaveClass('font-mono');
  });
});

export type { AnswerBlock };
