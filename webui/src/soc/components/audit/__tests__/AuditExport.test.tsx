/**
 * The audit export (Round 14 SPEC §4.5.6): the Export menu and its dialog. The range is
 * resolved to absolute UTC instants when the dialog opens; the count, the range shown,
 * the file name and the job all use them; over 100,000 events Export is disabled and
 * "Use last 30 days" is offered only when that range fits; exports always read oldest
 * first; small exports download on the page, larger ones run in the background.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  submit: vi.fn(),
  request: vi.fn(),
  jobsGet: vi.fn(),
  artifact: vi.fn(),
  saveBlob: vi.fn(() => 'agentic-soc-audit.csv'),
  announce: vi.fn(),
  demo: { active: false, confirmed: true, loading: false, status: { mode: 'off' as string, run_id: null as string | null } },
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/api-audit', () => ({
  AUDIT_COUNT_CAP: 100_001,
  listAuditPage: h.list,
  countAudit: h.count,
  submitAuditExport: h.submit,
}));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body?: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    request: h.request,
    api: { jobs: { get: h.jobsGet, artifact: h.artifact } },
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
  };
});
vi.mock('@/soc/jobs/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/jobs/jobs')>()),
  saveBlob: h.saveBlob,
  announceJobAccepted: h.announce,
}));
vi.mock('@/soc/auth', () => ({ useAuth: () => ({ authEnabled: false, hasPermission: () => true }) }));
vi.mock('@/soc/demo', () => ({ useDemo: () => h.demo }));
vi.mock('sonner', () => ({ toast: h.toast }));

import { ApiError } from '@/lib/api';
import { TooltipProvider } from '@/ui/tooltip';
import { RouterProvider } from '@/soc/router';
import Audit from '@/soc/pages/Audit';

import { page, rows } from './audit-fixtures';

const NOW = Date.UTC(2026, 9, 25, 15, 10, 0);

function renderAudit(hash = '#/audit?scope=people&from=now-7d&q=role') {
  window.location.hash = hash;
  return render(
    <TooltipProvider>
      <RouterProvider>
        <Audit />
      </RouterProvider>
    </TooltipProvider>,
  );
}

async function openDialog(format: 'CSV' | 'JSON Lines' = 'CSV') {
  const user = userEvent.setup();
  await screen.findByText('Settings changed 1');
  await user.click(screen.getByRole('button', { name: 'Export' }));
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(`Export ${format}`) }));
  return { user, dialog: await screen.findByRole('dialog') };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  for (const f of [h.list, h.count, h.submit, h.request, h.jobsGet, h.artifact, h.saveBlob, h.announce]) f.mockReset();
  Object.values(h.toast).forEach((f) => f.mockReset());
  h.saveBlob.mockReturnValue('agentic-soc-audit.csv');
  h.demo = { active: false, confirmed: true, loading: false, status: { mode: 'off', run_id: null } };
  h.list.mockResolvedValue(page(rows(3), { total: 1_284 }));
  h.count.mockResolvedValue({ count: 1_284, relation: 'eq' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('the Export menu', () => {
  it('offers CSV, JSON Lines and the full application export', async () => {
    const user = userEvent.setup();
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Export CSV \(spreadsheet\)/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Export JSON Lines \(for a SIEM\)/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Full application export' })).toBeInTheDocument();
  });

  it('is disabled with its reason when the view is empty, and in Demo Mode', async () => {
    const user = userEvent.setup();
    h.list.mockResolvedValue(page([], { total: 0 }));
    renderAudit();
    await screen.findByText('No events match these filters.');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Nothing to export in this view')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Export CSV/ })).toHaveAttribute('aria-disabled', 'true');
    cleanup();
    h.demo = { active: true, confirmed: true, loading: false, status: { mode: 'seeded', run_id: 'r1' } };
    h.list.mockResolvedValue(page(rows(3)));
    renderAudit();
    await screen.findByText('Settings changed 1');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('Audit exports are not available in Demo Mode.')).toBeInTheDocument();
  });
});

describe('the export dialog', () => {
  it('counts the view over absolute instants and states what the file holds', async () => {
    renderAudit();
    const { dialog } = await openDialog();
    expect(await within(dialog).findByRole('heading', { name: 'Export 1,284 events?' })).toBeInTheDocument();
    expect(h.count).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'people',
        q: 'role',
        from: '2026-10-18T15:10:00Z',
        to: '2026-10-25T15:10:00Z',
        cap: 100_001,
      }),
      expect.anything(),
    );
    expect(within(dialog).getByTestId('audit-export-range')).toHaveTextContent('18 Oct 15:10 to 25 Oct 15:10 UTC');
    expect(within(dialog).getByText('Search: "role"')).toBeInTheDocument();
    expect(within(dialog).getByText('Oldest first, times in ISO 8601 UTC')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv');
    expect(dialog).toHaveTextContent('You will be asked to sign in again. This export is recorded in the audit log.');
    expect(within(dialog).getByRole('button', { name: 'Export 1,284 events' })).toBeEnabled();
  });

  it('refuses more than 100,000 events and offers the last 30 days when it fits', async () => {
    h.count.mockResolvedValueOnce({ count: 100_001, relation: 'gte' }).mockResolvedValueOnce({ count: 84_386, relation: 'eq' });
    renderAudit('#/audit?scope=all&from=now-90d');
    const { user, dialog } = await openDialog();
    expect(await within(dialog).findByTestId('audit-export-count')).toHaveTextContent('More than 100,000 events');
    expect(within(dialog).getByRole('button', { name: 'Export' })).toBeDisabled();
    const narrow = await within(dialog).findByRole('button', { name: 'Use last 30 days' });
    expect(h.count).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-09-25T15:10:00Z', to: '2026-10-25T15:10:00Z' }),
      expect.anything(),
    );
    await user.click(narrow);
    expect(within(dialog).getByRole('heading', { name: 'Export 84,386 events?' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('audit-export-range')).toHaveTextContent('25 Sep 15:10 to 25 Oct 15:10 UTC (last 30 days)');
    expect(within(dialog).getByRole('button', { name: 'Export 84,386 events' })).toBeEnabled();
  });

  it('says to narrow the filters when even the last 30 days do not fit', async () => {
    h.count.mockResolvedValue({ count: 100_001, relation: 'gte' });
    renderAudit('#/audit?scope=all&from=now-90d');
    const { dialog } = await openDialog();
    expect(await within(dialog).findByText(/Narrow the filters or the time range/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Use last 30 days' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('submits the job oldest first with the absolute instants, then downloads a small file', async () => {
    h.submit.mockResolvedValue({ job_id: 'job-1', kind: 'audit_export', status: 'succeeded', result: { kind: 'audit_export', artifact_id: 'a1', counts: {} }, failures: [] });
    h.artifact.mockResolvedValue({ blob: new Blob(['x']), contentDisposition: null, contentType: 'text/csv' });
    renderAudit('#/audit?scope=people&from=now-7d&q=role&outcome=denied');
    const { user, dialog } = await openDialog('JSON Lines');
    await within(dialog).findByRole('heading', { name: 'Export 1,284 events?' });
    expect(dialog).toHaveTextContent('.ndjson');
    await user.click(within(dialog).getByRole('button', { name: 'Export 1,284 events' }));
    await waitFor(() => expect(h.submit).toHaveBeenCalled());
    const [params, key] = h.submit.mock.calls[0];
    expect(params).toEqual({
      format: 'jsonl',
      filters: { outcome: 'denied' },
      order: 'asc',
      scope: 'people',
      from: '2026-10-18T15:10:00Z',
      to: '2026-10-25T15:10:00Z',
      q: 'role',
    });
    expect(String(key)).toMatch(/^audit_export-/);
    await waitFor(() => expect(h.saveBlob).toHaveBeenCalledWith(expect.anything(), 'agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.ndjson'));
    expect(h.toast.success).toHaveBeenCalledWith('Audit export downloaded.', expect.anything());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('runs a large export in the background with the usual notice', async () => {
    h.count.mockResolvedValue({ count: 12_000, relation: 'eq' });
    h.submit.mockResolvedValue({ job_id: 'job-2', kind: 'audit_export', status: 'queued', result: null, failures: [] });
    renderAudit();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Export 12,000 events' }));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Audit export started.', expect.anything()));
    expect(h.artifact).not.toHaveBeenCalled();
  });

  it('explains a refusal and keeps the dialog open', async () => {
    h.submit.mockRejectedValue(new ApiError(429, 'busy', { detail: { code: 'job_busy' } }));
    renderAudit();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Export 1,284 events' }));
    expect(await within(dialog).findByText('You already have an audit export running. Wait for it to finish, then try again.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('moves focus into the dialog, onto the chosen format once counted, and back to Export on Esc', async () => {
    let finishCount: (value: { count: number; relation: 'eq' }) => void = () => {};
    h.count.mockImplementationOnce(() => new Promise((resolve) => (finishCount = resolve)));
    renderAudit();
    const { user, dialog } = await openDialog();
    // While the count is out, the dialog itself holds focus: never the page behind it.
    await waitFor(() => expect(dialog).toHaveFocus());
    finishCount({ count: 1_284, relation: 'eq' });
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /CSV \(spreadsheet\)/ })).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toHaveFocus());
  });

  it('lets a person leave a small export to finish in the background', async () => {
    h.submit.mockResolvedValue({ job_id: 'job-3', kind: 'audit_export', status: 'running', result: null, failures: [] });
    h.jobsGet.mockResolvedValue({ job_id: 'job-3', kind: 'audit_export', status: 'succeeded', result: { kind: 'audit_export', artifact_id: 'a3', counts: {} }, failures: [] });
    h.artifact.mockResolvedValue({ blob: new Blob(['x']), contentDisposition: null, contentType: 'text/csv' });
    renderAudit();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Export 1,284 events' }));
    const leave = await within(dialog).findByRole('button', { name: 'Continue in the background' });
    expect(leave).toBeEnabled();
    await user.click(leave);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.toast.info).toHaveBeenCalledWith('The export is still running.', expect.objectContaining({ action: expect.anything() }));
    // The wait it left stops: no download lands on the page afterwards.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(h.saveBlob).not.toHaveBeenCalled();
  });

  it('closes on Esc while it waits, with the same background notice', async () => {
    h.submit.mockResolvedValue({ job_id: 'job-4', kind: 'audit_export', status: 'queued', result: null, failures: [] });
    h.jobsGet.mockReturnValue(new Promise(() => {}));
    renderAudit();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Export 1,284 events' }));
    await within(dialog).findByRole('button', { name: 'Continue in the background' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.toast.info).toHaveBeenCalledWith('The export is still running.', expect.anything());
  });

  it('never says the export did not run once the job was accepted', async () => {
    h.submit.mockResolvedValue({ job_id: 'job-5', kind: 'audit_export', status: 'running', result: null, failures: [] });
    h.jobsGet.mockRejectedValue(new ApiError(502, 'Bad gateway'));
    renderAudit();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Export 1,284 events' }));
    await waitFor(
      () => expect(h.toast.info).toHaveBeenCalledWith('The export is running. The file will be in Jobs.', expect.objectContaining({ action: expect.anything() })),
      { timeout: 3_000 },
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('The export did not run.')).toBeNull();
  });

  it('points to Jobs when the finished file cannot be downloaded here', async () => {
    h.submit.mockResolvedValue({ job_id: 'job-6', kind: 'audit_export', status: 'succeeded', result: { kind: 'audit_export', artifact_id: 'a6', counts: {} }, failures: [] });
    h.artifact.mockRejectedValue(new ApiError(503, 'unavailable'));
    renderAudit();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Export 1,284 events' }));
    await waitFor(() => expect(h.toast.info).toHaveBeenCalledWith('The export finished. Download the file from Jobs.', expect.anything()));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a job that ended without its file did not finish', async () => {
    h.submit.mockResolvedValue({ job_id: 'job-7', kind: 'audit_export', status: 'failed', result: null, failures: [{ reason: 'audit_export_too_large' }] });
    renderAudit();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Export 1,284 events' }));
    expect(await within(dialog).findByText('The export did not finish.')).toBeInTheDocument();
    expect(within(dialog).getByText('The export failed: audit_export_too_large')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('never shows an em dash, an en dash or the retired word', async () => {
    renderAudit();
    const { dialog } = await openDialog();
    await within(dialog).findByRole('heading', { name: 'Export 1,284 events?' });
    const text = dialog.textContent ?? '';
    expect(text).not.toMatch(/[–—]/);
    expect(text.toLowerCase()).not.toContain('playbook');
  });
});
