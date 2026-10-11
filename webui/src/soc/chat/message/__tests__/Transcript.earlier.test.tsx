/**
 * Transcript — "Show earlier messages" (Round 12: a long conversation opens on its
 * newest messages and pages the older ones in; nothing is removed).
 *
 *  - the quiet control above the first turn with how many are left, its loading state
 *    (the same button, never disabled, so focus stays), an error with Retry, and the
 *    "Start of the conversation" marker once everything is shown (focus moves there
 *    when the control it was on goes away);
 *  - a page loaded above keeps the reader's place: the first message in view is
 *    measured before the load (again after a scroll while it loads) and the lane is
 *    scrolled by exactly how far it moved; a prepend is never treated as another thread
 *    (which would jump to the latest turn), while a real thread change still does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { ChatTranscriptItem } from '../../useChatEngine';
import { Transcript, earlierCountLabel, type TranscriptEarlier } from '../Transcript';
import { assistantItem, stubEngine, userItem } from './fixtures';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Exchanges `from`..`to` (exclusive), with stable keys and message ids like a restored thread. */
function exchanges(from: number, to: number): ChatTranscriptItem[] {
  const out: ChatTranscriptItem[] = [];
  for (let i = from; i < to; i += 1) {
    out.push(userItem(`question ${i}`, { key: `mu-${i}`, messageId: `mu-${i}` }));
    out.push(assistantItem({ key: `ma-${i}`, messageId: `ma-${i}`, restored: true }));
  }
  return out;
}

function earlier(over: Partial<TranscriptEarlier> = {}): TranscriptEarlier {
  return { remaining: 150, loading: false, error: null, loadedAny: false, onLoad: vi.fn(), ...over };
}

function view(items: ChatTranscriptItem[], more: TranscriptEarlier | null) {
  return (
    <TooltipProvider>
      <Transcript engine={{ ...stubEngine(), items }} earlier={more} />
    </TooltipProvider>
  );
}

/**
 * jsdom has no layout: a lane whose scrollTop clamps like a browser's, and message boxes
 * placed at a content offset each (moved by the lane's scrollTop).
 */
function layout(container: HTMLElement) {
  const lane = container.querySelector('[data-chat-scroll-lane]') as HTMLElement;
  const m = { top: 0, height: 4000, client: 600 };
  Object.defineProperty(lane, 'scrollTop', {
    configurable: true,
    get: () => m.top,
    set: (value: number) => {
      m.top = Math.max(0, Math.min(value, m.height - m.client));
    },
  });
  Object.defineProperty(lane, 'scrollHeight', { configurable: true, get: () => m.height });
  Object.defineProperty(lane, 'clientHeight', { configurable: true, get: () => m.client });
  const LANE_TOP = 100;
  const offsets = new Map<string, number>();
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === lane) return DOMRect.fromRect({ x: 0, y: LANE_TOP, width: 800, height: m.client });
    // A message box, or an exchange (keyed by its question's id in these fixtures).
    const id = this.dataset.messageId ?? this.dataset.exchange;
    if (id && offsets.has(id)) {
      return DOMRect.fromRect({ x: 0, y: LANE_TOP + (offsets.get(id) as number) - m.top, width: 600, height: 80 });
    }
    return original.call(this);
  });
  /** Lay the messages out 100 px apart from `start` px into the content. */
  const place = (ids: string[], start: number) => ids.forEach((id, i) => offsets.set(id, start + i * 100));
  return { lane, m, place };
}

const idsOf = (items: ChatTranscriptItem[]) =>
  items.map((item) => (item.kind === 'user' ? item.messageId : item.messageId) as string);

