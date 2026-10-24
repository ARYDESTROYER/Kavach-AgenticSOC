/**
 * The "Hidden for a day" toast's place with sonner itself mounted (SPEC-chat §3.9):
 * the console's top-centre toaster, the toast moved under the thread toolbar and
 * centred over the conversation lane by its own inline style, so neither it nor its
 * hover gap covers the console header (search, notifications, navigation) or the
 * toolbar. The other start-screen behaviour is in StartScreen.test.tsx, which mocks
 * `toast`; this file keeps sonner real so the style is proven to reach the toast.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';

import { Toaster } from '@/ui/sonner';
import { TooltipProvider } from '@/ui/tooltip';
import { makeContext } from '../../composer/__tests__/fixtures';
import { clearGreetingNameCache } from '../greeting';
import { HIDDEN_FOR_A_DAY, StartScreen } from '../StartScreen';
import { clearChatStartersCache, type ChatStartersController } from '../useChatStarters';
import { json, makeInfo, stubStarterFetch } from './fixtures';

const LANE = { x: 504, y: 100, width: 936, height: 700 };

beforeEach(() => {
  clearChatStartersCache();
  clearGreetingNameCache();
  // jsdom has no layout: a 1440 px console whose lane starts under the toolbar (y 100),
  // right of the navigation and the history rail.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'chat-start') return DOMRect.fromRect({ width: 1200, height: 300 });
    if (this.dataset.chatScrollLane) return DOMRect.fromRect(LANE);
    return DOMRect.fromRect();
  });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
  stubStarterFetch(() => json(makeInfo()));
});

afterEach(() => {
  act(() => toast.dismiss());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function controller(): ChatStartersController {
  return { info: makeInfo(), loading: false, error: null, retry: vi.fn(), setHeld: vi.fn() };
}

describe('StartScreen hide toast place (sonner mounted)', () => {
  it('opens in the top-centre toaster, under the thread toolbar and centred over the lane', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <div data-chat-scroll-lane="true">
          <StartScreen context={makeContext()} starters={controller()} onActivate={vi.fn()} />
        </div>
        <Toaster theme="light" />
      </TooltipProvider>,
    );
    const first = within(screen.getByRole('list', { name: 'Suggested questions' }))
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('data-starter'))[0];
    act(() => first.focus());
    await user.keyboard('{Delete}');

    const item = (await screen.findByText(HIDDEN_FOR_A_DAY)).closest<HTMLElement>('[data-sonner-toast]');
    expect(item).not.toBeNull();
    expect(item).toHaveAttribute('data-y-position', 'top');
    expect(item).toHaveAttribute('data-x-position', 'center');
    expect(item!.closest('[data-sonner-toaster]')).toHaveAttribute('data-y-position', 'top');
    // 20 px under the lane's top edge (y 120 on screen, less the toaster's own offset)...
    expect(item!.style.top).toBe('calc(120px - var(--offset-top))');
    // ...and centred over the lane: its centre (972) is 252 px right of the viewport's (720).
    expect(item!.style.left).toBe('252px');
  });
});
