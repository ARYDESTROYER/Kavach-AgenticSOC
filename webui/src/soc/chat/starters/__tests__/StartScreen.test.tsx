/**
 * The new-chat start stack (SPEC-chat §3.9, §3.11, §5.2, §5.6): greeting, catch-up or
 * capability line, the card count for the MEASURED lane width, questions never truncated,
 * Hide with an Undo toast, one tab stop with arrows/Home/End/Delete, held refreshes,
 * skeletons equal to the visible count, Retry, the viewer switch, pills, text-only
 * rendering of server strings (#9), and axe.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

const { toastMock } = vi.hoisted(() => ({ toastMock: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));
vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: toastMock }));

import type { ChatStarter, ChatStartersInfo } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { makeContext } from '../../composer/__tests__/fixtures';
import { OPEN_PROMPT_LIBRARY_EVENT } from '../../composer/library-events';
import { PROMPTBOOK_RUNNING_REASON } from '../../composer/PromptRunner';
import { beginPromptbook, resetPromptbookForTests } from '../../composer/promptbook-store';
import { clearChatActivity } from '../../../chat-activity/activity';
import { CATEGORY_PILLS, visiblePills } from '../CategoryPills';
import { GREETING_NAME_TTL_MS, clearGreetingNameCache, greetingFor, greetingLine, profileDisplayName } from '../greeting';
import { STARTER_ICONS, starterIcon } from '../starter-icons';
import {
  CAPABILITY_LINE,
  HIDDEN_FOR_A_DAY,
  HIDE_TOAST_CLEARANCE_PX,
  HIDE_TOAST_MS,
  HIDE_TOAST_POSITION,
  STARTERS_LOAD_ERROR,
  StartScreen,
  hideToastStyle,
  isUndoHideKey,
  startGrid,
  startGridClass,
  starterHideKey,
  starterSlots,
  visibleCatchUp,
  type StartScreenProps,
} from '../StartScreen';
import { STARTER_CARD_KEYSHORTCUTS } from '../StarterCard';
import {
  STARTERS_REFRESH_MS,
  clearChatStartersCache,
  flushStarterDismissals,
  pendingStarterDismissal,
  useChatStarters,
  type ChatStartersController,
} from '../useChatStarters';
import {
  CATCH_UP,
  CONTINUE,
  HOME_STARTERS,
  NEEDS_HUMAN,
  NEW_CASES,
  POSTURE,
  SILENT_SOURCE,
  TRIAGE,
  json,
  makeInfo,
  stubStarterFetch,
} from './fixtures';

expect.extend(toHaveNoViolations);

let stackWidth = 1200;
let laneHeight = 0;

beforeEach(() => {
  clearChatStartersCache();
  clearGreetingNameCache();
  toastMock.mockReset();
  toastMock.dismiss.mockReset();
  stackWidth = 1200;
  laneHeight = 0;
  // jsdom has no layout: the stack's measured width and the lane's height are scripted.
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'chat-start') return DOMRect.fromRect({ width: stackWidth, height: 300 });
    return original.call(this);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.chatScrollLane ? laneHeight : 0;
  });
  // A stub server for the greeting's profile read and the events the stack posts.
  stubStarterFetch(() => json(makeInfo()));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPromptbookForTests();
});

type Box = { x: number; y: number; width: number; height: number };

/**
 * Script the console's layout for the hide toast's place: the scroll lane's and the
 * main region's boxes, the viewport width and whether sonner's phone layout applies.
 */
function scriptLayout({ lane, main, viewportWidth, phone = false }: { lane?: Box; main?: Box; viewportWidth: number; phone?: boolean }) {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'chat-start') return DOMRect.fromRect({ width: stackWidth, height: 300 });
    if (lane && this.dataset.chatScrollLane) return DOMRect.fromRect(lane);
    if (main && this.id === 'socMain') return DOMRect.fromRect(main);
    return DOMRect.fromRect();
  });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(viewportWidth);
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: phone && query === '(max-width: 600px)',
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

function controller(info: ChatStartersInfo | null, overrides: Partial<ChatStartersController> = {}): ChatStartersController {
  return { info, loading: false, error: null, retry: vi.fn(), setHeld: vi.fn(), ...overrides };
}

function renderStart(props: Partial<StartScreenProps> = {}) {
  const onActivate = vi.fn();
  const view = render(
    <TooltipProvider>
      <div data-chat-scroll-lane="true">
        <StartScreen context={makeContext()} starters={controller(makeInfo())} onActivate={onActivate} {...props} />
      </div>
    </TooltipProvider>,
  );
  return { onActivate, ...view };
}

const cards = () => within(screen.getByRole('list', { name: 'Suggested questions' })).getAllByRole('button', { name: /\?|\./ });
const mainCards = () =>
  within(screen.getByRole('list', { name: 'Suggested questions' }))
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('data-starter'));

