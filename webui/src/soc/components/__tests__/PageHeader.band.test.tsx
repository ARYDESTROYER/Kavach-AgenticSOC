/**
 * PageHeader: a pinned sticky band keeps focus and headings clear of itself.
 *
 * Round 12 screenshot tour 2: the sticky Overview title band sat over a section heading
 * when scrolled ("Human vs AI" half under the band at 768), and polish round 2 found that
 * Shift+Tab could move keyboard focus onto a small control (the 24px "About Total Cases"
 * help button) entirely behind the band without the page scrolling (WCAG 2.4.11). A
 * heading-only `scroll-margin-top` could not cover focus. A pinned PageHeader now sets the
 * document scroller's `scroll-padding-top` to the top bar, its MEASURED height and the
 * 16px scroll-edge fade, which every scroll-into-view honours: focus, in-page links,
 * `scrollIntoView` and find-in-page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

import { PageHeader, bandScrollPadding } from '../PageHeader';

/** jsdom has no Tailwind: give the `sticky` utility its one declaration. */
let sheet: HTMLStyleElement;
beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = '.sticky { position: sticky; } .force-static { position: static; }';
  document.head.appendChild(sheet);
});
afterEach(() => {
  sheet.remove();
  vi.restoreAllMocks();
});

/** Each band (by test id) reports its height; every other element keeps jsdom's zero rect. */
function bandHeights(heights: Record<string, number>) {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.dataset.testid ? heights[this.dataset.testid] : undefined;
    if (height !== undefined) {
      return { x: 0, y: 56, top: 56, left: 0, right: 0, width: 0, height, bottom: 56 + height, toJSON: () => ({}) } as DOMRect;
    }
    return real.call(this);
  });
}

/** The document scroller's inline scroll padding (what focus scrolling honours). */
const rootPadding = () => document.documentElement.style.getPropertyValue('scroll-padding-top');

describe('PageHeader sticky band: document scroll padding', () => {
  it('pads the document scroller by the top bar, the pinned band and its fade, and clears it on unmount', () => {
    bandHeights({ band: 81.4 });
    const { unmount } = render(<PageHeader title="Cyber Defence Center" sticky data-testid="band" />);
    expect(rootPadding()).toBe('calc(var(--header-h) + 82px + 1rem)');
    expect(rootPadding()).toBe(bandScrollPadding(82));
    unmount();
    expect(rootPadding()).toBe('');
  });

  it('never leaves a scroll margin on the page headings (margin and padding would add up)', () => {
    bandHeights({ band: 82 });
    const { container } = render(
      <div>
        <PageHeader title="Overview" sticky data-testid="band" />
        <h2>Human vs AI</h2>
      </div>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toBe('');
    expect(wrapper.getAttribute('style')).toBeNull();
    expect(container.querySelector('h2')?.getAttribute('style')).toBeNull();
  });

  it('re-measures when the band wraps (resize)', () => {
    bandHeights({ band: 52 });
    const { unmount } = render(<PageHeader title="Overview" sticky data-testid="band" />);
    expect(rootPadding()).toBe(bandScrollPadding(52));
    vi.restoreAllMocks();
    bandHeights({ band: 108 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(rootPadding()).toBe(bandScrollPadding(108));
    unmount();
    expect(rootPadding()).toBe('');
  });

  it('holds no padding while the band is not pinned (static on a phone)', () => {
    bandHeights({ band: 108 });
    const { unmount } = render(
      <PageHeader title="Overview" sticky className="force-static" data-testid="band" />,
    );
    expect(rootPadding()).toBe('');
    unmount();
  });

  it('holds no padding for a header that is not sticky', () => {
    bandHeights({ band: 60 });
    const { unmount } = render(<PageHeader title="Cases" data-testid="band" />);
    expect(rootPadding()).toBe('');
    unmount();
  });

  it('keeps the arriving page padded when the leaving page unmounts during a route transition', () => {
    bandHeights({ leaving: 60, arriving: 82 });
    const leaving = render(<PageHeader title="Overview" sticky data-testid="leaving" />);
    const arriving = render(<PageHeader title="Overview" sticky data-testid="arriving" />);
    expect(rootPadding()).toBe(bandScrollPadding(82));
    leaving.unmount();
    expect(rootPadding()).toBe(bandScrollPadding(82));
    arriving.unmount();
    expect(rootPadding()).toBe('');
  });
});

describe('Overview pins its title band', () => {
  it('renders the sticky PageHeader and no heading scroll margin of its own', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'pages', 'Overview.tsx'),
      'utf8',
    );
    expect(src).toMatch(/<PageHeader\s+data-testid="page-hero"[\s\S]{0,120}\bsticky\b/);
    expect(src).not.toMatch(/scroll-mt-\[calc\(var\(--header-h\)/);
  });
});
