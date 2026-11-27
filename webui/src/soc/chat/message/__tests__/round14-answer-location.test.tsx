/**
 * Round 14 (SPEC §4.6.6, "Back to answer"): a Workspace answer hands its saved location to
 * its blocks, so a drill that leaves it remembers that exact answer. The Chat workspace's
 * location is the bare `#/chat` while a thread is open from the history rail, which names
 * no conversation: without the answer's own location nothing would be offered. A Case
 * Manager answer (the compact case chat) goes back to its case instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/prefs', () => ({ useOptionalPrefs: () => null }));
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => () => undefined }));

import { TooltipProvider } from '@/ui/tooltip';
import { answerOrigin, clearAnswerOrigin } from '@/soc/answer-origin';
import sample from '../../blocks/__tests__/fixtures/severity-sample.json';
import { Message } from '../Message';
import { assistantItem, response, stubEngine } from './fixtures';

/** The levels table without its breakdown: a plain table whose rows open Logs. */
function levelsTable(): Record<string, unknown> {
  const block: Record<string, unknown> = structuredClone(sample.severity);
  delete block.severity;
  return block;
}

async function settleHash(hash: string): Promise<void> {
  if (window.location.hash !== hash) {
    const changed = new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.location.hash = hash;
    await changed;
  }
}

function renderAnswer({ compact = false, conversationId = 'conv-7' }: { compact?: boolean; conversationId?: string | null } = {}) {
  const item = assistantItem({ messageId: 'm-assistant-7', response: response({ blocks: [levelsTable()], message_id: 'm-assistant-7' }) });
  return render(
    <TooltipProvider>
      <Message latest headingId="h-a7" item={item} compact={compact} engine={stubEngine({ conversationId })} />
    </TooltipProvider>,
  );
}

describe('Back to answer from a Workspace answer', () => {
  beforeEach(async () => {
    clearAnswerOrigin();
    // A thread opened from the history rail: the location names no conversation.
    await settleHash('#/chat');
  });

  afterEach(async () => {
    clearAnswerOrigin();
    await settleHash('');
  });

  it('remembers the exact answer in its conversation when one of its drills is followed', async () => {
    const user = userEvent.setup();
    renderAnswer();
    await user.click(await screen.findByRole('link', { name: 'Open in Logs: High (8, 7, 55)' }, { timeout: 4000 }));
    await waitFor(() =>
      expect(answerOrigin()).toEqual({ hash: '#/chat?conversationId=conv-7&messageId=m-assistant-7', label: 'Back to answer' }),
    );
  });

  it('remembers nothing for an answer outside a saved conversation on the bare Chat page', async () => {
    const user = userEvent.setup();
    renderAnswer({ conversationId: null });
    await user.click(await screen.findByRole('link', { name: 'Open in Logs: High (8, 7, 55)' }, { timeout: 4000 }));
    expect(answerOrigin()).toBeNull();
  });

  it('leaves a case answer to its case (the compact case chat names no Workspace answer)', async () => {
    await settleHash('#/case_manager?caseId=case-1');
    const user = userEvent.setup();
    renderAnswer({ compact: true });
    await user.click(await screen.findByRole('link', { name: 'Open in Logs: High (8, 7, 55)' }, { timeout: 4000 }));
    await waitFor(() => expect(answerOrigin()).toEqual({ hash: '#/case_manager?caseId=case-1', label: 'Back to the case' }));
  });
});
