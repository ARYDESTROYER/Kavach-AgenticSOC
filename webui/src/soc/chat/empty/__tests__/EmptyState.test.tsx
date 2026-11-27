/**
 * EmptyState (SPEC-chat §3.1, §3.14, §5.2): the Workspace variant is the Round 13 start
 * stack (no "What can the assistant access?" link and no "Browse the prompt library"
 * link any more: the Read-only chip and the All prompts pill do those jobs); the case
 * variant keeps its compact line and access link and gains the three case-scoped chips
 * of `GET /api/chat/starters?surface=case`, sent in the case chat. axe in each state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import { TooltipProvider } from '@/ui/tooltip';
import { makeContext } from '../../composer/__tests__/fixtures';
import { CASE_CHIP_COUNT } from '../../starters/CaseStarterChips';
import { clearChatStartersCache, type ChatStartersController } from '../../starters/useChatStarters';
import {
  CASE_HANDOFF,
  CASE_NEEDS_PERSON,
  NEEDS_HUMAN,
  json,
  makeInfo,
  query,
  stubStarterFetch,
} from '../../starters/__tests__/fixtures';
import { ACCESS_LINK, CAPABILITY_LINE, CASE_CAPABILITY_LINE, EmptyState } from '../EmptyState';

expect.extend(toHaveNoViolations);

beforeEach(() => clearChatStartersCache());
afterEach(() => vi.unstubAllGlobals());

function controller(): ChatStartersController {
  return { info: makeInfo(), loading: false, error: null, retry: vi.fn(), setHeld: vi.fn() };
}

describe('EmptyState — workspace', () => {
  it('renders the start stack from the host\'s starters, without the old links', async () => {
    stubStarterFetch(() => json(makeInfo()));
    const onStarter = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <TooltipProvider>
        <EmptyState context={makeContext()} starters={controller()} onStarter={onStarter} />
      </TooltipProvider>,
    );
    expect(screen.getByText(CAPABILITY_LINE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ACCESS_LINK })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Browse the prompt library' })).toBeNull();
    await user.click(screen.getByRole('button', { name: NEEDS_HUMAN.prompt }));
    expect(onStarter).toHaveBeenCalledWith(NEEDS_HUMAN);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('makes no request of its own (the host owns the read)', async () => {
    const server = stubStarterFetch(() => json(makeInfo()));
    render(<EmptyState context={makeContext()} onStarter={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.reads()).toHaveLength(0);
  });
});

describe('EmptyState — case', () => {
  it('shows the compact line, the access link and the case chips, and sends a chip in the case chat', async () => {
    const server = stubStarterFetch(() =>
      json(makeInfo({ surface: 'case', starters: [CASE_NEEDS_PERSON, CASE_HANDOFF] })),
    );
    const onStarter = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <EmptyState context={makeContext()} variant="case" caseId="case-0042" principal="alice" onStarter={onStarter} />,
    );
    expect(screen.getByText(CASE_CAPABILITY_LINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ACCESS_LINK })).toBeInTheDocument();
    const chips = await screen.findByRole('list', { name: 'Suggested questions' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual([CASE_NEEDS_PERSON.prompt, CASE_HANDOFF.prompt]);
    expect(Object.fromEntries(query(server.reads()[0]))).toEqual({ surface: 'case', case_id: 'case-0042' });
    await user.click(within(chips).getByRole('button', { name: CASE_HANDOFF.prompt }));
    expect(onStarter).toHaveBeenCalledWith(CASE_HANDOFF);
    // Case chips post no events (presentation state belongs to the Workspace).
    expect(server.events()).toHaveLength(0);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows at most three chips, pauses them while a turn runs, and shows none when the read fails', async () => {
    let fail = false;
    stubStarterFetch(() =>
      fail
        ? json({ detail: 'down' }, 503)
        : json(makeInfo({ surface: 'case', starters: [CASE_NEEDS_PERSON, CASE_HANDOFF, NEEDS_HUMAN, { ...NEEDS_HUMAN, id: 'case_entity', key: 'aaaaaaaaaaaaaaaa' }] })),
    );
    const onStarter = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <EmptyState context={makeContext()} variant="case" caseId="case-1" principal="alice" disabled onStarter={onStarter} />,
    );
    const chips = await screen.findByRole('list', { name: 'Suggested questions' });
    expect(within(chips).getAllByRole('button')).toHaveLength(CASE_CHIP_COUNT);
    await user.click(within(chips).getAllByRole('button')[0]);
    expect(onStarter).not.toHaveBeenCalled();
    unmount();

    clearChatStartersCache();
    fail = true;
    render(<EmptyState context={makeContext()} variant="case" caseId="case-2" principal="alice" onStarter={onStarter} />);
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Suggested questions' })).toBeNull());
    expect(screen.getByText(CASE_CAPABILITY_LINE)).toBeInTheDocument();
  });

  it('shows the context error in the case variant\'s access popover', async () => {
    stubStarterFetch(() => json(makeInfo({ surface: 'case', starters: [] })));
    const user = userEvent.setup();
    render(<EmptyState context={null} error="HTTP 503" onRetry={() => {}} onStarter={() => {}} variant="case" caseId="case-3" />);
    await user.click(screen.getByRole('button', { name: ACCESS_LINK }));
    const dialog = await screen.findByRole('dialog', { name: 'What the assistant can access' });
    expect(within(dialog).getByText("Couldn't load what the assistant can access.")).toBeInTheDocument();
  });

  it('renders chip text as text (#9)', async () => {
    stubStarterFetch(() =>
      json(makeInfo({ surface: 'case', starters: [{ ...CASE_HANDOFF, prompt: '<img src=x> summary?' }] })),
    );
    const { container } = render(<EmptyState context={makeContext()} variant="case" caseId="case-4" onStarter={() => {}} />);
    expect(await screen.findByText('<img src=x> summary?')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
