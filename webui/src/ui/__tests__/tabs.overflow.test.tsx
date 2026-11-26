/**
 * Underline tabs that do not fit (FXA1, acceptance gap phone-tab-strip-hides-active-tab).
 *
 * At a phone width the case header's six tabs scroll sideways. Selecting one past the
 * edge (a lane's "Open activity" link, Alt+5 or Alt+6) must bring it into the list by the
 * list's own scrollLeft, and each edge with more tabs past it fades. jsdom has no layout:
 * the list and the triggers report a 300 px list over 500 px of tabs, 80 px each.
 */
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { Tabs, TabsList, TabsTrigger } from '../tabs';

const TABS = ['brief', 'evidence', 'ai', 'response', 'activity', 'chat'];
const TAB_W = 80;
const LIST_W = 300;

const saved = {
  scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  rect: HTMLElement.prototype.getBoundingClientRect,
};

/** Lay the list out: the list scrolls over `TABS.length * TAB_W` px of triggers. */
function layout() {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'tablist' ? TABS.length * TAB_W : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'tablist' ? LIST_W : 0;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
    const list = this.closest('[role="tablist"]') as HTMLElement | null;
    const scroll = list?.scrollLeft ?? 0;
    if (this.getAttribute('role') === 'tablist') return new DOMRect(0, 0, LIST_W, 36);
    if (this.getAttribute('role') === 'tab') {
      const index = TABS.indexOf(this.getAttribute('data-value') ?? '');
      return new DOMRect(index * TAB_W - scroll, 0, TAB_W, 36);
    }
    return new DOMRect(0, 0, 0, 0);
  };
}

/** Put a faked layout property back (jsdom defines it on Element, not HTMLElement). */
function restore(name: 'scrollWidth' | 'clientWidth', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
}

afterEach(() => {
  restore('scrollWidth', saved.scrollWidth);
  restore('clientWidth', saved.clientWidth);
  HTMLElement.prototype.getBoundingClientRect = saved.rect;
});

const Strip: React.FC<{ value: string; variant?: 'underline' | 'boxed' }> = ({ value, variant = 'underline' }) => (
  <Tabs value={value}>
    <TabsList variant={variant} aria-label="Case sections">
      {TABS.map((tab) => (
        <TabsTrigger key={tab} value={tab} data-value={tab}>
          {tab}
        </TabsTrigger>
      ))}
    </TabsList>
  </Tabs>
);

describe('underline tabs that scroll (FXA1)', () => {
  it('bring the selected tab into the list by its own scrollLeft, clear of the fade', async () => {
    layout();
    const { rerender } = render(<Strip value="brief" />);
    const list = screen.getByRole('tablist');
    expect(list.scrollLeft).toBe(0);
    // More tabs past the right edge: the end fades, the start does not.
    expect(list).toHaveAttribute('data-overflow', 'end');
    expect(list.style.getPropertyValue('mask-image')).toContain('linear-gradient');

    rerender(<Strip value="activity" />);
    await act(async () => {});
    // Activity spans 320 to 400: its right edge plus the 24 px fade is inside 300 px.
    expect(list.scrollLeft).toBe(400 - LIST_W + 24);
    expect(list).toHaveAttribute('data-overflow', 'both');

    rerender(<Strip value="brief" />);
    await act(async () => {});
    expect(list.scrollLeft).toBe(0);
    expect(list).toHaveAttribute('data-overflow', 'end');
  });

  it('never pull a list the person scrolled back when a count changes, only on a new selection (FXA1 review)', async () => {
    layout();
    // A live count on the AI tab (a run under way) changes the triggers' text.
    const Live: React.FC<{ value: string; count: number }> = ({ value, count }) => (
      <Tabs value={value}>
        <TabsList variant="underline" aria-label="Case sections">
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab} data-value={tab}>
              {tab}
              {tab === 'ai' ? <span> {count}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    );
    const { rerender } = render(<Live value="brief" count={1} />);
    const list = screen.getByRole('tablist');
    expect(list.scrollLeft).toBe(0);
    // A count change while the list is where the reveal left it keeps the tab in view.
    rerender(<Live value="brief" count={2} />);
    await act(async () => {});
    expect(list.scrollLeft).toBe(0);

    // The person swipes the list to its end to reach Chat.
    list.scrollLeft = 180;
    list.dispatchEvent(new Event('scroll'));
    expect(list).toHaveAttribute('data-overflow', 'start');
    // The run adds a step: the list stays where the person put it.
    rerender(<Live value="brief" count={3} />);
    await act(async () => {});
    expect(list.scrollLeft).toBe(180);
    expect(list).toHaveAttribute('data-overflow', 'start');

    // A new selection still brings its tab into view.
    rerender(<Live value="evidence" count={3} />);
    await act(async () => {});
    // Evidence spans 80 to 160: its left edge clear of the 24 px fade.
    expect(list.scrollLeft).toBe(80 - 24);
  });

  it('leave a list that fits, and a boxed list, exactly as they were', () => {
    render(<Strip value="chat" />);
    const list = screen.getByRole('tablist');
    expect(list).not.toHaveAttribute('data-overflow');
    expect(list.style.getPropertyValue('mask-image')).toBe('');

    layout();
    render(<Strip value="chat" variant="boxed" />);
    const boxed = screen.getAllByRole('tablist')[1];
    expect(boxed.scrollLeft).toBe(0);
    expect(boxed).not.toHaveAttribute('data-overflow');
  });
});
