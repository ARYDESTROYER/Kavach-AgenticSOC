/**
 * The Console material (SPEC D16 / SYNTHESIS-ux §1.4): one recipe for floating chrome,
 * two thicknesses, the scroll-edge fade, and the shared sticky bars that wear it.
 *
 * jsdom has no layout, so the scroll-edge cases stub the two measurements the hook reads
 * (the bar's rect and its scroll container's offset) and drive it with real scroll events.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as React from 'react';

import { MaterialBar, materialBar, materialThick, useScrollEdge } from '@/design-system';
import { menuItem, menuSurface, overlaySurface } from '@/lib/ui-recipes';
import { ControlBar } from '@/soc/components/ControlBar';
import { FilterBar } from '@/soc/components/FilterBar';
import { PageHeader } from '@/soc/components/PageHeader';
import { Table, TableHead, TableHeader, TableRow } from '@/ui/table';

const tokens = (cls: string) => cls.split(/\s+/).filter(Boolean);

describe('material recipes', () => {
  it('keep a ≥0.97 fill with or without blur support, blur only where supported, and carry the fallback marker', () => {
    // The fill alone must hide what scrolls beneath: in Chromium the backdrop blur does
    // not reach routed content, so a 0.80 fill let chart labels and card text read
    // through (Round 12 screenshot tour).
    const fillOf = (c: string): number | null => {
      const m = /\/(?:(\d+)|\[(0?\.\d+)\])$/.exec(c);
      if (!m) return null;
      return m[1] !== undefined ? Number(m[1]) / 100 : Number(m[2]);
    };
    for (const recipe of [materialBar, materialThick]) {
      const t = tokens(recipe);
      expect(t).toContain('material-surface');
      const fills = t.map(fillOf).filter((f): f is number => f !== null);
      expect(fills.length).toBeGreaterThan(0);
      for (const f of fills) expect(f).toBeGreaterThanOrEqual(0.97);
      // One fill for every engine: no lighter `supports-[backdrop-filter]:` override.
      expect(t.filter((c) => c.startsWith('supports-') && fillOf(c) !== null)).toEqual([]);
      // Blur is gated on support, so an engine without backdrop-filter gets a near-solid fill.
      expect(t.filter((c) => c.includes('backdrop-blur')).every((c) => c.startsWith('supports-'))).toBe(true);
    }
    // Thicker for bigger surfaces.
    expect(materialThick).toContain('backdrop-blur-2xl');
    expect(materialBar).toContain('backdrop-blur-xl');
  });

  it('never makes a menu or popover translucent (no stacking), and rounds them concentrically', () => {
    for (const surface of [overlaySurface, menuSurface]) {
      expect(tokens(surface)).toContain('bg-popover');
      expect(surface).not.toMatch(/material-surface|backdrop-blur|bg-popover\/\d/);
      expect(tokens(surface)).toContain('rounded-lg');
    }
    expect(tokens(menuItem)).toContain('rounded-sm');
    expect(overlaySurface).toContain('shadow-overlay');
    expect(menuSurface).toContain('shadow-menu');
  });
});

describe('shared sticky bars wear the one material', () => {
  it('ControlBar, FilterBar and PageHeader use materialBar only when sticky', () => {
    const { container, rerender } = render(
      <>
        <ControlBar label="Page actions" sticky controls={<button type="button">Refresh</button>} />
        <FilterBar aria-label="Filters" sticky>
          <button type="button">Severity</button>
        </FilterBar>
        <PageHeader title="Cases" sticky />
      </>,
    );
    const sticky = Array.from(container.querySelectorAll('.sticky'));
    expect(sticky).toHaveLength(3);
    // The recipe, whole, and no second page-local fill beside it (the old bars spelled
    // their own `bg-background/95 backdrop-blur`, which none of the fallbacks reached).
    const fills = (cls: string) => tokens(cls).filter((c) => /(^|:)bg-[a-z-]+\/(\d+|\[[\d.]+\])$/.test(c));
    for (const el of sticky) {
      for (const token of tokens(materialBar)) expect(el).toHaveClass(token);
      expect(fills(el.className)).toEqual(fills(materialBar));
    }

    rerender(
      <>
        <ControlBar label="Page actions" controls={<button type="button">Refresh</button>} />
        <FilterBar aria-label="Filters">
          <button type="button">Severity</button>
        </FilterBar>
        <PageHeader title="Cases" />
      </>,
    );
    expect(container.querySelectorAll('.material-surface')).toHaveLength(0);
  });
});

describe('useScrollEdge — the scroll-edge fade', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function Harness({ enabled = true }: { enabled?: boolean }) {
    const ref = React.useRef<HTMLDivElement | null>(null);
    useScrollEdge(ref, { enabled });
    return (
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <div ref={ref} data-testid="bar" style={{ position: 'sticky', top: '56px' }} />
      </div>
    );
  }

  /** jsdom has no layout: say how tall the content is relative to the box. */
  function setOverflow(el: Element, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  }

  async function scrollTo(scroller: HTMLElement, bar: HTMLElement, scrollTop: number, barTop: number) {
    setOverflow(scroller, 2000, 600);
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: scrollTop });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ top: barTop } as DOMRect);
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
  }

  it('shows the fade only while the bar is pinned AND content has scrolled under it', async () => {
    render(<Harness />);
    const scroller = screen.getByTestId('scroller');
    const bar = screen.getByTestId('bar');

    // Unscrolled page, bar below its sticky offset: no fade.
    await scrollTo(scroller, bar, 0, 120);
    expect(bar).not.toHaveAttribute('data-scrolled');

    // Pinned at its offset but nothing scrolled (it simply starts at the top): no fade.
    await scrollTo(scroller, bar, 0, 56);
    expect(bar).not.toHaveAttribute('data-scrolled');

    // Pinned with content scrolled beneath: fade.
    await scrollTo(scroller, bar, 240, 56);
    expect(bar).toHaveAttribute('data-scrolled', 'true');

    // Scrolled back up so the bar sits below its offset again: fade removed.
    await scrollTo(scroller, bar, 10, 64);
    expect(bar).not.toHaveAttribute('data-scrolled');

    // Pushed up and out by the end of its containing block: it is leaving with the
    // content, not floating over it, so no fade.
    await scrollTo(scroller, bar, 900, 20);
    expect(bar).not.toHaveAttribute('data-scrolled');
  });

  it('skips an overflow-x:hidden wrapper that never scrolls and follows the WINDOW', async () => {
    // The AppShell shape: <main class="overflow-x-hidden"> computes overflow-y to `auto`
    // but grows with its content, so the document is what scrolls. Picking <main> would
    // read a scrollTop that never moves and never show the fade.
    function Shell() {
      const ref = React.useRef<HTMLDivElement | null>(null);
      useScrollEdge(ref);
      return (
        <main data-testid="main" style={{ overflowX: 'hidden', overflowY: 'auto' }}>
          <div ref={ref} data-testid="bar" style={{ position: 'sticky', top: '56px' }} />
        </main>
      );
    }
    render(<Shell />);
    const main = screen.getByTestId('main');
    const bar = screen.getByTestId('bar');
    setOverflow(main, 3000, 3000); // grows with its content: nothing to scroll
    const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ top: 56 } as DOMRect);
    try {
      Object.defineProperty(root, 'scrollTop', { configurable: true, value: 1000 });
      await act(async () => {
        document.dispatchEvent(new Event('scroll'));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });
      expect(bar).toHaveAttribute('data-scrolled', 'true');

      Object.defineProperty(root, 'scrollTop', { configurable: true, value: 0 });
      await act(async () => {
        document.dispatchEvent(new Event('scroll'));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });
      expect(bar).not.toHaveAttribute('data-scrolled');
    } finally {
      delete (root as unknown as { scrollTop?: number }).scrollTop;
    }
  });

  it('does nothing when disabled, and clears the flag on unmount', async () => {
    const { rerender, unmount } = render(<Harness />);
    const scroller = screen.getByTestId('scroller');
    const bar = screen.getByTestId('bar');
    await scrollTo(scroller, bar, 240, 56);
    expect(bar).toHaveAttribute('data-scrolled', 'true');

    rerender(<Harness enabled={false} />);
    expect(bar).not.toHaveAttribute('data-scrolled');
    await scrollTo(scroller, bar, 300, 56);
    expect(bar).not.toHaveAttribute('data-scrolled');
    unmount();
  });
});

