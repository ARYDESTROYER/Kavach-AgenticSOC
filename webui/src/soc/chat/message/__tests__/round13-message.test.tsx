/**
 * Round 13 (SPEC-chat §4.2, §5.1, T7, T10, T17, T20, T28, T36) on one assistant turn:
 *
 *  - quiet block placeholders at the height their cards will take, never a dashed box;
 *  - ONE row of ghost follow-up chips in the reading column, the back-off to one chip
 *    after five answers whose chips went unused, the reset on any use, restored answers
 *    never counting, and the viewer's switch;
 *  - the narrow (30rem) row's ⋯: Copy, Usage details (the card that holds the tokens,
 *    focus back to ⋯) and Sources;
 *  - the meta row follows the widest block of its answer;
 *  - answer prose at 15/24, the Case Manager's compact chat at its own size, and inline
 *    code without a border;
 *  - the live run log before any lookup;
 *  - the step inspector's one status line, the lookup's name, lines that keep their
 *    shape and the quieter footer buttons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  getStepObservation: vi.fn(),
  copyText: vi.fn(async () => true),
}));

/** The viewer's preferences (`null`: no provider, every suggestion on). */
const prefsRef = vi.hoisted(() => ({ current: null as null | { misc: Record<string, unknown> } }));
vi.mock('@/soc/prefs', () => ({
  useOptionalPrefs: () => (prefsRef.current ? { ready: true, prefs: prefsRef.current } : null),
}));
vi.mock('@/lib/clipboard', () => ({ copyText: mocks.copyText, default: mocks.copyText }));
vi.mock('../../chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../chat-api')>();
  return { ...actual, getStepObservation: mocks.getStepObservation };
});

import type { ChatResponse } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { FOLLOW_UPS_IGNORED_KEY, resetFollowUpBackoffForTests } from '../follow-up-backoff';
import { META_COL, READING_COL } from '../lane';
import { Message, PLACEHOLDER_ROW_PX, type MessageProps } from '../Message';
import type { RunLogStep } from '../RunLog';
import { StepInspector } from '../StepInspector';
import type { ChatLiveTurn } from '../../useChatEngine';
import { assistantItem, response, runningItem, step, stubEngine } from './fixtures';

const FOLLOW_UPS = ['Show the same for all time', 'Compare with last month', 'Which hosts were involved?'];

function renderMessage(props: Partial<MessageProps> & Pick<MessageProps, 'item'>) {
  const engine = props.engine ?? stubEngine();
  const view = render(
    <TooltipProvider>
      <Message latest headingId="h-a1" engine={engine} {...props} />
    </TooltipProvider>,
  );
  return { ...view, engine };
}

const KPIS = {
  id: 'k1',
  type: 'kpi_group',
  provenance: 'code',
  artifact_kind: 'kpis',
  items: [
    { key: 'open', label: 'Open cases', value: 12, unit: 'count' },
    { key: 'closed', label: 'Closed cases', value: 30, unit: 'count' },
  ],
};

const TABLE = {
  id: 't1',
  type: 'table',
  provenance: 'source',
  artifact_kind: 'table',
  allowed_views: ['table'],
  columns: [{ key: 'h', label: 'Host', type: 'text' }],
  rows: [['web-01'], ['web-02'], ['db-01']],
};

const LINE = {
  id: 'l1',
  type: 'chart',
  kind: 'line',
  provenance: 'code',
  artifact_kind: 'series',
  unit: 'count',
  x: { kind: 'time', values: Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(2026, 9, i + 1)).toISOString()) },
  series: [{ key: 's', label: 'Cases', values: [1, 2, 3, 4, 5, 6] }],
};

const withBlocks = (blocks: unknown[]) => response({ blocks: blocks as ChatResponse['blocks'] });

beforeEach(() => {
  mocks.getStepObservation.mockReset().mockReturnValue(new Promise(() => undefined));
  mocks.copyText.mockClear();
  prefsRef.current = null;
  resetFollowUpBackoffForTests();
});

afterEach(() => {
  resetFollowUpBackoffForTests();
});

