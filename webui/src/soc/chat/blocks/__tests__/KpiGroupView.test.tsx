/**
 * KpiGroupView (Round 12, diagnosis/layout.md (c), the operator's screenshot 4): the
 * columns follow the item count (three figures, three columns: no empty tracks), the
 * grid draws no second frame inside the block card, a lower bound keeps its whole
 * numeral and its caption wraps on its own line ("≥253" over "in the returned page…",
 * never "≥…" beside "in the returned …"), and print/static mode puts each delta chip on
 * its own line and never renders a tile as a button.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { kpiGridColumns } from '@/soc/components/KpiTile';
import { BlockBody, BlockCard } from '../BlockCard';
import { BlocksContext } from '../context';
import { GALLERY_RAW, galleryBlock } from '../__fixtures__/gallery';
import { ROUND12_RAW, round12Block } from '../__fixtures__/round12';
import { KPI_HANG, KpiGroupView } from '../renderers/KpiGroupView';
import { parseBlock, type AnswerBlock, type KpiItem } from '../schema';

const SHOT4: KpiItem[] = [
  { key: 'matching', label: 'Matching cases', unit: 'count', value: 253 } as KpiItem,
  { key: 'still_open', label: 'Still open', unit: 'count', value: 253, bound: 'lower', context: 'in the returned page of 100 cases' } as KpiItem,
  { key: 'avg_risk', label: 'Average risk', unit: 'score', value: 13 } as KpiItem,
];

function show(items: KpiItem[], props: { staticMode?: boolean; framed?: boolean; navigate?: () => void } = {}) {
  return render(
    <BlocksContext.Provider value={{ navigate: props.navigate ?? vi.fn(), compact: false, domId: 'm' }}>
      <KpiGroupView items={items} idPrefix="t" staticMode={props.staticMode} framed={props.framed} />
    </BlocksContext.Provider>,
  );
}

const list = () => within(screen.getByTestId('block-kpis')).getByRole('list');

describe('KpiGroupView', () => {
  it('gives three figures three columns (never three tiles in a six-track row)', () => {
    show(SHOT4);
    const grid = list();
    expect(within(grid).getAllByRole('listitem')).toHaveLength(3);
    for (const cls of kpiGridColumns(3).split(' ')) expect(grid).toHaveClass(cls);
    expect(grid.className).not.toContain('grid-cols-6');
    expect(screen.getByTestId('block-kpis').querySelector('[data-kpi-grid-count]')).toHaveAttribute('data-kpi-grid-count', '3');
  });

  it.each([1, 2, 4, 5, 6, 7])('follows the item count with %i figures', (n) => {
    const items = Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `Figure ${i}`, unit: 'count', value: i } as KpiItem));
    show(items);
    expect(list().className).toContain(kpiGridColumns(n));
  });

  it('draws no frame of its own inside the block card (no double frame)', () => {
    show(SHOT4);
    const frame = screen.getByTestId('block-kpis').querySelector('[data-kpi-grid-frame]') as HTMLElement;
    expect(frame).toHaveAttribute('data-kpi-grid-frame', 'bare');
    expect(frame).not.toHaveClass('border');
  });

  it('hangs an unframed grid by the tiles\' padding, so tile text starts on the card\'s content edge', () => {
    show(SHOT4);
    // The hang equals the tiles' own side padding (KpiTile strip/compact px-3).
    expect(KPI_HANG).toBe('-mx-3');
    const container = screen.getByTestId('block-kpis').querySelector('[data-kpi-grid-count]') as HTMLElement;
    expect(container).toHaveClass(KPI_HANG);
    // The frame's clip still hides the outermost rules; the inner hairlines stay.
    const frame = container.querySelector('[data-kpi-grid-frame]') as HTMLElement;
    expect(frame).toHaveClass('overflow-hidden');
    expect(screen.getByTestId('kpi-t-0').className).toMatch(/\bpx-3\b/);
  });

  it('can still draw a closed frame when a host asks for one, and then does not hang', () => {
    show(SHOT4, { framed: true });
    const frame = screen.getByTestId('block-kpis').querySelector('[data-kpi-grid-frame]') as HTMLElement;
    expect(frame).toHaveAttribute('data-kpi-grid-frame', 'framed');
    expect(frame).toHaveClass('border', 'rounded-md');
    expect(screen.getByTestId('block-kpis').querySelector('[data-kpi-grid-count]')).not.toHaveClass(KPI_HANG);
  });

  it('keeps a lower bound whole and puts its caption on its own wrapping line (screenshot 4)', () => {
    show(SHOT4);
    const tile = screen.getByTestId('kpi-t-1');
    expect(tile).toHaveTextContent('≥253');
    expect(tile).toHaveTextContent('at least');
    const caption = screen.getByText('in the returned page of 100 cases');
    // The caption's line is its own block under the numeral and wraps: no ellipsis.
    const line = caption.closest('[data-kpi-secondary]') as HTMLElement;
    expect(line).toHaveClass('block', 'break-words');
    expect(line).not.toHaveClass('truncate');
    expect(caption).not.toHaveAttribute('title');
    // Nothing in the group is cut with an ellipsis.
    for (const el of Array.from(screen.getByTestId('block-kpis').querySelectorAll('span'))) {
      expect(el.className).not.toMatch(/\btruncate\b/);
    }
  });

  it('wraps a gauge tile label and caption instead of truncating them', () => {
    show([{ key: 'ari', label: 'Active Risk Index', unit: 'score', value: 47.6, display: 'gauge', context: '20 active cases now' } as KpiItem]);
    const tile = screen.getByTestId('kpi-t-0');
    expect(within(tile).getByText('Active Risk Index')).toHaveClass('break-words');
    expect(within(tile).getByText('20 active cases now')).toHaveClass('break-words');
    expect(tile.innerHTML).not.toContain('truncate');
  });

  it('in static/print mode puts each delta chip on its own line and renders no buttons', () => {
    const navigate = vi.fn();
    const items: KpiItem[] = [
      {
        key: 'opened',
        label: 'Cases opened',
        unit: 'count',
        value: 1284,
        delta: { value: 212, period_label: 'vs last week', good_direction: 'down' },
        ref: { page: 'cases', opts: { status: 'open' } },
      } as KpiItem,
    ];
    show(items, { staticMode: true, navigate });
    expect(screen.getByTestId('block-kpis')).toHaveAttribute('data-static', 'true');
    expect(screen.queryByRole('button')).toBeNull();
    const tile = screen.getByTestId('kpi-t-0');
    // The row that holds the chip becomes a column (selected by what it contains).
    expect(tile.className).toContain('[&_div:has(>[role=img])]:flex-col');
    const chip = within(tile).getByRole('img', { name: /changed up by \+212 vs last week/ });
    expect(chip.parentElement).toContainElement(chip);
  });

  it('keeps tiles with a ref as navigation buttons on screen', () => {
    const navigate = vi.fn();
    show([{ key: 'o', label: 'Open cases', unit: 'count', value: 3, ref: { page: 'cases', opts: { status: 'open' } } } as KpiItem], { navigate });
    screen.getByRole('button', { name: /Open cases/ }).click();
    expect(navigate).toHaveBeenCalledWith({ page: 'cases', opts: { status: 'open' } });
    expect(screen.getByTestId('kpi-t-0').className).not.toContain('flex-col');
  });
});

/* -------------------------------------------------------------------------- */
/* The host decides the frame (review: a report leaf lost its only frame).      */
/* -------------------------------------------------------------------------- */
const ctx = { navigate: vi.fn(), compact: false, domId: 'm' };
const kpiFrame = (root: HTMLElement) => root.querySelector('[data-kpi-grid-frame]')?.getAttribute('data-kpi-grid-frame');
const kpiHung = (root: HTMLElement) => (root.querySelector('[data-kpi-grid-count]') as HTMLElement).classList.contains(KPI_HANG);

