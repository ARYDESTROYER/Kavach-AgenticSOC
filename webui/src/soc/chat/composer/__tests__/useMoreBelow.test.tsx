/**
 * useMoreBelow (Round 13, SPEC-chat T23): a scroll box fades at its bottom edge only
 * while more content is below it, re-measured on scroll; a list that fits never fades.
 * The scope popover's source list uses it (12rem tall at most).
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BOTTOM_FADE, BOTTOM_FADE_PX, revealInList, useMoreBelow } from '../useMoreBelow';

function Box({ height, content }: { height: number; content: number }) {
  const { ref, moreBelow } = useMoreBelow<HTMLDivElement>();
  return (
    <div
      ref={(el) => {
        if (el) {
          Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
          Object.defineProperty(el, 'scrollHeight', { configurable: true, value: content });
        }
        ref(el);
      }}
      data-testid="box"
      className={moreBelow ? BOTTOM_FADE : undefined}
      data-more-below={moreBelow ? '' : undefined}
    />
  );
}

describe('useMoreBelow', () => {
  it('fades while more is below and stops at the end', () => {
    render(<Box height={192} content={400} />);
    const box = screen.getByTestId('box');
    expect(box).toHaveAttribute('data-more-below');
    expect(box.className).toContain('mask-image');
    act(() => {
      box.scrollTop = 208;
      fireEvent.scroll(box);
    });
    expect(box).not.toHaveAttribute('data-more-below');
  });

  it('never fades a list that fits', () => {
    render(<Box height={192} content={150} />);
    expect(screen.getByTestId('box')).not.toHaveAttribute('data-more-below');
  });
});

describe('revealInList', () => {
  function list(scrollHeight: number) {
    const el = document.createElement('div');
    let top = 0;
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = Math.max(0, Math.min(v, scrollHeight - 192))) });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 192 });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
    el.getBoundingClientRect = () => ({ top: 100, bottom: 292, height: 192 }) as DOMRect;
    return { el, top: () => top };
  }
  const row = (top: number, height = 32) => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect;
    return el;
  };

  it('lifts a row out from under the bottom fade, scrolling only the list', () => {
    expect(BOTTOM_FADE_PX).toBe(24);
    const box = list(600);
    revealInList(box.el, row(280));
    // 312 bottom against 292 - 24: up by 44.
    expect(box.top()).toBe(44);
  });

  it('brings a row above the box back into view and leaves a visible row alone', () => {
    const box = list(600);
    box.el.scrollTop = 100;
    revealInList(box.el, row(60));
    expect(box.top()).toBe(60);
    revealInList(box.el, row(150));
    expect(box.top()).toBe(60);
  });
});
