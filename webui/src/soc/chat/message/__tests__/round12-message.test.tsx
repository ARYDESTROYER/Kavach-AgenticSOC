/**
 * Round 12 answer-level features on one assistant turn (WP-FEAT-A, SPEC D2–D4, D9–D11,
 * SYNTHESIS-chat P0-1, P0-7, P0-11, P1-1, P1-3, P1-4, P1-6, P1-9):
 *
 *  - the clarify card (option picks are `origin: clarify`, the analyst's own words are
 *    `origin: user`, model text renders as text);
 *  - zero-result chips read from the stored observation (follow-up origin, deduplicated
 *    against follow-ups, latest saved Workspace answer only);
 *  - no Continue chip; quiet run-log notes (continued, summarised, stopped repeating) and
 *    the running lookup's progress; the compaction line; aria-busy on the running turn;
 *  - "Product help" only without data lookups; the unsupported body without a console link;
 *  - the step inspector (stored observation as untrusted text, Retry step = retry_step,
 *    Explain this step = follow_up, focus back to Inspect);
 *  - answer feedback (thumbs, reason panel, stored rating shown on reload);
 *  - the saved-report line (Open navigates, Export opens the export menu) and the
 *    report-save error line;
 *  - "Add to case" (human-confirmed preview, the analyst's own comment, mentions defanged);
 *  - long answers (contents for ≥ 4 headings, Jump to end) and Ctrl/⌘+Shift+C.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const mocks = vi.hoisted(() => ({
  announce: vi.fn(),
  navigate: vi.fn(),
  hasPermission: vi.fn(() => true),
  getStepObservation: vi.fn(),
  listChatFeedback: vi.fn(),
  postChatFeedback: vi.fn(),
  searchCasesForPicker: vi.fn(),
  postCaseComment: vi.fn(),
  getReport: vi.fn(),
  createReport: vi.fn(),
  addToReport: vi.fn(),
  deleteReport: vi.fn(),
  saveAnswerAsReport: vi.fn(),
  copyText: vi.fn(),
}));

/** The viewer's preferences (`null`: no provider, every suggestion on). */
const prefsRef = vi.hoisted(() => ({ current: null as null | { misc: Record<string, unknown> } }));
vi.mock('@/soc/prefs', () => ({
  useOptionalPrefs: () => (prefsRef.current ? { ready: true, prefs: prefsRef.current } : null),
}));
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => mocks.announce }));
vi.mock('@/soc/router', () => ({ useNavigateOptional: () => mocks.navigate }));
vi.mock('@/soc/auth', () => ({
  useOptionalAuth: () => ({ hasPermission: mocks.hasPermission, username: 'analyst' }),
}));
vi.mock('@/lib/clipboard', () => ({ copyText: mocks.copyText, default: mocks.copyText }));
vi.mock('../../chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../chat-api')>();
  return {
    ...actual,
    getStepObservation: mocks.getStepObservation,
    listChatFeedback: mocks.listChatFeedback,
    postChatFeedback: mocks.postChatFeedback,
    searchCasesForPicker: mocks.searchCasesForPicker,
    postCaseComment: mocks.postCaseComment,
    getReport: mocks.getReport,
    createReport: mocks.createReport,
    addToReport: mocks.addToReport,
    deleteReport: mocks.deleteReport,
    saveAnswerAsReport: mocks.saveAnswerAsReport,
  };
});

import type { ChatStep } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { ROUND12_RAW } from '../../blocks/__fixtures__/round12';
import { Message, type MessageProps } from '../Message';
import { Transcript } from '../Transcript';
import { resetAnswerFeedbackForTests } from '../feedback';
import { resetZeroChipCacheForTests } from '../ZeroResultChips';
import { NEEDS_INPUT_ANNOUNCEMENT, useTurnAnnouncer } from '../useTurnAnnouncer';
import type { ChatAssistantItem } from '../../useChatEngine';
import { assistantItem, response, runningItem, step, stubEngine, userItem } from './fixtures';

const CONV = 'conv-1';

function renderMessage(props: Partial<MessageProps> & Pick<MessageProps, 'item'>) {
  const engine = props.engine ?? stubEngine({ conversationId: CONV });
  const view = render(
    <TooltipProvider>
      <Message latest headingId="h-a1" engine={engine} question="How many critical false positives this week?" {...props} />
    </TooltipProvider>,
  );
  return { ...view, engine };
}

/** Open "Add to case…" from the answer's ⋯ menu (Round 13 T10); returns the ⋯ trigger. */
async function openAddToCase(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement = document.body): Promise<HTMLElement> {
  const trigger = within(scope).getByTestId('answer-more-actions');
  await user.click(trigger);
  await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Add to case/ }));
  return trigger;
}

function zeroStep(index = 2, extra: Partial<ChatStep> = {}): ChatStep {
  return step(index, {
    tool: 'case_stats',
    label: 'Counted cases',
    query: null,
    coverage: null,
    rows: 0,
    basis: 'exact',
    summary: '0 cases (exact, this week)',
    observation_ref: `o${index}:turn-1`,
    ...extra,
  });
}

