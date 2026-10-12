/**
 * Promptbooks run as consecutive turns (Round 12 SPEC §3.1, SYNTHESIS-chat P1-8): the
 * next step is sent only after the previous answer has finished, as the analyst's own
 * message (`origin: "user"`), with a step counter and Stop; a failed, stopped or
 * clarifying step — or a switch to another conversation — ends the book without sending
 * the rest. The book lives outside the composer (SPEC D13): leaving the chat page and
 * coming back keeps it, and the returning view carries on. The values card asks for
 * every placeholder before anything is sent.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ChatResponse } from '@/lib/types';
import { clearChatActivity } from '../../../chat-activity/activity';
import type { ChatEngine } from '../../useChatEngine';
import type { ChatTranscriptItem, TurnRun } from '../../turn-runner';
import { planPrompt, type LibraryPrompt } from '../prompt-library';
import { resetPromptbookForTests } from '../promptbook-store';
import { PromptParamsCard, PromptbookBar, usePromptbookRunner, type PromptbookRunnerOptions } from '../PromptRunner';

const runner = vi.hoisted(() => ({ runs: [] as unknown[], stopRun: vi.fn() }));
vi.mock('../../turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../turn-runner')>();
  return { ...actual, listRuns: () => runner.runs, stopRun: runner.stopRun };
});

expect.extend(toHaveNoViolations);

afterEach(() => {
  resetPromptbookForTests();
  runner.runs = [];
  runner.stopRun.mockReset();
});

/** A minimal engine whose busy/items/conversation the test drives between renders. */
function fakeEngine(over: Partial<ChatEngine> = {}): ChatEngine {
  return {
    items: [],
    running: null,
    busy: false,
    canStop: true,
    conversationId: 'c-1',
    persist: true,
    draft: '',
    setDraft: vi.fn(),
    model: null,
    setModel: vi.fn(),
    sourceId: null,
    setSourceId: vi.fn(),
    scopes: [],
    setScopes: vi.fn(),
    timeRange: null,
    setTimeRange: vi.fn(),
    historySize: { exchanges: 0, chars: 0 },
    streamMode: 'steps',
    effectiveStreamMode: 'steps',
    setStreamMode: vi.fn(),
    lastUserPrompt: null,
    send: vi.fn(() => true),
    stop: vi.fn(),
    retry: () => false,
    askAgain: () => false,
    continueAnswer: () => false,
    reset: vi.fn(),
    ...over,
  } as ChatEngine;
}

const userItem = (key: string, requestKey: string | null = null): ChatTranscriptItem =>
  ({ kind: 'user', key, messageId: null, content: 'q', prompt: 'q', origin: 'user', at: 0, requestKey, failed: false }) as unknown as ChatTranscriptItem;

const answerItem = (
  key: string,
  status: 'done' | 'error' | 'running',
  response: Partial<ChatResponse> | null = {},
  requestKey: string | null = null,
): ChatTranscriptItem =>
  ({
    kind: 'assistant',
    key,
    messageId: null,
    at: 0,
    requestKey,
    status,
    response: response === null ? null : ({ answer: 'ok', ...response } as ChatResponse),
    live: null,
    failure: null,
    restored: false,
    model: null,
    source: null,
    request: null,
  }) as ChatTranscriptItem;

/**
 * One exchange: the question and its answer, both carrying the turn's request key `kN`
 * (the same while it runs, settles, and after a reload restores it from the thread).
 */
const exchange = (n: number, status: 'done' | 'error' | 'running', response: Partial<ChatResponse> | null = {}) => [
  userItem(`u${n}`, `k${n}`),
  answerItem(`a${n}`, status, response, `k${n}`),
];

function setup(over: Partial<ChatEngine> = {}, options: PromptbookRunnerOptions = {}) {
  let engine = fakeEngine(over);
  let opts = options;
  const announce = vi.fn();
  const hook = renderHook(({ e, o }: { e: ChatEngine; o: PromptbookRunnerOptions }) => usePromptbookRunner(e, announce, o), {
    initialProps: { e: engine, o: opts },
  });
  const update = (patch: Partial<ChatEngine>, next: PromptbookRunnerOptions = opts) => {
    engine = { ...engine, ...patch };
    opts = next;
    hook.rerender({ e: engine, o: opts });
  };
  return { hook, announce, update, get engine() { return engine; } };
}

