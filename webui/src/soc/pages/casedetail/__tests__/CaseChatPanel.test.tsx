/**
 * CaseChatPanel (ChatTab) — the case-scoped entry point to the ONE chat engine (#5,
 * SPEC §4.6, §10.8), ported from the pre-revamp ChatPanel embed suite:
 *
 *   1. every turn carries THIS case id and is never saved to personal history
 *      (no `persist_conversation`, no conversation list or report calls);
 *   2. the quick actions send their prompt as a starter;
 *   3. the one-line status reads Working while a turn runs and Ready after it, without
 *      a live region (the shell announcer speaks);
 *   4. the transcript uses the shared compact message components, with no rail, no
 *      report panel and no Add to report;
 *   5. "Open full chat" closes the sheet and navigates to the case-scoped chat;
 *   6. the Case Manager frame keeps its shared content rail and bottom-docked layout;
 *   7. axe-clean.
 *
 * The composer and empty state are the composer package's; they are doubles here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

vi.mock('@/soc/chat/composer/Composer', async () => {
  const React = await import('react');
  type Engine = import('@/soc/chat/useChatEngine').ChatEngine;
  const Composer = React.forwardRef(function ComposerDouble(
    props: { engine: Engine; variant?: string; contextError?: string | null },
    ref: React.Ref<{ focus: () => void; setText: (text: string) => void; savePrompt: (text: string) => void }>,
  ) {
    const area = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => area.current?.focus(),
      setText: (text: string) => props.engine.setDraft(text),
      savePrompt: () => undefined,
    }));
    return React.createElement(
      'form',
      {
        'data-testid': 'composer',
        'data-variant': props.variant,
        'data-context-error': props.contextError ?? '',
        onSubmit: (event: React.FormEvent) => {
          event.preventDefault();
          props.engine.send();
        },
      },
      React.createElement('textarea', {
        ref: area,
        'aria-label': 'Message',
        value: props.engine.draft,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.engine.setDraft(event.target.value),
      }),
      React.createElement('button', { type: 'submit' }, 'Send'),
    );
  });
  return { Composer };
});

vi.mock('@/soc/chat/empty/EmptyState', async () => {
  const React = await import('react');
  return {
    EmptyState: (props: { variant?: string; error?: string | null; onRetry?: () => void }) =>
      React.createElement(
        'div',
        { 'data-testid': 'empty-state', 'data-variant': props.variant, 'data-error': props.error ?? '' },
        'Ask about this case. Read-only.',
        props.error && props.onRetry ? React.createElement('button', { type: 'button', onClick: props.onRetry }, 'Retry context') : null,
      ),
  };
});

import type { Case } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { clearChatContextCache } from '@/soc/chat/useChatContext';
import { ChatTab } from '../CaseChatPanel';

const encoder = new TextEncoder();
const CASE = { case_id: 'case-9' } as unknown as Case;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];
let controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
let contextFailures = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  controllers = [];
  contextFailures = 0;
  clearChatContextCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/prefs/user')) return json({});
      if (url.startsWith('/api/chat/context')) {
        if (contextFailures > 0) {
          contextFailures -= 1;
          return json({ detail: 'Chat context is temporarily unavailable.' }, 503);
        }
        return json({ tools: [], bounds: { max_tool_calls: 10 }, text_streaming: { available: true } });
      }
      if (url === '/api/chat/stream') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      throw new Error(`Unhandled request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function push(...events: unknown[]) {
  await act(async () => {
    for (const event of events) controllers[0].enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

function renderTab(props: Partial<React.ComponentProps<typeof ChatTab>> = {}) {
  return render(
    <TooltipProvider>
      <ChatTab c={CASE} onNavigate={vi.fn()} onClose={vi.fn()} {...props} />
    </TooltipProvider>,
  );
}

const streamBodies = () => calls.filter((call) => call.url === '/api/chat/stream').map((call) => call.body);

describe('ChatTab — the case-scoped chat', () => {
  it('scopes every turn to this case and never saves it to personal history', async () => {
    renderTab();
    await settle();
    expect(screen.getByRole('group', { name: 'AI analyst status' })).toHaveTextContent(/Scoped to\s*case-9/);
    expect(screen.getByTestId('empty-state')).toHaveAttribute('data-variant', 'case');
    expect(screen.getByTestId('composer')).toHaveAttribute('data-variant', 'case');
    fireEvent.click(screen.getByRole('button', { name: 'Summarize this case' }));
    await settle();
    expect(streamBodies()[0]).toMatchObject({ message: 'Summarize this case', case_id: 'case-9', origin: 'starter' });
    expect(streamBodies()[0]).not.toHaveProperty('persist_conversation');
    expect(calls.some((call) => call.url.startsWith('/api/chat/conversations') || call.url.startsWith('/api/reports'))).toBe(false);
    expect(screen.queryByRole('navigation', { name: 'Chat history' })).toBeNull();
  });

  it('shows Working while a turn runs and Ready with the compact answer after it, with no Add to report', async () => {
    renderTab({ presentation: 'case-manager' });
    await settle();
    const status = screen.getByRole('group', { name: 'AI analyst status' });
    expect(status).not.toHaveAttribute('aria-live');
    expect(status).toHaveTextContent('Ready');
    fireEvent.click(screen.getByRole('button', { name: 'Check IOCs' }));
    await settle();
    expect(status).toHaveTextContent('Working');
    expect(streamBodies()[0]).toMatchObject({ message: 'Check IOCs', case_id: 'case-9' });
    await push(
      { type: 'turn.start', turn_id: 't-1', conversation_id: null, model: 'm', stream_mode: 'steps', replayed: false, estimate: { prompt_tokens: 10 } },
      { type: 'turn.done', response: { answer: 'No additional malicious indicators were found.', usage: { calls: 1, total_tokens: 500, cost: 0.001 } } },
    );
    expect(await screen.findByText('No additional malicious indicators were found.')).toBeInTheDocument();
    expect(status).toHaveTextContent('Ready');
    expect(screen.getByTestId('meta-row')).toHaveTextContent('500 tokens');
    expect(screen.queryByRole('button', { name: 'Add answer to report' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeInTheDocument();
  });

  it('keeps focus in the composer after a quick action and surfaces a failed context with Retry', async () => {
    contextFailures = 1;
    renderTab({ presentation: 'case-manager' });
    await settle();
    const empty = screen.getByTestId('empty-state');
    expect(empty.getAttribute('data-error')).toMatch(/unavailable/i);
    expect(screen.getByTestId('composer').getAttribute('data-context-error')).toMatch(/unavailable/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry context' }));
    await settle();
    expect(screen.getByTestId('empty-state')).toHaveAttribute('data-error', '');

    const action = screen.getByRole('button', { name: 'Summarize Case' });
    action.focus();
    fireEvent.click(action);
    await settle();
    // The quick action is disabled while the turn runs: focus is in the composer.
    expect(action).toBeDisabled();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
  });

  it('"Open full chat" closes the sheet then navigates to the case-scoped chat', async () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    renderTab({ onNavigate, onClose });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Open full chat/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('chat', { caseId: 'case-9' });
  });

  it('omits the deep-link when no navigate handler is provided', async () => {
    renderTab({ onNavigate: undefined });
    await settle();
    expect(screen.queryByRole('button', { name: /Open full chat/ })).toBeNull();
  });

  it('keeps the Case Manager frame on the shared rail with the composer docked below the transcript', async () => {
    const { container } = renderTab({ presentation: 'case-manager' });
    await settle();
    const panel = container.querySelector('[data-case-panel="chat"][data-presentation="case-manager"]');
    expect(panel).toHaveClass('flex', 'h-full', 'min-h-0', 'overflow-hidden', 'px-4', 'py-4', 'sm:px-5', 'sm:py-5', 'lg:px-6');
    const frame = container.querySelector('[data-chat-presentation="case-manager"]');
    expect(frame).toHaveClass('h-full', 'min-h-0', 'w-full', 'overflow-hidden');
    expect(container.querySelector('[data-chat-scroll-lane="true"]')).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(frame?.lastElementChild).toHaveClass('shrink-0');
    const actions = screen.getByRole('group', { name: 'Analyst quick actions' });
    expect(actions).toHaveClass('flex-nowrap', 'overflow-x-auto');
    for (const action of ['Summarize Case', 'Check IOCs', 'Suggest Remediation']) {
      expect(screen.getByRole('button', { name: action })).toHaveClass('shrink-0');
    }
    expect(screen.queryByRole('heading', { name: /case chat/i })).toBeNull();
  });

  it('has no accessibility violations in either presentation', async () => {
    const { container, unmount } = renderTab();
    await settle();
    expect(await axe(container)).toHaveNoViolations();
    unmount();
    const second = renderTab({ presentation: 'case-manager' });
    await settle();
    expect(await axe(second.container)).toHaveNoViolations();
  });
});
