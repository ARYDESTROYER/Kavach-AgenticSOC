/**
 * Transcript — `role="log"` with `aria-live="off"`, exchanges in order, the empty and
 * replace slots, scroll anchoring on send (user turn at the lane top with a 48 px peek),
 * Jump to latest when the reader is away from the bottom (and again after a jump, when
 * new content lands), sticking to the bottom while late content lands after a thread
 * opens, the requested-message highlight for 2 s (and dropping a request whose message
 * is gone), content-visibility on older exchanges without subgrid, focus handed to the
 * composer after a transcript action, and the turn announcer.
 *
 * Round 12 (SPEC D12, diagnosis/layout.md): one lane with two edges (three tracks, the
 * gutters are tracks, no side padding), the user turn spanning the lane so its bubble
 * sits on the right edge, the scroll lane as the containing block of every absolutely
 * positioned descendant (sr-only headings can never scroll the frame), and Jump to
 * latest whenever ANY content is hidden below the fold, outside the content (a pill over
 * a masked band).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { AnnouncerProvider } from '@/soc/components/announcer';
import { TooltipProvider } from '@/ui/tooltip';
import type { ChatEngine, ChatTranscriptItem } from '../../useChatEngine';
import { CONTENT_COL, LANE_COL, LANE_GRID } from '../lane';
import {
  ANCHOR_PEEK_PX,
  FOLLOW_THRESHOLD_PX,
  HIGHLIGHT_MS,
  JUMP_MASK,
  JUMP_SCROLL_PADDING,
  JUMP_THRESHOLD_PX,
  Transcript,
  groupExchanges,
  type TranscriptProps,
} from '../Transcript';
import { useTurnAnnouncer } from '../useTurnAnnouncer';
import { assistantItem, response, runningItem, stubEngine, userItem } from './fixtures';

type TestEngine = Pick<ChatEngine, 'items'> & ReturnType<typeof stubEngine>;

function engineWith(items: ChatTranscriptItem[], busy = false): TestEngine {
  return { ...stubEngine({ busy }), items };
}

function renderTranscript(props: Partial<TranscriptProps> & { engine: TestEngine }) {
  return render(
    <TooltipProvider>
      <Transcript {...props} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // jsdom has no Element.scrollTo; drop the spy one test installs.
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

/** Controllable lane geometry (jsdom has no layout); `top` clamps like a browser. */
function laneMetrics(container: HTMLElement, initial = { top: 0, height: 2000, client: 500 }) {
  const lane = container.querySelector('[data-chat-scroll-lane]') as HTMLElement;
  const m = { ...initial };
  Object.defineProperty(lane, 'scrollTop', {
    configurable: true,
    get: () => m.top,
    set: (value: number) => {
      m.top = Math.max(0, Math.min(value, m.height - m.client));
    },
  });
  Object.defineProperty(lane, 'scrollHeight', { configurable: true, get: () => m.height });
  Object.defineProperty(lane, 'clientHeight', { configurable: true, get: () => m.client });
  return { lane, m };
}

/** A ResizeObserver whose notifications the test delivers. */
function captureResizeObservers() {
  const callbacks: Array<() => void> = [];
  class ManualResizeObserver {
    constructor(callback: () => void) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ManualResizeObserver);
  return () => act(() => callbacks.forEach((callback) => callback()));
}

function withText(item: ReturnType<typeof runningItem>, text: string) {
  return { ...item, live: { ...item.live!, text } };
}