describe('StartScreen', () => {
  it('greets, shows the capability line, four cards in four columns and the pills', async () => {
    const { container } = renderStart();
    const section = screen.getByRole('region', { name: greetingLine(null) });
    expect(within(section).getByRole('heading', { level: 3 })).toHaveTextContent(/^Good (morning|afternoon|evening)$/);
    expect(screen.getByText(CAPABILITY_LINE)).toBeInTheDocument();
    expect(section).toHaveAttribute('data-columns', '4');
    expect(mainCards()).toHaveLength(4);
    // The question is the card's name; the reason line is its description.
    expect(mainCards()[0]).toHaveAccessibleName(NEEDS_HUMAN.prompt);
    expect(mainCards()[0]).toHaveAccessibleDescription(NEEDS_HUMAN.reason as string);
    expect(screen.getByRole('group', { name: 'Prompt library categories' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('follows the measured lane width: 3 cards in one column below 560 px, 4 in two columns to 1,039 px', () => {
    expect(startGrid(0)).toEqual({ columns: 1, count: 3 });
    expect(startGrid(559)).toEqual({ columns: 1, count: 3 });
    expect(startGrid(560)).toEqual({ columns: 2, count: 4 });
    expect(startGrid(1039)).toEqual({ columns: 2, count: 4 });
    expect(startGrid(1040)).toEqual({ columns: 4, count: 4 });

    stackWidth = 358;
    const narrow = renderStart();
    expect(screen.getByTestId('chat-start')).toHaveAttribute('data-columns', '1');
    expect(mainCards()).toHaveLength(3);
    expect(screen.getByRole('list', { name: 'Suggested questions' }).className).toContain('grid-cols-1');
    // Below 560 px the pill row scrolls sideways instead of wrapping.
    expect(screen.getByTestId('category-pills').className).toMatch(/flex-nowrap.*overflow-x-auto/);
    narrow.unmount();

    stackWidth = 800;
    renderStart();
    expect(screen.getByTestId('chat-start')).toHaveAttribute('data-columns', '2');
    expect(mainCards()).toHaveLength(4);
    expect(screen.getByTestId('category-pills').className).toContain('flex-wrap');
  });

  it('scrolls a focused pill clear of the narrow row\'s right-edge fade, focus ring included', () => {
    stackWidth = 358;
    const scrolled: Array<{ el: Element; options: unknown }> = [];
    const original = (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    (Element.prototype as unknown as { scrollIntoView: (o?: unknown) => void }).scrollIntoView = function (this: Element, options?: unknown) {
      scrolled.push({ el: this, options });
    };
    try {
      renderStart();
      const report = screen.getByRole('button', { name: 'Report' });
      // 4 px for the ring on the left; the 24 px fade plus the ring on the right.
      expect(report.className).toContain('scroll-ml-1');
      expect(report.className).toContain('scroll-mr-7');
      act(() => report.focus());
      expect(scrolled).toEqual([{ el: report, options: { block: 'nearest', inline: 'nearest' } }]);
    } finally {
      (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = original;
    }
  });

  it('never truncates or clamps a question, a reason or a pill', () => {
    const long: ChatStarter = {
      ...NEEDS_HUMAN,
      prompt: 'Why did detection rule web-sqli-uri-generic-2024 create 1,284 of the 2,019 cases in the last 24 hours?',
    };
    renderStart({ starters: controller(makeInfo({ starters: [long, ...HOME_STARTERS.slice(1)] })) });
    const section = screen.getByTestId('chat-start');
    for (const el of Array.from(section.querySelectorAll('*'))) {
      expect(el.getAttribute('class') ?? '', el.outerHTML.slice(0, 80)).not.toMatch(/\btruncate\b|line-clamp|text-ellipsis|text-clip/);
    }
    expect(screen.getByText(long.prompt)).toBeInTheDocument();
  });

  it('hands a chosen card to the host exactly as served', async () => {
    const user = userEvent.setup();
    const { onActivate } = renderStart();
    await user.click(mainCards()[1]);
    expect(onActivate).toHaveBeenCalledWith(HOME_STARTERS[1]);
  });

  it('shows the catch-up line with clause links that send their question', async () => {
    const user = userEvent.setup();
    const { onActivate } = renderStart({ starters: controller(makeInfo({ catch_up: CATCH_UP })) });
    const line = screen.getByTestId('catch-up-line');
    expect(line).toHaveTextContent('Since 09:12: 5 new cases (2 critical) and Wazuh quiet for 3 hours.');
    expect(screen.queryByText(CAPABILITY_LINE)).toBeNull();
    const clause = within(line).getByRole('button', { name: '5 new cases (2 critical)' });
    expect(clause).toHaveAccessibleDescription(CATCH_UP.clauses[0].starter.prompt);
    await user.click(clause);
    expect(onActivate).toHaveBeenCalledWith(CATCH_UP.clauses[0].starter);
  });

  it('hides a card for a day with Delete: the next ranked card takes its slot, focus follows, the others stay', async () => {
    const user = userEvent.setup();
    const server = stubStarterFetch(() => json(makeInfo()));
    renderStart();
    const before = mainCards();
    act(() => before[0].focus());
    await user.keyboard('{Delete}');
    // TRIAGE (the 5th card) takes slot 0; slots 1 to 3 keep their cards and DOM nodes.
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['triage', 'new_cases', 'silent_source', 'continue']);
    expect(mainCards().slice(1)).toEqual(before.slice(1));
    expect(mainCards()[0]).toHaveFocus();
    expect(mainCards().filter((b) => b.tabIndex === 0)).toEqual([mainCards()[0]]);
    expect(toastMock).toHaveBeenCalledWith(HIDDEN_FOR_A_DAY, expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }));
    // Nothing is posted while the toast can still be undone.
    await act(async () => {});
    expect(server.events()).toEqual([]);
    // The toast closes by itself: now the family is hidden on the server.
    const options = toastMock.mock.calls[0][1] as { onAutoClose: () => void };
    act(() => options.onAutoClose());
    await act(async () => {});
    expect(server.events()).toEqual([{ type: 'dismissed', surface: 'home', keys: [NEEDS_HUMAN.key] }]);
  });

  it('keeps every other slot when a middle card is hidden, and Undo puts it back in its slot with focus', async () => {
    const user = userEvent.setup();
    const server = stubStarterFetch(() => json(makeInfo()));
    renderStart();
    act(() => mainCards()[1].focus());
    await user.keyboard('{Backspace}');
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'triage', 'silent_source', 'continue']);
    expect(mainCards()[1]).toHaveFocus();
    const options = toastMock.mock.calls[0][1] as { action: { onClick: () => void }; onAutoClose: () => void; onDismiss: () => void };
    act(() => options.action.onClick());
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'new_cases', 'silent_source', 'continue']);
    expect(mainCards()[1]).toHaveFocus();
    expect(mainCards().filter((b) => b.tabIndex === 0)).toEqual([mainCards()[1]]);
    // Undo posts nothing, and a late close callback of that toast posts nothing either.
    act(() => options.onAutoClose());
    act(() => options.onDismiss());
    await act(async () => {});
    expect(server.events()).toEqual([]);
  });

  it('posts the dismissal when the toast is closed by hand', async () => {
    const user = userEvent.setup();
    const server = stubStarterFetch(() => json(makeInfo()));
    renderStart();
    act(() => mainCards()[2].focus());
    await user.keyboard('{Delete}');
    act(() => (toastMock.mock.calls[0][1] as { onDismiss: () => void }).onDismiss());
    await act(async () => {});
    expect(server.events()).toEqual([{ type: 'dismissed', surface: 'home', keys: [SILENT_SOURCE.key] }]);
  });

  it('hides one card per key press: a held Delete or Backspace does not walk through the grid', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    renderStart();
    act(() => mainCards()[0].focus());
    fireEvent.keyDown(document.activeElement as Element, { key: 'Delete' });
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(document.activeElement as Element, { key: 'Delete', repeat: true });
    fireEvent.keyDown(document.activeElement as Element, { key: 'Backspace', repeat: true });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['triage', 'new_cases', 'silent_source', 'continue']);
    act(() => (toastMock.mock.calls[0][1] as { onAutoClose: () => void }).onAutoClose());
    await act(async () => {});
    expect(server.events()).toHaveLength(1);
  });

  it('never hides a paused card: Delete does nothing and there is no Hide button', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    renderStart({ disabled: true });
    const first = mainCards()[0];
    expect(first).toHaveAttribute('aria-disabled', 'true');
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'Delete' });
    fireEvent.keyDown(first, { key: 'Backspace' });
    expect(toastMock).not.toHaveBeenCalled();
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'new_cases', 'silent_source', 'continue']);
    expect(screen.queryByRole('button', { name: /^Hide for a day/ })).toBeNull();
    await act(async () => {});
    expect(server.events()).toEqual([]);
  });

  it('opens the hide toast at the top centre for 10 seconds, away from the docked composer', async () => {
    const user = userEvent.setup();
    renderStart();
    act(() => mainCards()[0].focus());
    await user.keyboard('{Delete}');
    expect(HIDE_TOAST_MS).toBeGreaterThanOrEqual(10_000);
    expect(toastMock).toHaveBeenCalledWith(
      HIDDEN_FOR_A_DAY,
      expect.objectContaining({ position: 'top-center', duration: HIDE_TOAST_MS, id: expect.stringMatching(/^starter-hide-\d+$/) }),
    );
  });

  it('opens the hide toast under the thread toolbar, centred over the conversation lane, never over the header', async () => {
    const user = userEvent.setup();
    // A 1440 px console: the lane starts under the toolbar (y 100), right of the
    // navigation and the history rail (x 504), so its centre is 252 px right of the
    // viewport's, where sonner centres its top toaster.
    scriptLayout({ lane: { x: 504, y: 100, width: 936, height: 700 }, viewportWidth: 1440 });
    renderStart();
    act(() => mainCards()[0].focus());
    await user.keyboard('{Delete}');
    const options = toastMock.mock.calls[0][1] as { position: string; style: React.CSSProperties };
    expect(options.position).toBe(HIDE_TOAST_POSITION);
    expect(options.style).toEqual({ top: 'calc(120px - var(--offset-top))', left: '252px' });
    // Its hover gap (the 15 px strip above it that also takes clicks) stays below the toolbar.
    expect(HIDE_TOAST_CLEARANCE_PX).toBeGreaterThan(15);
  });

  it('opens the hide toast under the thread toolbar in the phone layout, across the lane', async () => {
    const user = userEvent.setup();
    stackWidth = 358;
    scriptLayout({ lane: { x: 0, y: 100, width: 390, height: 640 }, viewportWidth: 390, phone: true });
    renderStart();
    act(() => mainCards()[0].focus());
    await user.keyboard('{Delete}');
    const options = toastMock.mock.calls[0][1] as { style: React.CSSProperties };
    // sonner's phone toaster sits at --mobile-offset-top and spans the viewport: no sideways move.
    expect(options.style).toEqual({ top: 'calc(120px - var(--mobile-offset-top))' });
  });

  it('places the hide toast below the console main region outside a lane, and leaves it to sonner with neither', () => {
    scriptLayout({ main: { x: 240, y: 56, width: 1200, height: 844 }, viewportWidth: 1440 });
    const main = document.createElement('main');
    main.id = 'socMain';
    const inside = document.createElement('div');
    main.append(inside);
    document.body.append(main);
    try {
      expect(hideToastStyle(inside)).toEqual({ top: 'calc(76px - var(--offset-top))', left: '120px' });
      expect(hideToastStyle(null)).toEqual({ top: 'calc(76px - var(--offset-top))', left: '120px' });
    } finally {
      main.remove();
    }
    expect(hideToastStyle(document.createElement('div'))).toBeUndefined();
  });

  it('undoes the last hide with Ctrl+Z or Cmd+Z: the card comes back with focus, its toast closes and nothing is posted', async () => {
    const user = userEvent.setup();
    const server = stubStarterFetch(() => json(makeInfo()));
    renderStart();
    act(() => mainCards()[0].focus());
    await user.keyboard('{Delete}');
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['triage', 'new_cases', 'silent_source', 'continue']);
    const first = toastMock.mock.calls[0][1] as { id: string; onAutoClose: () => void; onDismiss: () => void };
    await user.keyboard('{Control>}z{/Control}');
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'new_cases', 'silent_source', 'continue']);
    expect(mainCards()[0]).toHaveFocus();
    expect(toastMock.dismiss).toHaveBeenCalledWith(first.id);
    // A late close callback of that toast posts nothing: Undo kept the card.
    act(() => first.onAutoClose());
    act(() => first.onDismiss());
    await act(async () => {});
    expect(server.events()).toEqual([]);
    // Two hides in a row: ⌘Z takes them back newest first, and each slot gets its card.
    act(() => mainCards()[1].focus());
    await user.keyboard('{Delete}');
    act(() => mainCards()[2].focus());
    await user.keyboard('{Backspace}');
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'triage', 'posture', 'continue']);
    await user.keyboard('{Meta>}z{/Meta}');
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'triage', 'silent_source', 'continue']);
    expect(mainCards()[2]).toHaveFocus();
    // From a pill too (anywhere in the start stack).
    act(() => (document.querySelector('[data-pill]') as HTMLElement).focus());
    await user.keyboard('{Control>}z{/Control}');
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'new_cases', 'silent_source', 'continue']);
    expect(mainCards()[1]).toHaveFocus();
    // Nothing left to undo: the key is left alone.
    expect(fireEvent.keyDown(mainCards()[1], { key: 'z', ctrlKey: true })).toBe(true);
    await act(async () => {});
    expect(server.events()).toEqual([]);
  });

  it('reads Ctrl+Z and Cmd+Z only, on any keyboard layout', () => {
    const k = (init: Partial<KeyboardEvent>) =>
      ({ key: 'z', code: 'KeyZ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false, ...init }) as KeyboardEvent;
    expect(isUndoHideKey(k({ ctrlKey: true }))).toBe(true);
    expect(isUndoHideKey(k({ metaKey: true, key: 'Z' }))).toBe(true);
    expect(isUndoHideKey(k({}))).toBe(false);
    expect(isUndoHideKey(k({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isUndoHideKey(k({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isUndoHideKey(k({ ctrlKey: true, repeat: true }))).toBe(false);
    expect(isUndoHideKey(k({ ctrlKey: true, isComposing: true }))).toBe(false);
    // A non-Latin layout: the physical Z key. A Latin layout types its own character there.
    expect(isUndoHideKey(k({ ctrlKey: true, key: 'я' }))).toBe(true);
    expect(isUndoHideKey(k({ ctrlKey: true, key: ';' }))).toBe(false);
  });

  it('takes a hidden card\'s clause off the catch-up line, and Undo puts it back', async () => {
    const user = userEvent.setup();
    const LINE = 'Since 09:12: 5 new cases (2 critical) and Wazuh quiet for 3 hours.';
    renderStart({ starters: controller(makeInfo({ catch_up: CATCH_UP })) });
    expect(screen.getByTestId('catch-up-line')).toHaveTextContent(LINE);
    // NEW_CASES (slot 1) is hidden: its clause sends the same question, so it goes too.
    act(() => mainCards()[1].focus());
    await user.keyboard('{Delete}');
    const line = screen.getByTestId('catch-up-line');
    expect(line).toHaveTextContent('Since 09:12: Wazuh quiet for 3 hours.');
    expect(within(line).queryByRole('button', { name: '5 new cases (2 critical)' })).toBeNull();
    expect(within(line).getAllByRole('button').map((b) => b.dataset.starter)).toEqual(['silent_source']);
    act(() => (toastMock.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick());
    expect(screen.getByTestId('catch-up-line')).toHaveTextContent(LINE);
    // Both clause families hidden: no line is left, so the capability line shows.
    act(() => mainCards()[1].focus());
    await user.keyboard('{Delete}');
    act(() => mainCards()[2].focus());
    await user.keyboard('{Delete}');
    expect(screen.queryByTestId('catch-up-line')).toBeNull();
    expect(screen.getByText(CAPABILITY_LINE)).toBeInTheDocument();
  });

  it('matches a clause to a hidden card by its key or by its family', () => {
    const info = makeInfo({ catch_up: CATCH_UP });
    expect(visibleCatchUp(info, new Set())).toBe(CATCH_UP);
    expect(visibleCatchUp(info, new Set(['unrelated-key']))).toBe(CATCH_UP);
    expect(visibleCatchUp(info, new Set([NEW_CASES.key as string]))?.clauses.map((c) => c.starter.id)).toEqual(['silent_source']);
    // The clause carries another key, but its family's card is hidden: it goes too.
    const rekeyed = makeInfo({
      catch_up: { ...CATCH_UP, clauses: [{ ...CATCH_UP.clauses[0], starter: { ...NEW_CASES, key: 'aaaaaaaaaaaaaaaa' } }, CATCH_UP.clauses[1]] },
    });
    expect(visibleCatchUp(rekeyed, new Set([NEW_CASES.key as string]))?.clauses.map((c) => c.starter.id)).toEqual(['silent_source']);
    expect(visibleCatchUp(info, new Set([NEW_CASES.key as string, SILENT_SOURCE.key as string]))).toBeNull();
    expect(visibleCatchUp(makeInfo(), new Set([NEW_CASES.key as string]))).toBeNull();
  });

  it('shares the tallest card\'s height across rows only from two columns', () => {
    expect(startGridClass(1)).not.toContain('auto-rows-fr');
    expect(startGridClass(2)).toContain('auto-rows-fr');
    expect(startGridClass(4)).toContain('auto-rows-fr');
    const rows = (width: number) => {
      stackWidth = width;
      const view = renderStart();
      const className = screen.getByRole('list', { name: 'Suggested questions' }).className;
      view.unmount();
      return className;
    };
    // One column: each card keeps its own height (no empty fill on a phone).
    expect(rows(0)).not.toContain('auto-rows-fr');
    expect(rows(400)).not.toContain('auto-rows-fr');
    expect(rows(600)).toContain('auto-rows-fr');
    expect(rows(1100)).toContain('auto-rows-fr');
    stackWidth = 400;
    const loading = renderStart({ starters: controller(null, { loading: true }) });
    expect(screen.getByTestId('starter-skeletons').className).not.toContain('auto-rows-fr');
    loading.unmount();
    stackWidth = 1100;
    renderStart({ starters: controller(null, { loading: true }) });
    expect(screen.getByTestId('starter-skeletons').className).toContain('auto-rows-fr');
  });

  it('declares Delete, Backspace and the undo keys on a hideable card, and no keys on a paused one', () => {
    expect(STARTER_CARD_KEYSHORTCUTS).toBe('Delete Backspace Control+Z Meta+Z');
    const view = renderStart();
    for (const card of mainCards()) expect(card).toHaveAttribute('aria-keyshortcuts', 'Delete Backspace Control+Z Meta+Z');
    view.unmount();
    renderStart({ disabled: true });
    for (const card of mainCards()) expect(card).not.toHaveAttribute('aria-keyshortcuts');
  });

  it('places stand-ins slot by slot, and Undo of an earlier hide leaves later slots alone', () => {
    const order = HOME_STARTERS.map((st) => ({ ...st }));
    const ids = (shown: ChatStarter[]) => shown.map((c) => c.id);
    const k = (st: ChatStarter) => st.key as string;
    const history = (events: Array<[ChatStarter, 'hide' | 'restore']>) => {
      const keys = new Set<string>();
      for (const [st, type] of events) {
        if (type === 'hide') keys.add(k(st));
        else keys.delete(k(st));
      }
      return { keys, log: events.map(([st, type]) => ({ key: k(st), type })) };
    };
    expect(ids(starterSlots(order, history([]), 4))).toEqual(['needs_human', 'new_cases', 'silent_source', 'continue']);
    expect(ids(starterSlots(order, history([[NEW_CASES, 'hide']]), 4))).toEqual(['needs_human', 'triage', 'silent_source', 'continue']);
    // Hide slot 0, then slot 2, then Undo the first: slot 2 keeps POSTURE.
    const twice = history([[NEEDS_HUMAN, 'hide'], [SILENT_SOURCE, 'hide'], [NEEDS_HUMAN, 'restore']]);
    expect(ids(starterSlots(order, twice, 4))).toEqual(['needs_human', 'new_cases', 'posture', 'continue']);
    // A stand-in hidden in turn: the next reserve takes the same slot.
    const chain = history([[NEEDS_HUMAN, 'hide'], [TRIAGE, 'hide']]);
    expect(ids(starterSlots(order, chain, 4))).toEqual(['posture', 'new_cases', 'silent_source', 'continue']);
    // No reserve left: the slot closes.
    const all = history([[NEEDS_HUMAN, 'hide'], [TRIAGE, 'hide'], [POSTURE, 'hide']]);
    expect(ids(starterSlots(order, all, 4))).toEqual(['new_cases', 'silent_source', 'continue']);
    // Hidden with no history (a trimmed log) still leaves its slot.
    expect(ids(starterSlots(order, { keys: new Set([k(NEW_CASES)]), log: [] }, 3))).toEqual(['needs_human', 'continue', 'silent_source']);
  });

  it('keeps each slot\'s claims in hide order, so Undo newest first or oldest first brings the original card back', () => {
    const order = HOME_STARTERS.map((st) => ({ ...st }));
    const ids = (shown: ChatStarter[]) => shown.map((c) => c.id);
    const k = (st: ChatStarter) => st.key as string;
    const history = (events: Array<[ChatStarter, 'hide' | 'restore']>) => {
      const keys = new Set<string>();
      for (const [st, type] of events) {
        if (type === 'hide') keys.add(k(st));
        else keys.delete(k(st));
      }
      return { keys, log: events.map(([st, type]) => ({ key: k(st), type })) };
    };
    const ORIGINAL = ['needs_human', 'new_cases', 'silent_source', 'continue'];
    // Hide NEW_CASES (TRIAGE stands in), then hide TRIAGE (POSTURE stands in).
    const hides: Array<[ChatStarter, 'hide' | 'restore']> = [[NEW_CASES, 'hide'], [TRIAGE, 'hide']];
    expect(ids(starterSlots(order, history(hides), 4))).toEqual(['needs_human', 'posture', 'silent_source', 'continue']);
    // Newest toast first: Undo TRIAGE puts it back, then Undo NEW_CASES puts that back.
    const newestFirst = [...hides, [TRIAGE, 'restore'], [NEW_CASES, 'restore']] as Array<[ChatStarter, 'hide' | 'restore']>;
    expect(ids(starterSlots(order, history(newestFirst.slice(0, 3)), 4))).toEqual(['needs_human', 'triage', 'silent_source', 'continue']);
    expect(ids(starterSlots(order, history(newestFirst), 4))).toEqual(ORIGINAL);
    // Oldest toast first: Undo NEW_CASES ends TRIAGE's claim, so its Undo leaves it in the reserve.
    const oldestFirst = [...hides, [NEW_CASES, 'restore'], [TRIAGE, 'restore']] as Array<[ChatStarter, 'hide' | 'restore']>;
    expect(ids(starterSlots(order, history(oldestFirst.slice(0, 3)), 4))).toEqual(ORIGINAL);
    expect(ids(starterSlots(order, history(oldestFirst), 4))).toEqual(ORIGINAL);
    // TRIAGE is back in the reserve: the next hide brings it, not POSTURE.
    expect(ids(starterSlots(order, history([...oldestFirst, [CONTINUE, 'hide']]), 4))).toEqual([
      'needs_human',
      'new_cases',
      'silent_source',
      'triage',
    ]);
    // Claims are per slot: an Undo in another slot leaves this slot's stack alone.
    const twoSlots = history([[NEW_CASES, 'hide'], [CONTINUE, 'hide'], [TRIAGE, 'hide'], [CONTINUE, 'restore'], [TRIAGE, 'restore']]);
    expect(ids(starterSlots(order, twoSlots, 4))).toEqual(['needs_human', 'triage', 'silent_source', 'continue']);
  });

  it('lets the grid shrink when a slot closes with no card left to take it, but not for a shorter stand-in', async () => {
    const user = userEvent.setup();
    stackWidth = 400; // one column, three cards
    const cardHeight = (id: string | undefined) => (id === 'continue' ? 80 : 104);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-start') return DOMRect.fromRect({ width: stackWidth, height: 300 });
      if (this.tagName === 'UL' && this.getAttribute('aria-label') === 'Suggested questions') {
        const heights = Array.from(this.querySelectorAll<HTMLElement>('[data-starter]')).map((b) => cardHeight(b.dataset.starter));
        return DOMRect.fromRect({ width: stackWidth, height: heights.reduce((sum, h) => sum + h, 0) + 8 * (heights.length - 1) });
      }
      return Element.prototype.getBoundingClientRect.call(this);
    });
    const four = [NEEDS_HUMAN, NEW_CASES, SILENT_SOURCE, CONTINUE].map((st) => ({ ...st }));
    renderStart({ starters: controller(makeInfo({ starters: four })) });
    const grid = () => screen.getByRole('list', { name: 'Suggested questions' });
    expect(grid().style.minHeight).toBe('328px');
    // A shorter stand-in (CONTINUE) takes slot 1: the grid keeps its height.
    act(() => mainCards()[1].focus());
    await user.keyboard('{Delete}');
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'continue', 'silent_source']);
    expect(grid().style.minHeight).toBe('328px');
    // Hidden again with no reserve left: the slot closes and two cards keep their own height.
    await user.keyboard('{Delete}');
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'silent_source']);
    expect(grid().style.minHeight).toBe('216px');
  });

  it('hides a card from its Hide button, which stays out of the tab order and shows only on hover or keyboard focus', async () => {
    const user = userEvent.setup();
    renderStart();
    const hide = screen.getByRole('button', { name: `Hide for a day: ${NEEDS_HUMAN.prompt}` });
    expect(hide).toHaveAttribute('tabindex', '-1');
    expect(hide.className).toMatch(/opacity-0/);
    expect(hide.className).toMatch(/group-hover:opacity-100/);
    // Keyboard focus only: a card focused by code after a mouse Hide does not keep it.
    expect(hide.className).toContain('group-has-[:focus-visible]:opacity-100');
    expect(hide.className).not.toMatch(/group-focus-within/);
    await user.click(hide);
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['triage', 'new_cases', 'silent_source', 'continue']);
  });

  it('is one tab stop: arrows move in reading order and wrap, Home and End jump', async () => {
    const user = userEvent.setup();
    renderStart();
    const tabbable = mainCards().filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    await user.tab();
    expect(mainCards()[0]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(mainCards()[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(mainCards()[2]).toHaveFocus();
    await user.keyboard('{End}');
    expect(mainCards()[3]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(mainCards()[0]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(mainCards()[3]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(mainCards()[0]).toHaveFocus();
    expect(mainCards().filter((b) => b.tabIndex === 0)).toEqual([mainCards()[0]]);
    // Tab leaves the grid for the pills (one stop).
    await user.tab();
    expect(document.activeElement).toHaveAttribute('data-pill', 'investigate');
  });

  it('holds a fresh result while hovered or focused, and releases it on leave', () => {
    const setHeld = vi.fn();
    renderStart({ starters: controller(makeInfo(), { setHeld }) });
    const list = screen.getByRole('list', { name: 'Suggested questions' });
    fireEvent.pointerEnter(list);
    expect(setHeld).toHaveBeenLastCalledWith(true);
    fireEvent.pointerLeave(list);
    expect(setHeld).toHaveBeenLastCalledWith(false);
    act(() => mainCards()[0].focus());
    expect(setHeld).toHaveBeenLastCalledWith(true);
    act(() => mainCards()[0].blur());
    expect(setHeld).toHaveBeenLastCalledWith(false);
  });

  it('shows exactly the visible count of skeletons while loading', () => {
    stackWidth = 400;
    const { unmount } = renderStart({ starters: controller(null, { loading: true }) });
    const skeletons = screen.getByTestId('starter-skeletons');
    expect(skeletons).toHaveAttribute('aria-hidden', 'true');
    expect(skeletons.children).toHaveLength(3);
    for (const el of Array.from(skeletons.children)) expect(el.className).toContain('motion-safe:animate-pulse');
    expect(screen.getByText(CAPABILITY_LINE)).toBeInTheDocument();
    unmount();
    stackWidth = 900;
    renderStart({ starters: controller(null, { loading: true }) });
    expect(screen.getByTestId('starter-skeletons').children).toHaveLength(4);
  });

  it('says suggestions could not load, with Retry, and keeps the greeting and pills', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { container } = renderStart({ starters: controller(null, { error: 'HTTP 503', retry }) });
    expect(screen.getByText(STARTERS_LOAD_ERROR)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Prompt library categories' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows only the greeting, the capability line and the pills when the viewer switched suggestions off', () => {
    renderStart({ starters: null });
    expect(screen.queryByRole('list', { name: 'Suggested questions' })).toBeNull();
    expect(screen.queryByTestId('starter-skeletons')).toBeNull();
    expect(screen.queryByText(STARTERS_LOAD_ERROR)).toBeNull();
    expect(screen.getByText(CAPABILITY_LINE)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /All prompts/ })).toHaveLength(1);
  });

  it('shows no grid when no card is allowed, and only the pills whose prompts the role can run', () => {
    // A role that can run only the Help Center tools.
    const restricted = makeContext(
      {},
      {
        search_logs: 'sources:read',
        log_stats: 'sources:read',
        search_cases: 'cases:read',
        case_stats: 'cases:read',
        get_case: 'cases:read',
        shift_report: 'cases:read',
        soc_metrics: 'metrics:view',
        lookup_indicator: 'enrichment:read',
        mitre_lookup: 'x:y',
        cost_usage: 'cost:view',
        source_health: 'sources:read',
      },
    );
    renderStart({ context: restricted, starters: controller(makeInfo({ starters: [] })) });
    expect(screen.queryByRole('list', { name: 'Suggested questions' })).toBeNull();
    const pills = within(screen.getByRole('group', { name: 'Prompt library categories' })).getAllByRole('button');
    expect(pills.map((p) => p.textContent)).toEqual(['Learn the app', 'All prompts']);
    // Without a catalogue every pill shows (the library gates its own prompts).
    expect(visiblePills(null)).toHaveLength(CATEGORY_PILLS.length);
  });

  it('opens the prompt library filtered to a pill\'s categories', async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener(OPEN_PROMPT_LIBRARY_EVENT, listener);
    try {
      renderStart();
      await user.click(screen.getByRole('button', { name: 'Hunt' }));
      await user.click(screen.getByRole('button', { name: 'All prompts' }));
      const details = listener.mock.calls.map(([event]) => (event as CustomEvent).detail);
      expect(details).toEqual([{ categories: ['hunt', 'ioc'] }, {}]);
    } finally {
      window.removeEventListener(OPEN_PROMPT_LIBRARY_EVENT, listener);
    }
  });

  it('pauses the cards with the composer\'s reason while a promptbook runs', () => {
    act(() => {
      beginPromptbook('Weekly review', ['Count open cases.', 'Summarise.'], 'c-1');
    });
    const { onActivate } = renderStart();
    const list = screen.getByRole('list', { name: 'Suggested questions' });
    expect(list).toHaveAccessibleDescription(PROMPTBOOK_RUNNING_REASON);
    for (const card of mainCards()) expect(card).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(mainCards()[0]);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('reports the keys of the cards on screen', () => {
    const onShownKeysChange = vi.fn();
    stackWidth = 400;
    renderStart({ onShownKeysChange });
    expect(onShownKeysChange).toHaveBeenLastCalledWith(HOME_STARTERS.slice(0, 3).map((s) => s.key));
  });

  it('hides the greeting visually below a 480 px lane, keeping it as the section name', () => {
    laneHeight = 420;
    renderStart();
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.className).toContain('sr-only');
    expect(screen.getByRole('region', { name: heading.textContent ?? '' })).toBeInTheDocument();
  });

  it('renders server text as text, never as markup (#9)', () => {
    const hostile: ChatStarter = { ...NEEDS_HUMAN, prompt: '<img src=x onerror=alert(1)> and <b>bold</b>?', reason: '<i>x</i>' };
    const { container } = renderStart({ starters: controller(makeInfo({ starters: [hostile] })) });
    expect(container.querySelector('img, b, i')).toBeNull();
    expect(screen.getByText(hostile.prompt)).toBeInTheDocument();
  });

  it('marks urgency with a decorative dot only', () => {
    renderStart();
    const dot = mainCards()[0].querySelector('[data-urgency]');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot).toHaveAttribute('data-urgency', 'critical');
    expect(mainCards()[3].querySelector('[data-urgency]')).toBeNull();
  });
});

describe('StartScreen with the real starters hook', () => {
  /** A server that honours `dismissed`: a dismissed key is left out of later reads. */
  function honouringServer(script: { fail?: () => boolean; gate?: () => Promise<void> } = {}) {
    const dismissed = new Set<string>();
    const server = stubStarterFetch(async () => {
      await script.gate?.();
      if (script.fail?.()) return json({ detail: 'busy' }, 503);
      return json(makeInfo({ starters: HOME_STARTERS.filter((st) => !dismissed.has(st.key as string)).map((st) => ({ ...st })) }));
    });
    const original = server.fetchMock.getMockImplementation();
    server.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).split('?')[0] === '/api/chat/starters/events' && init?.body) {
        const body = JSON.parse(String(init.body)) as { type: string; keys: string[] };
        if (body.type === 'dismissed') for (const key of body.keys) dismissed.add(key);
      }
      return (original as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>)(input, init);
    });
    return server;
  }

  function LiveStart({ poll = false, principal = 'admin' }: { poll?: boolean; principal?: string }) {
    const starters = useChatStarters({ surface: 'home', principal, enabled: true, poll });
    return (
      <TooltipProvider>
        <div data-chat-scroll-lane="true">
          <StartScreen context={makeContext()} starters={starters} principal={principal} onActivate={() => {}} />
          <button type="button">Elsewhere</button>
          <textarea aria-label="Composer" />
        </div>
      </TooltipProvider>
    );
  }

  it('keeps an undone card through the next refresh (Undo posts nothing, so the server keeps it)', async () => {
    const user = userEvent.setup();
    const server = honouringServer();
    const view = render(<LiveStart />);
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    act(() => mainCards()[1].focus());
    await user.keyboard('{Delete}');
    act(() => (toastMock.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick());
    expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'new_cases', 'silent_source', 'continue']);
    // A new start stack (a later new chat) reads the server again: the card is still there.
    view.unmount();
    clearChatStartersCache();
    render(<LiveStart />);
    await waitFor(() => expect(server.reads()).toHaveLength(2));
    await waitFor(() => expect(mainCards().map((b) => b.dataset.starter)).toEqual(['needs_human', 'new_cases', 'silent_source', 'continue']));
    expect(server.events()).toEqual([]);
  });

  it('hides the family on the server once the toast closes, and the next read asks the server again', async () => {
    const user = userEvent.setup();
    const server = honouringServer();
    const view = render(<LiveStart />);
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    act(() => mainCards()[0].focus());
    await user.keyboard('{Delete}');
    expect(pendingStarterDismissal(starterHideKey(NEEDS_HUMAN))).toBe(true);
    act(() => (toastMock.mock.calls[0][1] as { onAutoClose: () => void }).onAutoClose());
    await waitFor(() => expect(server.events()).toEqual([{ type: 'dismissed', surface: 'home', keys: [NEEDS_HUMAN.key] }]));
    // The cached answer was invalidated by the dismissal: a remount within the minute reads again.
    view.unmount();
    render(<LiveStart />);
    await waitFor(() => expect(server.reads()).toHaveLength(2));
    await waitFor(() => expect(mainCards().map((b) => b.dataset.starter)).toEqual(['new_cases', 'silent_source', 'continue', 'triage']));
  });

  it('posts a waiting dismissal as the viewer who hid it when the start screen goes, and closes its toast', async () => {
    const user = userEvent.setup();
    const server = honouringServer();
    const view = render(<LiveStart principal="admin" />);
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    act(() => mainCards()[0].focus());
    await user.keyboard('{Delete}');
    const options = toastMock.mock.calls[0][1] as { id: string; onAutoClose: () => void; onDismiss: () => void };
    expect(server.events()).toEqual([]);
    // Leaving the start screen (another page, a send, a sign-out from the menu) ends Undo:
    // the dismissal goes now, while the session is still the one that hid it.
    view.unmount();
    await waitFor(() => expect(server.events()).toEqual([{ type: 'dismissed', surface: 'home', keys: [NEEDS_HUMAN.key] }]));
    expect(toastMock.dismiss).toHaveBeenCalledWith(options.id);
    expect(pendingStarterDismissal(starterHideKey(NEEDS_HUMAN))).toBe(false);
    // The toast closing later (on the sign-in page, under the next viewer) posts nothing.
    act(() => options.onAutoClose());
    act(() => options.onDismiss());
    await act(async () => {});
    expect(server.events()).toHaveLength(1);
  });

  it('drops a waiting dismissal, never posting it, when the viewer signs out or another viewer appears', async () => {
    const user = userEvent.setup();
    const server = honouringServer();
    const view = render(<LiveStart principal="admin" />);
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    act(() => mainCards()[0].focus());
    await user.keyboard('{Delete}');
    expect(pendingStarterDismissal(starterHideKey(NEEDS_HUMAN))).toBe(true);
    // A sign-out here or in another tab of this user (the chat activity `clear` signal).
    act(() => clearChatActivity());
    expect(pendingStarterDismissal(starterHideKey(NEEDS_HUMAN))).toBe(false);
    act(() => (toastMock.mock.calls[0][1] as { onAutoClose: () => void }).onAutoClose());
    await act(async () => {});
    expect(server.events()).toEqual([]);
    // Hidden again, then another viewer's suggestions render in this tab before the toast closes.
    await waitFor(() => expect(mainCards()[0].dataset.starter).toBe('needs_human'));
    act(() => mainCards()[0].focus());
    await user.keyboard('{Delete}');
    const other = render(<LiveStart principal="bob" />);
    act(() => (toastMock.mock.calls[1][1] as { onAutoClose: () => void }).onAutoClose());
    other.unmount();
    view.unmount();
    await act(async () => {});
    expect(server.events()).toEqual([]);
  });

  it('posts a waiting dismissal when the page goes away', async () => {
    const user = userEvent.setup();
    const server = honouringServer();
    render(<LiveStart />);
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    act(() => mainCards()[3].focus());
    await user.keyboard('{Delete}');
    expect(server.events()).toEqual([]);
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(server.events()).toEqual([{ type: 'dismissed', surface: 'home', keys: [HOME_STARTERS[3].key] }]));
    expect(flushStarterDismissals).toBeTypeOf('function');
  });

  it('keeps focus on Retry while the read runs, then hands it to the cards', async () => {
    const user = userEvent.setup();
    let failing = true;
    let release: (() => void) | null = null;
    let gated = false;
    const server = honouringServer({
      fail: () => failing,
      gate: () => (gated ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()),
    });
    render(<LiveStart />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    act(() => retry.focus());
    // A second failure keeps the same button, with focus.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveAttribute('aria-busy'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBe(retry);
    expect(retry).toHaveFocus();
    // Then the read succeeds: the grid's tab stop takes focus, never <body>.
    failing = false;
    gated = true;
    await user.keyboard('{Enter}');
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toHaveFocus();
    // Pressing it again while busy reads nothing more.
    await user.keyboard('{Enter}');
    expect(server.reads()).toHaveLength(3);
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    expect(mainCards()[0]).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('never moves focus to the cards after a Retry that failed again, when a later refresh lands', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let failing = true;
      honouringServer({ fail: () => failing });
      render(<LiveStart poll />);
      const retry = await screen.findByRole('button', { name: 'Retry' });
      act(() => retry.focus());
      fireEvent.click(retry);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).not.toHaveAttribute('aria-busy'));
      expect(retry).toHaveFocus();
      // The analyst gives up on suggestions and starts typing a question.
      const composer = screen.getByRole('textbox', { name: 'Composer' });
      act(() => composer.focus());
      // The two-minute refresh succeeds: the cards appear, focus stays in the composer.
      failing = false;
      await act(async () => {
        vi.advanceTimersByTime(STARTERS_REFRESH_MS + 10);
      });
      await waitFor(() => expect(mainCards()).toHaveLength(4));
      expect(composer).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never pulls focus back to the cards when a slow Retry lands after the analyst moved on', async () => {
    let failing = true;
    let release: (() => void) | null = null;
    let gated = false;
    honouringServer({
      fail: () => failing,
      gate: () => (gated ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()),
    });
    render(<LiveStart />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    act(() => retry.focus());
    failing = false;
    gated = true;
    fireEvent.click(retry);
    await waitFor(() => expect(release).not.toBeNull());
    expect(retry).toHaveAttribute('aria-busy', 'true');
    const composer = screen.getByRole('textbox', { name: 'Composer' });
    act(() => composer.focus());
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(mainCards()).toHaveLength(4));
    expect(composer).toHaveFocus();
  });
});