function card(block: AnswerBlock, props: Partial<React.ComponentProps<typeof BlockCard>> = {}) {
  return render(
    <BlocksContext.Provider value={ctx}>
      <BlockCard block={block} index={0} {...props} />
    </BlocksContext.Provider>,
  );
}

/** An entity whose counts carry a link and a change (the static contract must hold for them too). */
function entityWithLinkedCounts(): AnswerBlock {
  const block = parseBlock({
    id: 'ioc-linked',
    type: 'entity',
    provenance: 'source',
    artifact_kind: 'entity',
    allowed_views: ['entity'],
    entity: { kind: 'ip', value: '203.0.113.14' },
    facts: [],
    reputation: [],
    counts: [
      {
        key: 'cases',
        label: 'Open cases',
        value: 4,
        unit: 'count',
        delta: { value: 2, period_label: 'vs last week', good_direction: 'down' },
        ref: { page: 'cases', opts: { status: 'open' } },
      },
    ],
    related_cases: [],
  });
  // Guard the fixture: the count really is linked and has a change.
  expect(block.type).toBe('entity');
  const count = (block as Extract<AnswerBlock, { type: 'entity' }>).counts[0];
  expect(count.ref).toBeTruthy();
  expect(count.delta).toBeTruthy();
  return block;
}

