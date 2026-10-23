/**
 * Proportional numerals on the chat's reading surfaces (Round 13 polish, re-shoot PW2-3).
 *
 * The body sets `font-variant-numeric: tabular-nums` (theme.css), and Inter's tabular
 * forms widen the hyphen as well as the digits: measured in Chromium with the shipped
 * Inter at 13 px, 5.91 px proportional against 8.36 px tabular, so prose read
 * "Read - only" and "demo - synthetic". The chat's prose surfaces set
 * `proportional-nums`; figures, meta rows, KPI values and tables keep tabular numerals.
 * jsdom has no font metrics, so this pins the classes; the advance was measured live.
 *
 * Re-shoot PW3-3: an answer block's title ("Highest-risk cases"), its caption and the
 * answer's shared scope line are prose too (8.38 px against 5.98 px at 13 px).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { AnnouncerProvider } from '@/soc/components/announcer';
import AnswerBlocks from '../blocks/AnswerBlocks';
import { parseBlock } from '../blocks/schema';
import { TooltipProvider } from '@/ui/tooltip';

import { ChatMarkdown } from '../ChatMarkdown';
import { SuggestionChip } from '../message/FollowUps';
import { UserTurn } from '../message/UserTurn';
import { userItem } from '../message/__tests__/fixtures';
import { CatchUpLine } from '../starters/CatchUpLine';
import { StarterCard } from '../starters/StarterCard';
import { CATCH_UP, NEEDS_HUMAN } from '../starters/__tests__/fixtures';
import { HistoryRail, type HistoryRailProps } from '../workspace/HistoryRail';

const PROPORTIONAL = 'proportional-nums';

describe('reading surfaces set proportional numerals', () => {
  it('answer prose, with tables inside it kept tabular', () => {
    const { container } = render(<ChatMarkdown text={'Read-only lookups.\n\n| Case | Count |\n| --- | ---: |\n| CASE-000045 | 12 |'} />);
    const root = container.querySelector('[data-chat-markdown]')!;
    expect(root).toHaveClass(PROPORTIONAL);
    expect(root.querySelector('table')).toHaveClass('tabular-nums');
  });

  it('the user bubble', () => {
    render(
      <AnnouncerProvider>
        <TooltipProvider>
          <UserTurn item={userItem('Is demo-synthetic data read-only?')} headingId="h" />
        </TooltipProvider>
      </AnnouncerProvider>,
    );
    expect(screen.getByText('Is demo-synthetic data read-only?')).toHaveClass(PROPORTIONAL);
  });

  it('follow-up and zero-result chips', () => {
    render(<SuggestionChip label="Summarise CASE-000046 for a handoff note" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Summarise CASE-000046 for a handoff note' })).toHaveClass(PROPORTIONAL);
  });

  it('a starter card question and reason', () => {
    render(
      <TooltipProvider>
        <StarterCard starter={NEEDS_HUMAN} tabIndex={0} onActivate={vi.fn()} />
      </TooltipProvider>,
    );
    const question = screen.getByText(NEEDS_HUMAN.prompt);
    expect(question.parentElement).toHaveClass(PROPORTIONAL);
    expect(screen.getByText(NEEDS_HUMAN.reason!).closest(`.${PROPORTIONAL}`)).not.toBeNull();
  });

  it.each(['home', 'thread'] as const)('the %s catch-up line', (variant) => {
    render(<CatchUpLine catchUp={CATCH_UP} variant={variant} onSend={vi.fn()} onHide={vi.fn()} />);
    const line = screen.getByTestId(variant === 'home' ? 'catch-up-line' : 'thread-catch-up-line');
    expect(line).toHaveClass(PROPORTIONAL);
  });

  it('history rail titles, while the row time stays tabular', () => {
    const props: HistoryRailProps = {
      conversations: [
        { id: 'c1', title: 'Cases past their response target', preview: '', created_at: '2026-10-23T10:00:00Z', updated_at: '2026-10-23T10:00:00Z', message_count: 2 },
      ],
      activeId: 'c1',
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
    };
    render(
      <TooltipProvider>
        <HistoryRail {...props} />
      </TooltipProvider>,
    );
    const row = screen.getByRole('button', { name: /^Cases past their response target, / });
    expect(within(row).getByText('Cases past their response target')).toHaveClass(PROPORTIONAL);
    expect(row.querySelector('[aria-hidden]')).toHaveClass('tabular-nums');
  });

  it('an answer block title and caption, and the shared scope line, while table cells stay tabular', () => {
    const kpis = (id: string, title: string, caption: string) =>
      parseBlock({
        id,
        type: 'kpi_group',
        title,
        provenance: 'code',
        artifact_kind: 'kpis',
        caption,
        as_of: '2026-10-17T11:13:20Z',
        items: [{ key: 'a', label: 'Open', value: 4, unit: 'count' }],
      });
    render(
      <AnnouncerProvider>
        <AnswerBlocks
          blocks={[kpis('a', 'Highest-risk cases', '44 cases · last 24 hours'), kpis('b', 'Auto-closed cases', '12 cases · last 24 hours')]}
          messageId="m1"
          shareCaptions
        />
      </AnnouncerProvider>,
    );
    expect(screen.getByRole('heading', { level: 4, name: 'Highest-risk cases' })).toHaveClass(PROPORTIONAL);
    for (const caption of screen.getAllByTestId('block-caption')) expect(caption).toHaveClass(PROPORTIONAL);
    expect(screen.getByTestId('answer-scope-line')).toHaveClass(PROPORTIONAL);
    // KPI values keep the body's tabular numerals.
    expect(document.querySelector('figure .tabular-nums')).not.toBeNull();
  });
});
