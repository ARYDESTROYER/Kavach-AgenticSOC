/**
 * KpiTile in a KpiStrip, Round 14 closing fixes (SPEC §4.9.2 "one KpiStrip grammar", the
 * §4.8.3 frame budget):
 *
 *   - ROW ALIGNMENT. Each strip tile is three rows of the strip's own grid (a subgrid:
 *     label, numeral, context line), so the numerals of one strip row share a line whatever
 *     the length of a label or a caption. A caption that wraps to a third line grows
 *     downward instead of lifting its numeral above its neighbours' (the Cost strip's
 *     "Tokens per call" tile at 1440px). A grid that holds anything but tiles (a wrapper
 *     cell) keeps the per-tile layout, since mixed rows would misplace the tracks, unless
 *     it opts in with `rowAlign` (its wrappers are subgrids of the strip's rows). Only the
 *     rows are the strip's: the tile's one column is bounded (`grid-cols-1`), so a long
 *     label word never widens the numeral row past the tile's clipping edge.
 *   - THE FIT GUARD does not re-render a numeral that is already at its largest size when
 *     its row widens (every tile of a strip widens together when the navigation collapses).
 *
 * jsdom has no layout, so the alignment is pinned on its structure (the classes the
 * browser lays out); the live check measures the numerals' positions.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { KpiStrip } from '../KpiStrip';
import { KpiStripContext, KpiTile, KpiTileGrid } from '../KpiTile';

// `grid-cols-1` is `repeat(1, minmax(0, 1fr))`: the tile's own column, bounded to the tile.
const ROW_ALIGNED = ['row-span-3', 'grid', 'grid-cols-1', 'grid-rows-subgrid'];

/** The numeral row of a tile: the parent of its numeral span. */
const numeralRow = (tile: HTMLElement) => {
  const row = tile.querySelector('span.leading-none')?.parentElement;
  if (!row) throw new Error('no numeral row');
  return row;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('row alignment in a KpiStrip', () => {
  it('makes every tile three rows of the strip grid, numerals on the row bottom, captions growing down', () => {
    render(
      <KpiStrip label="Spend summary" density="comfortable">
        <KpiTile label="Total cost" value="$0.10" context="last 7 days" testId="total" />
        <KpiTile label="LLM calls" value="7" context="last 7 days" testId="calls" />
        <KpiTile
          label="Tokens per call"
          value="4.6K"
          context="prompt and completion, a caption long enough to wrap past two lines in a narrow tile"
          testId="tokens-per-call"
        />
      </KpiStrip>,
    );
    const grid = screen.getByTestId('kpi-total').parentElement as HTMLElement;
    expect(grid).toHaveAttribute('data-kpi-rows', 'aligned');
    for (const id of ['total', 'calls', 'tokens-per-call']) {
      const tile = screen.getByTestId(`kpi-${id}`);
      expect(tile.parentElement).toBe(grid);
      expect(tile).toHaveClass(...ROW_ALIGNED);
      expect(tile).not.toHaveClass('flex-col');
      // Row 1: the label, from the top. Row 2: the numeral, on the row's bottom edge (no
      // auto margin pushing it inside its own cell). Row 3: the context, from the top.
      const [label, numerals, context] = Array.from(tile.children) as HTMLElement[];
      expect(label).toHaveClass('self-start');
      expect(numerals).toBe(numeralRow(tile));
      expect(numerals).toHaveClass('self-end', 'mt-0');
      expect(numerals).not.toHaveClass('mt-auto');
      expect(context).toHaveAttribute('data-kpi-row', 'context');
      expect(context).toHaveClass('self-start');
      expect(context.querySelector('[data-kpi-line="context"]')).not.toBeNull();
    }
    // The long caption is never clamped or cut: it wraps and grows its row downward.
    const caption = screen.getByTestId('kpi-tokens-per-call').querySelector('[data-kpi-line="context"]');
    expect(caption).toHaveClass('whitespace-normal', 'min-h-[2lh]');
    expect(caption?.className).not.toMatch(/line-clamp|truncate/);
  });

  it('keeps a delta out of the numeral row, opening the context row instead', () => {
    // A delta beside the numeral wraps under it on a narrow tile (the Lifecycle timing
    // strip at 1280px and 390px): that second line lifted the numeral above its
    // neighbours'. In the context row it grows downward like a long caption.
    render(
      <KpiStrip label="Lifecycle timing" density="compact">
        <KpiTile
          label="MTTR"
          value="<1m"
          context="median, resolved cases"
          delta={{ value: -1, label: '-100%', period: 'vs the previous window' }}
          testId="mttr"
        />
        <KpiTile label="MTTA" value="12m" context="median, acknowledged cases" testId="mtta" />
      </KpiStrip>,
    );
    const tile = screen.getByTestId('kpi-mttr');
    expect(tile).toHaveClass(...ROW_ALIGNED);
    // The three rows: label, numeral, context.
    const numerals = tile.children[1] as HTMLElement;
    expect(numerals.querySelector('[data-kpi-delta-period]')).toBeNull();
    expect(numerals.querySelector('[role="img"]')).toBeNull();
    const context = tile.children[2] as HTMLElement;
    expect(context).toHaveAttribute('data-kpi-row', 'context');
    const delta = context.querySelector('[data-kpi-row-delta]') as HTMLElement;
    expect(delta).not.toBeNull();
    // First in the context row, then the caption under it.
    expect(context.firstElementChild).toBe(delta);
    expect(delta.querySelector('[role="img"]')).toHaveAccessibleName(/100%/);
    expect(delta.querySelector('[data-kpi-delta-period]')).toHaveTextContent('vs the previous window');
    expect(delta.nextElementSibling).toHaveAttribute('data-kpi-line', 'context');
    // The numeral row still carries the numeral, and only it.
    expect(numerals).toHaveClass('self-end');
    expect(numerals.textContent).toBe('<1m');
    // A tile with no delta has no delta line.
    expect(screen.getByTestId('kpi-mtta').querySelector('[data-kpi-row-delta]')).toBeNull();
  });

  it('keeps the delta beside the numeral on a tile outside an aligned strip', () => {
    render(
      <KpiTile
        label="Escalations"
        value="7"
        context="last 7 days"
        delta={{ value: -1, label: '-100%', period: 'vs the previous window' }}
        testId="standalone-delta"
      />,
    );
    const tile = screen.getByTestId('kpi-standalone-delta');
    // The comparison words sit in the numeral's own row, beside the figure.
    const period = tile.querySelector('[data-kpi-delta-period]') as HTMLElement;
    expect(period.parentElement?.firstElementChild).toHaveTextContent('7');
    expect(period.parentElement).toHaveClass('flex-wrap', 'items-end');
    expect(tile.querySelector('[data-kpi-row-delta]')).toBeNull();
  });

  it('aligns a clickable tile with help through its cell root and its trigger', () => {
    render(
      <KpiStrip label="Case summary" density="compact">
        <KpiTile label="Open" value="12" context="open now" help="Cases not yet closed." onClick={() => undefined} testId="open" />
        <KpiTile label="Critical" value="2" context="open now" testId="critical" />
      </KpiStrip>,
    );
    const trigger = screen.getByTestId('kpi-open');
    expect(trigger.tagName).toBe('BUTTON');
    const cellRoot = trigger.parentElement as HTMLElement;
    expect(cellRoot.parentElement).toHaveAttribute('data-kpi-rows', 'aligned');
    expect(cellRoot).toHaveClass(...ROW_ALIGNED);
    expect(trigger).toHaveClass(...ROW_ALIGNED);
    // The help button still sits beside the trigger, in the cell's corner.
    expect(cellRoot.querySelector('button[aria-label="About Open"]')).not.toBeNull();
  });

  it("bounds every aligned tile's own column to the tile, whatever its label", () => {
    // MEASURED (Cost, 390px): an implicit `auto` column took a long label word's min-content
    // width (194px in a 147px tile), so the numeral and context rows ran 31px past the
    // tile's clipping edge and the fit guard measured a numeral row wider than what showed.
    // A one-column `minmax(0, 1fr)` template keeps every row at the tile's width.
    render(
      <KpiStrip label="Spend summary" density="compact">
        <KpiTile label="Supercalifragilisticexpialidocious" value="$1,234.56" context="last 7 days" testId="long" />
        <KpiTile
          label="Open"
          value="12"
          context="open now"
          help="Cases not yet closed."
          onClick={() => undefined}
          testId="help"
        />
      </KpiStrip>,
    );
    const long = screen.getByTestId('kpi-long');
    expect(long).toHaveClass('grid-cols-1', 'grid-rows-subgrid');
    const trigger = screen.getByTestId('kpi-help');
    const cellRoot = trigger.parentElement as HTMLElement;
    for (const el of [cellRoot, trigger]) {
      expect(el).toHaveClass('grid-cols-1', 'grid-rows-subgrid');
      // Never an implicit or content-sized column.
      expect(el.className).not.toMatch(/\bauto-cols-|\bgrid-cols-(?!1\b)/);
    }
  });

  it('aligns tiles inside wrapper cells when the grid opts in with rowAlign', () => {
    // The Agent effectiveness outcomes strip: each tile sits in a wrapper that is itself a
    // subgrid of the strip's rows (the tile's three rows, then its evidence lines).
    render(
      <KpiStripContext.Provider value={{ density: 'compact' }}>
        <KpiTileGrid count={2} surface="panel" rowAlign data-testid="outcomes">
          {['first', 'second'].map((id) => (
            <div key={id} className="row-span-4 grid min-w-0 grid-rows-subgrid" data-testid={`wrap-${id}`}>
              <KpiTile label={`Outcome ${id}`} value="42%" context="observed" testId={id} />
              <div>Evidence lines</div>
            </div>
          ))}
        </KpiTileGrid>
      </KpiStripContext.Provider>,
    );
    const grid = screen.getByTestId('outcomes');
    expect(grid).toHaveAttribute('data-kpi-rows', 'aligned');
    // `rowAlign` is the grid's option, not a DOM attribute.
    expect(grid).not.toHaveAttribute('rowalign');
    for (const id of ['first', 'second']) {
      const tile = screen.getByTestId(`kpi-${id}`);
      expect(tile.parentElement).toBe(screen.getByTestId(`wrap-${id}`));
      expect(tile).toHaveClass(...ROW_ALIGNED);
      // Label, numeral and context rows: the strip's rows 1 to 3, through the wrapper.
      expect(tile.children[1]).toHaveClass('self-end');
      expect(tile.children[2]).toHaveAttribute('data-kpi-row', 'context');
    }
  });

  it('keeps the per-tile layout when the strip holds anything but tiles', () => {
    render(
      <KpiStrip label="Case summary" density="comfortable">
        <div className="grid min-w-0">
          <KpiTile label="Open" value="12" context="open now" testId="wrapped" />
        </div>
        <KpiTile label="Closed" value="30" context="last 7 days" testId="plain" />
      </KpiStrip>,
    );
    const plain = screen.getByTestId('kpi-plain');
    expect(plain.parentElement).not.toHaveAttribute('data-kpi-rows');
    for (const tile of [plain, screen.getByTestId('kpi-wrapped')]) {
      expect(tile).toHaveClass('flex', 'h-full', 'flex-col');
      expect(tile).not.toHaveClass('row-span-3');
      expect(numeralRow(tile)).toHaveClass('mt-auto');
    }
  });

  it('gives a tile that cannot align the strip row three rows as one cell', () => {
    render(
      <KpiStrip label="Case summary" density="comfortable">
        <KpiTile label="Open" value="12" context="open now" testId="aligned" />
        <KpiTile
          label="Closed"
          value="30"
          breakdown={[
            { label: 'By the agent', value: '20' },
            { label: 'By a human', value: '10' },
          ]}
          testId="partitioned"
        />
        <KpiTile label="Framed" value="4" chrome="framed" numeral="default" testId="framed" />
      </KpiStrip>,
    );
    expect(screen.getByTestId('kpi-aligned')).toHaveClass(...ROW_ALIGNED);
    // A partition would add a fourth row, so the tile keeps its own column, across all three.
    const partitioned = screen.getByTestId('kpi-partitioned');
    expect(partitioned).toHaveClass('row-span-3', 'flex', 'flex-col');
    expect(partitioned).not.toHaveClass('grid-rows-subgrid');
    const framed = screen.getByTestId('kpi-framed');
    expect(framed).toHaveClass('row-span-3');
    expect(framed).not.toHaveClass('grid-rows-subgrid');
  });

  it('leaves a framed tile, a card grid and a tile outside any strip as they were', () => {
    render(
      <>
        <KpiTileGrid count={1}>
          <KpiTile label="In a card grid" value="1" chrome="framed" testId="card-grid" />
        </KpiTileGrid>
        <KpiTile label="Standalone" value="2" context="no strip" testId="standalone" />
      </>,
    );
    expect(screen.getByTestId('kpi-card-grid')).not.toHaveClass('row-span-3');
    expect(screen.getByTestId('kpi-standalone')).toHaveClass('flex', 'flex-col');
    expect(screen.getByTestId('kpi-standalone')).not.toHaveClass('row-span-3');
  });
});

describe('the numeral fit guard on a widening row', () => {
  it('does not re-render a numeral already at its largest size when its row widens', () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const commits = vi.fn();
    render(
      <React.Profiler id="tile" onRender={commits}>
        <KpiStrip label="Spend summary">
          <KpiTile label="Total cost" value="$0.10" context="last 7 days" testId="total" />
        </KpiStrip>
      </React.Profiler>,
    );
    const row = numeralRow(screen.getByTestId('kpi-total'));
    let width = 0;
    Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => width });
    commits.mockClear();
    // The navigation collapses: the row widens; the guard checks it on the next frame.
    width = 640;
    act(() => observers.forEach((callback) => callback([], {} as ResizeObserver)));
    act(() => {
      const pending = frames;
      frames = [];
      pending.forEach((callback) => callback(performance.now()));
    });
    expect(commits).not.toHaveBeenCalled();
  });
});
