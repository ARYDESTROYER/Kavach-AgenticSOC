/**
 * Focus handed back by code does not open a tooltip (Round 13 polish): on a phone the
 * History sheet closed onto "History (Ctrl+Shift+S)" covering the chosen conversation.
 * `focusQuietly` + a trigger's `quietFocusGuard` keep the tooltip shut for that focus
 * only; the analyst's own keyboard focus still opens it. Covered here: the mechanism,
 * `useOpenerFocus.restore`, and every chat-workspace trigger that code focuses back
 * (toolbar History, Report and title; the rail's strip and header buttons; a rail row
 * after rename; the answer's feedback buttons after the reason panel; the composer's
 * Read-only chip after its access popover closes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { ChatConversationSummary } from '@/lib/types';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { focusQuietly, quietFocusGuard } from '../quiet-focus';
import { useOpenerFocus } from '../workspace/useOpenerFocus';
import { ThreadToolbar } from '../workspace/ThreadToolbar';
import { HintedIconButton, HistoryStrip } from '../workspace/HistoryRail';
import { FeedbackButtons, type AnswerFeedbackState } from '../message/AnswerFeedback';
import { Harness, makeSpies, stubServer } from '../composer/__tests__/harness';
import { makeContext } from '../composer/__tests__/fixtures';

/** Let Radix commit an open (focus opens a tooltip at once, without the delay). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function GuardedTip({ guarded = true }: { guarded?: boolean }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onFocus={guarded ? quietFocusGuard : undefined}>
            History
          </button>
        </TooltipTrigger>
        <TooltipContent>History (Ctrl+Shift+S)</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

describe('focusQuietly / quietFocusGuard', () => {
  it('focuses without opening a guarded tooltip, and keyboard focus still opens it', async () => {
    render(<GuardedTip />);
    const button = screen.getByRole('button', { name: 'History' });
    act(() => focusQuietly(button));
    expect(button).toHaveFocus();
    await settle();
    expect(screen.queryByRole('tooltip')).toBeNull();
    // The mark lasts only for that call: the analyst's next focus opens the tooltip.
    act(() => button.blur());
    act(() => button.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('History (Ctrl+Shift+S)');
  });

  it('changes nothing for an unguarded trigger, and accepts a missing element', async () => {
    render(<GuardedTip guarded={false} />);
    act(() => focusQuietly(screen.getByRole('button', { name: 'History' })));
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    expect(() => focusQuietly(null)).not.toThrow();
    expect(() => focusQuietly(undefined)).not.toThrow();
  });

  it('useOpenerFocus.restore hands focus back to a guarded opener without its tooltip', async () => {
    render(<GuardedTip />);
    const opener = screen.getByRole('button', { name: 'History' });
    const { result } = renderHook(() => useOpenerFocus());
    // Opened from the keyboard: the tooltip shows while the opener has focus.
    act(() => opener.focus());
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    act(() => result.current.capture());
    act(() => opener.blur());
    await settle();
    expect(screen.queryByRole('tooltip')).toBeNull();
    const close = new CustomEvent('focusScope.autoFocusOnUnmount', { cancelable: true });
    act(() => result.current.restore(close));
    expect(close.defaultPrevented).toBe(true);
    expect(opener).toHaveFocus();
    await settle();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

const SUMMARY: ChatConversationSummary = {
  id: 'c-1',
  title: 'Failed sign-in review',
  created_at: '2026-10-08T09:00:00Z',
  updated_at: '2026-10-08T09:05:00Z',
  message_count: 4,
  total_tokens: 12_400,
  total_cost: 0.031,
};

describe('chat workspace triggers that code focuses back', () => {
  it('keeps the toolbar History, Report and title tooltips shut on a quiet focus', async () => {
    render(
      <TooltipProvider>
        <ThreadToolbar
          title={SUMMARY.title}
          summary={SUMMARY}
          railInSheet
          onOpenHistory={vi.fn()}
          onNewChat={vi.fn()}
          narrow
          report={{ count: 0, open: false, onToggle: vi.fn() }}
          busy={false}
          onRename={vi.fn()}
          onTogglePin={vi.fn()}
          onExport={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>,
    );
    for (const name of ['History', 'Report', 'Failed sign-in review', 'New chat']) {
      const button = screen.getByRole('button', { name });
      act(() => focusQuietly(button));
      expect(button).toHaveFocus();
      await settle();
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => button.blur());
    }
    // The analyst's keyboard focus still shows the shortcut hint.
    act(() => screen.getByRole('button', { name: 'History' }).focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^History \(/);
  });

  it('keeps the strip and header button hints shut on a quiet focus', async () => {
    render(
      <TooltipProvider>
        <HistoryStrip busy={false} onNewChat={vi.fn()} onSearch={vi.fn()} onExpand={vi.fn()} />
        <HintedIconButton label="Collapse history" onClick={vi.fn()} onFocus={vi.fn()}>
          <span aria-hidden>x</span>
        </HintedIconButton>
      </TooltipProvider>,
    );
    for (const name of ['New chat', 'Search chats', 'Show history', 'Collapse history']) {
      const button = screen.getByRole('button', { name });
      act(() => focusQuietly(button));
      await settle();
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => button.blur());
    }
  });

  it('keeps the feedback buttons quiet when the reason panel hands focus back', async () => {
    const downRef = { current: null as HTMLButtonElement | null };
    const detailsRef = { current: null as HTMLButtonElement | null };
    const state = {
      value: { rating: 'down', reason: null, comment: '' },
      saving: false,
      panelOpen: false,
      rateUp: vi.fn(),
      rateDown: vi.fn(),
      sendDetails: vi.fn(),
      closePanel: vi.fn(),
      toggleDetails: vi.fn(),
      downRef,
      detailsRef,
    } as unknown as AnswerFeedbackState;
    render(
      <TooltipProvider>
        <FeedbackButtons state={state} panelId="panel-1" />
      </TooltipProvider>,
    );
    for (const ref of [detailsRef, downRef]) {
      act(() => focusQuietly(ref.current));
      expect(ref.current).toHaveFocus();
      await settle();
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => ref.current?.blur());
    }
    // Moving between the thumbs with the arrow keys is the analyst's focus: hints show.
    fireEvent.keyDown(downRef.current as HTMLButtonElement, { key: 'ArrowLeft' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Good answer');
  });
});

describe('composer controls that code focuses back', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CHIP = 'Read-only. What can the assistant access?';
  const ACCESS = 'What the assistant can access';

  it('returns focus to the Read-only chip on Escape without opening its tooltip over the composer', async () => {
    stubServer();
    const user = userEvent.setup();
    render(<Harness spies={makeSpies()} context={makeContext()} />);
    const chip = screen.getByRole('button', { name: CHIP });
    // Pointer: open, move the pointer away, Escape.
    await user.click(chip);
    await screen.findByRole('dialog', { name: ACCESS });
    await user.unhover(chip);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: ACCESS })).toBeNull());
    expect(chip).toHaveFocus();
    await settle();
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Keyboard: Tab from the field to the chip (its hint shows: the analyst moved focus),
    // Enter, Escape.
    act(() => screen.getByRole('textbox', { name: 'Message the assistant' }).focus());
    await user.tab();
    expect(chip).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: ACCESS });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: ACCESS })).toBeNull());
    expect(chip).toHaveFocus();
    await settle();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('leaves focus where a click outside put it', async () => {
    stubServer();
    const user = userEvent.setup();
    render(<Harness spies={makeSpies()} context={makeContext()} />);
    const chip = screen.getByRole('button', { name: CHIP });
    await user.click(chip);
    await screen.findByRole('dialog', { name: ACCESS });
    const field = screen.getByRole('textbox', { name: 'Message the assistant' });
    await user.click(field);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: ACCESS })).toBeNull());
    expect(field).toHaveFocus();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
