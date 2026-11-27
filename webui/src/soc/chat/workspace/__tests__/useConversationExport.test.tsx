/**
 * The conversation export runner (Round 12 final review): the same discipline as a
 * report export. One export per conversation at a time (a second pick while a long
 * thread is still being read is ignored), visible progress while it reads, a success
 * toast naming the file, the PDF guidance BEFORE the print dialog opens (print() blocks
 * until it closes), and failures worded for what happened.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatConversation } from '@/lib/types';

const { getFullConversationMock, exportConversationMock, toastMock, announceMock } = vi.hoisted(() => ({
  getFullConversationMock: vi.fn(),
  exportConversationMock: vi.fn(),
  toastMock: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
  announceMock: vi.fn(),
}));

vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: toastMock }));
vi.mock('@/soc/chat/chat-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/chat/chat-api')>()),
  getFullConversation: getFullConversationMock,
}));
vi.mock('@/soc/chat/report/export/conversation', () => ({ exportConversation: exportConversationMock }));
vi.mock('@/soc/components/announcer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/components/announcer')>()),
  useAnnouncer: () => announceMock,
}));

import { ApiError } from '@/lib/api';
import { PRINT_OPENED_MESSAGE } from '../../report/export/formats';
import { CHUNK_ERROR_MESSAGE, UNREACHABLE_MESSAGE } from '../../report/useReportExport';
import {
  CONVERSATION_EXPORT_FAILED,
  CONVERSATION_GONE_MESSAGE,
  conversationExportFailure,
  useConversationExport,
} from '../useConversationExport';

const CONVERSATION: ChatConversation = {
  id: 'c-1',
  title: 'VPN brute force',
  created_at: '2026-10-08T12:00:00Z',
  updated_at: '2026-10-08T12:10:00Z',
  message_count: 0,
  messages: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup() {
  return renderHook(() => useConversationExport({ author: 'analyst' }));
}

beforeEach(() => {
  getFullConversationMock.mockReset().mockResolvedValue(CONVERSATION);
  exportConversationMock.mockReset().mockResolvedValue({ ok: true, message: 'Markdown downloaded', filename: 'agentic-soc-conversation.md' });
  toastMock.mockReset();
  toastMock.error.mockReset();
  toastMock.success.mockReset();
  toastMock.loading.mockReset();
  announceMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('useConversationExport', () => {
  it('runs one export per conversation: a second pick while the thread is read is ignored', async () => {
    const read = deferred<ChatConversation>();
    getFullConversationMock.mockReturnValueOnce(read.promise);
    const { result } = setup();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.run('c-1', 'markdown');
      second = result.current.run('c-1', 'markdown');
    });
    // Progress is visible (the menu has closed) and announced while the read runs.
    expect(toastMock.loading).toHaveBeenCalledTimes(1);
    expect(toastMock.loading).toHaveBeenCalledWith('Preparing Markdown…', { id: 'conversation-export-c-1' });
    expect(announceMock).toHaveBeenCalledWith('Preparing Markdown…');
    await act(async () => {
      read.resolve(CONVERSATION);
      await Promise.all([first, second]);
    });
    expect(getFullConversationMock).toHaveBeenCalledTimes(1);
    expect(exportConversationMock).toHaveBeenCalledTimes(1);
    // Once it finishes, the next pick runs again.
    await act(async () => {
      await result.current.run('c-1', 'html');
    });
    expect(exportConversationMock).toHaveBeenCalledTimes(2);
  });

  it('lets two different conversations export at once', async () => {
    const { result } = setup();
    await act(async () => {
      await Promise.all([result.current.run('c-1', 'markdown'), result.current.run('c-2', 'markdown')]);
    });
    expect(exportConversationMock).toHaveBeenCalledTimes(2);
  });

  it('replaces the progress toast with a success toast naming the file', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.run('c-1', 'markdown');
    });
    const [conversation, format, options] = exportConversationMock.mock.calls[0];
    expect(conversation).toBe(CONVERSATION);
    expect(format).toBe('markdown');
    expect(options).toMatchObject({ author: 'analyst' });
    expect(toastMock.success).toHaveBeenCalledWith('Markdown downloaded', {
      id: 'conversation-export-c-1',
      description: 'agentic-soc-conversation.md',
    });
    expect(announceMock).toHaveBeenLastCalledWith('Markdown downloaded: agentic-soc-conversation.md');
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('shows the PDF guidance before the print dialog opens, and nothing after it closes', async () => {
    const order: string[] = [];
    toastMock.success.mockImplementation((message: string) => order.push(`toast:${message}`));
    announceMock.mockImplementation((message: string) => order.push(`announce:${message}`));
    exportConversationMock.mockImplementation(async (_c: ChatConversation, _f: string, options: { onPrintOpening?: (filename: string) => void }) => {
      options.onPrintOpening?.('agentic-soc-conversation.pdf');
      order.push('print');
      return { ok: true, message: PRINT_OPENED_MESSAGE, filename: 'agentic-soc-conversation.pdf', guided: true };
    });
    const { result } = setup();
    await act(async () => {
      await result.current.run('c-1', 'print');
    });
    expect(order).toEqual([
      'announce:Preparing PDF…',
      `announce:${PRINT_OPENED_MESSAGE}`,
      `toast:${PRINT_OPENED_MESSAGE}`,
      'print',
    ]);
    expect(toastMock.success).toHaveBeenCalledWith(PRINT_OPENED_MESSAGE, {
      id: 'conversation-export-c-1',
      description: 'Suggested file name: agentic-soc-conversation.pdf',
    });
  });

  it('keeps a failure visible, worded for what happened', async () => {
    const { result } = setup();
    getFullConversationMock.mockRejectedValueOnce(new ApiError(404, 'not found'));
    await act(async () => {
      await result.current.run('c-gone', 'markdown');
    });
    expect(toastMock.error).toHaveBeenLastCalledWith(CONVERSATION_GONE_MESSAGE, { id: 'conversation-export-c-gone' });
    expect(announceMock).toHaveBeenLastCalledWith(CONVERSATION_GONE_MESSAGE);
    // An outcome that is not ok (no download support) is an error too.
    exportConversationMock.mockResolvedValueOnce({ ok: false, message: 'Downloads are not available in this browser', retryable: false });
    await act(async () => {
      await result.current.run('c-1', 'html');
    });
    expect(toastMock.error).toHaveBeenLastCalledWith('Downloads are not available in this browser', { id: 'conversation-export-c-1' });
    // The guard is released after a failure.
    await act(async () => {
      await result.current.run('c-1', 'html');
    });
    expect(toastMock.success).toHaveBeenCalled();
  });

  it('maps a thrown error to plain copy (stale chunk, unreachable server, gone, other)', () => {
    expect(conversationExportFailure(new TypeError('Failed to fetch dynamically imported module: /assets/conversation.js'))).toBe(CHUNK_ERROR_MESSAGE);
    expect(conversationExportFailure(new ApiError(0, 'Failed to fetch'))).toBe(UNREACHABLE_MESSAGE);
    expect(conversationExportFailure(new ApiError(404, 'conversation_not_found'))).toBe(CONVERSATION_GONE_MESSAGE);
    expect(conversationExportFailure(new ApiError(500, 'Internal Server Error'))).toBe(CONVERSATION_EXPORT_FAILED);
    expect(conversationExportFailure('weird')).toBe(CONVERSATION_EXPORT_FAILED);
  });
});