const OBSERVATION = {
  conversation_id: CONV,
  message_id: 'm-assistant-1',
  index: 2,
  tool: 'case_stats',
  status: 'ok',
  label: 'Counted cases',
  summary: '0 cases (exact, this week)',
  observation: { total: 0, note: '<img src=x onerror=alert(1)>', suggestions: [{ label: 'All time' }, { label: 'Without the verdict filter' }] },
  params: {},
  truncated: false,
  stored_at: null,
  suggestions: [
    { label: 'All time', tool: 'case_stats' },
    { label: 'Without the verdict filter', tool: 'case_stats' },
  ],
};

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.hasPermission.mockReturnValue(true);
  // Pending by default: a test that needs stored ratings resolves it (no stray update).
  mocks.listChatFeedback.mockReturnValue(new Promise(() => undefined));
  mocks.postChatFeedback.mockResolvedValue(undefined);
  mocks.getStepObservation.mockResolvedValue(OBSERVATION);
  mocks.copyText.mockResolvedValue(true);
  resetAnswerFeedbackForTests();
  resetZeroChipCacheForTests();
  prefsRef.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clarify', () => {
  const clarify = { question: 'Trend of <b>what</b>?', options: ['Alerts', 'Cases', 'AI cost', 'FP rate'], allow_custom: true };

  it('offers the options with origin clarify and renders model text as text (#9)', () => {
    const { engine, container } = renderMessage({
      item: assistantItem({ response: response({ answer: 'Which trend do you want?', clarify, steps: [] }) }),
    });
    const card = screen.getByTestId('clarify-card');
    expect(within(card).getByText('Needs input')).toBeInTheDocument();
    expect(within(card).getByText('Trend of <b>what</b>?')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('article')).toHaveAttribute('data-needs-input', 'true');
    fireEvent.click(within(card).getByRole('button', { name: 'Cases' }));
    expect(engine.send).toHaveBeenCalledWith('Cases', { origin: 'clarify' });
  });

  it('sends the analyst’s own words as origin user, and Escape cancels', async () => {
    const user = userEvent.setup();
    const { engine } = renderMessage({ item: assistantItem({ response: response({ answer: 'Which?', clarify, steps: [] }) }) });
    await user.click(screen.getByRole('button', { name: 'Something else…' }));
    const field = screen.getByRole('textbox', { name: /Your answer to/ });
    expect(field).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: /Your answer to/ })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Something else…' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Something else…' }));
    await user.type(screen.getByRole('textbox', { name: /Your answer to/ }), 'Escalations per analyst{Enter}');
    expect(engine.send).toHaveBeenCalledWith('Escalations per analyst', { origin: 'user' });
  });

  it('says a question-only answer once, in the card', () => {
    renderMessage({ item: assistantItem({ response: response({ answer: 'Trend of <b>what</b>?', clarify, steps: [] }) }) });
    expect(screen.getAllByText('Trend of <b>what</b>?')).toHaveLength(1);
    expect(within(screen.getByTestId('clarify-card')).getByText('Trend of <b>what</b>?')).toBeInTheDocument();
  });

  it('keeps only the question on an older turn and disables the chips while busy', () => {
    const { unmount } = renderMessage({ latest: false, item: assistantItem({ response: response({ answer: 'Which?', clarify, steps: [] }) }) });
    expect(screen.queryByTestId('clarify-card')).toBeNull();
    expect(screen.getByTestId('clarify-asked')).toHaveTextContent('Asked: Trend of <b>what</b>?');
    unmount();
    renderMessage({
      engine: stubEngine({ busy: true, conversationId: CONV }),
      item: assistantItem({ response: response({ answer: 'Which?', clarify, steps: [] }) }),
    });
    expect(screen.getByRole('button', { name: 'Alerts' })).toBeDisabled();
  });
});

describe('clarify announcement', () => {
  it('announces a settled clarify question as needing input, not "Answer ready"', () => {
    const running = runningItem();
    const { rerender } = renderHook(
      ({ items, run }: { items: ChatAssistantItem[]; run: ChatAssistantItem | null }) => useTurnAnnouncer({ items, running: run }),
      { initialProps: { items: [running], run: running } },
    );
    expect(mocks.announce).toHaveBeenLastCalledWith('Working');
    const settled: ChatAssistantItem = {
      ...running,
      status: 'done',
      live: null,
      response: response({ clarify: { question: 'Which?', options: ['A'], allow_custom: true } }),
    };
    rerender({ items: [settled], run: null });
    expect(mocks.announce).toHaveBeenLastCalledWith(NEEDS_INPUT_ANNOUNCEMENT);
    expect(mocks.announce).not.toHaveBeenCalledWith('Answer ready');
  });
});