describe('KPI frame by host', () => {
  it('a top-level card is the frame: no frame of its own, hung to the card\'s content edge', () => {
    const { container } = card(galleryBlock('kpis'));
    expect(container.querySelector('figure')).toHaveClass('border', 'px-3');
    expect(kpiFrame(container)).toBe('bare');
    expect(kpiHung(container)).toBe(true);
  });

  it('a report leaf has no card frame, so its KPI group keeps its own closed frame (like a case list or table leaf)', () => {
    const { container } = card(galleryBlock('kpis'), { nested: true, headingLevel: 6 });
    expect(container.querySelector('figure')).not.toHaveClass('border');
    expect(kpiFrame(container)).toBe('framed');
    expect(kpiHung(container)).toBe(false);
  });

  it('a bare card (a report panel item) and the expanded sheet keep the closed frame too', () => {
    const bare = card(galleryBlock('kpis'), { bare: true });
    expect(kpiFrame(bare.container)).toBe('framed');
    bare.unmount();
    const block = galleryBlock('kpis');
    const sheet = render(
      <BlocksContext.Provider value={ctx}>
        <BlockBody block={block} title="Posture now" index={0} expanded />
      </BlocksContext.Provider>,
    );
    expect(kpiFrame(sheet.container)).toBe('framed');
    expect(kpiHung(sheet.container)).toBe(false);
  });

  it('an entity\'s counts sit in the card\'s or the entity\'s own frame, and frame themselves only with neither', () => {
    const top = card(galleryBlock('ioc'));
    expect(kpiFrame(top.container)).toBe('bare');
    expect(kpiHung(top.container)).toBe(true);
    top.unmount();
    // A report leaf: the entity draws its own 0.75rem-padded frame around the counts.
    const leaf = card(galleryBlock('ioc'), { nested: true, headingLevel: 6 });
    expect(screen.getByTestId('block-entity')).toHaveClass('border', 'p-3');
    expect(kpiFrame(leaf.container)).toBe('bare');
    expect(kpiHung(leaf.container)).toBe(true);
    leaf.unmount();
    const bare = card(galleryBlock('ioc'), { bare: true });
    expect(screen.getByTestId('block-entity')).not.toHaveClass('border');
    expect(kpiFrame(bare.container)).toBe('framed');
    expect(kpiHung(bare.container)).toBe(false);
  });

  it('a period comparison follows the same rule: hung in a top-level card, its note on the same content edge', () => {
    const { container } = card(round12Block('compare-tiles'));
    expect(container.querySelector('figure')).toHaveClass('border', 'px-3');
    const cmp = screen.getByTestId('block-comparison');
    expect(kpiFrame(cmp)).toBe('bare');
    expect(kpiHung(cmp)).toBe(true);
    // The tiles (and their trend row) keep the px-3 the hang cancels.
    expect(screen.getByTestId('kpi-chat-0-0').className).toMatch(/\bpx-3\b/);
    // The small-sample note is outside the hung grid: it starts on the card's content
    // edge, the same edge as the hung tile text, the title and the prose.
    const note = screen.getByTestId('comparison-small-sample-note');
    expect(note.closest('[data-kpi-grid-count]')).toBeNull();
    expect(note.parentElement).toBe(cmp);
    expect(note.className).not.toMatch(/(^|\s)-?m[xl]-/);
  });

  it('a period comparison draws its own closed frame in a report leaf, a bare card and the expanded sheet', () => {
    const block = round12Block('compare-tiles');
    const leaf = card(block, { nested: true, headingLevel: 6 });
    expect(leaf.container.querySelector('figure')).not.toHaveClass('border');
    expect(kpiFrame(screen.getByTestId('block-comparison'))).toBe('framed');
    expect(kpiHung(screen.getByTestId('block-comparison'))).toBe(false);
    expect(screen.getByTestId('block-comparison').querySelector('[data-kpi-grid-frame]')).toHaveClass('border', 'rounded-md');
    leaf.unmount();
    const bare = card(block, { bare: true });
    expect(kpiFrame(bare.container)).toBe('framed');
    expect(kpiHung(bare.container)).toBe(false);
    bare.unmount();
    const sheet = render(
      <BlocksContext.Provider value={ctx}>
        <BlockBody block={block} title="Change versus the previous period" index={0} expanded />
      </BlocksContext.Provider>,
    );
    expect(kpiFrame(sheet.container)).toBe('framed');
    expect(kpiHung(sheet.container)).toBe(false);
  });

  it('a comparison inside a report: the comparison leaf is framed like the KPI leaf beside it', () => {
    const brief = GALLERY_RAW.find((b) => (b as { id?: string }).id === 'shift-brief') as { sections: unknown[] };
    const tiles = ROUND12_RAW.find((b) => (b as { id?: string }).id === 'compare-tiles');
    const report = parseBlock({ ...brief, sections: [{ id: 'volume', heading: 'Volume', blocks: [tiles] }, ...brief.sections] });
    // Guard the fixture: a report holding both a comparison leaf and a KPI leaf.
    expect(report.type).toBe('report');
    card(report);
    const comparison = screen.getByTestId('block-comparison');
    const kpis = screen.getByTestId('block-kpis');
    expect(comparison.closest('figure')?.parentElement?.closest('figure')).not.toBeNull();
    expect(kpiFrame(comparison)).toBe('framed');
    expect(kpiFrame(kpis)).toBe('framed');
    expect(kpiHung(comparison)).toBe(false);
  });

  it('an entity\'s linked counts follow the static contract: no button on paper, the change on its own line', () => {
    const block = entityWithLinkedCounts();
    // On screen the linked count is a button that navigates.
    const live = card(block);
    expect(within(screen.getByTestId('block-entity')).getByRole('button', { name: /Open cases/ })).toBeInTheDocument();
    live.unmount();
    // Static (print / export): a plain tile, its delta chip in a column row.
    card(block, { staticMode: true });
    const entity = screen.getByTestId('block-entity');
    expect(within(entity).queryByRole('button', { name: /Open cases/ })).toBeNull();
    expect(within(entity).getByTestId('block-kpis')).toHaveAttribute('data-static', 'true');
    const tile = screen.getByTestId('kpi-chat-0-counts-0');
    expect(tile.tagName).not.toBe('BUTTON');
    expect(tile.className).toContain('[&_div:has(>[role=img])]:flex-col');
  });
});
