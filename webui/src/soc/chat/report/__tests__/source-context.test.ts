/**
 * The source context behind a report's methodology (SPEC §9.3) and the report error copy:
 * conversations past the read limit are `skipped` (never "not recorded"), a cached
 * conversation that lacks an item's message is read again, a report change drops the
 * conversation's cached copy, and every server code the report routes send reads as
 * what happened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { ChatConversation, Report } from '@/lib/types';

const api = vi.hoisted(() => ({ getConversation: vi.fn() }));
vi.mock('@/soc/chat/chat-api', () => api);

import { emitReportChanged, reportErrorMessage } from '../report-sync';
import { MAX_SOURCE_CONVERSATIONS, clearSourceTurnCache, loadReportSourceContext } from '../useSourceTurns';
import { sampleConversation, sampleReport } from './fixtures';

const conversation = (id: string, messageIds: string[]): ChatConversation => ({
  ...sampleConversation(),
  id,
  title: `Conversation ${id}`,
  messages: messageIds.map((m) => ({ id: m, role: 'assistant' as const, content: 'ok', created_at: '2026-10-08T12:00:00Z', response: { answer: 'ok', steps: [], message_id: m } })),
});

const reportFrom = (sources: Array<[string, string]>): Report => {
  const base = sampleReport();
  return {
    ...base,
    conversation_id: sources[0]?.[0] ?? null,
    items: sources.map(([cid, mid], i) => ({ ...base.items[1], id: `it-${i}`, source: { conversation_id: cid, message_id: mid, block_id: 'b' } })),
  };
};

beforeEach(() => {
  api.getConversation.mockReset();
  clearSourceTurnCache();
});

describe('loadReportSourceContext', () => {
  it('reads at most the limit and marks the rest skipped, gone ones gone, errors failed', async () => {
    const ids = Array.from({ length: MAX_SOURCE_CONVERSATIONS + 2 }, (_, i) => `c-${i}`);
    api.getConversation.mockImplementation(async (id: string) => {
      if (id === 'c-1') throw new ApiError(404, 'gone');
      if (id === 'c-2') throw new ApiError(503, 'down');
      return conversation(id, [`m-${id}`]);
    });
    const state = await loadReportSourceContext(reportFrom(ids.map((id) => [id, `m-${id}`])));
    expect(api.getConversation).toHaveBeenCalledTimes(MAX_SOURCE_CONVERSATIONS);
    expect(state.status.get('c-0')).toBe('read');
    expect(state.status.get('c-1')).toBe('gone');
    expect(state.status.get('c-2')).toBe('failed');
    expect(state.status.get(`c-${MAX_SOURCE_CONVERSATIONS}`)).toBe('skipped');
    expect(state.status.get(`c-${MAX_SOURCE_CONVERSATIONS + 1}`)).toBe('skipped');
    expect(state.turns?.has('m-c-0')).toBe(true);
  });

  it('reads a cached conversation again when an item names a message it lacks', async () => {
    api.getConversation.mockResolvedValueOnce(conversation('c-a', ['m-1']));
    await loadReportSourceContext(reportFrom([['c-a', 'm-1']]));
    // A newer turn was added to the report within the cache minute.
    api.getConversation.mockResolvedValueOnce(conversation('c-a', ['m-1', 'm-2']));
    const state = await loadReportSourceContext(reportFrom([['c-a', 'm-1'], ['c-a', 'm-2']]));
    expect(api.getConversation).toHaveBeenCalledTimes(2);
    expect(state.turns?.has('m-2')).toBe(true);
  });

  it('serves the cache, and forgets a conversation when its report changes', async () => {
    api.getConversation.mockImplementation(async (id: string) => conversation(id, ['m-1']));
    const report = reportFrom([['c-b', 'm-1']]);
    await loadReportSourceContext(report);
    await loadReportSourceContext(report);
    expect(api.getConversation).toHaveBeenCalledTimes(1);
    emitReportChanged({ reportId: 'rep-1', conversationId: 'c-b' });
    await loadReportSourceContext(report);
    expect(api.getConversation).toHaveBeenCalledTimes(2);
  });
});

describe('reportErrorMessage', () => {
  const err = (status: number, code: string) => new ApiError(status, code, { detail: { code, message: 'server text' } });

  it('says what each summary failure means and offers a retry only where it can help', () => {
    expect(reportErrorMessage(err(409, 'report_too_large_to_summarise'))).toBe('This report is too large to summarise. Remove some items first');
    expect(reportErrorMessage(err(503, 'budget_blocked'))).toMatch(/budget is used up/);
    expect(reportErrorMessage(err(503, 'budget_blocked'))).not.toMatch(/Try again/);
    expect(reportErrorMessage(err(503, 'provider_unavailable'))).toMatch(/unavailable or not configured/);
    expect(reportErrorMessage(err(503, 'breaker_open'))).toMatch(/paused/);
    expect(reportErrorMessage(err(504, 'report_summary_timeout'))).toMatch(/took too long/);
    expect(reportErrorMessage(err(502, 'report_summary_invalid'))).toMatch(/no summary/);
  });

  it('maps the remaining report codes and falls back for unknown ones', () => {
    expect(reportErrorMessage(err(409, 'report_conversation_draft_exists'))).toMatch(/already has a report/);
    expect(reportErrorMessage(err(422, 'report_item_unknown'))).toMatch(/no longer in the report/);
    expect(reportErrorMessage(err(422, 'report_item_order_invalid'))).toMatch(/Reload it/);
    expect(reportErrorMessage(err(500, 'something_new'), 'Fallback')).toBe('Fallback');
  });

  it('tells a full report by items from one at its storage size bound', () => {
    const full = (reason?: string) =>
      new ApiError(409, 'full', { detail: { code: 'report_full', message: 'server text', ...(reason ? { reason } : {}) } });
    expect(reportErrorMessage(full('items'))).toBe('Report is full (40 items)');
    expect(reportErrorMessage(full())).toBe('Report is full (40 items)');
    expect(reportErrorMessage(full('size'))).toMatch(/storage size limit/);
    expect(reportErrorMessage(err(409, 'block_unavailable'))).toMatch(/Ask again to refresh it/);
  });
});
