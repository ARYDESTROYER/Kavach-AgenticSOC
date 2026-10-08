/**
 * Message — the assistant turn's anatomy (chat revamp SPEC §10.3): the live run log and
 * its collapse, the meta row (lookups, time, usage, legacy and simulated wording), the
 * Sources disclosure and `[D1]` markers, the notice placement table (callout, Continue
 * chip, locally stopped wording, D1 said once), failed turns (Retry same request vs Ask
 * again), the action visibility rule (opacity, so older turns stay keyboard-reachable),
 * follow-ups on the latest turn only, the memory line gated on `memory:manage` (a
 * removal resolves its ids first), "Run again to save", the usage popover, per-turn
 * provenance without usage, the lazy blocks and Add to report (toggles stay mounted
 * when the report is full).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { canRef, addMemoryMock, deleteMemoryMock, getMemoryMock } = vi.hoisted(() => ({
  canRef: { current: true },
  addMemoryMock: vi.fn(),
  deleteMemoryMock: vi.fn(),
  getMemoryMock: vi.fn(),
}));

vi.mock('@/soc/components/Can', () => ({ useCan: () => canRef.current }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, addMemory: addMemoryMock, deleteMemory: deleteMemoryMock, getMemory: getMemoryMock },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import { GALLERY_RAW } from '../../blocks/__fixtures__/gallery';
import { LOCAL_STOP_MESSAGE, Message, type MessageProps, type MessageReportBinding } from '../Message';
import { USAGE, assistantItem, response, runningItem, step, stubEngine } from './fixtures';

function renderMessage(props: Partial<MessageProps> & Pick<MessageProps, 'item'>) {
  const engine = props.engine ?? stubEngine();
  const view = render(
    <TooltipProvider>
      <Message latest headingId="h-a1" engine={engine} {...props} />
    </TooltipProvider>,
  );
  return { ...view, engine };
}

beforeEach(() => {
  canRef.current = true;
  addMemoryMock.mockReset().mockResolvedValue({});
  deleteMemoryMock.mockReset().mockResolvedValue({ ok: true, id: 'x' });
  getMemoryMock.mockReset().mockResolvedValue({ entries: [], count: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Message — running', () => {
  it('shows the live header and run log rows, then collapses once answer text streams', () => {
    const item = runningItem({
      steps: [
        { index: 1, ordinal: 1, kind: 'tool', tool: 'search_logs', label: 'Searched logs', params: { window: 'last 24h' }, group: null, status: 'ok', result: step(1), startedAt: 0 },
        { index: 2, ordinal: null, kind: 'model', tool: null, label: 'Thinking', params: {}, group: null, status: 'running', result: null, startedAt: 0 },
      ],
      usage: { ...USAGE, total_tokens: 1200, cost: 0.002 },
    });
    const { rerender, engine } = renderMessage({ item });
    const header = screen.getByTestId('run-log-header');
    expect(header).toHaveTextContent('Working · 1 lookup · 1.2k tokens · $0.002');
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(header.getAttribute('aria-controls') ?? '')).not.toHaveAttribute('hidden');
    expect(screen.getByText('Searched logs')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('Done · 1.2 s')).toBeInTheDocument();
    // The shared reduced-motion-aware glyph, never a page-local spinner.
    expect(screen.getAllByTestId('console-loading-glyph').length).toBeGreaterThan(0);
    // No actions or meta row while running.
    expect(screen.queryByTestId('meta-row')).toBeNull();

    const streaming = { ...item, live: { ...item.live!, text: 'Partial answer so far' } };
    rerender(
      <TooltipProvider>
        <Message latest headingId="h-a1" engine={engine} item={streaming} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('run-log-header')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('run-log-header')).toHaveTextContent('≈ 6 output tokens');
    expect(screen.getByText('Partial answer so far')).toBeInTheDocument();
  });

  it('tells the reader when the connection dropped and the answer is being checked', () => {
    renderMessage({ item: runningItem({ connection: 'recovering' }) });
    expect(screen.getByTestId('run-log-header')).toHaveTextContent(
      'Connection lost — checking whether the answer was saved',
    );
  });
});

describe('Message — completed', () => {
  it('renders the answer and a one-line meta row whose disclosure reopens the run log', () => {
    renderMessage({ item: assistantItem() });
    expect(screen.getByRole('heading', { level: 3, name: 'Assistant' })).toHaveClass('sr-only');
    expect(screen.getByText(/Five failed logins came from/)).toBeInTheDocument();
    const meta = screen.getByTestId('meta-row');
    const disclosure = within(meta).getByRole('button', { name: /2 lookups · 2\.4 s/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    const list = document.getElementById(disclosure.getAttribute('aria-controls') ?? '');
    expect(list).toHaveAttribute('hidden');
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(list).not.toHaveAttribute('hidden');
    expect(within(list as HTMLElement).getByText('Counted cases')).toBeInTheDocument();
    expect(within(list as HTMLElement).getByText(/newest 200 of 1,284/)).toBeInTheDocument();
    // The exact query sits behind its own disclosure, rendered as code.
    fireEvent.click(within(list as HTMLElement).getByRole('button', { name: 'Query' }));
    expect(screen.getByText('event.outcome:failure AND source.ip:10.0.0.5')).toBeInTheDocument();
    expect(within(meta).getByRole('button', { name: /2\.1k tokens · \$0\.004\. Usage details/ })).toBeInTheDocument();
  });

  it('reads "Answered in" without lookups, "Usage not recorded" for legacy turns and "simulated" in Demo', () => {
    const { unmount } = renderMessage({
      item: assistantItem({ response: response({ steps: [], usage: { ...USAGE, simulated: true } }) }),
    });
    const meta = screen.getByTestId('meta-row');
    expect(meta).toHaveTextContent('Answered in 1.8 s');
    expect(meta).toHaveTextContent('simulated');
    unmount();

    renderMessage({ item: assistantItem({ restored: true, response: { answer: 'Legacy answer' } }) });
    expect(screen.getByTestId('meta-row')).toHaveTextContent('Usage not recorded · —');
    expect(screen.getByTestId('meta-row')).not.toHaveTextContent(/\b0 tokens/);
  });

  it('discloses sources, links docs safely, names the grant a console link needs and jumps from [D1]', async () => {
    renderMessage({
      item: assistantItem({
        response: response({
          console_links: [
            { id: 'settings:admin_users', label: 'Users & roles', page: 'settings', opts: {}, allowed: false, requires: 'users:manage' },
            { id: 'page:cases', label: 'Cases', page: 'cases', opts: {}, allowed: true },
          ],
        }),
      }),
    });
    const sources = screen.getByRole('button', { name: 'Sources 3' });
    expect(sources).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Source D1' }));
    expect(sources).toHaveAttribute('aria-expanded', 'true');
    const link = screen.getByRole('link', { name: /Failed logins/ });
    expect(link).toHaveAttribute('href', '/docs/0.1/analyst/chat/');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Failed logins'));
    expect(screen.getByText(/needs users:manage/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Users & roles/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Cases/ })).toBeInTheDocument();
  });

  it('shows Copy, Add to report and Ask again; older turns reveal them on hover only', () => {
    const report: MessageReportBinding = {
      blocks: new Set(),
      answerInReport: false,
      canAdd: true,
      onToggleAnswer: vi.fn(),
      onToggleBlock: vi.fn(),
    };
    const { engine, unmount } = renderMessage({ item: assistantItem(), report });
    const actions = screen.getByTestId('meta-row').querySelector('[data-actions-visibility]');
    expect(actions).toHaveAttribute('data-actions-visibility', 'always');
    expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add answer to report' });
    expect(add).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(add);
    expect(report.onToggleAnswer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(engine.askAgain).toHaveBeenCalledTimes(1);
    unmount();

    renderMessage({ item: assistantItem(), latest: false, report: { ...report, answerInReport: true } });
    const older = screen.getByTestId('meta-row').querySelector('[data-actions-visibility]');
    expect(older).toHaveAttribute('data-actions-visibility', 'hover');
    // Opacity, never visibility: a visibility-hidden control cannot take focus.
    expect(older).toHaveClass('opacity-0');
    expect(older).not.toHaveClass('invisible');
    expect(screen.getByRole('button', { name: 'Add answer to report' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps Copy and Ask again keyboard-reachable on an older pre-revamp turn', async () => {
    const user = userEvent.setup();
    // A restored legacy turn: no usage, no lookups, no sources — nothing focusable
    // precedes the actions inside the turn.
    renderMessage({
      latest: false,
      item: assistantItem({ restored: true, response: response({ usage: null, steps: [], citations: [] }) }),
    });
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName('Copy answer');
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName('Ask again');
  });

  it('never offers Add to report without a binding (case scope)', () => {
    renderMessage({ item: assistantItem() });
    expect(screen.queryByRole('button', { name: 'Add answer to report' })).toBeNull();
  });

  it('keeps the answer toggle focusable on a full report and says why in its tooltip', async () => {
    const onToggleAnswer = vi.fn();
    const full: MessageReportBinding = {
      blocks: new Set(),
      answerInReport: false,
      canAdd: false,
      disabledReason: 'Report is full (40 items)',
      onToggleAnswer,
      onToggleBlock: vi.fn(),
    };
    const { unmount } = renderMessage({ item: assistantItem(), report: full });
    const toggle = screen.getByRole('button', { name: 'Add answer to report' });
    // aria-disabled, not disabled: it keeps focus and its tooltip.
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    act(() => toggle.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Report is full (40 items)');
    // The binding answers the click with the reason (no request).
    fireEvent.click(toggle);
    expect(onToggleAnswer).toHaveBeenCalledTimes(1);
    unmount();

    // An answer already in a full report stays removable, with the block vocabulary.
    renderMessage({ item: assistantItem(), report: { ...full, answerInReport: true } });
    const inReport = screen.getByRole('button', { name: 'Add answer to report' });
    expect(inReport).not.toHaveAttribute('aria-disabled');
    expect(inReport).toHaveAttribute('aria-pressed', 'true');
    act(() => inReport.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('In report ✓ (click to remove)');
  });

  it('labels product help and offers follow-ups on the latest turn only (origin follow_up)', () => {
    const item = assistantItem({
      response: response({ answer_kind: 'product_help', follow_ups: ['How do I add a source?'] }),
    });
    const { engine, unmount } = renderMessage({ item });
    expect(screen.getByText('Product help')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'How do I add a source?' }));
    expect(engine.send).toHaveBeenCalledWith('How do I add a source?', { origin: 'follow_up' });
    unmount();
    renderMessage({ item, latest: false });
    expect(screen.queryByRole('group', { name: 'Suggested follow-ups' })).toBeNull();
  });
});

describe('Message — notices and failures', () => {
  it('puts a partial notice at the top with Retry only when retryable', () => {
    const { engine } = renderMessage({
      item: assistantItem({ response: response({ notice: { kind: 'partial', message: '2 of 3 sources answered', retryable: true } }) }),
    });
    const note = screen.getByRole('note', { name: 'Partial answer' });
    expect(note).toHaveTextContent('2 of 3 sources answered');
    fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));
    expect(engine.retry).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('meta-row')).toHaveTextContent(/^Partial ·/);
  });

  it('offers Continue on a capped answer instead of a callout', () => {
    const { engine } = renderMessage({
      item: assistantItem({ response: response({ notice: { kind: 'cap', message: 'Limit reached', retryable: false } }) }),
      continueEstimate: 2400,
    });
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Continue where this stopped \(≈ \+2\.4k tokens\)/ }));
    expect(engine.continueAnswer).toHaveBeenCalledTimes(1);
  });

  it('says a locally stopped turn is saved later, and a D1 notice only once', () => {
    const { unmount } = renderMessage({
      stoppedLocally: true,
      item: assistantItem({
        messageId: null,
        response: response({ answer: '', message_id: null, notice: { kind: 'cancelled', message: 'Stopped before the answer finished.', retryable: false } }),
      }),
    });
    expect(screen.getByRole('note', { name: 'Stopped' })).toHaveTextContent(LOCAL_STOP_MESSAGE);
    expect(screen.getByTestId('meta-row')).toHaveTextContent(/^Stopped/);
    unmount();

    const message = 'The model is not configured or its key was rejected.';
    renderMessage({
      item: assistantItem({
        messageId: null,
        response: response({ answer: message, steps: [], message_id: null, usage: null, notice: { kind: 'provider', message, retryable: true } }),
      }),
    });
    expect(screen.getAllByText(message)).toHaveLength(1);
    // A turn that billed nothing and saved nothing offers no "Ask again".
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
  });

  it('offers Retry same request for a retryable failure and Ask again otherwise', () => {
    const failure = { kind: 'http' as const, message: 'Conversation storage is temporarily unavailable.', code: 'x', status: 503, retryable: true, notice: null };
    const { engine, unmount } = renderMessage({ item: assistantItem({ status: 'error', response: null, failure }) });
    expect(screen.getByRole('note', { name: 'The assistant could not answer' })).toHaveTextContent(failure.message);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
    expect(engine.retry).toHaveBeenCalledTimes(1);
    unmount();

    const second = renderMessage({ item: assistantItem({ status: 'error', response: null, failure: { ...failure, retryable: false } }) });
    expect(screen.queryByRole('button', { name: 'Retry same request' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(second.engine.askAgain).toHaveBeenCalledTimes(1);
  });

  it('offers Run again to save (honestly a re-run) only for a retryable not-saved notice', () => {
    const { engine, unmount } = renderMessage({
      item: assistantItem({ response: response({ notice: { kind: 'not_saved', message: 'Not saved to the case thread', retryable: true } }) }),
    });
    const rerun = screen.getByRole('button', { name: 'Run again to save' });
    // It says it is a new model run, not a save-only retry.
    expect(rerun).toHaveAccessibleDescription(/asks the model again and uses tokens again/);
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull();
    fireEvent.click(rerun);
    expect(engine.retry).toHaveBeenCalledTimes(1);
    unmount();
    renderMessage({
      item: assistantItem({ response: response({ notice: { kind: 'not_saved', message: 'Not saved to the case thread', retryable: false } }) }),
    });
    expect(screen.getByText('Not saved to the case thread')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again to save' })).toBeNull();
  });

  it('shows a not-saved line and a memory proposal on the same turn', () => {
    renderMessage({
      item: assistantItem({
        response: response({
          notice: { kind: 'not_saved', message: 'Not saved to the case thread', retryable: false },
          memory_proposal: { op: 'add', text: 'Jump host is 10.1.1.9', ids: [] },
        }),
      }),
    });
    expect(screen.getByText('Not saved')).toBeInTheDocument();
    expect(screen.getByText('Jump host is 10.1.1.9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remember this' })).toBeInTheDocument();
  });
});

describe('Message — memory line', () => {
  it('confirms a proposed memory only with memory:manage', async () => {
    const item = assistantItem({ response: response({ memory_proposal: { op: 'add', text: 'VPN egress is 203.0.113.0/24', ids: [] } }) });
    const { unmount } = renderMessage({ item });
    fireEvent.click(screen.getByRole('button', { name: 'Remember this' }));
    await waitFor(() => expect(addMemoryMock).toHaveBeenCalledWith({ text: 'VPN egress is 203.0.113.0/24' }));
    expect(await screen.findByText('Saved to memory')).toBeInTheDocument();
    unmount();

    canRef.current = false;
    renderMessage({ item });
    expect(screen.getByText('VPN egress is 203.0.113.0/24')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remember this' })).toBeNull();
    expect(screen.getByText(/needs memory:manage/)).toBeInTheDocument();
  });

  it('shows exactly which facts a proposed removal forgets, and skips unknown ids', async () => {
    getMemoryMock.mockResolvedValue({
      entries: [
        { id: 'mem-1', text: 'The VPN pool is 10.8.0.0/16', source: 'human', active: true },
        { id: 'mem-other', text: 'Unrelated fact', source: 'human', active: true },
      ],
      count: 2,
    });
    const item = assistantItem({ response: response({ memory_proposal: { op: 'remove', ids: ['mem-1', 'mem-gone'] } }) });
    const { unmount } = renderMessage({ item });
    const list = await screen.findByRole('list', { name: 'Facts that would be forgotten' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['The VPN pool is 10.8.0.0/16']);
    expect(screen.queryByText('Unrelated fact')).toBeNull();
    expect(screen.getByText(/1 saved fact is no longer saved and will be skipped/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forget this fact' }));
    await waitFor(() => expect(deleteMemoryMock).toHaveBeenCalledTimes(1));
    expect(deleteMemoryMock).toHaveBeenCalledWith('mem-1');
    expect(await screen.findByText('Removed from memory (1 saved fact)')).toBeInTheDocument();
    unmount();

    // Nothing resolvable: nothing to confirm.
    getMemoryMock.mockResolvedValue({ entries: [], count: 0 });
    renderMessage({ item: assistantItem({ response: response({ memory_proposal: { op: 'remove', ids: ['mem-gone'] } }) }) });
    expect(await screen.findByText(/None of these facts are saved any more/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Forget/ })).toBeNull();
  });

  it('never resolves or confirms a removal without memory:manage, and retries a failed lookup', async () => {
    canRef.current = false;
    const item = assistantItem({ response: response({ memory_proposal: { op: 'remove', ids: ['mem-1'] } }) });
    const { unmount } = renderMessage({ item });
    expect(screen.getByText(/needs memory:manage/)).toBeInTheDocument();
    expect(getMemoryMock).not.toHaveBeenCalled();
    unmount();

    canRef.current = true;
    getMemoryMock.mockRejectedValueOnce(new Error('Memory is unavailable'));
    renderMessage({ item });
    expect(await screen.findByText('Memory is unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Forget/ })).toBeNull();
    getMemoryMock.mockResolvedValueOnce({ entries: [{ id: 'mem-1', text: 'Fact one', source: 'human', active: true }], count: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Forget this fact' })).toBeInTheDocument();
  });

  it('echoes a legacy memory removal as a forgotten fact', () => {
    renderMessage({ item: assistantItem({ response: response({ memory_action: { op: 'remove', text: 'The legacy gateway is trusted.' } }) }) });
    expect(screen.getByText('Forgot this fact')).toBeInTheDocument();
    expect(screen.getByText('The legacy gateway is trusted.')).toBeInTheDocument();
  });
});

describe('Message — answer blocks', () => {
  it('loads the blocks lazily and wires Add to report per block', async () => {
    const onToggleBlock = vi.fn();
    renderMessage({
      item: assistantItem({ response: response({ blocks: [GALLERY_RAW[1]] }) }),
      report: { blocks: new Set(['kpis']), answerInReport: false, canAdd: true, onToggleAnswer: vi.fn(), onToggleBlock },
    });
    const blocks = await screen.findByTestId('answer-blocks', {}, { timeout: 15000 });
    expect(blocks).toHaveAttribute('data-message-id', 'm-assistant-1');
    const add = within(blocks).getByTestId('block-add-to-report');
    expect(add).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(add);
    expect(onToggleBlock).toHaveBeenCalledWith('kpis');
  });

  it('keeps block toggles mounted on a full report: in-report blocks stay removable', async () => {
    const onToggleBlock = vi.fn();
    renderMessage({
      item: assistantItem({ response: response({ blocks: [GALLERY_RAW[1]] }) }),
      report: {
        blocks: new Set(['kpis']),
        answerInReport: false,
        canAdd: false,
        disabledReason: 'Report is full (40 items)',
        onToggleAnswer: vi.fn(),
        onToggleBlock,
      },
    });
    const blocks = await screen.findByTestId('answer-blocks', {}, { timeout: 15000 });
    const toggle = within(blocks).getByTestId('block-add-to-report');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(onToggleBlock).toHaveBeenCalledWith('kpis');
  });

  it('renders a pre-revamp table through the same block path', async () => {
    renderMessage({
      item: assistantItem({
        restored: true,
        response: { answer: 'Legacy rows', table: { columns: ['host', 'count'], rows: [['web-01', 4]] } },
      }),
    });
    expect(await screen.findByText('web-01', {}, { timeout: 15000 })).toBeInTheDocument();
  });
});

describe('Message — usage and provenance', () => {
  it('opens the usage details on click as a labelled dialog (touch and keyboard friendly)', async () => {
    const user = userEvent.setup();
    renderMessage({ item: assistantItem() });
    await user.click(screen.getByRole('button', { name: /Usage details$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Usage details' });
    expect(dialog).toHaveTextContent('Input tokens');
    expect(dialog).toHaveTextContent('gpt-test');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Usage details' })).toBeNull());
  });

  it('names the model and source a turn without usage ran on', () => {
    renderMessage({
      item: assistantItem({
        restored: true,
        response: response({ usage: null, steps: [], effective_model: 'gpt-legacy', effective_source_name: 'Wazuh prod' }),
      }),
    });
    const meta = screen.getByTestId('meta-row');
    expect(meta).toHaveTextContent('Usage not recorded · —');
    expect(within(meta).getAllByTestId('turn-provenance').map((node) => node.textContent)).toEqual(['gpt-legacy', 'Wazuh prod']);
  });
});

describe('Message — accessibility', () => {
  it('has no detectable violations when completed with sources open', async () => {
    const { container } = renderMessage({
      item: assistantItem({ response: response({ follow_ups: ['Show the hosts'] }) }),
      report: { blocks: new Set(), answerInReport: false, canAdd: true, onToggleAnswer: vi.fn(), onToggleBlock: vi.fn() },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sources 1' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