describe('zero-result chips', () => {
  it('reads the suggestions of a zero-match lookup and sends a follow-up, never removing a follow-up already shown', async () => {
    let release: (value: typeof OBSERVATION) => void = () => undefined;
    mocks.getStepObservation.mockReturnValue(new Promise((resolve) => {
      release = resolve;
    }));
    const { engine } = renderMessage({
      item: assistantItem({
        response: response({
          answer: 'No critical false positive case matched this week.',
          steps: [zeroStep()],
          follow_ups: ['Show the same for all time', 'Compare with last month'],
        }),
      }),
    });
    const article = screen.getByRole('article');
    const followUps = screen.getByRole('group', { name: 'Suggested follow-ups' });
    const before = Array.from(article.children);
    const shown = within(followUps).getAllByRole('button').map((b) => b.textContent);
    expect(shown).toEqual(['Show the same for all time', 'Compare with last month']);
    // The suggestions arrive after the answer rendered.
    await act(async () => {
      release(OBSERVATION);
    });
    const group = await screen.findByRole('group', { name: 'Ways to widen the search' });
    expect(mocks.getStepObservation).toHaveBeenCalledWith(CONV, 'm-assistant-1', 2);
    expect(group).toHaveTextContent(/^Widen the search:/);
    // Nothing on screen moved or disappeared: the chips were APPENDED last, in the SAME
    // row as the follow-ups (Round 13 §4.2).
    expect(Array.from(article.children).slice(0, before.length)).toEqual(before);
    const row = screen.getByTestId('answer-suggestions');
    expect(article.lastElementChild).toBe(row);
    expect(row.firstElementChild).toBe(followUps);
    expect(row.lastElementChild).toBe(group);
    expect(within(followUps).getAllByRole('button').map((b) => b.textContent)).toEqual(shown);
    // The chip a follow-up already offers is the one left out.
    expect(within(group).queryByRole('button', { name: 'All time' })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Without the verdict filter' }));
    expect(engine.send).toHaveBeenCalledWith('Show the same without the verdict filter', { origin: 'follow_up' });
  });

  it('reads "Widen the search:" whether or not another lookup returned data, as ghost chips', async () => {
    renderMessage({ item: assistantItem({ response: response({ steps: [step(1, { rows: 12 }), zeroStep()] }) }) });
    const group = await screen.findByRole('group', { name: 'Ways to widen the search' });
    expect(group).toHaveTextContent(/^Widen the search:/);
    for (const chip of within(group).getAllByRole('button')) {
      expect(chip).not.toHaveClass('border');
      expect(chip).toHaveClass('rounded-sm', 'hover:bg-hover');
    }
  });

  it('keeps the zero-result chips when the viewer turned suggested follow-ups off', async () => {
    prefsRef.current = { misc: { chat_suggest_follow_ups: false } };
    renderMessage({
      item: assistantItem({ response: response({ steps: [zeroStep()], follow_ups: ['Compare with last month'] }) }),
    });
    expect(screen.queryByRole('group', { name: 'Suggested follow-ups' })).toBeNull();
    expect(await screen.findByRole('group', { name: 'Ways to widen the search' })).toBeInTheDocument();
  });

  it('reads nothing for an older turn, a case chat or an unsaved answer', async () => {
    renderMessage({ latest: false, item: assistantItem({ response: response({ steps: [zeroStep()] }) }) });
    renderMessage({ compact: true, item: assistantItem({ response: response({ steps: [zeroStep()] }) }) });
    renderMessage({ engine: stubEngine(), item: assistantItem({ response: response({ steps: [zeroStep()] }) }) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getStepObservation).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Ways to widen the search' })).toBeNull();
  });
});

describe('limits, notes and notices (Round 12)', () => {
  it('shows quiet notes for a continued and summarised answer, and the compaction line', () => {
    renderMessage({
      item: assistantItem({
        response: response({
          continued: 1,
          compacted: true,
          notice: { kind: 'compacted', message: 'Earlier messages were summarised to keep going.', retryable: false },
          steps: [
            { ...step(1), kind: 'model', tool: null, label: 'Summarised earlier messages', query: null },
            step(2),
            { ...step(3), kind: 'model', tool: null, label: 'Wrote the answer', query: null },
            { ...step(4), kind: 'model', tool: null, label: 'Continued the answer (part 2)', query: null },
          ],
        }),
      }),
    });
    // A quiet line, never a callout.
    expect(screen.queryByRole('note', { name: /summarised/ })).toBeNull();
    expect(screen.getByTestId('answer-compacted')).toHaveTextContent('Earlier messages were summarised to keep going');
    const disclosure = within(screen.getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ });
    fireEvent.click(disclosure);
    const log = document.getElementById(disclosure.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(log.querySelector('[data-run-note="compacted"]')).toHaveTextContent('Earlier messages were summarised to keep going');
    expect(log.querySelector('[data-run-note="continued"]')).toHaveTextContent('Continued the answer (part 2)');
    expect(screen.queryByText(/Partial/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
  });

  it('adds a "Stopped repeating" note and an info callout without repeating its title', () => {
    renderMessage({
      item: assistantItem({
        response: response({
          notice: {
            kind: 'stopped_repeating',
            message: 'Stopped repeating the same lookup; the answer uses the results gathered so far.',
            retryable: false,
          },
        }),
      }),
    });
    const note = screen.getByRole('note', { name: 'Stopped repeating the same lookup' });
    expect(note).toHaveTextContent('The answer uses the results gathered so far.');
    expect(document.querySelector('[data-run-note="repeat"]')).toHaveTextContent('Stopped repeating the same lookup');
    expect(screen.getByTestId('meta-row')).not.toHaveTextContent(/Partial/);
  });

  it('reads a limited answer as an answer, and an unsupported one names a page only when it resolved (D9)', () => {
    const { unmount } = renderMessage({
      item: assistantItem({
        response: response({
          answer_kind: 'data',
          notice: {
            kind: 'limited',
            message: 'Answered with what chat can read; part of the question is outside its lookups.',
            retryable: false,
          },
        }),
      }),
    });
    expect(screen.getByRole('note', { name: 'Answered with what chat can read' })).toHaveTextContent(
      'Part of the question is outside its lookups.',
    );
    unmount();
    renderMessage({
      item: assistantItem({
        response: response({
          answer: 'I cannot do that here.',
          steps: [],
          console_links: [],
          notice: { kind: 'unsupported', message: 'Chat cannot read that data. Use the linked console page instead.', retryable: false },
        }),
      }),
    });
    const note = screen.getByRole('note', { name: 'Not something this assistant can do' });
    expect(note).toHaveTextContent('Chat has no lookup for this data yet.');
    expect(note).not.toHaveTextContent(/linked console page/);
  });

  it('calls a chat-cap cut a warning, never a failure or a pause (D5)', () => {
    renderMessage({
      item: assistantItem({
        response: response({
          notice: { kind: 'budget', message: 'Today’s chat spending limit was reached, so this answer stops here.', retryable: false },
        }),
      }),
    });
    const note = screen.getByRole('note', { name: 'Chat spending limit reached' });
    expect(note).toHaveTextContent('so this answer stops here');
    expect(screen.getByTestId('meta-row')).not.toHaveTextContent(/Failed/);
  });

  it('hides "Product help" when the answer read SOC data (D9)', () => {
    renderMessage({ item: assistantItem({ response: response({ answer_kind: 'product_help' }) }) });
    expect(screen.queryByText('Product help')).toBeNull();
  });

  it('marks the running turn busy and shows a long lookup’s progress', () => {
    renderMessage({
      item: runningItem({
        steps: [
          {
            index: 1,
            ordinal: 1,
            kind: 'tool',
            tool: 'case_stats',
            label: 'Counted cases',
            params: {},
            group: null,
            status: 'running',
            result: null,
            startedAt: 0,
            progress: { done: 42000, total: 118402, unit: 'cases' },
          },
        ],
      }),
    });
    expect(screen.getByRole('article')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('run-log-progress')).toHaveTextContent('Counted 42,000 of 118,402 cases…');
  });
});

describe('step inspector', () => {
  it('opens a lookup with its parameters and the stored observation as untrusted text', async () => {
    const user = userEvent.setup();
    const { engine } = renderMessage({
      item: assistantItem({ response: response({ steps: [zeroStep(2, { untrusted_params: { query: 'brute force' } })] }) }),
    });
    await user.click(within(screen.getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ }));
    const inspect = screen.getByRole('button', { name: 'Inspect step 2: Counted cases' });
    await user.click(inspect);
    const sheet = await screen.findByTestId('step-inspector');
    expect(within(sheet).getByText('Step 2: Counted cases')).toBeInTheDocument();
    expect(within(sheet).getByText('brute force')).toBeInTheDocument();
    expect(within(sheet).getByText('untrusted')).toBeInTheDocument();
    const observation = await within(sheet).findByTestId('step-inspector-observation');
    expect(observation).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(sheet.querySelector('img')).toBeNull();
    expect(within(sheet).getByText('Stored result · untrusted text')).toBeInTheDocument();
    // A successful lookup is explained, not retried.
    expect(within(sheet).queryByRole('button', { name: 'Retry step' })).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Explain this step' }));
    await waitFor(() => expect(engine.send).toHaveBeenCalledWith(
      'Explain step 2 (Counted cases) of your answer to “How many critical false positives this week?”: what it looked up, what it found and how it shaped the answer.',
      { origin: 'follow_up' },
    ));
  });

  it('retries a failed lookup as origin retry_step and returns focus to Inspect on close', async () => {
    const user = userEvent.setup();
    const { engine } = renderMessage({
      item: assistantItem({
        response: response({ steps: [step(1, { status: 'timeout', observation_ref: null, summary: 'The source timed out' })] }),
      }),
    });
    await user.click(within(screen.getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ }));
    const inspect = screen.getByRole('button', { name: 'Inspect step 1: Searched logs' });
    await user.click(inspect);
    const sheet = await screen.findByTestId('step-inspector');
    expect(within(sheet).getByText('No result was stored for this lookup.')).toBeInTheDocument();
    expect(mocks.getStepObservation).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(inspect).toHaveFocus());
    await user.click(inspect);
    await user.click(within(await screen.findByTestId('step-inspector')).getByRole('button', { name: 'Retry step' }));
    await waitFor(() =>
      expect(engine.send).toHaveBeenCalledWith(
        'Run step 1 (Searched logs) of your answer to “How many critical false positives this week?” again with the same inputs and update the answer.',
        { origin: 'retry_step' },
      ),
    );
  });

  it('opens on the step’s title, never on an action that sends a turn', async () => {
    const user = userEvent.setup();
    const { engine } = renderMessage({ item: assistantItem({ response: response({ steps: [zeroStep(2)] }) }) });
    await user.click(within(screen.getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ }));
    await user.click(screen.getByRole('button', { name: 'Inspect step 2: Counted cases' }));
    const sheet = await screen.findByTestId('step-inspector');
    await waitFor(() => expect(within(sheet).getByTestId('step-inspector-title')).toHaveFocus());
    // A second Enter on the title sends nothing.
    await user.keyboard('{Enter}');
    expect(engine.send).not.toHaveBeenCalled();
  });

  it('shows an input sent as untrusted once, not also as a plain value', async () => {
    const user = userEvent.setup();
    renderMessage({
      item: assistantItem({
        response: response({ steps: [zeroStep(2, { params: { text: 'brute force', window: 'this_week' }, untrusted_params: { text: 'brute force' } })] }),
      }),
    });
    await user.click(within(screen.getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ }));
    await user.click(screen.getByRole('button', { name: 'Inspect step 2: Counted cases' }));
    const sheet = await screen.findByTestId('step-inspector');
    expect(within(sheet).getAllByText('brute force')).toHaveLength(1);
    expect(within(sheet).getAllByText('untrusted')).toHaveLength(1);
  });

  it('writes invisible and bidi characters as escapes and never says the model saw a cut copy', async () => {
    mocks.getStepObservation.mockResolvedValue({
      ...OBSERVATION,
      observation: { file: 'evil\u202etxt.exe', user: 'admin\u200b', rows: 'x'.repeat(400) },
      truncated: true,
    });
    const user = userEvent.setup();
    renderMessage({ item: assistantItem({ response: response({ steps: [zeroStep(2, { rows: 4 })] }) }) });
    await user.click(within(screen.getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ }));
    await user.click(screen.getByRole('button', { name: 'Inspect step 2: Counted cases' }));
    const sheet = await screen.findByTestId('step-inspector');
    const observation = await within(sheet).findByTestId('step-inspector-observation');
    const text = observation.textContent ?? '';
    expect(text).toContain('evil\\u202etxt.exe');
    expect(text).toContain('admin\\u200b');
    expect(text).not.toMatch(/[\u200b\u202e]/u);
    expect(within(sheet).getByTestId('step-inspector-truncated')).toHaveTextContent(
      'Shortened to fit storage. The model saw the full result; this copy is cut.',
    );
    expect(within(sheet).getByTestId('step-inspector-tokens')).toHaveTextContent(/stored copy is ≈ .* tokens; the result the model read was larger/);
    expect(sheet).not.toHaveTextContent(/added ≈/);
  });

  it('shows what was sent exactly: lookalike characters of an input and the query are escapes, as in the stored result (P1-1)', async () => {
    mocks.getStepObservation.mockResolvedValue({ ...OBSERVATION, observation: { user: 'admin​', total: 0 } });
    const user = userEvent.setup();
    renderMessage({
      item: assistantItem({
        response: response({
          steps: [
            zeroStep(2, {
              // The backend form (an ASCII escape), and a raw character (escaped here too).
              untrusted_params: { user: 'admin\\u200b', host: 'evil‮txt.exe' },
              query: 'user.name:"admin​"',
            }),
          ],
        }),
      }),
    });
    await user.click(within(screen.getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ }));
    await user.click(screen.getByRole('button', { name: 'Inspect step 2: Counted cases' }));
    const sheet = await screen.findByTestId('step-inspector');
    expect(within(sheet).getAllByTestId('step-inspector-untrusted').map((node) => node.textContent)).toEqual([
      'admin\\u200b',
      'evil\\u202etxt.exe',
    ]);
    expect(within(sheet).getByTestId('step-inspector-query')).toHaveTextContent('user.name:"admin\\u200b"');
    const observation = await within(sheet).findByTestId('step-inspector-observation');
    // Both halves of the panel agree: the model saw the same escape.
    expect(observation.textContent).toContain('admin\\u200b');
    expect(sheet.textContent ?? '').not.toMatch(/[​‮]/u);
  });

  it('names the answer in an Explain request, so two answers with the same step number differ', async () => {
    const user = userEvent.setup();
    const engine = stubEngine({ conversationId: CONV });
    render(
      <TooltipProvider>
        <Message latest={false} headingId="h-old" engine={engine} question="Cases this week?" item={assistantItem({ key: 'a-old', response: response({ steps: [zeroStep(2)] }) })} />
        <Message latest headingId="h-new" engine={engine} question="Cases last week?" item={assistantItem({ key: 'a-new', response: response({ steps: [zeroStep(2)] }) })} />
      </TooltipProvider>,
    );
    const asked: string[] = [];
    for (const article of screen.getAllByRole('article')) {
      await user.click(within(within(article).getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ }));
      await user.click(within(article).getByRole('button', { name: 'Inspect step 2: Counted cases' }));
      const sheet = await screen.findByTestId('step-inspector');
      await user.click(within(sheet).getByRole('button', { name: 'Explain this step' }));
      await waitFor(() => expect(engine.send).toHaveBeenCalledTimes(asked.length + 1));
      asked.push(engine.send.mock.calls[asked.length][0] as string);
      await waitFor(() => expect(screen.queryByTestId('step-inspector')).toBeNull());
    }
    expect(asked[0]).toContain('“Cases this week?”');
    expect(asked[1]).toContain('“Cases last week?”');
    expect(asked[0]).not.toBe(asked[1]);
  });

  it('names which of several answers to the identical question a step belongs to (Ask again, repeated chips)', async () => {
    const user = userEvent.setup();
    const question = 'How many cases are open?';
    const engine = {
      ...stubEngine({ conversationId: CONV }),
      items: [
        userItem(question),
        assistantItem({ key: 'a-1', response: response({ steps: [zeroStep(2)] }) }),
        userItem('Something else'),
        assistantItem({ key: 'a-2', response: response({ steps: [zeroStep(2)] }) }),
        // "Ask again" resends the same prompt.
        userItem(question),
        assistantItem({ key: 'a-3', response: response({ steps: [zeroStep(2)] }) }),
      ],
    };
    render(
      <TooltipProvider>
        <Transcript engine={engine} />
      </TooltipProvider>,
    );
    const asked: string[] = [];
    for (const row of screen.getAllByTestId('meta-row')) {
      const article = row.closest('article') as HTMLElement;
      await user.click(within(row).getByRole('button', { name: /1 lookup/ }));
      await user.click(within(article).getByRole('button', { name: 'Inspect step 2: Counted cases' }));
      const sheet = await screen.findByTestId('step-inspector');
      await user.click(within(sheet).getByRole('button', { name: 'Explain this step' }));
      await waitFor(() => expect(engine.send).toHaveBeenCalledTimes(asked.length + 1));
      asked.push(engine.send.mock.calls[asked.length][0] as string);
      await waitFor(() => expect(screen.queryByTestId('step-inspector')).toBeNull());
    }
    expect(asked).toEqual([
      'Explain step 2 (Counted cases) of your second most recent answer to “How many cases are open?”: what it looked up, what it found and how it shaped the answer.',
      'Explain step 2 (Counted cases) of your answer to “Something else”: what it looked up, what it found and how it shaped the answer.',
      'Explain step 2 (Counted cases) of your latest answer to “How many cases are open?”: what it looked up, what it found and how it shaped the answer.',
    ]);
    expect(new Set(asked).size).toBe(3);
  });

  it('says why an expired observation cannot be shown', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.getStepObservation.mockRejectedValue(new ApiError(404, 'gone', { detail: { code: 'step_observation_expired' } }));
    const user = userEvent.setup();
    renderMessage({ item: assistantItem({ response: response({ steps: [zeroStep(2, { rows: 4 })] }) }) });
    await user.click(within(screen.getByTestId('meta-row')).getByRole('button', { name: /1 lookup/ }));
    await user.click(screen.getByRole('button', { name: 'Inspect step 2: Counted cases' }));
    const sheet = await screen.findByTestId('step-inspector');
    expect(await within(sheet).findByText(/no longer stored/)).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('feedback', () => {
  it('rates up at once and announces only after the server saved it', async () => {
    const user = userEvent.setup();
    renderMessage({ item: assistantItem() });
    const group = screen.getByRole('radiogroup', { name: 'Rate this answer' });
    const up = within(group).getByRole('radio', { name: 'Good answer' });
    expect(up).toHaveAttribute('aria-checked', 'false');
    await user.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-checked', 'true'));
    expect(mocks.postChatFeedback).toHaveBeenCalledWith({
      conversation_id: CONV,
      message_id: 'm-assistant-1',
      rating: 'up',
      reason: null,
      comment: '',
    });
    expect(mocks.announce).toHaveBeenCalledWith('Thanks. Your feedback was saved.');
  });

  it('is one single-choice group: one tab stop, arrows move, a checked thumb stays checked and sends nothing', async () => {
    const user = userEvent.setup();
    renderMessage({ item: assistantItem() });
    const up = screen.getByRole('radio', { name: 'Good answer' });
    const down = screen.getByRole('radio', { name: 'Bad answer' });
    expect(up).toHaveAttribute('tabindex', '0');
    expect(down).toHaveAttribute('tabindex', '-1');
    act(() => up.focus());
    await user.keyboard('{ArrowRight}');
    expect(down).toHaveFocus();
    // Moving focus never rates.
    expect(mocks.postChatFeedback).not.toHaveBeenCalled();
    await user.keyboard('{ArrowLeft}');
    expect(up).toHaveFocus();
    await user.keyboard(' ');
    await waitFor(() => expect(up).toHaveAttribute('aria-checked', 'true'));
    expect(mocks.postChatFeedback).toHaveBeenCalledTimes(1);
    // Activating the checked thumb again is a no-op, as for any checked radio (a rating
    // cannot be withdrawn): no request, still checked, nothing toggles.
    await user.click(up);
    expect(mocks.postChatFeedback).toHaveBeenCalledTimes(1);
    expect(up).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: 'Good answer' })).toBeNull();
  });

  it('opens the reason panel after a thumbs down, sends the reason and comment, and returns focus', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
    try {
      const user = userEvent.setup();
      renderMessage({ item: assistantItem() });
      const down = screen.getByRole('radio', { name: 'Bad answer' });
      await user.click(down);
      const panel = await screen.findByTestId('feedback-panel');
      // The whole panel is scrolled clear of the transcript's bottom band before focus moves.
      expect(scrolled).toContain(panel);
      expect(panel.className).toContain('scroll-mb-24');
      expect(within(panel).getByRole('button', { name: 'Wrong' })).toHaveFocus();
      expect(panel).toHaveTextContent('never used to train a model');
      const details = screen.getByRole('button', { name: 'Add details' });
      expect(details).toHaveAttribute('aria-expanded', 'true');
      expect(details).toHaveAttribute('aria-controls', panel.id);
      await user.click(within(panel).getByRole('button', { name: 'Incomplete' }));
      expect(within(panel).getByRole('button', { name: 'Incomplete' })).toHaveAttribute('aria-pressed', 'true');
      await user.type(within(panel).getByRole('textbox'), 'Missed last week');
      await user.click(within(panel).getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(screen.queryByTestId('feedback-panel')).toBeNull());
      expect(mocks.postChatFeedback).toHaveBeenLastCalledWith({
        conversation_id: CONV,
        message_id: 'm-assistant-1',
        rating: 'down',
        reason: 'incomplete',
        comment: 'Missed last week',
      });
      expect(details).toHaveFocus();
      expect(details).toHaveAttribute('aria-expanded', 'false');
      expect(details).not.toHaveAttribute('aria-controls');
      expect(down).toHaveAttribute('aria-checked', 'true');
      // The checked thumbs-down is a radio, not a disclosure: it does not reopen the panel.
      await user.click(down);
      expect(screen.queryByTestId('feedback-panel')).toBeNull();
      // "Add details" does, and Escape closes it back onto the disclosure.
      await user.click(details);
      expect(await screen.findByTestId('feedback-panel')).toBeInTheDocument();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByTestId('feedback-panel')).toBeNull());
      expect(details).toHaveFocus();
      expect(mocks.postChatFeedback).toHaveBeenCalledTimes(2);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('shows the stored rating of a reopened conversation and keeps the old state when a save fails', async () => {
    mocks.listChatFeedback.mockResolvedValue([
      { conversation_id: CONV, message_id: 'm-assistant-1', rating: 'down', reason: 'slow', comment: '', updated_at: '' },
    ]);
    mocks.postChatFeedback.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderMessage({ item: assistantItem({ restored: true }) });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Bad answer' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('radio', { name: 'Bad answer' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Add details' })).toHaveAttribute('aria-expanded', 'false');
    expect(mocks.listChatFeedback).toHaveBeenCalledWith(CONV);
    await user.click(screen.getByRole('radio', { name: 'Good answer' }));
    await waitFor(() => expect(mocks.announce).toHaveBeenCalledWith('Feedback could not be saved. Try again.'));
    expect(screen.getByRole('radio', { name: 'Good answer' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Bad answer' })).toHaveAttribute('aria-checked', 'true');
  });

  it('offers no feedback on a case chat answer or an unsaved one', () => {
    renderMessage({ compact: true, item: assistantItem() });
    renderMessage({ engine: stubEngine(), item: assistantItem() });
    expect(screen.queryByRole('radio', { name: 'Good answer' })).toBeNull();
  });
});

