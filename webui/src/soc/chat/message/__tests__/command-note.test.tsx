/**
 * Round 12 final review (L4): a `/compact` reply is a quiet note, not an answer.
 *
 * In Demo Mode `/compact` makes no model call; its turn used to read "Usage not recorded ·
 * —" followed by the primary source's name (a source the turn never read) and offered
 * Rate, Add to case and Add to report. Now the reply carries `command: "compact"` and a
 * zero usage, and the console shows one note: the server's sentence and "No model call ·
 * $0" (or the summary call's usage figure when a model call ran, #6), no source, no run
 * log or meta row, and no answer actions. A command reply is also never replayed as
 * client history.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

vi.mock('@/soc/auth', () => ({
  useOptionalAuth: () => ({ hasPermission: () => true, username: 'analyst' }),
}));

import type { ChatResponse, TurnUsage } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { normaliseChatResponse } from '../../stream-events';
import { runExchange, type TurnRun } from '../../turn-runner';
import { COMMAND_NOTE_EMPTY, COMMAND_NOTE_FREE } from '../CommandNote';
import { Message, type MessageProps, type MessageReportBinding } from '../Message';
import { USAGE, assistantItem, response, stubEngine } from './fixtures';

const ZERO: TurnUsage = {
  ...USAGE,
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  cost: 0,
  latency_ms: 0,
  model: null,
  pricing_source: null,
  simulated: true,
  context_window: null,
  peak_prompt_tokens: 0,
};

const SOURCE = 'Splunk Enterprise Security — HEC';
const DONE = 'Summarised 2 earlier exchanges. The conversation continues from the summary.';

function compactResponse(extra: Partial<ChatResponse> = {}): ChatResponse {
  return response({
    answer: DONE,
    answer_kind: 'conversation',
    command: 'compact',
    compacted: true,
    usage: ZERO,
    cost: 0,
    citations: [],
    // The Demo fold's one quiet model step.
    steps: [
      {
        index: 1,
        ordinal: null,
        kind: 'model',
        tool: null,
        label: 'Summarised earlier messages',
        params: {},
        status: 'ok',
        duration_ms: 0,
        summary: '2 earlier exchanges summarised',
        untrusted_params: {},
        query: null,
        rows: null,
        basis: null,
        coverage: null,
        sources: [],
        usage: null,
        group: null,
      },
    ],
    // A reply stored before the fix still named the conversation's source.
    effective_source_name: SOURCE,
    effective_source_id: 'demo-splunk',
    ...extra,
  });
}

const REPORT: MessageReportBinding = {
  blocks: new Set(),
  answerInReport: false,
  canAdd: true,
  onToggleAnswer: vi.fn(),
  onToggleBlock: vi.fn(),
};

function renderMessage(props: Partial<MessageProps> & Pick<MessageProps, 'item'>) {
  return render(
    <TooltipProvider>
      <Message
        latest
        headingId="h-c1"
        engine={stubEngine({ conversationId: 'conv-1' })}
        report={REPORT}
        question="/compact"
        {...props}
      />
    </TooltipProvider>,
  );
}

describe('a /compact reply', () => {
  it('is one quiet note: the sentence, "No model call · $0", no source and no answer actions', async () => {
    const { container } = renderMessage({ item: assistantItem({ response: compactResponse(), source: SOURCE }) });
    const note = screen.getByTestId('answer-command-note');
    expect(note).toHaveAttribute('role', 'note');
    expect(within(note).getByText(DONE)).toBeInTheDocument();
    expect(within(note).getByTestId('command-note-usage')).toHaveTextContent(COMMAND_NOTE_FREE);

    expect(screen.queryByText(/Usage not recorded/)).toBeNull();
    expect(container.textContent).not.toContain('Splunk');
    expect(screen.queryByTestId('meta-row')).toBeNull();
    expect(screen.queryByTestId('turn-provenance')).toBeNull();
    // The note replaces the automatic "summarised to keep going" line and the run log.
    expect(screen.queryByTestId('answer-compacted')).toBeNull();
    expect(screen.queryByText(/to keep going/)).toBeNull();
    // No answer actions at all.
    expect(screen.queryByRole('radiogroup', { name: 'Rate this answer' })).toBeNull();
    for (const name of ['Add to case', 'Add answer to report', 'Copy answer', 'Ask again', 'More actions']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the summary call\'s usage when a model call ran (#6), still without actions', () => {
    const billed: TurnUsage = { ...USAGE, calls: 1, total_tokens: 2100, cost: 0.0042, simulated: false };
    renderMessage({ item: assistantItem({ response: compactResponse({ usage: billed, cost: billed.cost }) }) });
    const usage = screen.getByTestId('command-note-usage');
    expect(usage).not.toHaveTextContent(COMMAND_NOTE_FREE);
    expect(within(usage).getByRole('button', { name: /2\.1k tokens.*Usage details/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to case' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Rate this answer' })).toBeNull();
  });

  it('says what happened when nothing was summarised, and shows no figure without usage', () => {
    renderMessage({
      item: assistantItem({
        response: compactResponse({
          answer: 'There is nothing earlier in this conversation to summarise yet.',
          compacted: false,
          steps: [],
          usage: null,
        }),
      }),
    });
    const note = screen.getByTestId('answer-command-note');
    expect(note).toHaveTextContent('There is nothing earlier in this conversation to summarise yet.');
    expect(screen.queryByTestId('command-note-usage')).toBeNull();
    expect(screen.queryByText(/Usage not recorded/)).toBeNull();
  });

  it('a Stop before anything ran keeps its callout and says nothing was summarised', () => {
    renderMessage({
      item: assistantItem({
        messageId: null,
        response: compactResponse({
          answer: '',
          compacted: false,
          message_id: null,
          steps: [],
          notice: { kind: 'cancelled', message: 'Stopped before the answer.', retryable: false },
        }),
      }),
    });
    expect(screen.getByTestId('answer-command-note')).toHaveTextContent(COMMAND_NOTE_EMPTY.compact);
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
  });

  it('an ordinary answer keeps its meta row and actions', async () => {
    const user = userEvent.setup();
    renderMessage({ item: assistantItem({ response: response() }) });
    expect(screen.queryByTestId('answer-command-note')).toBeNull();
    expect(screen.getByTestId('meta-row')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument();
    // Add to case and Ask again live in the answer's ⋯ menu (Round 13 T10): the
    // permission-gated Add to case is still offered on this path.
    await user.click(screen.getByTestId('answer-more-actions'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Add to case/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Ask again' })).toBeInTheDocument();
  });
});

describe('the command marker', () => {
  it('is read leniently from a turn.done or a stored message', () => {
    expect(normaliseChatResponse({ answer: 'x', command: 'compact' })?.command).toBe('compact');
    expect(normaliseChatResponse({ answer: 'x', command: ' COMPACT ' })?.command).toBe('compact');
    expect(normaliseChatResponse({ answer: 'x', command: 'reboot' })?.command).toBeNull();
    expect(normaliseChatResponse({ answer: 'x' })?.command).toBeNull();
  });

  it('keeps a command reply out of the client history replayed with the next question', () => {
    const base = {
      state: 'done',
      requestKey: 'chat-key-1',
      request: { message: '/compact', origin: 'command', idempotency_key: 'chat-key-1' },
    };
    const command = { ...base, response: compactResponse() } as unknown as TurnRun;
    const answer = { ...base, request: { ...base.request, message: 'Show failed logins' }, response: response() } as unknown as TurnRun;
    expect(runExchange(command)).toEqual([]);
    expect(runExchange(answer)).toHaveLength(2);
  });
});
