/**
 * PageContainer — W0-C width-authority coverage (DESIGN_STANDARD §4.1/§4.5).
 *
 * jsdom does not run CSS layout, so we assert on the emitted Tailwind width classes
 * — those ARE the responsive contract Tailwind compiles to real breakpoints:
 *   - `wide`  widens PAST 1400 at ultrawide: base cap 1760px + `2xl:max-w-[1920px]`
 *             (≥1536px viewport → 1920px), so it never strands a narrow column.
 *   - `prose` stays a readable ~72ch measure (`max-w-[75ch]`) at EVERY breakpoint —
 *             it must NOT pick up the wide caps.
 *   - `fixed` (the DEFAULT) keeps the focused ~1200px cap so pages that have not
 *             opted into a width look unchanged after the shell's hard cap was removed.
 *   - `fluid` is uncapped (`max-w-none`) for full-bleed dashboards.
 * Every variant centers (`mx-auto w-full min-w-0`) and opens a container-query
 * context — but the page GUTTER/vertical rhythm is owned once by the AppShell
 * content wrapper, NOT re-declared here (so migrated + un-migrated pages share a
 * single consistent inset instead of doubling it). See PageContainer's docstring.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { PageContainer } from '../PageContainer';

/** Pull the class list of the single root box PageContainer renders. */
function classesOf(node: HTMLElement | null): string {
  return node?.getAttribute('class') ?? '';
}

describe('PageContainer width authority (W0-C)', () => {
  it("defaults to `fixed` (~1200px) so nothing changes until a page opts in", () => {
    const { container } = render(<PageContainer>body</PageContainer>);
    const cls = classesOf(container.firstElementChild as HTMLElement);
    expect(cls).toContain('max-w-[1200px]');
    // It must not accidentally inherit a wide/fluid/prose cap.
    expect(cls).not.toContain('max-w-[1760px]');
    expect(cls).not.toContain('max-w-none');
    expect(cls).not.toContain('75ch');
  });

  it('`wide` widens PAST 1400 at ≥1920 (1760 base, 1920 at 2xl)', () => {
    const { container } = render(<PageContainer variant="wide">body</PageContainer>);
    const cls = classesOf(container.firstElementChild as HTMLElement);
    // Base cap is already past 1400…
    expect(cls).toContain('max-w-[1760px]');
    // …and the 2xl (≥1536px viewport, i.e. any ≥1920 ultrawide) step widens to 1920.
    expect(cls).toContain('2xl:max-w-[1920px]');

    // Extract the numeric caps and prove BOTH exceed 1400.
    const caps = [...cls.matchAll(/max-w-\[(\d+)px\]/g)].map((m) => Number(m[1]));
    expect(caps.length).toBeGreaterThanOrEqual(2);
    for (const cap of caps) expect(cap).toBeGreaterThan(1400);
  });

  it('`prose` stays ~72ch (75ch measure) and never picks up the wide caps', () => {
    const { container } = render(<PageContainer variant="prose">body</PageContainer>);
    const cls = classesOf(container.firstElementChild as HTMLElement);
    expect(cls).toContain('max-w-[75ch]');
    // The ~72ch reading measure must not be overridden by a wide/fixed px cap.
    expect(cls).not.toMatch(/max-w-\[\d+px\]/);
    expect(cls).not.toContain('2xl:max-w-[1920px]');
  });

  it('`fluid` is uncapped for full-bleed dashboards', () => {
    const { container } = render(<PageContainer variant="fluid">body</PageContainer>);
    const cls = classesOf(container.firstElementChild as HTMLElement);
    expect(cls).toContain('max-w-none');
  });

  it('every variant centers + opens a container-query context (min-w-0)', () => {
    for (const variant of ['fixed', 'wide', 'fluid', 'prose'] as const) {
      const { container } = render(
        <PageContainer variant={variant}>body</PageContainer>,
      );
      const cls = classesOf(container.firstElementChild as HTMLElement);
      // Shared centering + container-query context (width authority per archetype).
      for (const shared of ['mx-auto', 'w-full', 'min-w-0', '@container']) {
        expect(cls).toContain(shared);
      }
    }
  });

  it('does NOT re-declare the page gutter/vertical rhythm (owned once by AppShell)', () => {
    // The AppShell content wrapper is the single gutter authority; PageContainer must
    // not double it (would waste width + add top dead space on every migrated page).
    for (const variant of ['fixed', 'wide', 'fluid', 'prose'] as const) {
      const { container } = render(
        <PageContainer variant={variant}>body</PageContainer>,
      );
      const cls = classesOf(container.firstElementChild as HTMLElement);
      for (const gutter of ['px-4', 'sm:px-6', 'lg:px-8', '2xl:px-12', 'py-6']) {
        expect(cls).not.toContain(gutter);
      }
    }
  });

  it('renders the requested element via `as` and forwards className/props', () => {
    const { container } = render(
      <PageContainer as="section" variant="wide" className="custom-page" data-testid="pc">
        content
      </PageContainer>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName.toLowerCase()).toBe('section');
    expect(root.getAttribute('data-testid')).toBe('pc');
    const cls = classesOf(root);
    expect(cls).toContain('custom-page');
    expect(cls).toContain('max-w-[1760px]');
  });
});

describe('PageContainer page rhythm (Round 14, SPEC §4.9.2)', () => {
  it('owns the rhythm by default through the `.page-rhythm` rule (type specificity, below any class)', () => {
    for (const variant of ['fixed', 'wide', 'fluid', 'prose'] as const) {
      const { container, unmount } = render(<PageContainer variant={variant}>body</PageContainer>);
      expect(classesOf(container.firstElementChild as HTMLElement)).toContain('page-rhythm');
      unmount();
    }
  });

  it('`rhythm="none"` opts out for a page that lays itself out', () => {
    const { container } = render(<PageContainer rhythm="none">body</PageContainer>);
    expect(classesOf(container.firstElementChild as HTMLElement)).not.toContain('page-rhythm');
  });

  it('keeps a page-supplied space-y (it wins until the page migrates)', () => {
    const { container } = render(<PageContainer className="space-y-6">body</PageContainer>);
    const cls = classesOf(container.firstElementChild as HTMLElement);
    expect(cls).toContain('page-rhythm');
    expect(cls).toContain('space-y-6');
  });
});