// First in the file: the blocks chunk has not loaded yet, so the placeholders show.
describe('block placeholders (T20)', () => {
  it('reserves each card’s height in quiet, motionless boxes, then gives way to the cards', async () => {
    renderMessage({ item: assistantItem({ response: withBlocks([KPIS, TABLE, LINE]) }) });
    const loading = screen.getByTestId('blocks-loading');
    expect(loading).toHaveAttribute('aria-hidden', 'true');
    const boxes = Array.from(loading.children) as HTMLElement[];
    expect(boxes.map((box) => box.style.height)).toEqual(['112px', `${3 * PLACEHOLDER_ROW_PX}px`, '280px']);
    expect(boxes.map((box) => box.dataset.blockWidth)).toEqual(['compact', 'compact', 'wide']);
    for (const box of boxes) {
      expect(box).toHaveClass('rounded-lg', 'bg-muted/40');
      expect(box.className).not.toMatch(/border-dashed|animate-/);
    }
    await waitFor(() => expect(screen.queryByTestId('blocks-loading')).toBeNull());
  });
});

describe('suggested follow-ups (§4.2)', () => {
  it('offers up to three ghost chips in one row in the reading column, sent as follow-ups', async () => {
    const user = userEvent.setup();
    const { engine } = renderMessage({ item: assistantItem({ response: response({ follow_ups: FOLLOW_UPS }) }) });
    const row = screen.getByTestId('answer-suggestions');
    expect(row.className).toBe(`${READING_COL} flex flex-wrap items-center gap-x-1 gap-y-1`);
    const group = within(row).getByRole('group', { name: 'Suggested follow-ups' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(FOLLOW_UPS);
    for (const chip of chips) {
      expect(chip).not.toHaveClass('border');
      expect(chip).toHaveClass('rounded-sm', 'text-xs', 'hover:bg-hover');
    }
    await user.click(chips[1]);
    expect(engine.send).toHaveBeenCalledWith('Compare with last month', { origin: 'follow_up' });
  });

  it('offers one chip after five answers in a row whose chips went unused, and three again on use', async () => {
    const user = userEvent.setup();
    const counts: number[] = [];
    let last: ReturnType<typeof renderMessage> | null = null;
    for (let i = 0; i < 6; i += 1) {
      last?.unmount();
      last = renderMessage({ item: assistantItem({ response: response({ follow_ups: FOLLOW_UPS }) }) });
      counts.push(within(screen.getByRole('group', { name: 'Suggested follow-ups' })).getAllByRole('button').length);
    }
    // The chips an answer shows never shrink in view: the sixth answer opens on one chip.
    expect(counts).toEqual([3, 3, 3, 3, 3, 1]);
    expect(window.localStorage.getItem(FOLLOW_UPS_IGNORED_KEY)).toBe('5');
    const group = screen.getByRole('group', { name: 'Suggested follow-ups' });
    await user.click(within(group).getByRole('button', { name: FOLLOW_UPS[0] }));
    expect(last?.engine.send).toHaveBeenCalledWith(FOLLOW_UPS[0], { origin: 'follow_up' });
    expect(window.localStorage.getItem(FOLLOW_UPS_IGNORED_KEY)).toBeNull();
    await waitFor(() => expect(within(group).getAllByRole('button')).toHaveLength(3));
  });

  it('never counts a restored thread opened to read', () => {
    for (let i = 0; i < 7; i += 1) {
      const view = renderMessage({ item: assistantItem({ restored: true, response: response({ follow_ups: FOLLOW_UPS }) }) });
      expect(within(screen.getByRole('group', { name: 'Suggested follow-ups' })).getAllByRole('button')).toHaveLength(3);
      view.unmount();
    }
    expect(window.localStorage.getItem(FOLLOW_UPS_IGNORED_KEY)).toBeNull();
  });

  it('shows nothing when the viewer turned suggested follow-ups off, or on an older answer', () => {
    prefsRef.current = { misc: { chat_suggest_follow_ups: false } };
    const off = renderMessage({ item: assistantItem({ response: response({ follow_ups: FOLLOW_UPS }) }) });
    expect(screen.queryByRole('group', { name: 'Suggested follow-ups' })).toBeNull();
    expect(screen.queryByTestId('answer-suggestions')).toBeNull();
    off.unmount();
    prefsRef.current = { misc: {} };
    renderMessage({ latest: false, item: assistantItem({ response: response({ follow_ups: FOLLOW_UPS }) }) });
    expect(screen.queryByTestId('answer-suggestions')).toBeNull();
  });
});

describe('the narrow meta row (T10, T36)', () => {
  it('moves Copy, the usage card and Sources into ⋯, and returns focus to ⋯ from the card', async () => {
    const user = userEvent.setup();
    renderMessage({ item: assistantItem() });
    const narrow = screen.getByTestId('answer-more-actions-narrow');
    await user.click(narrow);
    let menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Copy answer/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Sources \(1\)/ })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /Usage details/ }));
    const card = await screen.findByRole('dialog', { name: 'Usage details' });
    // The card holds the tokens the row no longer shows.
    expect(card).toHaveTextContent(/Input tokens/);
    expect(card).toHaveTextContent(/Total tokens/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Usage details' })).toBeNull());
    await waitFor(() => expect(narrow).toHaveFocus());

    await user.click(narrow);
    menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: /Sources \(1\)/ }));
    expect(screen.getByRole('button', { name: 'Sources 1' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(narrow);
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Hide sources/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('keeps the lead whole and the cost as the usage trigger on the wide row', () => {
    renderMessage({ item: assistantItem() });
    const meta = screen.getByTestId('meta-row');
    expect(within(meta).getByTestId('meta-lead')).toHaveClass('whitespace-nowrap');
    expect(within(meta).getByTestId('meta-lead')).toHaveTextContent('2 lookups');
    const trigger = within(meta).getByTestId('usage-trigger');
    expect(trigger).toHaveTextContent('$0.004');
    expect(trigger).toHaveClass('whitespace-nowrap');
    expect(within(meta).getByTestId('meta-wide')).toHaveClass('hidden', '@[30rem]/meta:inline-flex');
  });
});

describe('the meta row column (§5.1)', () => {
  it('stays in the reading column next to compact cards, and takes the lane with a wide one', async () => {
    const compact = renderMessage({ item: assistantItem({ response: withBlocks([KPIS, TABLE]) }) });
    expect(screen.getByTestId('meta-row').parentElement?.className).toBe(`${READING_COL} space-y-1.5`);
    await screen.findByText('Open cases');
    compact.unmount();
    renderMessage({ item: assistantItem({ response: withBlocks([KPIS, LINE]) }) });
    expect(screen.getByTestId('meta-row').parentElement?.className).toBe(`${META_COL} space-y-1.5`);
    await screen.findByText('Open cases');
  });

  it('keeps the Case Manager’s compact chat in the reading column', async () => {
    renderMessage({ compact: true, item: assistantItem({ response: withBlocks([LINE]) }) });
    expect(screen.getByTestId('meta-row').parentElement?.className).toBe(`${READING_COL} space-y-1.5`);
    await waitFor(() => expect(screen.queryByTestId('blocks-loading')).toBeNull());
  });
});

describe('answer prose (T7, T17)', () => {
  const answer = 'Five failed logins came from `10.0.0.5` and `a-very-long-identifier-that-keeps-going-on-and-on` [D1].';

  it('reads at 15/24 in the Workspace and keeps the paragraph leading plain', () => {
    const { container } = renderMessage({ item: assistantItem({ response: response({ answer }) }) });
    const prose = container.querySelector('[data-chat-markdown]') as HTMLElement;
    expect(prose).toHaveClass('text-md', 'leading-6');
    expect(prose.querySelector('p')).not.toHaveClass('leading-relaxed');
    // The prose measure (38rem) replaces the reading column's 42rem cap on its wrapper.
    const wrapper = prose.parentElement as HTMLElement;
    expect(wrapper).toHaveClass('max-w-[38rem]', 'justify-self-start');
    expect(wrapper).not.toHaveClass('max-w-[42rem]');
  });

  it('keeps the compact chat’s own size with relaxed paragraphs', () => {
    const { container } = renderMessage({ compact: true, item: assistantItem({ response: response({ answer }) }) });
    const prose = container.querySelector('[data-chat-markdown]') as HTMLElement;
    expect(prose).toHaveClass('text-sm');
    expect(prose).not.toHaveClass('text-md');
    expect(prose).not.toHaveClass('leading-6');
    expect(prose.querySelector('p')).toHaveClass('leading-relaxed');
    // The slim case panel keeps the reading column (it is narrower than either measure).
    expect(prose.parentElement).not.toHaveClass('max-w-[38rem]');
  });

  it('draws inline code as a borderless chip that wraps piece by piece', () => {
    renderMessage({ item: assistantItem({ response: response({ answer }) }) });
    const short = screen.getByText('10.0.0.5');
    expect(short.tagName).toBe('CODE');
    expect(short).toHaveClass('rounded-sm', 'bg-muted', '[box-decoration-break:clone]', 'whitespace-nowrap');
    expect(short.className).not.toMatch(/\bborder\b/);
    const long = screen.getByText('a-very-long-identifier-that-keeps-going-on-and-on');
    expect(long).toHaveClass('[overflow-wrap:anywhere]');
    expect(long).not.toHaveClass('whitespace-nowrap');
  });
});

describe('the live run log before any lookup (T20)', () => {
  const modelStep = (label: string): ChatLiveTurn['steps'][number] => ({
    index: 1,
    kind: 'model',
    tool: null,
    label,
    params: {},
    group: null,
    status: 'running',
    result: null,
    progress: null,
  });

  it('reads the question, then chooses lookups', () => {
    const first = renderMessage({ item: runningItem({ steps: [] }) });
    expect(screen.getByTestId('run-log-pending')).toHaveTextContent('Reading your question…');
    first.unmount();
    renderMessage({ item: runningItem({ steps: [modelStep('Thinking')] }) });
    expect(screen.getByTestId('run-log-pending')).toHaveTextContent('Choosing lookups…');
  });
});

describe('the step inspector (T28)', () => {
  function renderInspector(onAsk = vi.fn(), extra: Parameters<typeof step>[1] = {}, tool = 'search_logs') {
    const base = step(2, { tool, ...extra });
    const runStep: RunLogStep = {
      index: 2,
      kind: 'tool',
      tool,
      label: 'Searched logs',
      params: base.params,
      group: null,
      status: 'ok',
      result: base,
    };
    render(
      <StepInspector step={runStep} open conversationId="conv-1" messageId="m-1" onOpenChange={() => undefined} onAsk={onAsk} />,
    );
    return screen.getByTestId('step-inspector');
  }

  it('states the status once, names the lookup in words and keeps the query lines whole', () => {
    const sheet = renderInspector();
    expect(within(sheet).getByText(/200 rows/)).toBeInTheDocument();
    const names = within(sheet)
      .getAllByRole('term')
      .map((term) => term.textContent);
    for (const gone of ['Status', 'Time', 'Rows']) expect(names).not.toContain(gone);
    expect(names).toContain('Coverage');
    const lookup = within(sheet).getByTestId('step-inspector-lookup');
    expect(lookup).toHaveTextContent('Search logs');
    // The tool's id is visible text (muted), never only a tooltip (review F18).
    expect(lookup).not.toHaveAttribute('title');
    expect(within(sheet).getByTestId('step-inspector-tool-id')).toHaveTextContent('(search_logs)');
    expect(within(sheet).getByRole('heading', { name: 'Sources and tokens' })).toBeInTheDocument();
    const query = within(sheet).getByTestId('step-inspector-query');
    expect(within(query).getByText(/event\.outcome:failure/).closest('pre')).toHaveClass('whitespace-pre');
  });

  it('titles the figures section by what it holds, and words kinds in sentence case (review F21)', () => {
    const sheet = renderInspector(vi.fn(), { sources: [], coverage: null, params: { kind: 'posture' } }, 'soc_metrics');
    expect(within(sheet).getByRole('heading', { name: 'Tokens' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('heading', { name: 'Sources and tokens' })).toBeNull();
    expect(within(sheet).getByText('Posture')).toBeInTheDocument();
    expect(within(sheet).queryByText('posture')).toBeNull();
  });

  it('uses quieter footer buttons', () => {
    const sheet = renderInspector();
    const explain = within(sheet).getByRole('button', { name: /Explain this step/ });
    expect(explain).toHaveClass('bg-secondary');
  });
});
