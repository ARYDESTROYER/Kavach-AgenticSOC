/**
 * Transcript — `role="log"` without `aria-live`, exchanges in order, the empty and
 * replace slots, scroll anchoring on send (user turn at the lane top with a 48 px peek),
 * Jump to latest when the reader is away from the bottom, the requested-message
 * highlight for 2 s, content-visibility on older exchanges, and the turn announcer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { AnnouncerProvider } from '@/soc/components/announcer';
import { TooltipProvider } from '@/ui/tooltip';
import type { ChatEngine, ChatTranscriptItem } from '../../useChatEngine';
import { ANCHOR_PEEK_PX, HIGHLIGHT_MS, Transcript, groupExchanges, type TranscriptProps } from '../Transcript';
import { useTurnAnnouncer } from '../useTurnAnnouncer';
import { assistantItem, runningItem, stubEngine, userItem } from './fixtures';

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
  // jsdom has no Element.scrollTo; drop the spy one test installs.
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

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

  it('is a log without a live region and renders the user content, never the raw prompt', () => {
    renderTranscript({
      engine: engineWith([userItem('Show failed logins', { prompt: 'Show failed​ logins' }), assistantItem()]),
    });
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log).not.toHaveAttribute('aria-live');
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
