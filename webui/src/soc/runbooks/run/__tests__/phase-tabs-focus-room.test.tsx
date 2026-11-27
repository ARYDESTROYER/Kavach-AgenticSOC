/**
 * The phase tabs' focus ring is drawn whole (XFUI3). The phase list scrolls sideways
 * (`overflow-x-auto`), so it clips everything outside its padding box; with no padding the
 * ring a focused tab draws 2px off itself (`ring-2 ring-offset-2`) lost its top and bottom
 * edges, and the first tab its left one. The list now reaches past the tabs by the ring's
 * reach on every side, with a matching negative margin so the tabs do not move, and the
 * narrow fade sits on the list's own edge.
 *
 * jsdom applies no stylesheet, so this reads the ring's reach from the tab's own classes
 * and the room from the list's; the seeded Demo check measures the ring against the
 * list's clip at 390 by 844.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';

import { RunbookRunProvider } from '../context';
import { PHASE_LIST_ROOM, PhaseTabs } from '../PhaseTabs';
import { makeData, makeRun } from './fixtures';

function renderTabs(narrow: boolean) {
  const run = makeRun();
  return render(
    <TooltipProvider>
      <RunbookRunProvider
        caseId="case-1"
        caseLabel="CASE-000041"
        data={makeData([run])}
        run={run}
        canRun
        hasPermission={() => true}
        applyUpdate={vi.fn()}
        announce={vi.fn()}
      >
        <PhaseTabs phase="triage" onPhaseChange={vi.fn()} narrow={narrow} />
      </RunbookRunProvider>
    </TooltipProvider>,
  );
}

const classesOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/** Tailwind's spacing scale: `1` is 4px. */
const px = (step: string) => Number(step) * 4;

/** How far a focused tab's ring reaches past the tab, in px (`ring-N` plus `ring-offset-N`). */
function ringReach(tab: Element): number {
  const classes = classesOf(tab);
  const width = classes.map((c) => /^focus-visible:ring-(\d+)$/.exec(c)?.[1]).find(Boolean);
  const offset = classes.map((c) => /^focus-visible:ring-offset-(\d+)$/.exec(c)?.[1]).find(Boolean);
  expect(width, 'the tab draws a focus ring').toBeDefined();
  return Number(width) + Number(offset ?? 0);
}

/** The list's padding on one side, in px, the later utility winning as Tailwind orders them. */
function padding(list: Element, side: 't' | 'b' | 'l' | 'r'): number {
  let value = 0;
  const axis = side === 't' || side === 'b' ? 'y' : 'x';
  for (const c of classesOf(list)) {
    const m = new RegExp(`^p(${side}|${axis})?-(\\d+(?:\\.\\d+)?)$`).exec(c);
    if (m) value = px(m[2]);
  }
  return value;
}

describe('the phase tabs keep room for their focus ring inside the scrolling list', () => {
  it('pads the list by the ring reach on every side', () => {
    renderTabs(false);
    const list = screen.getByRole('tablist', { name: 'Phases' });
    expect(classesOf(list)).toContain('overflow-x-auto');
    const reach = ringReach(screen.getAllByRole('tab')[0]);
    expect(reach).toBe(4);
    for (const side of ['t', 'b', 'l', 'r'] as const) {
      expect(padding(list, side), `padding ${side}`).toBeGreaterThanOrEqual(reach);
    }
  });

  it('takes the room back with a matching negative margin and width, so the tabs stay put', () => {
    renderTabs(false);
    const list = screen.getByRole('tablist', { name: 'Phases' });
    const classes = classesOf(list);
    expect(classes).toEqual(expect.arrayContaining(['-m-1', 'p-1', 'w-[calc(100%+0.5rem)]']));
    expect(classes).not.toContain('w-full');
    expect(classes).not.toContain('p-0');
    expect(PHASE_LIST_ROOM.list).toBe('-m-1 w-[calc(100%+0.5rem)] p-1 scroll-px-1');
  });

  it('scrolls a focused tab into view with its ring inside the clip, and clear of the fade', () => {
    // Radix moves focus with the arrow keys, and focus scrolls the tab only as far as the
    // scroll padding asks: without it a tab at the edge lands flush with the clip.
    const { unmount } = renderTabs(false);
    expect(classesOf(screen.getByRole('tablist', { name: 'Phases' }))).toContain('scroll-px-1');
    unmount();
    renderTabs(true);
    const classes = classesOf(screen.getByRole('tablist', { name: 'Phases' }));
    // 2rem for the fade and 4px for the ring at the end.
    expect(classes).toEqual(expect.arrayContaining(['scroll-px-1', 'scroll-pr-9', 'pr-8']));
  });

  it('brings a focused tab whole into view, since the browser leaves a half-hidden one as it is', () => {
    // Live at 768 by 1024 the arrow keys moved focus to a tab 128px out of the list's
    // left edge and the list did not scroll: focus scrolls only a tab wholly out of view.
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderTabs(true);
      const tabs = screen.getAllByRole('tab');
      fireEvent.focus(tabs[tabs.length - 1]);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
      expect(scrollIntoView.mock.instances[0]).toBe(tabs[tabs.length - 1]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('keeps the narrow fade on the list edge and the end room for the last tab', () => {
    renderTabs(true);
    const list = screen.getByRole('tablist', { name: 'Phases' });
    // The end room the fade covers, plus the ring room above, below and at the start.
    expect(padding(list, 'r')).toBe(32);
    expect(padding(list, 't')).toBe(4);
    expect(padding(list, 'l')).toBe(4);
    const fade = list.parentElement!.querySelector('[aria-hidden].bg-gradient-to-l');
    expect(fade).not.toBeNull();
    // The list reaches 4px past its wrapper, so the fade does too, over its whole height.
    expect(classesOf(fade)).toEqual(expect.arrayContaining(['absolute', 'w-8', '-right-1', '-inset-y-1', 'pointer-events-none']));
    expect(classesOf(fade)).not.toContain('right-0');
  });
});
