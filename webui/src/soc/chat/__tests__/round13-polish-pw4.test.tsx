/**
 * Round 13 polish, third re-shoot (PW4): chat layout details measured on the live Demo.
 *
 * - PW4-1: a case number, technique id or rule id (a word of up to 27 characters, its
 *   punctuation not counted, the server's reference limit too) never breaks inside, in
 *   card text, case-list rows and table cells; the sentence still wraps between words,
 *   and a longer token may still break (third re-shoot review: one limit, no gap).
 * - PW4-2: a block table wider than its frame scrolls inside it, faded on the side that
 *   holds more columns.
 * - PW4-7: prose inside a Brief keeps the 38rem prose measure (a note 42rem).
 * - PW4-8: text values on blocks set proportional numerals; figures stay tabular.
 * - PW4-9: the conversation widths are offered only where one changes the lane.
 *
 * jsdom has no line layout: these pin the classes and spans; the wrapping, the fade and
 * the hyphen widths were measured live in Chromium (SPEC-chat §10.5, third re-shoot).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { AnnouncerProvider } from '@/soc/components/announcer';
import { TooltipProvider } from '@/ui/tooltip';

import AnswerBlocks from '../blocks/AnswerBlocks';
import { galleryBlock } from '../blocks/__fixtures__/gallery';
import { parseBlock, type AnswerBlock } from '../blocks/schema';
import { scrollEdges } from '../blocks/scroll-edges';
import { LANE_CHOICE_FROM_PX, laneWidthChoiceMatters } from '../message/lane';
import { StarterCard } from '../starters/StarterCard';
import { KEEP_TOKEN, LONG_TOKEN, softBreakLongTokens } from '../starters/soft-breaks';
import { NEEDS_HUMAN } from '../starters/__tests__/fixtures';
import { ThreadToolbar } from '../workspace/ThreadToolbar';
import { HistoryRail, type HistoryRailProps } from '../workspace/HistoryRail';

function textOf(node: React.ReactNode): HTMLElement {
  return render(<span>{node}</span>).container.firstElementChild as HTMLElement;
}

const kept = (el: Element) => Array.from(el.querySelectorAll('[data-kept-token]'), (n) => n.textContent);

function show(blocks: AnswerBlock[]) {
  return render(
    <AnnouncerProvider>
      <TooltipProvider>
        <AnswerBlocks blocks={blocks} messageId="m1" />
      </TooltipProvider>
    </AnnouncerProvider>,
  );
}

describe('PW4-1: short references never break inside', () => {
  it('keeps a case number whole with its question mark, and leaves the words around it as one run', () => {
    const question = 'What links the 5 cases in the campaign that includes CASE-000089?';
    const el = textOf(softBreakLongTokens(question));
    expect(el.textContent).toBe(question);
    expect(kept(el)).toEqual(['CASE-000089?']);
    expect(el.querySelector('[data-kept-token]')).toHaveClass('whitespace-nowrap');
    expect(el.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(el.firstChild?.textContent).toBe('What links the 5 cases in the campaign that includes ');
  });

  it('keeps rule ids and host names that a browser would break at a hyphen; plain words stay text', () => {
    const el = textOf(softBreakLongTokens('Rule LP-ES-RISK-1001 fired on vpn-gw-2, T1078 and demo_noisy_scanner.'));
    expect(kept(el)).toEqual(['LP-ES-RISK-1001', 'vpn-gw-2,']);
    // No hyphen: a browser does not break inside it, so it stays plain text.
    expect(softBreakLongTokens('Which T1078 cases matter?')).toBe('Which T1078 cases matter?');
  });

  it('keeps every short token in `all` mode (text set break-all), and leaves longer tokens to break', () => {
    const el = textOf(softBreakLongTokens('T1021, T1048, T1078', { all: true }));
    expect(kept(el)).toEqual(['T1021,', 'T1048,', 'T1078']);
    // Up to KEEP_TOKEN characters is kept; the next length already breaks anywhere but at
    // its ends (one limit: no length is left to the browser's hyphen break).
    expect(KEEP_TOKEN).toBe(27);
    expect(LONG_TOKEN).toBe(KEEP_TOKEN + 1);
    const atLimit = `${'a'.repeat(KEEP_TOKEN - 2)}-b`;
    const over = `${'a'.repeat(KEEP_TOKEN - 1)}-b`;
    expect(kept(textOf(softBreakLongTokens(`x ${atLimit} y`)))).toEqual([atLimit]);
    const overEl = textOf(softBreakLongTokens(`x ${over} y`));
    expect(kept(overEl)).toEqual([]);
    expect(Array.from(overEl.querySelectorAll('[data-long-token]'), (n) => n.textContent)).toEqual([over]);
    // `breakLong: false` leaves a long id as text (a table cell grows or breaks it itself).
    const id = `campaign-${'4'.repeat(LONG_TOKEN)}`;
    expect(softBreakLongTokens(`${id} open`, { breakLong: false })).toBe(`${id} open`);
  });

  it('balances a starter question so a last word never stands alone', () => {
    render(
      <TooltipProvider>
        <StarterCard starter={{ ...NEEDS_HUMAN, prompt: 'What links the 5 cases in the campaign that includes CASE-000082?' }} tabIndex={0} onActivate={vi.fn()} />
      </TooltipProvider>,
    );
    const question = document.querySelector('[data-starter] [id$="-q"]') as HTMLElement;
    expect(question).toHaveClass('text-balance');
    expect(kept(question)).toEqual(['CASE-000082?']);
  });

  it('keeps a case-list row number and a rule name in its title whole', () => {
    show([
      parseBlock({
        id: 'cl',
        type: 'case_list',
        provenance: 'code',
        artifact_kind: 'case_list',
        items: [{ case_id: 'case-6b22d1999bf94f3a91c10ab2a23e6e7c', case_number: 'CASE-000078', title: 'ip:203.0.113.77 · LP-ES-RISK-1001' }],
      }),
    ]);
    const row = screen.getByTestId('block-case-list');
    const number = row.querySelector('[data-case-ref="number"]')!;
    expect(kept(number)).toEqual(['CASE-000078']);
    expect(number.querySelector('[data-kept-token]')).toHaveClass('whitespace-nowrap');
    expect(kept(row.querySelector('[data-case-ref="title"]')!)).toEqual(['LP-ES-RISK-1001']);
  });

  it('keeps every technique id in a mono table cell whole, and sets sans text cells as prose', () => {
    show([
      parseBlock({
        id: 't',
        type: 'table',
        title: 'Open campaigns',
        provenance: 'code',
        artifact_kind: 'table',
        columns: [
          { key: 'name', label: 'Campaign', type: 'text' },
          { key: 'mitre', label: 'Techniques', type: 'code' },
          { key: 'count', label: 'Cases', type: 'number' },
        ],
        rows: [['Lateral movement on vpn-gw-2', 'T1021, T1048, T1078', 5]],
      }),
    ]);
    const table = screen.getByTestId('block-table');
    const code = table.querySelector('td code') as HTMLElement;
    expect(code).toHaveTextContent('T1021, T1048, T1078');
    expect(kept(code)).toEqual(['T1021,', 'T1048,', 'T1078']);
    const textCell = within(table).getAllByRole('cell')[0].firstElementChild as HTMLElement;
    expect(textCell).toHaveClass('proportional-nums');
    expect(kept(textCell)).toEqual(['vpn-gw-2']);
    expect(within(table).getByText('5')).toHaveClass('tabular-nums');
  });
});

describe('PW4-2: a wide table scrolls inside its frame with a fade', () => {
  it('names the sides that hold more columns', () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toBeNull();
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 1202, clientWidth: 310 })).toBe('end');
    expect(scrollEdges({ scrollLeft: 400, scrollWidth: 1202, clientWidth: 310 })).toBe('both');
    expect(scrollEdges({ scrollLeft: 892, scrollWidth: 1202, clientWidth: 310 })).toBe('start');
    // Sub-pixel widths are not an overflow.
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 310.5, clientWidth: 310 })).toBeNull();
  });

  it('marks the scroll box as it scrolls, and the table root fades the marked side', () => {
    const geometry = { scrollWidth: 1202, clientWidth: 310 };
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.firstElementChild?.tagName === 'TABLE' ? geometry.scrollWidth : 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.firstElementChild?.tagName === 'TABLE' ? geometry.clientWidth : 0;
      }),
    ];
    try {
      show([galleryBlock('signins')]);
      const root = screen.getByTestId('block-table');
      const box = root.querySelector('table')!.parentElement!;
      expect(box).toHaveAttribute('data-x-scroll', 'end');
      expect(root.className).toContain('[&_[data-x-scroll=end]]:[mask-image:');
      act(() => {
        box.scrollLeft = 400;
        fireEvent.scroll(box);
      });
      expect(box).toHaveAttribute('data-x-scroll', 'both');
      act(() => {
        box.scrollLeft = 892;
        fireEvent.scroll(box);
      });
      expect(box).toHaveAttribute('data-x-scroll', 'start');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('PW4-7: prose inside a Brief keeps the reading measure', () => {
  it('caps a markdown leaf at 38rem, a note at 42rem, and a section summary at 38rem', () => {
    show([galleryBlock('shift-brief')]);
    const report = screen.getByTestId('block-report');
    const markdown = report.querySelector('[data-block-type="markdown"]') as HTMLElement;
    expect(markdown).toHaveClass('max-w-[38rem]');
    expect(report.querySelector('[data-block-type="callout"]')).toHaveClass('max-w-[42rem]');
    const summary = within(report).getByText('Alert volume and case backlog over the shift.');
    expect(summary).toHaveClass('max-w-[38rem]', 'proportional-nums');
  });
});

describe('PW4-8: text values on blocks set proportional numerals', () => {
  it('an indicator card: facts and provider names are prose, its dates and scores tabular', () => {
    show([
      parseBlock({
        id: 'ioc2',
        type: 'entity',
        provenance: 'code',
        artifact_kind: 'entity',
        entity: { kind: 'ip', value: '198.51.100.250' },
        facts: [{ label: 'Source', value: 'demo-synthetic feed' }],
        reputation: [{ provider: 'demo-synthetic', verdict: 'unknown', score: 12 }],
        first_seen: '2026-10-23T10:00:00Z',
        counts: [],
        related_cases: [],
      }),
    ]);
    const entity = screen.getByTestId('block-entity');
    expect(within(entity).getByText('demo-synthetic feed')).toHaveClass('proportional-nums');
    expect(within(entity).getByText('demo-synthetic')).toHaveClass('proportional-nums');
    expect(within(entity).getByText('score 12')).toHaveClass('tabular-nums');
    expect(within(entity).getByText(/^First seen/)).toHaveClass('tabular-nums');
  });
});

describe('PW4-9: the widths only where one changes the lane', () => {
  it('needs a lane wider than Comfortable (64rem) once the gutters are taken', () => {
    expect(LANE_CHOICE_FROM_PX).toBe(1024);
    expect(laneWidthChoiceMatters(390)).toBe(false);
    // 1440 with a docked rail: a 936 px conversation, all three widths the same lane.
    expect(laneWidthChoiceMatters(936)).toBe(false);
    expect(laneWidthChoiceMatters(1077)).toBe(false);
    expect(laneWidthChoiceMatters(1078)).toBe(true);
    expect(laneWidthChoiceMatters(1416)).toBe(true);
  });

  it('leaves the View group out of the thread menu without a width choice', () => {
    render(
      <TooltipProvider>
        <ThreadToolbar
          title="Shift brief"
          summary={null}
          caseScoped={false}
          railInSheet
          onOpenHistory={vi.fn()}
          onNewChat={vi.fn()}
          narrow
          busy={false}
          onRename={vi.fn()}
          onTogglePin={vi.fn()}
          onExport={vi.fn()}
          onDelete={vi.fn()}
          laneWidth={null}
        />
      </TooltipProvider>,
    );
    // A draft with no thread actions and no width choice has no menu at all.
    expect(screen.queryByRole('button', { name: 'Conversation actions' })).toBeNull();
  });
});

describe('PW4-6: history dates read like the answers', () => {
  it('names a row with its UTC date in the answers’ form', () => {
    const props: HistoryRailProps = {
      conversations: [
        { id: 'c1', title: 'Cases past their response target', preview: '', created_at: '2026-10-23T15:45:00Z', updated_at: '2026-10-23T15:45:00Z', message_count: 2 },
      ],
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
    };
    render(
      <TooltipProvider>
        <HistoryRail {...props} inSheet />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Cases past their response target, 2026-10-23 15:45 UTC · 2 messages' })).toBeInTheDocument();
  });
});
