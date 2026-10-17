/**
 * The thread catch-up line above the composer (SPEC-chat §3.1 `thread`): it shows when
 * the composer is empty, no turn runs, the thread's last answer settled 30 minutes ago or
 * more and the server has a clause; it hides on text, a turn, Hide or another thread, and
 * shows at most once per thread per visit. No request while it could not show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import { THREAD_SETTLED_MS, ThreadCatchUp, type ThreadCatchUpProps } from '../ThreadCatchUp';
import { clearChatStartersCache } from '../useChatStarters';
import { CATCH_UP, json, makeInfo, query, stubStarterFetch } from './fixtures';

expect.extend(toHaveNoViolations);

const NOW = Date.parse('2026-10-17T14:00:00Z');
const SETTLED = NOW - THREAD_SETTLED_MS;
const FRESH = NOW - THREAD_SETTLED_MS + 60_000;

beforeEach(() => clearChatStartersCache());
afterEach(() => vi.unstubAllGlobals());

function props(overrides: Partial<ThreadCatchUpProps> = {}): ThreadCatchUpProps {
  return {
    conversationId: 'c-1',
    principal: 'alice',
    enabled: true,
    lastAnswerAt: SETTLED,
    draftEmpty: true,
    busy: false,
    onSend: vi.fn(),
    now: () => NOW,
    ...overrides,
  };
}

describe('ThreadCatchUp', () => {
  it('shows the line for a thread whose answer settled 30 minutes ago, and a clause sends its question', async () => {
    const server = stubStarterFetch(() => json(makeInfo({ surface: 'thread', starters: [], catch_up: CATCH_UP })));
    const onSend = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<ThreadCatchUp {...props({ onSend })} />);
    const line = await screen.findByTestId('thread-catch-up-line');
    expect(line).toHaveTextContent('Since 09:12: 5 new cases (2 critical) and Wazuh quiet for 3 hours.');
    expect(Object.fromEntries(query(server.reads()[0]))).toEqual({ surface: 'thread', conversation_id: 'c-1' });
    await user.click(within(line).getByRole('button', { name: 'Wazuh quiet for 3 hours' }));
    expect(onSend).toHaveBeenCalledWith(CATCH_UP.clauses[1].starter);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('makes no request for a fresh answer, a running turn, or a viewer who switched it off', async () => {
    const server = stubStarterFetch(() => json(makeInfo({ catch_up: CATCH_UP })));
    const { rerender } = render(<ThreadCatchUp {...props({ lastAnswerAt: FRESH })} />);
    rerender(<ThreadCatchUp {...props({ lastAnswerAt: null })} />);
    rerender(<ThreadCatchUp {...props({ enabled: false })} />);
    rerender(<ThreadCatchUp {...props({ conversationId: null })} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.calls).toHaveLength(0);
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
  });

  it('shows nothing without a clause', async () => {
    const server = stubStarterFetch(() => json(makeInfo({ catch_up: null })));
    render(<ThreadCatchUp {...props()} />);
    await waitFor(() => expect(server.reads()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
  });

  it('hides when the composer gets text and does not come back for that thread in this visit', async () => {
    stubStarterFetch(() => json(makeInfo({ catch_up: CATCH_UP })));
    const { rerender } = render(<ThreadCatchUp {...props()} />);
    await screen.findByTestId('thread-catch-up');
    rerender(<ThreadCatchUp {...props({ draftEmpty: false })} />);
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
    rerender(<ThreadCatchUp {...props({ draftEmpty: true })} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
  });

  it('hides while a turn runs, on Hide, and when the thread changes', async () => {
    stubStarterFetch(() => json(makeInfo({ catch_up: CATCH_UP })));
    const user = userEvent.setup();
    const { rerender } = render(<ThreadCatchUp {...props()} />);
    await screen.findByTestId('thread-catch-up');
    rerender(<ThreadCatchUp {...props({ busy: true })} />);
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();

    // Another thread shows its own line once; Hide ends it.
    const onHidden = vi.fn();
    rerender(<ThreadCatchUp {...props({ conversationId: 'c-2', onHidden })} />);
    await screen.findByTestId('thread-catch-up');
    await user.click(screen.getByRole('button', { name: 'Hide this summary' }));
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
    // The host is told, so it can move focus on (the composer below).
    expect(onHidden).toHaveBeenCalledTimes(1);
    // Back to c-1 (already shown this visit): nothing.
    rerender(<ThreadCatchUp {...props({ conversationId: 'c-1', onHidden })} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('thread-catch-up')).toBeNull();
  });

  it('pauses its clauses while sending is blocked', async () => {
    stubStarterFetch(() => json(makeInfo({ catch_up: CATCH_UP })));
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<ThreadCatchUp {...props({ onSend, disabled: true })} />);
    const line = await screen.findByTestId('thread-catch-up-line');
    const clause = within(line).getByRole('button', { name: '5 new cases (2 critical)' });
    expect(clause).toHaveAttribute('aria-disabled', 'true');
    await user.click(clause);
    expect(onSend).not.toHaveBeenCalled();
  });
});
