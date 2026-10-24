/**
 * Long conversation titles in the history rail (Round 13 polish, re-shoot PW2-4): a row
 * keeps one line and cuts a long title at the rail's width ("Cases past their response
 * tar…"), so the whole title is in the row's accessible name and in a tooltip on hover
 * and keyboard focus, for history rows and for search results alike.
 *
 * Re-shoot PW3-2: a phone has no hover, so no tooltip. In the History sheet and on any
 * touch screen a row's and a hit's title wrap to up to three lines; the thread toolbar's
 * title wraps to three under 480 px (390 px phone: `narrow`) and on a touch screen, and
 * the band grows to hold them, so a 48-character generated title or an 80-character
 * rename is read whole there (measured live at 390: 2 and 3 lines, nothing cut).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import type { ChatConversationSearchHit, ChatConversationSummary } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import { HistoryRail, railTitleClass, type HistoryRailProps } from '../HistoryRail';
import { ThreadToolbar, titleTextClass, type ThreadToolbarProps } from '../ThreadToolbar';

const LONG = 'Cases past their response target in the last week';

function props(overrides: Partial<HistoryRailProps> = {}): HistoryRailProps {
  const row: ChatConversationSummary = {
    id: 'c1',
    title: LONG,
    preview: '',
    created_at: '2026-10-23T10:00:00Z',
    updated_at: '2026-10-23T10:00:00Z',
    message_count: 2,
  };
  return {
    conversations: [row],
    activeId: null,
    busy: false,
    loading: false,
    error: null,
    retention: { limit: 50, truncated: false, total: 1, showNote: false },
    search: { query: '', setQuery: vi.fn(), results: null, searching: false, error: null, openHit: vi.fn() },
    onRetry: vi.fn(),
    onNewChat: vi.fn(),
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onOpenReport: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

function renderRail(p: HistoryRailProps) {
  return render(
    <TooltipProvider>
      <HistoryRail {...p} />
    </TooltipProvider>,
  );
}

/** A generated title at its longest (MAX_CONVERSATION_TITLE_CHARS, 48) and a rename at 80. */
const GENERATED = 'Cases past their response target, night shift 12';
const RENAMED = 'Cases past their response target on the night shift, raised by the Monday review';

/** The touch-screen variant: wraps where no tooltip can show. */
const TOUCH_WRAP = ['[@media(hover:none)]:whitespace-normal', '[@media(hover:none)]:break-words'];

function renderToolbar(title: string, narrow: boolean) {
  const summary = { id: 'c1', title, created_at: '2026-10-23T10:00:00Z', updated_at: '2026-10-23T10:00:00Z', message_count: 2 };
  const p: ThreadToolbarProps = {
    title,
    summary,
    railInSheet: narrow,
    onOpenHistory: vi.fn(),
    onNewChat: vi.fn(),
    narrow,
    report: { count: 0, open: false, onToggle: vi.fn() },
    busy: false,
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
  };
  return render(
    <TooltipProvider>
      <ThreadToolbar {...p} />
    </TooltipProvider>,
  );
}

describe('long titles in the history rail', () => {
  it('a row keeps one line, with the whole title in its name and its keyboard-focus tooltip', async () => {
    renderRail(props());
    const row = screen.getByRole('button', { name: new RegExp(`^${LONG}, `) });
    expect(row.querySelector('.truncate')).toHaveTextContent(LONG);
    act(() => row.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(LONG);
  });

  it('a search result shows the whole title in a tooltip on keyboard focus too', async () => {
    const hit = { id: 'c1', title: LONG, updated_at: '2026-10-23T10:00:00Z', match: { snippet: 'past their response target' } } as unknown as ChatConversationSearchHit;
    renderRail(props({ search: { query: 'target', setQuery: vi.fn(), results: [hit], searching: false, error: null, openHit: vi.fn() } }));
    const result = screen.getByRole('button', { name: new RegExp(`^${LONG}`) });
    expect(result.querySelector('.truncate')).toHaveTextContent(LONG);
    act(() => result.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(LONG);
  });
});

describe('long titles where no tooltip can show (PW3-2)', () => {
  it('generated titles fit the sizes the wrapping is built for', () => {
    expect(GENERATED).toHaveLength(48);
    expect(RENAMED).toHaveLength(80);
  });

  it.each([GENERATED, RENAMED])('the toolbar title wraps to up to three lines at 390 px: %s', (title) => {
    renderToolbar(title, true);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveAccessibleName(title);
    expect(heading).not.toHaveClass('truncate');
    const text = screen.getByTestId('thread-title-text');
    expect(text).toHaveTextContent(title);
    expect(text).toHaveClass('line-clamp-3', 'break-words');
    expect(text).not.toHaveClass('truncate');
    // No `block`: it would override line-clamp's box and show a fourth line.
    expect(text).not.toHaveClass('block');
    expect(text.closest('button')).not.toHaveClass('truncate');
    // The band grows with the title instead of clipping it at 44 px.
    const band = screen.getByTestId('chat-thread-toolbar');
    expect(band).toHaveClass('min-h-11');
    expect(band).not.toHaveClass('h-11');
  });

  it('with room, the toolbar title keeps one line with its tooltip, and wraps on a touch screen', async () => {
    renderToolbar(GENERATED, false);
    const text = screen.getByTestId('thread-title-text');
    expect(text).toHaveClass('block', 'truncate', '[@media(hover:none)]:line-clamp-3', ...TOUCH_WRAP);
    act(() => text.closest('button')!.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(GENERATED);
  });

  it('a draft title (not yet saved) wraps the same way', () => {
    const summary = null;
    render(
      <TooltipProvider>
        <ThreadToolbar
          title={GENERATED}
          summary={summary}
          railInSheet
          onOpenHistory={vi.fn()}
          onNewChat={vi.fn()}
          narrow
          busy={false}
          onRename={vi.fn()}
          onTogglePin={vi.fn()}
          onExport={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('thread-title-text')).toHaveClass('line-clamp-3', 'break-words');
  });

  it('History sheet rows wrap to up to three lines', () => {
    renderRail(props({ inSheet: true, conversations: [{ ...props().conversations[0], title: GENERATED }] }));
    const title = screen.getByTestId('rail-row-title');
    expect(title).toHaveTextContent(GENERATED);
    expect(title).toHaveClass('line-clamp-3', 'break-words');
    expect(title).not.toHaveClass('truncate');
    // The row is at least 32 px and grows with a wrapped title.
    const row = title.closest('button')!;
    expect(row).toHaveClass('min-h-8');
    expect(row).not.toHaveClass('h-8');
  });

  it('a search hit in the History sheet wraps to up to three lines', () => {
    const hit = { id: 'c1', title: GENERATED, updated_at: '2026-10-23T10:00:00Z', match: { snippet: 'night shift' } } as unknown as ChatConversationSearchHit;
    renderRail(props({ inSheet: true, search: { query: 'night', setQuery: vi.fn(), results: [hit], searching: false, error: null, openHit: vi.fn() } }));
    const title = screen.getByTestId('hit-title');
    expect(title).toHaveClass('line-clamp-3', 'break-words');
    expect(title).not.toHaveClass('truncate', 'block');
  });

  it('the docked rail keeps one line with a tooltip, and wraps on a touch screen', () => {
    expect(railTitleClass(false).split(' ')).toEqual(expect.arrayContaining(['truncate', '[@media(hover:none)]:line-clamp-3', ...TOUCH_WRAP]));
    expect(titleTextClass(false).split(' ')).toEqual(expect.arrayContaining(['truncate', '[@media(hover:none)]:line-clamp-3', ...TOUCH_WRAP]));
  });
});
