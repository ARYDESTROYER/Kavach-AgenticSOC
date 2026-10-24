/**
 * Case Manager chat start edges (Round 13 polish, third re-shoot PW4-4): the start line
 * and its case chips sit in the composer's reading column (42rem), so the chip row ends
 * on the composer's right edge (it ran 32 px past it at 1440 and 108 px at 1920). jsdom
 * has no layout: this pins the shared cap; the edges were measured live.
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

describe('Case Manager chat start edges', () => {
  it('caps the start line and chips at the composer\u2019s reading column', async () => {
    await renderCaseManagerChat();
    await screen.findByTestId('case-starter-chips');
    const start = screen.getByTestId('case-chat-start');
    expect(start).toHaveClass('max-w-[42rem]');
    // The composer's column is the same 42rem reading column.
    const composerColumn = screen.getByRole('textbox', { name: 'Message' }).parentElement as HTMLElement;
    expect(composerColumn).toHaveClass('max-w-[42rem]');
  });
});