describe('Transcript', () => {
  it('pairs each user turn with its answer', () => {
    const u1 = userItem('one');
    const a1 = assistantItem();
    const u2 = userItem('two');
    expect(groupExchanges([u1, a1, u2]).map((e) => [e.user?.content ?? null, e.assistant?.key ?? null])).toEqual([
      ['one', a1.key],
      ['two', null],
    ]);
  });

  it('is a log with its implicit live region turned off and renders the user content, never the raw prompt', () => {
    renderTranscript({
      engine: engineWith([userItem('Show failed logins', { prompt: 'Show failed​ logins' }), assistantItem()]),
    });
    const log = screen.getByRole('log', { name: 'Messages' });
    // role=log is implicitly polite; only the shell announcer may speak.
    expect(log).toHaveAttribute('aria-live', 'off');
    expect(screen.getByText('Show failed logins')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'You' })).toBeInTheDocument();
  });

  it('shows the empty slot without turns and the replace slot instead of turns', () => {
    const { rerender } = renderTranscript({ engine: engineWith([]), empty: <p>Start here</p> });
    expect(screen.getByText('Start here')).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
    rerender(
      <TooltipProvider>
        <Transcript engine={engineWith([userItem(), assistantItem()])} replace={<p>Restoring</p>} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Restoring')).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('defers rendering of older exchanges but never the latest two', () => {
    const items: ChatTranscriptItem[] = [];
    for (let i = 0; i < 4; i += 1) items.push(userItem(`q${i}`), assistantItem());
    const { container } = renderTranscript({ engine: engineWith(items) });
    const exchanges = Array.from(container.querySelectorAll('[data-exchange]'));
    expect(exchanges).toHaveLength(4);
    expect(exchanges[0].className).toContain('[content-visibility:auto]');
    expect(exchanges[3].className).not.toContain('[content-visibility:auto]');
    // Layout containment turns a subgrid into a plain grid (CSS Grid 2), so every
    // exchange repeats the lane tracks instead of subgridding them.
    const tracks = 'grid-cols-[minmax(var(--chat-gutter,0px),1fr)_minmax(0,var(--chat-lane-max,100%))_minmax(var(--chat-gutter,0px),1fr)]';
    for (const exchange of exchanges) {
      expect(exchange.className).not.toContain('grid-cols-subgrid');
      expect(exchange.className).toContain(tracks);
    }
  });

  it('lays every turn on one lane with two edges (Round 12, SPEC D12)', () => {
    const { container } = renderTranscript({
      engine: engineWith([userItem('Show failed logins'), assistantItem({ response: response({ follow_ups: ['Which hosts?'] }) })]),
    });
    const lane = container.querySelector('[data-chat-scroll-lane]') as HTMLElement;
    const grid = lane.firstElementChild as HTMLElement;
    // The gutters are the grid's side tracks: no side padding on the content grid.
    expect(grid.className).toBe(`${LANE_GRID} gap-y-6 py-6`);
    expect(grid.className).not.toMatch(/\bpx-/);
    // The user turn spans the lane, so its right-aligned bubble ends on the lane's right edge.
    const userTurn = screen.getByText('Show failed logins').parentElement as HTMLElement;
    expect(userTurn.className).toContain(LANE_COL);
    expect(userTurn).toHaveClass('justify-end');
    // Prose keeps its measure on the lane's LEFT edge; follow-ups span the lane.
    expect(CONTENT_COL).toContain('max-w-[48rem]');
    expect(CONTENT_COL).toContain('justify-self-start');
    const followUps = screen.getByRole('group', { name: 'Suggested follow-ups' });
    expect(followUps.className).toContain(LANE_COL);
    expect(followUps.className).not.toContain('max-w-[48rem]');
  });

  it('makes the scroll lane the containing block of its sr-only headings (diagnosis (d))', () => {
    const { container } = renderTranscript({ engine: engineWith([userItem('q'), assistantItem()]) });
    const lane = container.querySelector('[data-chat-scroll-lane]') as HTMLElement;
    expect(lane).toHaveClass('relative', 'overflow-y-auto');
    // Every turn heading is inside the positioned lane, so it is clipped and scrolled by it.
    for (const heading of screen.getAllByRole('heading', { level: 3 })) {
      expect(heading).toHaveClass('sr-only');
      expect(lane.contains(heading)).toBe(true);
    }
  });

  it('centres the compact embed\'s Jump to latest on its one 48rem column', () => {
    const { container } = renderTranscript({ engine: engineWith([userItem('q'), assistantItem({ restored: true })]), compact: true });
    const { lane, m } = laneMetrics(container, { top: 500, height: 1000, client: 500 });
    fireEvent.wheel(lane);
    m.top = 100;
    fireEvent.scroll(lane);
    const bar = screen.getByTestId('jump-to-latest-bar');
    expect(bar).toHaveClass('px-1', '[scrollbar-gutter:stable_both-edges]');
    const column = screen.getByRole('button', { name: 'Jump to latest' }).parentElement as HTMLElement;
    expect(column.className).toContain(CONTENT_COL);
    expect(column).toHaveClass('justify-center');
  });

  it('keeps the compact embed on its own 4 px inset and in one 48rem column (no host gutter)', () => {
    const { container } = renderTranscript({ engine: engineWith([userItem('Case question'), assistantItem()]), compact: true });
    const grid = (container.querySelector('[data-chat-scroll-lane]') as HTMLElement).firstElementChild as HTMLElement;
    expect(grid).toHaveClass('px-1', 'py-3');
    // Its composer is a 48rem column too, so the bubble ends where the composer ends.
    const userTurn = screen.getByText('Case question').parentElement as HTMLElement;
    expect(userTurn.className).toContain(CONTENT_COL);
  });

  it('anchors a new turn at the lane top with a 48 px peek of the previous one', () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: scrollTo });
    const earlier = [userItem('earlier'), assistantItem({ restored: true })];
    const { rerender, container } = renderTranscript({ engine: engineWith(earlier) });
    const user = userItem('new question');
    const running = runningItem();
    // The new exchange sits 600 px into the lane content.
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.exchange === user.key) return DOMRect.fromRect({ x: 0, y: 600, width: 100, height: 50 });
      return original.call(this);
    });
    scrollTo.mockClear();
    rerender(
      <TooltipProvider>
        <Transcript engine={engineWith([...earlier, user, running], true)} />
      </TooltipProvider>,
    );
    expect(container.querySelector(`[data-exchange="${user.key}"]`)).not.toBeNull();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 600 - ANCHOR_PEEK_PX }));
  });

  it('offers Jump to latest while the reader is away from the bottom', () => {
    const user = userItem('q');
    const running = runningItem();
    const { container, rerender } = renderTranscript({ engine: engineWith([user, running], true) });
    const lane = container.querySelector('[data-chat-scroll-lane]') as HTMLElement;
    Object.defineProperty(lane, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(lane, 'clientHeight', { configurable: true, value: 500 });
    lane.scrollTop = 100;
    fireEvent.scroll(lane);
    rerender(
      <TooltipProvider>
        <Transcript engine={engineWith([user, { ...running, live: { ...running.live!, text: 'more' } }], true)} />
      </TooltipProvider>,
    );
    const jump = screen.getByRole('button', { name: 'Jump to latest' });
    fireEvent.click(jump);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('shows Jump to latest whenever content is hidden below the fold, not only past the follow threshold', () => {
    const deliverResize = captureResizeObservers();
    const { container } = renderTranscript({ engine: engineWith([userItem('q'), assistantItem({ restored: true })]) });
    const { lane, m } = laneMetrics(container, { top: 500, height: 1000, client: 500 });
    expect(JUMP_THRESHOLD_PX).toBeLessThan(FOLLOW_THRESHOLD_PX);
    // The reader takes over 40 px above the bottom: still "following" (≤ 72 px), but a
    // follow-up row is hidden, so the pill shows.
    fireEvent.wheel(lane);
    m.top = 460;
    fireEvent.scroll(lane);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
    // Within 8 px of the bottom nothing meaningful is hidden: no pill.
    m.top = 495;
    fireEvent.scroll(lane);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    // Growth below a reader who took over brings it back.
    m.height = 1100;
    deliverResize();
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
  });

  it('puts Jump to latest outside the content: a centred pill over a masked band', () => {
    const { container } = renderTranscript({ engine: engineWith([userItem('q'), assistantItem({ restored: true })]) });
    const { lane, m } = laneMetrics(container, { top: 500, height: 1000, client: 500 });
    expect(lane.className).not.toContain('mask-image');
    fireEvent.wheel(lane);
    m.top = 100;
    fireEvent.scroll(lane);
    const bar = screen.getByTestId('jump-to-latest-bar');
    // Centred on the lane's bottom edge, only the button takes pointer events, and no
    // page-coloured gradient is painted over the text any more.
    expect(bar).toHaveClass('pointer-events-none', 'absolute', 'inset-x-0', 'flex', 'justify-center');
    expect(bar.querySelector('[class*="bg-gradient"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toHaveClass('pointer-events-auto', 'rounded-full');
    // The lane fades its bottom band out while the pill shows, so the pill never sits
    // on a line of text.
    expect(lane).toHaveAttribute('data-jump-mask', 'true');
    for (const cls of JUMP_MASK.split(' ')) expect(lane).toHaveClass(cls);
    expect(JUMP_MASK).toContain('transparent_2.5rem');
    // A keyboard focus that scrolls into view lands clear of the faded band.
    expect(lane).toHaveClass(JUMP_SCROLL_PADDING);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(lane).not.toHaveAttribute('data-jump-mask');
    expect(lane).not.toHaveClass(JUMP_SCROLL_PADDING);
  });

  it('brings Jump to latest back after a jump when new content lands below the reader', () => {
    const onFocusComposer = vi.fn();
    const user = userItem('q');
    const running = runningItem();
    const { container, rerender } = renderTranscript({ engine: engineWith([user, running], true), onFocusComposer });
    const { lane, m } = laneMetrics(container);
    const update = (text: string) =>
      rerender(
        <TooltipProvider>
          <Transcript engine={engineWith([user, withText(running, text)], true)} onFocusComposer={onFocusComposer} />
        </TooltipProvider>,
      );

    // The reader scrolls away while the turn runs: Jump to latest appears.
    m.top = 100;
    fireEvent.scroll(lane);
    update('a');
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(m.top).toBe(1500);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    // The button unmounted: focus goes to the composer, not <body>.
    expect(onFocusComposer).toHaveBeenCalledTimes(1);

    // After the jump the lane follows the running turn to the bottom...
    m.height = 2600;
    update('ab');
    expect(m.top).toBe(2100);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    // ...until the reader scrolls away again; then the button comes back.
    m.top = 400;
    fireEvent.scroll(lane);
    m.height = 3000;
    update('abc');
    expect(m.top).toBe(400);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
  });

  it('keeps an opened thread at its latest turn while late content lands, until the reader takes over', () => {
    const deliverResize = captureResizeObservers();
    const { container } = renderTranscript({ engine: engineWith([userItem('q'), assistantItem({ restored: true })]) });
    const { lane, m } = laneMetrics(container, { top: 500, height: 1000, client: 500 });

    // The lazy answer blocks replace their placeholders: the lane re-pins to the bottom.
    m.height = 1400;
    deliverResize();
    expect(m.top).toBe(900);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    // The reader takes over and scrolls up: later growth no longer moves the lane, and
    // Jump to latest says there is more below.
    fireEvent.wheel(lane);
    m.top = 200;
    fireEvent.scroll(lane);
    m.height = 1800;
    deliverResize();
    expect(m.top).toBe(200);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
  });

  it('hands focus to the composer after a transcript action that sends', () => {
    const onFocusComposer = vi.fn();
    const engine = engineWith([userItem('q'), assistantItem({ response: response({ follow_ups: ['Show the top hosts'] }) })]);
    renderTranscript({ engine, onFocusComposer });
    fireEvent.click(screen.getByRole('button', { name: 'Show the top hosts' }));
    expect(engine.send).toHaveBeenCalledWith('Show the top hosts', { origin: 'follow_up' });
    expect(onFocusComposer).toHaveBeenCalledTimes(1);
    // Nothing sent (busy, blocked): focus is left alone.
    (engine.askAgain as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(onFocusComposer).toHaveBeenCalledTimes(1);
  });

  it('drops a requested message that is not in the restored thread and opens at the latest turn', () => {
    const onHighlightDone = vi.fn();
    const items = [userItem('q'), assistantItem({ restored: true, messageId: 'm-present' })];
    const { container, rerender } = renderTranscript({
      engine: engineWith(items),
      highlight: { messageId: 'm-gone', nonce: 1 },
      highlightReady: false,
      onHighlightDone,
    });
    const { m } = laneMetrics(container, { top: 0, height: 1200, client: 500 });
    // Still restoring: keep waiting.
    expect(onHighlightDone).not.toHaveBeenCalled();
    rerender(
      <TooltipProvider>
        <Transcript engine={engineWith(items)} highlight={{ messageId: 'm-gone', nonce: 1 }} highlightReady onHighlightDone={onHighlightDone} />
      </TooltipProvider>,
    );
    expect(onHighlightDone).toHaveBeenCalledTimes(1);
    expect(m.top).toBe(700);
    expect(document.querySelector('[data-highlighted="true"]')).toBeNull();
  });

  it('highlights a requested message for 2 s, then reports it done', () => {
    vi.useFakeTimers();
    const onHighlightDone = vi.fn();
    const answer = assistantItem({ restored: true, messageId: 'm-target' });
    renderTranscript({
      engine: engineWith([userItem('q'), answer]),
      highlight: { messageId: 'm-target', nonce: 1 },
      onHighlightDone,
    });
    expect(document.querySelector('[data-highlighted="true"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(HIGHLIGHT_MS);
    });
    expect(document.querySelector('[data-highlighted="true"]')).toBeNull();
    expect(onHighlightDone).toHaveBeenCalledTimes(1);
  });
});

function AnnouncerHarness({ engine }: { engine: Pick<ChatEngine, 'items' | 'running'> }) {
  useTurnAnnouncer(engine, 10);
  return null;
}

describe('useTurnAnnouncer', () => {
  it('announces Working, throttled progress and Answer ready through the shell region', () => {
    vi.useFakeTimers();
    const user = userItem('q');
    const running = runningItem({
      steps: [{ index: 1, ordinal: 1, kind: 'tool', tool: 'search_logs', label: 'Searched logs', params: {}, group: null, status: 'ok', result: null, startedAt: 0 }],
    });
    const region = () => document.body.textContent ?? '';
    const { rerender } = render(
      <AnnouncerProvider>
        <AnnouncerHarness engine={{ items: [user, running], running }} />
      </AnnouncerProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(region()).toContain('Working');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(region()).toContain('Searched logs, 1 of up to 10 lookups');
    const done = { ...running, status: 'done' as const, live: null, response: assistantItem().response };
    rerender(
      <AnnouncerProvider>
        <AnnouncerHarness engine={{ items: [user, done], running: null }} />
      </AnnouncerProvider>,
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(region()).toContain('Answer ready');
  });
});
