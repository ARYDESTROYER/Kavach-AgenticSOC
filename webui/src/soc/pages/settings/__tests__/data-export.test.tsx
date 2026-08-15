import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { BackgroundJob, BackgroundJobKind } from '@/lib/types';

const { submitMock, toastMock } = vi.hoisted(() => ({
  submitMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      jobs: { ...actual.api.jobs, submit: submitMock },
    },
  };
});
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/soc/components/Can', () => ({
  Can: ({ children }: { children: ReactNode }) => children,
}));

import { DataExportSection } from '../data-export';

function accepted(kind: BackgroundJobKind, id = 'job-export'): BackgroundJob {
  return {
    job_id: id,
    kind,
    actor: 'admin.one',
    created_at: '2026-08-13T10:00:00Z',
    started_at: null,
    finished_at: null,
    status: 'queued',
    progress: { done: 0, total: 6, unit: 'scopes' },
    failures: [],
    failure_count: 0,
    failures_truncated: 0,
    request_fingerprint: 'fp',
    result: null,
    params: {},
    cancel_requested: false,
  };
}

function selectOnlyCases(): void {
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Cases' }));
}

function chooseSegmented(): void {
  fireEvent.click(screen.getByRole('radio', { name: /segmented assembly/i }));
}

describe('DataExportSection durable jobs', () => {
  beforeEach(() => {
    submitMock.mockReset().mockResolvedValue(accepted('data_export_archive'));
    Object.values(toastMock).forEach((mock) => mock.mockReset());
  });

  it('submits one archive job and never starts a browser-held download loop', async () => {
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('button', { name: /build zip in background/i }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock).toHaveBeenCalledWith({
      kind: 'data_export_archive',
      idempotency_key: expect.stringMatching(/^data_export_archive-/),
      params: {
        scopes: ['audit', 'automation', 'cases', 'configuration', 'knowledge', 'usage'],
      },
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/running in the background/i),
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open Inbox' }) }),
    );
  });

  it('submits segmented server assembly as one ZIP job with the selected page bound', async () => {
    submitMock.mockResolvedValueOnce(accepted('data_export_segment'));
    render(<DataExportSection />);
    chooseSegmented();
    selectOnlyCases();

    expect(screen.getByLabelText(/records per server segment/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /build zip in background/i }));

    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    expect(submitMock).toHaveBeenCalledWith({
      kind: 'data_export_segment',
      idempotency_key: expect.stringMatching(/^data_export_segment-/),
      params: { scopes: ['cases'], page_size: 1000 },
    });
    expect(screen.getByText(/final delivery is still one zip/i)).toBeInTheDocument();
  });

  it('reuses an intent key after an ambiguous failure, then rotates after acceptance', async () => {
    submitMock
      .mockRejectedValueOnce(new Error('connection closed'))
      .mockResolvedValueOnce(accepted('data_export_archive', 'job-first'))
      .mockResolvedValueOnce(accepted('data_export_archive', 'job-second'));
    render(<DataExportSection />);
    const submit = screen.getByRole('button', { name: /build zip in background/i });

    fireEvent.click(submit);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    fireEvent.click(submit);
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));
    fireEvent.click(submit);
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(3));

    const firstKey = submitMock.mock.calls[0][0].idempotency_key;
    const retryKey = submitMock.mock.calls[1][0].idempotency_key;
    const laterKey = submitMock.mock.calls[2][0].idempotency_key;
    expect(retryKey).toBe(firstKey);
    expect(laterKey).not.toBe(firstKey);
  });

  it('rotates the retained intent when material selection changes after a failure', async () => {
    submitMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(accepted('data_export_archive'));
    render(<DataExportSection />);
    const submit = screen.getByRole('button', { name: /build zip in background/i });

    fireEvent.click(submit);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Audit' }));
    fireEvent.click(submit);
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));

    expect(submitMock.mock.calls[1][0].idempotency_key).not.toBe(
      submitMock.mock.calls[0][0].idempotency_key,
    );
  });

  it('prevents submission when no export scope is selected', () => {
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
    expect(screen.getByRole('button', { name: /build zip in background/i })).toBeDisabled();
  });
});