describe('saved report line', () => {
  it('names the report the server saved, opens it and offers its export menu', async () => {
    const user = userEvent.setup();
    renderMessage({
      item: assistantItem({
        response: response({ saved_report: { id: 'rpt-1', title: 'September 2026 SOC report', items: 9, skipped: 2 } }),
      }),
    });
    const line = screen.getByTestId('saved-report-line');
    // One line says it (Round 13 T29): "Saved to Reports: {title} · Open · Export".
    expect(line).toHaveTextContent(/^Saved to Reports: September 2026 SOC report·2 sections did not fit·Open/);
    expect(within(line).getByRole('button', { name: 'Open September 2026 SOC report in Reports' })).toBeInTheDocument();
    expect(within(line).getByRole('button', { name: 'Export September 2026 SOC report' })).toBeInTheDocument();
    await user.click(within(line).getByRole('button', { name: /^Open/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('reports', { reportId: 'rpt-1' });
    await user.click(within(line).getByTestId('saved-report-export'));
    expect(await screen.findByRole('menuitem', { name: /Markdown/ })).toBeInTheDocument();
  });

  it('says why a report was not saved and saves the requested report once, through the server, on request', async () => {
    mocks.saveAnswerAsReport.mockResolvedValue({ id: 'rpt-new', title: 'September SOC report', items: 3, skipped: 0 });
    const user = userEvent.setup();
    renderMessage({
      item: assistantItem({
        response: response({
          saved_report_error: { code: 'report_unavailable', message: 'The report could not be saved right now.', retryable: true },
        }),
      }),
    });
    const line = screen.getByTestId('report-save-error');
    expect(line).toHaveTextContent('The report could not be saved right now.');
    await user.click(within(line).getByRole('button', { name: 'Save as report' }));
    // One idempotent server call by reference (the server reads the requested title and
    // template from the stored answer and records the saved report on it).
    expect(mocks.saveAnswerAsReport).toHaveBeenCalledWith(CONV, 'm-assistant-1');
    expect(mocks.createReport).not.toHaveBeenCalled();
    expect(mocks.addToReport).not.toHaveBeenCalled();
    const saved = await screen.findByTestId('saved-report-line');
    expect(saved).toHaveTextContent('September SOC report');
    // The pressed button was replaced: focus moves to the new line's Open, not <body>.
    await waitFor(() => expect(within(saved).getByRole('button', { name: /^Open/ })).toHaveFocus());
    expect(mocks.announce).toHaveBeenCalledWith('Saved to Reports: September SOC report');
  });

  it('a reopened answer whose report was saved shows the saved line, never the offer again', () => {
    // After "Save as report" the server records saved_report on the stored answer and
    // drops saved_report_error, so a reload restores the line, not the button.
    renderMessage({
      item: assistantItem({
        restored: true,
        response: response({ saved_report: { id: 'rpt-new', title: 'September SOC report', items: 3, skipped: 0 }, saved_report_error: null }),
      }),
    });
    expect(screen.getByTestId('saved-report-line')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save as report' })).toBeNull();
  });

  it('keeps the offer and says why when the save fails', async () => {
    const { ApiError } = await import('@/lib/api');
    mocks.saveAnswerAsReport.mockRejectedValue(new ApiError(409, 'full', { detail: { code: 'report_limit' } }));
    const user = userEvent.setup();
    renderMessage({
      item: assistantItem({
        response: response({ saved_report_error: { code: 'report_unavailable', message: 'Not saved.', retryable: true } }),
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Save as report' }));
    await waitFor(() =>
      expect(mocks.announce).toHaveBeenCalledWith('Reports is full. Delete a report in Reports, then save this answer again.'),
    );
    expect(screen.getByTestId('report-save-error')).toBeInTheDocument();
    expect(mocks.deleteReport).not.toHaveBeenCalled();
  });

  it('offers no save when the same save cannot work (a full library)', () => {
    renderMessage({
      item: assistantItem({
        response: response({ saved_report_error: { code: 'report_limit', message: 'Your report library is full.', retryable: false } }),
      }),
    });
    expect(screen.getByTestId('report-save-error')).toHaveTextContent('Your report library is full.');
    expect(screen.queryByRole('button', { name: 'Save as report' })).toBeNull();
  });

  it('never shows the line in case chat', () => {
    renderMessage({ compact: true, item: assistantItem({ response: response({ saved_report: { id: 'rpt-1', title: 'x', items: 1 } }) }) });
    expect(screen.queryByTestId('saved-report-line')).toBeNull();
  });
});

describe('add to case', () => {
  it('previews the snapshot, posts it as the analyst’s comment after a pick, and never posts by itself', async () => {
    mocks.searchCasesForPicker.mockResolvedValue([
      { case_id: 'case-1', display_id: 'SOC-0001', title: 'Brute force on vpn', status: 'escalated', severity: null },
    ]);
    mocks.postCaseComment.mockResolvedValue({ id: 'msg-1' });
    const user = userEvent.setup();
    renderMessage({ item: assistantItem({ response: response({ answer: 'Ask @soc-lead about **10.0.0.5**.' }) }) });
    const open = await openAddToCase(user);
    const dialog = await screen.findByRole('dialog', { name: 'Add this answer to a case' });
    const preview = within(dialog).getByTestId('add-to-case-preview');
    expect(preview).toHaveTextContent('Question: How many critical false positives this week?');
    // Plain text, as the case thread shows a human comment: no Markdown syntax.
    expect(preview).toHaveTextContent('Ask ＠soc-lead about 10.0.0.5.');
    expect(preview.textContent).not.toContain('**');
    const post = within(dialog).getByRole('button', { name: 'Post comment' });
    expect(post).toBeDisabled();
    await user.click(await within(dialog).findByRole('radio', { name: /SOC-0001/ }));
    expect(mocks.postCaseComment).not.toHaveBeenCalled();
    await user.click(post);
    await waitFor(() => expect(mocks.postCaseComment).toHaveBeenCalledTimes(1));
    const [caseId, body] = mocks.postCaseComment.mock.calls[0];
    expect(caseId).toBe('case-1');
    expect(body).toMatch(/^From Workspace chat · /);
    // The preview is exactly what is posted.
    expect(body).toBe(preview.textContent);
    expect(body).not.toMatch(/(^|[^\w@])@soc-lead/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.announce).toHaveBeenCalledWith('Added to case SOC-0001');
    await waitFor(() => expect(open).toHaveFocus());
  });

  it('keeps a cited [D1] resolvable with a Sources list, drops an uncited marker, and says only blocks stay in chat', async () => {
    mocks.searchCasesForPicker.mockResolvedValue([]);
    const user = userEvent.setup();
    renderMessage({
      item: assistantItem({
        response: response({
          answer: 'Five failed logins came from **10.0.0.5** [D1] [Q9].\n\n| Host | Fails |\n| --- | --- |\n| vpn-1 | 5 |',
        }),
      }),
    });
    await openAddToCase(user);
    const dialog = await screen.findByRole('dialog', { name: 'Add this answer to a case' });
    const preview = within(dialog).getByTestId('add-to-case-preview');
    const text = preview.textContent ?? '';
    expect(text).toContain('Five failed logins came from 10.0.0.5 [D1].');
    expect(text).not.toContain('[Q9]');
    // A Markdown table in the answer is posted as rows of text…
    expect(text).toContain('Host · Fails\nvpn-1 · 5');
    expect(text.endsWith('Sources:\n[D1] Help Center · Failed logins')).toBe(true);
    // …so the note no longer claims tables stay in chat: only chart and table blocks do.
    expect(within(dialog).getByTestId('add-to-case-note')).toHaveTextContent(
      'Charts and table blocks stay in chat. Cited sources are listed at the end. Mentions in the answer do not notify anyone.',
    );
  });

  it('names each case status in the words the case badges use, never the stored key', async () => {
    mocks.searchCasesForPicker.mockResolvedValue([
      { case_id: 'case-1', display_id: 'SOC-0001', title: 'Loan API access', status: 'on_hold', severity: null },
      { case_id: 'case-2', display_id: 'SOC-0002', title: 'Phishing chain', status: 'needs_human', severity: null },
    ]);
    const user = userEvent.setup();
    renderMessage({ item: assistantItem() });
    await openAddToCase(user);
    const dialog = await screen.findByRole('dialog', { name: 'Add this answer to a case' });
    const first = await within(dialog).findByRole('radio', { name: 'SOC-0001: Loan API access (On hold)' });
    expect(first).toHaveTextContent('On hold');
    const second = within(dialog).getByRole('radio', { name: 'SOC-0002: Phishing chain (Open · awaiting analyst)' });
    expect(second).toHaveTextContent('Open · awaiting analyst');
    expect(dialog.textContent).not.toMatch(/on_hold|needs_human/);
  });

  it('picks one case from a single-choice group with one tab stop, wrapped titles and a result count', async () => {
    const entries = ['a1', 'b2', 'c3'].map((suffix, i) => ({
      case_id: `case-${suffix}`,
      display_id: `case-99918b23015c43639fe2ed0b81920a${suffix}`,
      title: `ip:203.0.113.77 brute force against the VPN gateway from a shared prefix ${i}`,
      status: 'escalated',
      severity: null,
    }));
    mocks.searchCasesForPicker.mockResolvedValue(entries);
    const user = userEvent.setup();
    renderMessage({ item: assistantItem() });
    await openAddToCase(user);
    const dialog = await screen.findByRole('dialog', { name: 'Add this answer to a case' });
    const group = await within(dialog).findByRole('radiogroup', { name: 'Matching cases' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('3 cases');
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    // Titles wrap (two lines) instead of being cut on one line.
    const title = within(radios[0]).getByText(/ip:203\.0\.113\.77/);
    expect(title.className).toContain('line-clamp-2');
    expect(title.className).not.toContain('truncate');
    // Arrows move and pick; the tab stop follows the pick.
    act(() => radios[0].focus());
    await user.keyboard('{ArrowDown}');
    expect(radios[1]).toHaveFocus();
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('tabindex', '0');
    expect(radios[0]).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{End}');
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}');
    expect(radios[0]).toHaveFocus();
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(within(dialog).getByRole('button', { name: 'Post comment' })).toBeEnabled();
    // A search with no match says so in the status line.
    mocks.searchCasesForPicker.mockResolvedValue([]);
    await user.type(within(dialog).getByRole('searchbox'), 'nothing');
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('No case matches that search.'));
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();
  });

  it('quotes the clarified question plus the pick for an answer to a clarify pick', async () => {
    mocks.searchCasesForPicker.mockResolvedValue([]);
    const user = userEvent.setup();
    const clarify = { question: 'Trend of what?', options: ['Alerts', 'Cases'], allow_custom: true };
    const engine = {
      ...stubEngine({ conversationId: CONV }),
      items: [
        userItem('Show me the trend'),
        assistantItem({ key: 'a-clarify', response: response({ answer: 'Trend of what?', clarify, steps: [] }) }),
        userItem('Cases', { origin: 'clarify' }),
        assistantItem({ key: 'a-pick', response: response({ answer: 'Cases rose 20% this week.', citations: [], steps: [zeroStep(2)] }) }),
      ],
    };
    render(
      <TooltipProvider>
        <Transcript engine={engine} />
      </TooltipProvider>,
    );
    const answer = screen.getByText('Cases rose 20% this week.').closest('article') as HTMLElement;
    await openAddToCase(user, answer);
    const dialog = await screen.findByRole('dialog', { name: 'Add this answer to a case' });
    const preview = within(dialog).getByTestId('add-to-case-preview');
    expect(preview.textContent).toMatch(/^From Workspace chat · .*\nQuestion: Show me the trend → Cases\n\nCases rose 20% this week\.$/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // A step question still quotes the question exactly as sent: the model and the Demo
    // planner find the answer by matching it against the conversation.
    await user.click(within(answer).getByRole('button', { name: /1 lookup/ }));
    await user.click(within(answer).getByRole('button', { name: 'Inspect step 2: Counted cases' }));
    const sheet = await screen.findByTestId('step-inspector');
    await user.click(within(sheet).getByRole('button', { name: 'Explain this step' }));
    await waitFor(() => expect(engine.send).toHaveBeenCalledTimes(1));
    expect(engine.send.mock.calls[0][0]).toBe(
      'Explain step 2 (Counted cases) of your answer to “Cases”: what it looked up, what it found and how it shaped the answer.',
    );
  });

  it('is offered only with cases:comment on a saved Workspace answer', async () => {
    const user = userEvent.setup();
    mocks.hasPermission.mockReturnValue(false);
    const { unmount } = renderMessage({ item: assistantItem() });
    await user.click(screen.getByTestId('answer-more-actions'));
    expect(within(await screen.findByRole('menu')).queryByRole('menuitem', { name: /Add to case/ })).toBeNull();
    await user.keyboard('{Escape}');
    unmount();
    mocks.hasPermission.mockReturnValue(true);
    renderMessage({ compact: true, item: assistantItem() });
    await user.click(screen.getByTestId('answer-more-actions'));
    expect(within(await screen.findByRole('menu')).queryByRole('menuitem', { name: /Add to case/ })).toBeNull();
  });
});

describe('long answers', () => {
  const longAnswer = ['## Summary', 'a', '## Findings', 'b', '## Timeline', 'c', '## Next steps', 'd'].join('\n\n');

  it('adds contents for four headings and jumps to a heading and to the end', async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    renderMessage({ item: assistantItem({ response: response({ answer: longAnswer }) }) });
    const contents = await screen.findByRole('group', { name: 'Answer contents' });
    const entries = within(contents).getAllByRole('button');
    expect(entries.map((b) => b.textContent)).toEqual(['Summary', 'Findings', 'Timeline', 'Next steps', 'Jump to end']);
    await user.click(within(contents).getByRole('button', { name: 'Timeline' }));
    expect(screen.getByRole('heading', { name: 'Timeline' })).toHaveFocus();
    await user.click(within(contents).getByRole('button', { name: 'Jump to end' }));
    const end = screen.getByTestId('answer-end');
    expect(end).toHaveFocus();
    expect(end).toHaveTextContent('End of answer');
    expect(scrolled.length).toBe(2);
    expect(scrolled[1]).toBe(end);
  });

  it('lands the end marker where the answer ends: in flow, never an absolutely positioned sr-only box', () => {
    renderMessage({ item: assistantItem({ response: response({ answer: longAnswer }) }) });
    const end = screen.getByTestId('answer-end');
    // `sr-only` is position:absolute; in the answer's grid its static position is the
    // article's first line, so scrolling it into view went to the TOP of the answer.
    expect(end.className).not.toMatch(/(^|\s)sr-only(\s|$)/);
    expect(end.className).not.toMatch(/(^|\s)(absolute|fixed)(\s|$)/);
    expect(end.className).toContain('scroll-mb-24');
    // Only its words are for screen readers.
    expect(end.querySelector('.sr-only')).toHaveTextContent('End of answer');
    // It is the article's last flow element before the meta column.
    const meta = screen.getByTestId('meta-row').closest('article > *');
    expect(meta?.previousElementSibling).toBe(end);
  });

  it('jumps to the entry’s own heading when the answer has an empty heading', async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    const withEmpty = ['## ', 'x', '## Alpha', 'a', '## Beta', 'b', '## Gamma', 'c', '## Delta', 'd'].join('\n\n');
    renderMessage({ item: assistantItem({ response: response({ answer: withEmpty }) }) });
    const contents = await screen.findByRole('group', { name: 'Answer contents' });
    const entries = within(contents).getAllByRole('button').map((b) => b.textContent);
    expect(entries).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Jump to end']);
    // The empty heading is rendered (so an unfiltered lookup would be off by one).
    expect(screen.getAllByRole('heading').filter((h) => /^H[456]$/.test(h.tagName))).toHaveLength(5);
    await user.click(within(contents).getByRole('button', { name: 'Alpha' }));
    expect(screen.getByRole('heading', { name: 'Alpha' })).toHaveFocus();
    await user.click(within(contents).getByRole('button', { name: 'Delta' }));
    expect(screen.getByRole('heading', { name: 'Delta' })).toHaveFocus();
  });

  it('offers nothing for a short answer with fewer headings', () => {
    renderMessage({ item: assistantItem({ response: response({ answer: '## One\n\ntext\n\n## Two' }) }) });
    expect(screen.queryByRole('group', { name: 'Answer contents' })).toBeNull();
  });

  it('copies the latest answer with Ctrl/⌘+Shift+C, and only the latest', async () => {
    const { unmount } = renderMessage({ item: assistantItem({ response: response({ answer: 'Latest answer' }) }) });
    expect(screen.getByRole('button', { name: 'Copy answer' })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+C Meta+Shift+C');
    fireEvent.keyDown(window, { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith('Latest answer'));
    expect(mocks.announce).toHaveBeenCalledWith('Copied the last answer');
    unmount();
    mocks.copyText.mockClear();
    renderMessage({ latest: false, item: assistantItem({ response: response({ answer: 'Older answer' }) }) });
    fireEvent.keyDown(window, { key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    expect(mocks.copyText).not.toHaveBeenCalled();
  });

  it('leaves Ctrl/⌘+Shift+C alone on Dvorak, during IME composition, on repeat and while a dialog owns the keyboard', async () => {
    renderMessage({ item: assistantItem({ response: response({ answer: 'Latest answer' }) }) });
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
      window.dispatchEvent(event);
      return event;
    };
    // Dvorak's physical C types "j": Ctrl+Shift+J is the browser's console/downloads.
    expect(press({ key: 'J', code: 'KeyC' }).defaultPrevented).toBe(false);
    expect(press({ key: 'C', code: 'KeyC', isComposing: true }).defaultPrevented).toBe(false);
    expect(press({ key: 'C', code: 'KeyC', repeat: true }).defaultPrevented).toBe(false);
    // A modal dialog or sheet (the step inspector, Add to case) owns the keyboard.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.appendChild(dialog);
    expect(press({ key: 'C', code: 'KeyC' }).defaultPrevented).toBe(false);
    dialog.remove();
    expect(mocks.copyText).not.toHaveBeenCalled();
    // With nothing in the way it copies.
    expect(press({ key: 'C', code: 'KeyC' }).defaultPrevented).toBe(true);
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith('Latest answer'));
  });
});

describe('narrow meta row menu', () => {
  it('keeps a full report’s "Add answer to report" reachable by keyboard, with its reason', async () => {
    const onToggleAnswer = vi.fn();
    const user = userEvent.setup();
    renderMessage({
      item: assistantItem(),
      report: {
        blocks: new Set(),
        answerInReport: false,
        canAdd: false,
        disabledReason: 'Report is full (60 items)',
        onToggleAnswer,
        onToggleBlock: vi.fn(),
      },
    });
    await user.click(screen.getByTestId('answer-more-actions-narrow'));
    const menu = await screen.findByRole('menu');
    const item = within(menu).getByTestId('more-actions-report');
    // Not Radix-disabled (roving focus would skip it and its reason): aria-disabled.
    expect(item).not.toHaveAttribute('data-disabled');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Report is full (60 items)');
    // Arrow keys reach it: Copy answer → Add answer to report.
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    expect(item).toHaveFocus();
    // Choosing it is answered with the reason by the binding (it refuses the add).
    await user.keyboard('{Enter}');
    expect(onToggleAnswer).toHaveBeenCalledTimes(1);
  });
});

describe('investigation brief (P1-3, #3)', () => {
  it('labels an investigation brief as advisory: the case decision is the policy’s', async () => {
    const brief = { ...(ROUND12_RAW[4] as Record<string, unknown>), id: 'brief-1', template: 'investigation_brief', layout: 'document' };
    const executive = { ...(ROUND12_RAW[4] as Record<string, unknown>), id: 'exec-1', template: 'executive', layout: 'document' };
    renderMessage({ item: assistantItem({ response: response({ blocks: [brief, executive] }) }) });
    // The blocks chunk is lazy: give its first import time on a busy machine.
    const labels = await screen.findAllByTestId('report-advisory', undefined, { timeout: 8000 });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toHaveTextContent('Advisory: the case decision is made by policy, not by this brief');
  });
});

describe('accessibility', () => {
  it('has no detectable violations with the clarify card, chips, feedback panel and saved report', async () => {
    const user = userEvent.setup();
    const { container } = renderMessage({
      item: assistantItem({
        response: response({
          answer: 'No case matched.',
          steps: [zeroStep()],
          clarify: { question: 'Which window?', options: ['This week', 'All time'], allow_custom: true },
          saved_report: { id: 'rpt-1', title: 'Lifetime', items: 3 },
        }),
      }),
    });
    await screen.findByRole('group', { name: 'Ways to widen the search' });
    await user.click(screen.getByRole('radio', { name: 'Bad answer' }));
    await screen.findByTestId('feedback-panel');
    expect(await axe(container)).toHaveNoViolations();
  });
});
