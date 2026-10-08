/**
 * useConversationReport — the transcript's view of the conversation report (SPEC §9.2,
 * §10.6): adds by reference, a second click removes (strict-CAS `expected_version`), a
 * 409 reloads, and the toggles never need to unmount. A request in flight does not
 * rebuild any message's binding and ignores further clicks; a full report refuses a
 * new add with its reason while an item already in it stays removable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { addToReportMock, getReportMock, patchReportMock, toastMock } = vi.hoisted(() => ({
  addToReportMock: vi.fn(),
  getReportMock: vi.fn(),
  patchReportMock: vi.fn(),
  toastMock: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock('../../chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../chat-api')>();
  return { ...actual, addToReport: addToReportMock, getReport: getReportMock, patchReport: patchReportMock };
});
vi.mock('sonner', () => ({ toast: toastMock }));

import { ApiError } from '@/lib/api';
import type { Report, ReportItem } from '@/lib/types';
import { REPORT_FULL_MESSAGE } from '../../report/report-sync';
import { assistantItem } from '../../message/__tests__/fixtures';
import { useConversationReport, type UseConversationReportOptions } from '../useConversationReport';

function item(id: string, messageId: string, blockId: string | null): ReportItem {
  return {
    id,
    kind: blockId ? 'block' : 'section',
    block: {},
    source: { conversation_id: 'c-1', message_id: messageId, block_id: blockId },
    scope: {},
    added_at: '2026-10-08T10:00:00Z',
  };
}

function report(items: ReportItem[], version = 3): Report {
  return {
    id: 'r-1',
    owner: 'analyst',
    title: 'Sign-in review',
    template: 'custom',
    conversation_id: 'c-1',
    items,
    created_at: '2026-10-08T10:00:00Z',
    updated_at: '2026-10-08T10:00:00Z',
    version,
  };
}

/** 40 items: m-1's block `kpis` plus 39 fillers. */
const FULL = report([item('i-kpis', 'm-1', 'kpis'), ...Array.from({ length: 39 }, (_, n) => item(`i-${n}`, `m-f${n}`, 'b'))]);

function setup(extra: Partial<UseConversationReportOptions> = {}) {
  const props: UseConversationReportOptions = { conversationId: 'c-1', reportId: 'r-1', enabled: true, ...extra };
  return renderHook((p: UseConversationReportOptions) => useConversationReport(p), { initialProps: props });
}

const message = assistantItem({ messageId: 'm-1' });

beforeEach(() => {
  addToReportMock.mockReset();
  getReportMock.mockReset();
  patchReportMock.mockReset();
  toastMock.mockReset();
  toastMock.error.mockReset();
});

describe('useConversationReport', () => {
  it('ignores clicks while a request is in flight without rebuilding any binding', async () => {
    getReportMock.mockResolvedValue(report([]));
    let resolveAdd!: (value: unknown) => void;
    addToReportMock.mockReturnValue(new Promise((resolve) => (resolveAdd = resolve)));
    const { result } = setup();
    await waitFor(() => expect(result.current.report?.id).toBe('r-1'));

    const before = result.current.bindingFor(message)!;
    expect(before).toMatchObject({ answerInReport: false, canAdd: true, disabledReason: null });
    act(() => before.onToggleAnswer());
    // Same object while pending: memoised messages (and the clicked toggle) stay put.
    expect(result.current.bindingFor(message)).toBe(before);
    act(() => before.onToggleBlock('kpis'));
    expect(addToReportMock).toHaveBeenCalledTimes(1);
    expect(addToReportMock).toHaveBeenCalledWith({ conversationId: 'c-1', messageId: 'm-1', blockId: null, reportId: 'r-1' });

    await act(async () => {
      resolveAdd({ report: report([item('i-1', 'm-1', null)], 4), itemId: 'i-1' });
    });
    expect(result.current.bindingFor(message)).toMatchObject({ answerInReport: true });
    expect(result.current.count).toBe(1);
  });

  it('refuses a new add to a full report with its reason, but still removes an item in it', async () => {
    getReportMock.mockResolvedValue(FULL);
    patchReportMock.mockResolvedValue(report(FULL.items.slice(1), 4));
    const onRefused = vi.fn();
    const onRemoved = vi.fn();
    const { result } = setup({ onRefused, onRemoved });
    await waitFor(() => expect(result.current.full).toBe(true));

    const binding = result.current.bindingFor(message)!;
    expect(binding).toMatchObject({ canAdd: false, disabledReason: REPORT_FULL_MESSAGE });
    expect(binding.blocks.has('kpis')).toBe(true);

    act(() => binding.onToggleBlock('other-block'));
    act(() => binding.onToggleAnswer());
    expect(addToReportMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(REPORT_FULL_MESSAGE);
    expect(onRefused).toHaveBeenCalledWith(REPORT_FULL_MESSAGE);

    await act(async () => binding.onToggleBlock('kpis'));
    expect(patchReportMock).toHaveBeenCalledWith('r-1', { expected_version: 3, remove_items: ['i-kpis'] });
    expect(onRemoved).toHaveBeenCalledWith(39);
    expect(result.current.full).toBe(false);
  });

  it('reloads the report and says so when a remove hits a version conflict', async () => {
    const current = report([item('i-1', 'm-1', null)]);
    getReportMock.mockResolvedValue(current);
    patchReportMock.mockRejectedValue(
      new ApiError(409, 'Conflict', { detail: { code: 'report_version_conflict', message: 'stale' } }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.report?.id).toBe('r-1'));
    getReportMock.mockClear();
    await act(async () => result.current.bindingFor(message)!.onToggleAnswer());
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/changed elsewhere/));
    await waitFor(() => expect(getReportMock).toHaveBeenCalledWith('r-1'));
  });

  it('offers no binding for case scope, a draft or an unsaved answer', () => {
    expect(setup({ enabled: false }).result.current.bindingFor(message)).toBeNull();
    expect(setup({ conversationId: null, reportId: null }).result.current.bindingFor(message)).toBeNull();
    expect(setup({ reportId: null }).result.current.bindingFor(assistantItem({ messageId: null }))).toBeNull();
  });
});
