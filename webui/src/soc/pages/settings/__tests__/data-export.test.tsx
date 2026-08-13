import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { postMock, postAbortableMock, archiveMock, toastMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  postAbortableMock: vi.fn(),
  archiveMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      post: postMock,
      postAbortable: postAbortableMock,
      dataExport: { ...actual.api.dataExport, archive: archiveMock },
    },
  };
});
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/soc/components/Can', () => ({
  Can: ({ children }: { children: ReactNode }) => children,
}));

import { DataExportSection } from '../data-export';

function response(
  scope: string,
  part = 1,
  complete = true,
  cursor: string | null = null,
  status = complete ? 'complete' : 'partial',
) {
  return {
    format: 'agentic-soc-portable-export-segment',
    format_version: 2,
    selection: { scope },
    consistency: { mode: 'point_in_time', exact: true, detail: 'fixed snapshot' },
    segment: {
      number: part,
      count: 2,
      cumulative_count: part * 2,
      snapshot_total: complete ? part * 2 : 4,
      remaining: complete ? 0 : 2,
      complete,
      status,
      next_cursor: cursor,
    },
    records: [{ record: { id: `${scope}-${part}-1` } }, { record: { id: `${scope}-${part}-2` } }],
  };
}

function selectOnlyCases(): void {
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Cases' }));
}

function chooseAdvanced(): void {
  fireEvent.click(screen.getByRole('radio', { name: /advanced \/ resumable/i }));
}

function lastClickedFilename(): string {
  const clickMock = vi.mocked(HTMLAnchorElement.prototype.click);
  return (clickMock.mock.instances.at(-1) as HTMLAnchorElement | undefined)?.download || '';
}

describe('DataExportSection', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue({ ok: true });
    postAbortableMock.mockReset();
    postAbortableMock.mockImplementation((_path: string, body: { scope: string }) =>
      Promise.resolve(response(body.scope)),
    );
    archiveMock.mockReset();
    archiveMock.mockResolvedValue({
      blob: new Blob(['zip-bytes'], { type: 'application/zip' }),
      contentDisposition: 'attachment; filename="agentic-soc-export-20260813T101112Z.zip"',
      contentType: 'application/zip',
    });
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.info.mockReset();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:agentic-soc-export'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses one archive request and one save, with the safe server filename', async () => {
    render(<DataExportSection />);
    expect(screen.queryByLabelText(/records per export file/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /download zip archive/i }));

    await waitFor(() => expect(archiveMock).toHaveBeenCalledTimes(1));
    expect(archiveMock).toHaveBeenCalledWith(
      ['cases', 'audit', 'usage', 'configuration', 'automation', 'knowledge'],
      expect.any(AbortSignal),
    );
    expect(postAbortableMock).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(lastClickedFilename()).toBe('agentic-soc-export-20260813T101112Z.zip');
  });

  it('accepts UTF-8 filename*, strips path components, and sanitizes its basename', async () => {
    archiveMock.mockResolvedValueOnce({
      blob: new Blob(['zip-bytes'], { type: 'application/zip' }),
      contentDisposition:
        "attachment; filename=ignored.zip; filename*=UTF-8''..%2Fcase%20export%20%282026%29.zip",
      contentType: 'application/zip; charset=binary',
    });
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('button', { name: /download zip archive/i }));

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(lastClickedFilename()).toBe('case-export-2026.zip');
  });

  it('falls back to a UTC filename when Content-Disposition is absent or unsafe', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-13T10:11:12.345Z'));
    archiveMock.mockResolvedValueOnce({
      blob: new Blob(['zip-bytes'], { type: 'application/zip' }),
      contentDisposition: 'attachment; filename="../../not-a-zip.txt"',
      contentType: 'application/zip',
    });
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('button', { name: /download zip archive/i }));

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(lastClickedFilename()).toBe('agentic-soc-export-20260813T101112Z.zip');
  });

  it.each([
    {
      label: 'API error',
      result: () => Promise.reject(new Error('archive unavailable')),
    },
    {
      label: 'wrong content type',
      result: () => Promise.resolve({
        blob: new Blob(['error'], { type: 'application/json' }),
        contentDisposition: 'attachment; filename="looks-safe.zip"',
        contentType: 'application/json',
      }),
    },
    {
      label: 'empty archive',
      result: () => Promise.resolve({
        blob: new Blob([], { type: 'application/zip' }),
        contentDisposition: 'attachment; filename="empty.zip"',
        contentType: 'application/zip',
      }),
    },
  ])('shows a clear error and never saves for $label', async ({ result }) => {
    archiveMock.mockImplementationOnce(result);
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('button', { name: /download zip archive/i }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(String(toastMock.error.mock.calls[0][0])).toMatch(/archive|zip|content type/i);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it('switches to the explicit advanced mode and reveals Records per file only there', () => {
    render(<DataExportSection />);
    expect(screen.getByRole('radio', { name: /one zip archive/i })).toBeChecked();
    expect(screen.queryByLabelText(/records per export file/i)).not.toBeInTheDocument();

    chooseAdvanced();

    expect(screen.getByRole('radio', { name: /advanced \/ resumable/i })).toBeChecked();
    expect(screen.getByLabelText(/records per export file/i)).toBeInTheDocument();
    expect(screen.getByText(/already downloaded parts remain after cancellation/i)).toBeInTheDocument();
  });

  it('preserves the numbered-file continuation flow in advanced mode', async () => {
    postAbortableMock
      .mockResolvedValueOnce(response('cases', 1, false, 'cursor-2'))
      .mockResolvedValueOnce(response('cases', 2, true, null));
    render(<DataExportSection />);
    chooseAdvanced();
    selectOnlyCases();
    fireEvent.click(screen.getByRole('button', { name: /export numbered files/i }));

    await waitFor(() => expect(postAbortableMock).toHaveBeenCalledTimes(2));
    expect(postAbortableMock.mock.calls[0][1]).toEqual({
      scope: 'cases', cursor: null, page_size: 1000,
    });
    expect(postAbortableMock.mock.calls[1][1]).toEqual({
      scope: 'cases', cursor: 'cursor-2', page_size: 1000,
    });
    expect(archiveMock).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it.each(['incomplete', 'unverified'])('rejects an advanced %s response before saving it', async (status) => {
    postAbortableMock.mockResolvedValueOnce(response('cases', 1, false, null, status));
    render(<DataExportSection />);
    chooseAdvanced();
    selectOnlyCases();
    fireEvent.click(screen.getByRole('button', { name: /export numbered files/i }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(String(toastMock.error.mock.calls[0][0])).toContain(status);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('best-effort releases the active cursor after an advanced failure', async () => {
    postAbortableMock
      .mockResolvedValueOnce(response('cases', 1, false, 'cursor-2'))
      .mockRejectedValueOnce(new Error('backend failed'));
    render(<DataExportSection />);
    chooseAdvanced();
    selectOnlyCases();
    fireEvent.click(screen.getByRole('button', { name: /export numbered files/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      'admin/export/segment/cancel',
      { scope: 'cases', cursor: 'cursor-2' },
    ));
  });

  it('prevents an empty selection in either mode', () => {
    render(<DataExportSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all export scopes' }));
    expect(screen.getByRole('button', { name: /download zip archive/i })).toBeDisabled();
    chooseAdvanced();
    expect(screen.getByRole('button', { name: /export numbered files/i })).toBeDisabled();
  });
});