describe('the shared sticky bars show the scroll-edge fade', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PageHeader, ControlBar, FilterBar and TableHeader flag themselves while pinned over scrolled content', async () => {
    const { container } = render(
      <>
        <PageHeader title="Cases" sticky data-testid="ph" />
        <ControlBar label="Page actions" sticky controls={<button type="button">Refresh</button>} />
        <FilterBar aria-label="Filters" sticky>
          <button type="button">Severity</button>
        </FilterBar>
        <Table>
          <TableHeader sticky>
            <TableRow>
              <TableHead>Col</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      </>,
    );
    const bars = Array.from(container.querySelectorAll<HTMLElement>('.material-surface'));
    expect(bars.map((b) => b.tagName)).toEqual(['SECTION', 'DIV', 'DIV', 'THEAD']);
    // The sticky offset comes from a class (no computed `top` in jsdom), so "pinned" is a
    // top edge at 0 relative to the window.
    for (const bar of bars) vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    try {
      Object.defineProperty(root, 'scrollTop', { configurable: true, value: 400 });
      await act(async () => {
        document.dispatchEvent(new Event('scroll'));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });
      for (const bar of bars) expect(bar).toHaveAttribute('data-scrolled', 'true');
    } finally {
      delete (root as unknown as { scrollTop?: number }).scrollTop;
    }
  });

  it('gives up the hard rules when pinned (the fade replaces them) and lifts small material text', () => {
    const { container } = render(
      <>
        <ControlBar label="Page actions" sticky controls={<button type="button">Refresh</button>} />
        <FilterBar aria-label="Filters" sticky>
          <button type="button">Severity</button>
        </FilterBar>
        <Table>
          <TableHeader sticky>
            <TableRow>
              <TableHead>Col</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      </>,
    );
    const [control, filter] = Array.from(container.querySelectorAll<HTMLElement>('div.material-surface'));
    expect(tokens(control.className)).toContain('border-b-0');
    expect(tokens(filter.className)).toContain('border-y-0');
    expect(tokens(filter.className)).not.toContain('border-y');
    // 11px column labels on the material are secondary ink, never muted.
    expect(tokens(container.querySelector('thead')!.className)).toContain('[&_th]:text-secondary-foreground');
  });

  it('a non-sticky bar keeps its own rules (none on a panel, hairlines as a band) and never observes scroll', () => {
    // Round 14: the FilterBar is a labelled group (its controls are ordinary tab stops; a
    // toolbar would promise a roving-focus model it does not have). On a panel (the
    // default) it draws no rules of its own; the canvas band keeps its hairlines.
    const { container } = render(
      <>
        <FilterBar aria-label="Panel filters">
          <button type="button">Severity</button>
        </FilterBar>
        <FilterBar aria-label="Band filters" variant="band">
          <button type="button">Severity</button>
        </FilterBar>
      </>,
    );
    const [plain, band] = Array.from(container.querySelectorAll<HTMLElement>('[role="group"][data-filter-bar]'));
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
    expect(tokens(plain.className)).not.toContain('border-y');
    expect(tokens(band.className)).toEqual(expect.arrayContaining(['border-y', 'border-border/80']));
    expect(plain).not.toHaveAttribute('data-scrolled');
    expect(band).not.toHaveAttribute('data-scrolled');
  });
});

describe('MaterialBar', () => {
  it('is a sticky material bar by default and forwards its ref', () => {
    const ref = React.createRef<HTMLDivElement>();
    render(
      <MaterialBar ref={ref} data-testid="bar">
        Controls
      </MaterialBar>,
    );
    const bar = screen.getByTestId('bar');
    expect(ref.current).toBe(bar);
    expect(bar).toHaveClass('material-surface', 'sticky', 'top-[var(--header-h)]', 'z-20');
    expect(bar).toHaveTextContent('Controls');
  });

  it('offers the thick material and a non-sticky form', () => {
    render(
      <MaterialBar data-testid="bar" thickness="thick" sticky={false}>
        Pane header
      </MaterialBar>,
    );
    const bar = screen.getByTestId('bar');
    expect(bar).toHaveClass('material-surface', 'supports-[backdrop-filter]:backdrop-blur-2xl');
    expect(bar).not.toHaveClass('sticky');
  });
});