const STEPS = ['First {x}', 'Second', 'Third'];

describe('usePromptbookRunner', () => {
  it('sends each step after the previous answer finishes, then reports done', () => {
    const t = setup();
    act(() => {
      expect(t.hook.result.current.start('Weekly review', STEPS)).toBe(true);
    });
    expect(t.engine.send).toHaveBeenCalledTimes(1);
    expect(t.engine.send).toHaveBeenLastCalledWith('First {x}', { origin: 'user' });
    expect(t.hook.result.current.run).toMatchObject({ index: 0, status: 'running' });

    // The answer is being written: nothing more is sent.
    act(() => t.update({ busy: true, items: exchange(1, 'running') }));
    expect(t.engine.send).toHaveBeenCalledTimes(1);
    // It finished: step 2 goes out.
    act(() => t.update({ busy: false, items: exchange(1, 'done') }));
    expect(t.engine.send).toHaveBeenCalledTimes(2);
    expect(t.engine.send).toHaveBeenLastCalledWith('Second', { origin: 'user' });
    expect(t.hook.result.current.run?.index).toBe(1);

    act(() => t.update({ busy: true, items: [...exchange(1, 'done'), ...exchange(2, 'running')] }));
    act(() => t.update({ busy: false, items: [...exchange(1, 'done'), ...exchange(2, 'done')] }));
    expect(t.engine.send).toHaveBeenLastCalledWith('Third', { origin: 'user' });
    const two = [...exchange(1, 'done'), ...exchange(2, 'done')];
    act(() => t.update({ busy: true, items: [...two, ...exchange(3, 'running')] }));
    act(() => t.update({ busy: false, items: [...two, ...exchange(3, 'done')] }));
    expect(t.engine.send).toHaveBeenCalledTimes(3);
    expect(t.hook.result.current.run).toMatchObject({ status: 'done', note: 'Finished all 3 steps.' });
    expect(t.announce).toHaveBeenLastCalledWith('Weekly review: finished all 3 steps.');
    expect(t.hook.result.current.running).toBe(false);
  });

  it('refuses to start while an answer is being written', () => {
    const t = setup({ busy: true });
    act(() => {
      expect(t.hook.result.current.start('Book', STEPS)).toBe(false);
    });
    expect(t.engine.send).not.toHaveBeenCalled();
    expect(t.hook.result.current.run).toBeNull();
  });

  it('Stop stops the running answer and sends nothing more', () => {
    const t = setup();
    act(() => void t.hook.result.current.start('Book', STEPS));
    act(() => t.update({ busy: true, items: exchange(1, 'running') }));
    act(() => t.hook.result.current.stop());
    expect(t.engine.stop).toHaveBeenCalledTimes(1);
    expect(t.hook.result.current.run).toMatchObject({ status: 'stopped', note: 'Stopped at step 1 of 3.' });
    act(() => t.update({ busy: false, items: exchange(1, 'done', { notice: { kind: 'cancelled' } as ChatResponse['notice'] }) }));
    expect(t.engine.send).toHaveBeenCalledTimes(1);
  });

  it('stops when a step fails, is cancelled elsewhere, is refused, or asks a question', () => {
    const cases: Array<[ChatTranscriptItem[], RegExp]> = [
      [exchange(1, 'error', null), /Step 1 of 3 failed/],
      [exchange(1, 'done', { notice: { kind: 'cancelled' } as ChatResponse['notice'] }), /Stopped at step 1 of 3/],
      [exchange(1, 'done', { notice: { kind: 'budget' } as ChatResponse['notice'] }), /could not be answered/],
      [exchange(1, 'done', { clarify: { question: 'Which?', options: ['A'], allow_custom: true } }), /asked a question/],
      // The turn ended and its exchange is not in the thread (nothing was saved).
      [[], /did not finish/],
    ];
    for (const [items, note] of cases) {
      const t = setup();
      act(() => void t.hook.result.current.start('Book', STEPS));
      act(() => t.update({ busy: true, items: exchange(1, 'running') }));
      act(() => t.update({ busy: false, items }));
      expect(t.engine.send).toHaveBeenCalledTimes(1);
      expect(t.hook.result.current.run?.status).not.toBe('running');
      expect(t.hook.result.current.run?.note).toMatch(note);
      t.hook.unmount();
      resetPromptbookForTests();
    }
  });

  it('stops when the analyst switches to another conversation, and adopts a new thread id', () => {
    const t = setup({ conversationId: null });
    act(() => void t.hook.result.current.start('Book', STEPS));
    // The first answer saved the new thread: the book follows it.
    act(() => t.update({ busy: true, conversationId: 'c-new', items: exchange(1, 'running') }));
    act(() => t.update({ busy: false, items: exchange(1, 'done') }));
    expect(t.engine.send).toHaveBeenCalledTimes(2);
    act(() => t.update({ conversationId: 'c-other', items: [] }));
    expect(t.hook.result.current.run).toMatchObject({ status: 'stopped' });
    expect(t.hook.result.current.run?.note).toMatch(/you switched conversations/);
  });

  it('stops on New chat in the same view (a deliberate switch)', () => {
    const t = setup();
    act(() => void t.hook.result.current.start('Book', STEPS));
    act(() => t.update({ busy: true, items: exchange(1, 'running') }));
    act(() => t.update({ busy: false, conversationId: null, items: [] }));
    expect(t.hook.result.current.run?.note).toBe('Stopped at step 1 of 3: you switched conversations.');
  });

  it('never takes another thread’s answer for its own step (a new chat switched away early)', () => {
    const t = setup({ conversationId: null });
    act(() => void t.hook.result.current.start('Book', STEPS));
    act(() => t.update({ busy: true, items: exchange(1, 'running') }));
    // Another saved thread opens while step 1 runs: its settled answers are on screen.
    act(() => t.update({ busy: false, conversationId: 'c-other', items: [userItem('r1', 'r1'), answerItem('r2', 'done', {}, 'r1')] }));
    expect(t.engine.send).toHaveBeenCalledTimes(1);
    expect(t.hook.result.current.run).toMatchObject({ status: 'stopped' });
    expect(t.hook.result.current.run?.note).toMatch(/switched conversations/);
  });

  it('survives leaving the chat page: the returning view finds the step’s answer and carries on (SPEC D13)', () => {
    const first = setup();
    act(() => void first.hook.result.current.start('Triage a case', STEPS));
    act(() => first.update({ busy: true, items: exchange(1, 'running') }));
    // The analyst opens Cases: the composer unmounts, the turn goes on (detached).
    first.hook.unmount();

    // Back on Chat: the thread list and the thread load first (the host blocks sending).
    const back = setup({ conversationId: null, items: [] }, { hostBlocked: true });
    expect(back.hook.result.current.run).toMatchObject({ title: 'Triage a case', index: 0, status: 'running' });
    // The list settled on New chat before the thread opened: wait, never stop.
    act(() => back.update({}, { hostBlocked: false }));
    expect(back.hook.result.current.run?.status).toBe('running');
    // The thread opens with step 1's answer restored from the saved conversation.
    act(() => back.update({ conversationId: 'c-1', items: exchange(1, 'done') }));
    expect(back.engine.send).toHaveBeenCalledTimes(1);
    expect(back.engine.send).toHaveBeenLastCalledWith('Second', { origin: 'user' });
    expect(back.hook.result.current.run?.index).toBe(1);
    // …and keeps advancing in the new view.
    act(() => back.update({ busy: true, items: [...exchange(1, 'done'), ...exchange(2, 'running')] }));
    act(() => back.update({ busy: false, items: [...exchange(1, 'done'), ...exchange(2, 'done')] }));
    expect(back.engine.send).toHaveBeenLastCalledWith('Third', { origin: 'user' });
  });

  it('a step still running when the analyst comes back re-attaches and is followed to the end', () => {
    const first = setup();
    act(() => void first.hook.result.current.start('Book', STEPS));
    act(() => first.update({ busy: true, items: exchange(1, 'running') }));
    first.hook.unmount();
    const back = setup({ conversationId: 'c-1', busy: true, items: exchange(1, 'running') });
    expect(back.engine.send).not.toHaveBeenCalled();
    act(() => back.update({ busy: false, items: exchange(1, 'done') }));
    expect(back.engine.send).toHaveBeenCalledWith('Second', { origin: 'user' });
  });

  it('coming back to another conversation stops the book and says so', () => {
    const first = setup();
    act(() => void first.hook.result.current.start('Book', STEPS));
    act(() => first.update({ busy: true, items: exchange(1, 'running') }));
    first.hook.unmount();
    const back = setup({ conversationId: 'c-2', items: [userItem('x', 'x1')] });
    expect(back.engine.send).not.toHaveBeenCalled();
    expect(back.hook.result.current.run).toMatchObject({ status: 'stopped' });
    expect(back.hook.result.current.run?.note).toBe('Stopped at step 1 of 3: another conversation is open.');
  });

  it('Stop from a view without the step’s thread stops that turn through the runner', () => {
    const first = setup();
    act(() => void first.hook.result.current.start('Book', STEPS));
    act(() => first.update({ busy: true, items: exchange(1, 'running') }));
    first.hook.unmount();
    const turn = { requestKey: 'k1', state: 'running' } as unknown as TurnRun;
    runner.runs = [turn];
    const back = setup({ conversationId: null, items: [] });
    act(() => back.hook.result.current.stop());
    expect(back.engine.stop).not.toHaveBeenCalled();
    expect(runner.stopRun).toHaveBeenCalledWith(turn);
    expect(back.hook.result.current.run?.note).toBe('Stopped at step 1 of 3.');
  });

  it('learns the step’s request key from the runner at once (no render needed)', () => {
    const t = setup();
    runner.runs = [
      { id: 1, requestKey: 'old', request: { message: 'First {x}' } },
      { id: 7, requestKey: 'k1', request: { message: 'First {x}' } },
    ];
    // The view goes away before it ever renders the new turn.
    act(() => {
      t.hook.result.current.start('Book', STEPS);
      t.hook.unmount();
    });
    // Back on the thread with step 1 saved: no transcript diff was ever seen.
    const back = setup({ conversationId: 'c-1', items: exchange(1, 'done') });
    expect(back.engine.send).toHaveBeenCalledWith('Second', { origin: 'user' });
  });

  it('waits for the engine to draw a step it sent from an effect (the book’s render can come first)', () => {
    const t = setup();
    act(() => void t.hook.result.current.start('Book', STEPS));
    act(() => t.update({ busy: true, items: exchange(1, 'running') }));
    // Step 2's turn is registered in the runner the moment it is sent…
    runner.runs = [{ id: 2, requestKey: 'k2', request: { message: 'Second' }, state: 'running' }];
    // …but the render right after the send still shows the engine as it was (not busy,
    // no step 2 pair): that is never "step 2 did not finish".
    act(() => t.update({ busy: false, items: exchange(1, 'done') }));
    expect(t.engine.send).toHaveBeenLastCalledWith('Second', { origin: 'user' });
    act(() => t.update({}));
    expect(t.hook.result.current.run).toMatchObject({ status: 'running', index: 1 });
    // The engine's own render lands: step 2 runs, then finishes, and step 3 goes out.
    const one = exchange(1, 'done');
    act(() => t.update({ busy: true, items: [...one, ...exchange(2, 'running')] }));
    act(() => t.update({ busy: false, items: [...one, ...exchange(2, 'done')] }));
    expect(t.engine.send).toHaveBeenLastCalledWith('Third', { origin: 'user' });
  });

  it('belongs to Workspace chat only, and sign-out forgets it', () => {
    const caseView = setup({}, { enabled: false });
    act(() => {
      expect(caseView.hook.result.current.start('Book', STEPS)).toBe(false);
    });
    expect(caseView.engine.send).not.toHaveBeenCalled();
    caseView.hook.unmount();

    const t = setup();
    act(() => void t.hook.result.current.start('Book', STEPS));
    expect(t.hook.result.current.run).not.toBeNull();
    // The case composer never shows (or drives) a Workspace book.
    const other = setup({}, { enabled: false });
    expect(other.hook.result.current.run).toBeNull();
    expect(other.hook.result.current.running).toBe(false);
    act(() => clearChatActivity());
    expect(t.hook.result.current.run).toBeNull();
  });

  it('shows the step counter with Stop, then what happened on its own line, with Close', async () => {
    const t = setup();
    act(() => void t.hook.result.current.start('Triage a case', STEPS));
    const onClosed = vi.fn();
    const view = render(<PromptbookBar runner={t.hook.result.current} onClosed={onClosed} />);
    expect(screen.getByTestId('promptbook-bar')).toHaveTextContent('Triage a case · Step 1 of 3');
    expect(await axe(view.container)).toHaveNoViolations();
    const stop = screen.getByRole('button', { name: 'Stop' });
    stop.focus();
    fireEvent.click(stop);
    view.rerender(<PromptbookBar runner={t.hook.result.current} onClosed={onClosed} />);
    // The outcome wraps on its own line (never cut off at phone width)…
    const note = screen.getByTestId('promptbook-note');
    expect(note).toHaveTextContent('Stopped at step 1 of 3.');
    expect(note.className).not.toMatch(/truncate/);
    expect(note.className).toMatch(/break-words/);
    // …and focus stays where it was: Stop became Close (the same button).
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toBe(stop);
    expect(close).toHaveFocus();
    fireEvent.click(close);
    expect(t.hook.result.current.run).toBeNull();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});

describe('PromptParamsCard', () => {
  const prompt: LibraryPrompt = {
    id: 'starter:hunt',
    title: 'Hunt an indicator',
    text: 'Hunt for {indicator} over the last {period}. Then {indicator} again.',
    starter: true,
  };

  it('asks for each value, previews the text and sends the analyst’s words', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const view = render(<PromptParamsCard plan={planPrompt(prompt)} canRun onSubmit={onSubmit} onCancel={vi.fn()} />);
    const indicator = screen.getByRole('textbox', { name: 'Indicator' });
    expect(indicator).toHaveFocus();
    // Nothing is sent with a value missing; the first empty field takes focus.
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText('Enter a value.')).toHaveLength(2);
    await user.type(indicator, '8.8.8.8');
    await user.type(screen.getByRole('textbox', { name: 'Period' }), '7 days{Enter}');
    expect(onSubmit).toHaveBeenCalledWith(['Hunt for 8.8.8.8 over the last 7 days. Then 8.8.8.8 again.']);
    expect(screen.getByTestId('prompt-preview')).toHaveTextContent('Hunt for 8.8.8.8 over the last 7 days.');
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('runs a promptbook with Run n steps, and Esc closes without sending', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const bookPrompt: LibraryPrompt = { id: 'book-1', title: 'Triage', text: 'Look at {case id}\n---\nRelated to {case_id}?' };
    render(<PromptParamsCard plan={planPrompt(bookPrompt)} canRun onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    await user.type(screen.getByRole('textbox', { name: 'Case id' }), 'case-0042');
    expect(screen.getByTestId('prompt-preview')).toHaveTextContent('Look at case-0042');
    expect(screen.getByTestId('prompt-preview')).toHaveTextContent('Related to case-0042?');
    await user.click(screen.getByRole('button', { name: 'Run 2 steps' }));
    expect(onSubmit).toHaveBeenCalledWith(['Look at case-0042', 'Related to case-0042?']);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('says why a promptbook cannot run yet and keeps it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const bookPrompt: LibraryPrompt = { id: 'book-2', title: 'Two', text: 'One\n---\nTwo' };
    render(
      <PromptParamsCard
        plan={planPrompt(bookPrompt)}
        canRun={false}
        blockedReason="Wait for the current answer to finish."
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Wait for the current answer to finish.')).toBeInTheDocument();
    const run = screen.getByRole('button', { name: 'Run 2 steps' });
    expect(run).toHaveAttribute('aria-disabled', 'true');
    // The reason is the button's description, so a screen reader hears why.
    expect(run).toHaveAccessibleDescription('Wait for the current answer to finish.');
    await user.click(run);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