describe('Transcript — earlier messages', () => {
  it('offers a quiet "Show earlier messages" above the first turn, with how many are left', () => {
    const more = earlier({ remaining: 1234 });
    render(view(exchanges(10, 12), more));
    const button = screen.getByRole('button', { name: 'Show earlier messages · 1,234 more' });
    const log = screen.getByRole('log');
    // Above the turns, outside the log.
    expect(button.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(log).not.toContainElement(button);
    fireEvent.click(button);
    expect(more.onLoad).toHaveBeenCalledTimes(1);
    expect(earlierCountLabel(1)).toBe('1 more');
  });

  it('shows nothing for a conversation shown from its start, and no control without turns or while restoring', () => {
    const { rerender } = render(view(exchanges(0, 2), earlier({ remaining: 0 })));
    expect(screen.queryByRole('button', { name: /Show earlier messages/ })).toBeNull();
    expect(screen.queryByText('Start of the conversation')).toBeNull();
    rerender(view([], earlier()));
    expect(screen.queryByRole('button', { name: /Show earlier messages/ })).toBeNull();
    rerender(
      <TooltipProvider>
        <Transcript engine={{ ...stubEngine(), items: exchanges(0, 2) }} earlier={earlier()} replace={<p>Restoring</p>} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('button', { name: /Show earlier messages/ })).toBeNull();
  });

  it('keeps one focused button through loading, says it is loading, and ignores a second click', () => {
    const more = earlier();
    const { rerender } = render(view(exchanges(10, 12), more));
    const button = screen.getByRole('button', { name: /Show earlier messages/ });
    button.focus();
    rerender(view(exchanges(10, 12), { ...more, loading: true }));
    const loading = screen.getByRole('button', { name: 'Loading earlier messages…' });
    expect(loading).toBe(button);
    expect(loading).toHaveFocus();
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading).toHaveAttribute('aria-disabled', 'true');
    expect(loading).not.toBeDisabled();
    fireEvent.click(loading);
    expect(more.onLoad).not.toHaveBeenCalled();
  });

  it('says when a page could not be loaded and retries with the same control', () => {
    const more = earlier({ error: 'Earlier messages could not be loaded.' });
    render(view(exchanges(10, 12), more));
    expect(screen.getByRole('alert')).toHaveTextContent('Earlier messages could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading earlier messages' }));
    expect(more.onLoad).toHaveBeenCalledTimes(1);
  });

  it('shows the count at the full muted foreground (AA for 12 px text), never dimmed further', () => {
    render(view(exchanges(10, 12), earlier({ remaining: 82 })));
    const count = screen.getByText('· 82 more');
    expect(count).toHaveClass('text-muted-foreground');
    expect(count.className).not.toMatch(/text-muted-foreground\/\d+/);
  });

  it('offers to reopen the conversation when the messages are gone (404), never a Retry that repeats the read', () => {
    const onReopen = vi.fn();
    const more = earlier({ error: 'Earlier messages could not be found.', errorKind: 'missing', onReopen });
    const { rerender } = render(view(exchanges(10, 12), more));
    expect(screen.getByRole('alert')).toHaveTextContent('Earlier messages could not be found.');
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    const reopen = screen.getByRole('button', { name: 'Reopen conversation' });
    fireEvent.click(reopen);
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(more.onLoad).not.toHaveBeenCalled();
    // A host without a reopen path shows the reason only (no dead-end button).
    rerender(view(exchanges(10, 12), earlier({ error: 'Earlier messages could not be found.', errorKind: 'missing' })));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry|Reopen|Show earlier/ })).toBeNull();
    // A read that may work again keeps Retry.
    rerender(view(exchanges(10, 12), earlier({ error: 'Earlier messages could not be loaded.', errorKind: 'failed', onReopen })));
    expect(screen.getByRole('button', { name: 'Retry loading earlier messages' })).toBeInTheDocument();
  });

  it('shows the error and Retry at the top, never the latest turn, when the read-back to a requested message failed', () => {
    const items = exchanges(10, 15);
    const onHighlightDone = vi.fn();
    const at = (more: TranscriptEarlier, ready: boolean) => (
      <TooltipProvider>
        <Transcript
          engine={{ ...stubEngine(), items }}
          earlier={more}
          highlight={{ messageId: 'mu-2', nonce: 7 }}
          highlightReady={ready}
          onHighlightDone={onHighlightDone}
        />
      </TooltipProvider>
    );
    const { container, rerender } = render(at(earlier({ loading: true }), false));
    const { lane, m } = layout(container);
    // The reader was further down the conversation when the hit was opened.
    m.top = 2000;
    fireEvent.scroll(lane);
    // The read-back failed: the host holds the request back (not ready).
    rerender(at(earlier({ error: 'Earlier messages could not be loaded.', errorKind: 'failed' }), false));
    expect(m.top).toBe(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Earlier messages could not be loaded.');
    expect(screen.getByRole('button', { name: 'Retry loading earlier messages' })).toBeInTheDocument();
    // Never reported done (which would open the latest turn as if it were the answer).
    expect(onHighlightDone).not.toHaveBeenCalled();
  });

  it('marks the start of the conversation once everything is shown, and moves focus there', () => {
    const more = earlier({ remaining: 2 });
    const { rerender } = render(view(exchanges(1, 3), more));
    screen.getByRole('button', { name: /Show earlier messages/ }).focus();
    rerender(view(exchanges(0, 3), { ...more, remaining: 0, loadedAny: true }));
    expect(screen.queryByRole('button', { name: /Show earlier messages/ })).toBeNull();
    const start = screen.getByText('Start of the conversation');
    expect(start).toHaveFocus();
    expect(start).toHaveAttribute('tabindex', '-1');
  });

  it('keeps the reader in place when a page goes in above, instead of jumping to the latest turn', () => {
    const newest = exchanges(10, 15);
    const more = earlier();
    const { container, rerender } = render(view(newest, more));
    const { m, place } = layout(container);
    place(idsOf(newest), 40);
    // The reader is at the top, the first question 40 px below the lane's top edge.
    m.top = 0;
    fireEvent.scroll(container.querySelector('[data-chat-scroll-lane]') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /Show earlier messages/ }));
    rerender(view(newest, { ...more, loading: true }));

    // Ten older messages (1,000 px) go in above.
    const older = exchanges(5, 10);
    m.height = 5000;
    place(idsOf([...older, ...newest]), 40);
    rerender(view([...older, ...newest], { ...more, loading: true, remaining: 140, loadedAny: true }));
    // The question that was 40 px below the top is still there: scrolled by exactly 1,000 px.
    expect(m.top).toBe(1000);
    expect(screen.getByText('question 10')).toBeInTheDocument();
    rerender(view([...older, ...newest], { ...more, remaining: 140, loadedAny: true }));
    expect(m.top).toBe(1000);
  });

  it('measures again when the reader scrolls while the page loads', () => {
    const newest = exchanges(10, 15);
    const more = earlier();
    const { container, rerender } = render(view(newest, more));
    const { lane, m, place } = layout(container);
    place(idsOf(newest), 40);
    fireEvent.click(screen.getByRole('button', { name: /Show earlier messages/ }));
    rerender(view(newest, { ...more, loading: true }));
    // The reader scrolls 250 px down while it loads: the third message is now first in view.
    m.top = 250;
    fireEvent.scroll(lane);
    const older = exchanges(9, 10);
    place(idsOf([...older, ...newest]), 40);
    m.height = 4200;
    rerender(view([...older, ...newest], { ...more, loading: true, remaining: 148, loadedAny: true }));
    // Two messages (200 px) went in above: the reader's view moves with them.
    expect(m.top).toBe(450);
  });

  it('jumps to a requested message far away and re-aligns while the turns above it render', () => {
    vi.useFakeTimers();
    try {
      const items = exchanges(0, 30);
      const plain = (highlight: { messageId: string; nonce: number } | null) => (
        <TooltipProvider>
          <Transcript engine={{ ...stubEngine(), items }} highlight={highlight} highlightReady />
        </TooltipProvider>
      );
      const { container, rerender } = render(plain(null));
      const { lane, m, place } = layout(container);
      m.height = 7000;
      place(idsOf(items), 40);
      m.top = 0;
      // mu-25 sits 5,040 px into the content: far more than two screens away.
      rerender(plain({ messageId: 'mu-25', nonce: 1 }));
      // A jump, not a smooth scroll over turns that have not rendered yet.
      expect(m.top).toBe(5040 - 48);
      // The turns above it render taller than their placeholders: it moved 100 px down.
      place(idsOf(items), 140);
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(m.top).toBe(5140 - 48);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(m.top).toBe(5140 - 48);

      // The reader taking over cancels any re-alignment still pending.
      rerender(plain({ messageId: 'mu-5', nonce: 2 }));
      expect(m.top).toBe(1140 - 48);
      fireEvent.wheel(lane);
      place(idsOf(items), 400);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(m.top).toBe(1140 - 48);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still opens another thread at its latest turn', () => {
    const { container, rerender } = render(view(exchanges(10, 15), earlier()));
    const { m } = layout(container);
    m.top = 0;
    rerender(view(exchanges(50, 55), earlier({ remaining: 3 })));
    // A thread change scrolls to the bottom (clamped like a browser).
    expect(m.top).toBe(m.height - m.client);
  });
});
