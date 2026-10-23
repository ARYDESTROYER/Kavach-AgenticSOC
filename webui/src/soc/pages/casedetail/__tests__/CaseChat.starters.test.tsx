/**
 * Case Manager chat × Round 13 case chips (SPEC-chat §3.1 `case`, §3.9, §3.14), on the
 * REAL path: ChatTab → lazy CaseChat → the real EmptyState → CaseStarterChips → the
 * starters client, over a scripted `fetch` (only the composer is a double: its own
 * package).
 *
 * - the chips are read for THIS case (`surface=case&case_id=`), once;
 * - clicking a chip sends its exact server question in the case chat, with
 *   `origin: "starter"` and the case id, never to personal Workspace history (no
 *   `persist_conversation`, no conversation or report calls) and with no starter event;
 *   focus moves to the composer;
 * - while chips are offered the quick-action row stays out of the way; it joins with
 *   the first message, and shows at once when no chip can be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/auth', () => {
  const auth = () => ({ username: 'analyst', hasPermission: () => true });
  return { useAuth: auth, useOptionalAuth: auth };
});
vi.mock('@/soc/chat/composer/Composer', async () => {
  const React = await import('react');
  type Engine = import('@/soc/chat/useChatEngine').ChatEngine;
  const Composer = React.forwardRef(function ComposerDouble(
    props: { engine: Engine },
    ref: React.Ref<{ focus: () => void; setText: (text: string) => void; savePrompt: (text: string) => void }>,
  ) {
    const area = React.useRef<HTMLTextAreaElement>(null);
    React.useImperativeHandle(ref, () => ({
      focus: () => area.current?.focus(),
      setText: (text: string) => props.engine.setDraft(text),
      savePrompt: () => undefined,
    }));
    return React.createElement('textarea', {
      ref: area,
      'aria-label': 'Message',
      value: props.engine.draft,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.engine.setDraft(event.target.value),
    });
  });
  return { Composer };
});

import type { Case, ChatStartersInfo } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { clearChatContextCache } from '@/soc/chat/useChatContext';
import { resetTurnRunnerForTests } from '@/soc/chat/turn-runner';
import { clearChatActivity } from '@/soc/chat-activity/activity';
import { clearChatStartersCache } from '@/soc/chat/starters/useChatStarters';
import { CASE_HANDOFF, CASE_NEEDS_PERSON, makeInfo } from '@/soc/chat/starters/__tests__/fixtures';
import { CASE_MANAGER_CHAT_STARTERS, ChatTab } from '../CaseChatPanel';
import { clearCaseStartersPrefetch } from '../case-starters-prefetch';

const CASE = { case_id: 'case-9' } as unknown as Case;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];
let caseInfo: ChatStartersInfo | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  caseInfo = makeInfo({ surface: 'case', starters: [{ ...CASE_NEEDS_PERSON }, { ...CASE_HANDOFF }] });
  clearChatContextCache();
  clearChatStartersCache();
  clearCaseStartersPrefetch();
  resetTurnRunnerForTests();
  clearChatActivity();
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
      const path = url.split('?')[0];
      if (path === '/api/prefs/user') return json({});
      if (path === '/api/chat/context') return json({ tools: [], bounds: { max_tool_calls: 10 }, text_streaming: { available: true } });
      if (path === '/api/chat/starters') return caseInfo ? json(caseInfo) : json({ detail: 'busy' }, 503);
      if (path === '/api/chat/stream') {
        // An open stream that never answers: enough to see what was sent.
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      return json({ detail: `Unhandled ${method} ${url}` }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderCaseManagerChat() {
  const view = render(
    <TooltipProvider>
      <ChatTab c={CASE} onClose={vi.fn()} presentation="case-manager" />
    </TooltipProvider>,
  );
  await screen.findByRole('group', { name: 'AI analyst status' }, { timeout: 5000 });
  return view;
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

const starterReads = () => calls.filter((call) => call.url.split('?')[0] === '/api/chat/starters');
const streamBodies = () => calls.filter((call) => call.url === '/api/chat/stream').map((call) => call.body);

describe('Case Manager chat — case chips on the real path', () => {
  it('reads the chips for this case and sends one in the case chat as a starter, never to Workspace history', async () => {
    const user = userEvent.setup();
    await renderCaseManagerChat();
    const chips = await screen.findByTestId('case-starter-chips');
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual([CASE_NEEDS_PERSON.prompt, CASE_HANDOFF.prompt]);
    expect(starterReads()).toHaveLength(1);
    const query = new URLSearchParams(starterReads()[0].url.split('?')[1]);
    expect(query.get('surface')).toBe('case');
    expect(query.get('case_id')).toBe('case-9');
    // Chips on screen: no second row of suggestions above the composer.
    expect(screen.queryByRole('group', { name: 'Analyst quick actions' })).toBeNull();

    await user.click(within(chips).getByRole('button', { name: CASE_HANDOFF.prompt }));
    await settle();
    expect(streamBodies()).toHaveLength(1);
    const body = streamBodies()[0] as Record<string, unknown>;
    expect(body).toMatchObject({ message: CASE_HANDOFF.prompt, case_id: 'case-9', origin: 'starter' });
    expect(body).not.toHaveProperty('persist_conversation');
    expect(calls.some((call) => call.url.startsWith('/api/chat/conversations') || call.url.startsWith('/api/reports'))).toBe(false);
    // A case chip records no starter event (its surface is case-scoped presentation).
    expect(calls.some((call) => call.url.startsWith('/api/chat/starters/events'))).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
    // The conversation has started: the quick actions join, in sentence case.
    const actions = screen.getByRole('group', { name: 'Analyst quick actions' });
    expect(within(actions).getAllByRole('button').map((b) => b.textContent)).toEqual([...CASE_MANAGER_CHAT_STARTERS]);
    expect(starterReads()).toHaveLength(1);
  });

  it('shows the quick actions at once when no chip can be read', async () => {
    caseInfo = null;
    await renderCaseManagerChat();
    expect(await screen.findByRole('group', { name: 'Analyst quick actions' })).toBeInTheDocument();
    expect(screen.queryByTestId('case-starter-chips')).toBeNull();
    await waitFor(() => expect(starterReads()).toHaveLength(1));
  });
});