describe('greeting and icons', () => {
  it('says good morning, afternoon or evening by the local hour', () => {
    expect(greetingFor(new Date(2026, 9, 17, 5, 0))).toBe('Good morning');
    expect(greetingFor(new Date(2026, 9, 17, 11, 59))).toBe('Good morning');
    expect(greetingFor(new Date(2026, 9, 17, 12, 0))).toBe('Good afternoon');
    expect(greetingFor(new Date(2026, 9, 17, 17, 59))).toBe('Good afternoon');
    expect(greetingFor(new Date(2026, 9, 17, 18, 0))).toBe('Good evening');
    expect(greetingFor(new Date(2026, 9, 17, 4, 59))).toBe('Good evening');
  });

  it('greets by the first word of the display name, else the username', async () => {
    vi.unstubAllGlobals();
    // The real `GET /api/account/me` body (`routes.account_me`): the profile is nested
    // under `user`, with no top-level display name.
    let profile: Record<string, unknown> = {
      authenticated: true,
      auth_enabled: true,
      env_managed: false,
      user: { username: 'asharma', role: 'analyst_tier1', display_name: 'Aryan Sharma' },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/account/me') ? json(profile) : json(makeInfo()),
    ));
    const first = renderStart({ principal: 'asharma' });
    expect(await screen.findByRole('heading', { name: /, Aryan$/ })).toBeInTheDocument();
    first.unmount();
    clearGreetingNameCache();
    // The env single admin: an empty profile, so the username.
    profile = { authenticated: true, auth_enabled: true, env_managed: true, user: { username: 'jdoe', display_name: '' } };
    renderStart({ principal: 'jdoe' });
    expect(await screen.findByRole('heading', { name: /, jdoe$/ })).toBeInTheDocument();
  });

  it('reads the display name from the nested profile, with a top-level fallback', () => {
    expect(profileDisplayName({ authenticated: true, user: { username: 'a', display_name: 'Priya Raman' } })).toBe('Priya Raman');
    expect(profileDisplayName({ username: 'a', display_name: 'Flat Name' })).toBe('Flat Name');
    expect(profileDisplayName({ user: { display_name: 7 } })).toBe('');
    expect(profileDisplayName(null)).toBe('');
    expect(profileDisplayName('nope')).toBe('');
  });

  it('re-reads a stale display name when a new start stack mounts, so a saved name shows without a reload', async () => {
    vi.unstubAllGlobals();
    const now = vi.spyOn(Date, 'now');
    let clock = 1_000_000;
    now.mockImplementation(() => clock);
    let displayName = 'Admin';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/account/me')
        ? json({ authenticated: true, user: { username: 'admin', display_name: displayName } })
        : json(makeInfo()),
    );
    vi.stubGlobal('fetch', fetchMock);
    const profileReads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/account/me')).length;
    const first = renderStart({ principal: 'admin' });
    expect(await screen.findByRole('heading', { name: /, Admin$/ })).toBeInTheDocument();
    first.unmount();
    // Within the minute a remount reads nothing.
    displayName = 'Priya Raman';
    clock += 30_000;
    const second = renderStart({ principal: 'admin' });
    expect(screen.getByRole('heading', { name: /, Admin$/ })).toBeInTheDocument();
    expect(profileReads()).toBe(1);
    second.unmount();
    // After it, the known name shows at once and the new one replaces it.
    clock += GREETING_NAME_TTL_MS;
    renderStart({ principal: 'admin' });
    expect(await screen.findByRole('heading', { name: /, Priya$/ })).toBeInTheDocument();
    expect(profileReads()).toBe(2);
  });

  it('has an icon for every family and a neutral one for an unknown id', () => {
    for (const id of [
      'needs_human', 'my_cases', 'sla', 'new_cases', 'volume_change', 'noisy_rule', 'campaign', 'silent_source',
      'budget', 'shift', 'weekly', 'continue', 'saved_prompt', 'hunt', 'approvals', 'platform', 'demo', 'triage',
      'posture', 'report', 'explain_metric', 'learn_app', 'connect_source', 'case_needs_person', 'case_undecided',
      'case_closed_why', 'case_entity', 'case_related', 'case_handoff',
    ]) {
      expect(STARTER_ICONS[id], id).toBeTruthy();
    }
    expect(starterIcon('mystery')).toBeTruthy();
    expect(starterIcon('constructor')).not.toBe(Object.prototype.constructor);
  });
});

void cards;
void React;
