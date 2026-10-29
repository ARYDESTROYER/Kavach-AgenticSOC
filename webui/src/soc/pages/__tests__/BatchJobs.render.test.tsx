import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

import type { BackgroundJob, BackgroundJobsResponse } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  cancelJob: vi.fn(),
  artifact: vi.fn(),
  genericGet: vi.fn(),
  getConfig: vi.fn(),
  putConfig: vi.fn(),
  permissions: new Set<string>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.genericGet,
      jobs: {
        ...actual.api.jobs,
        list: mocks.listJobs,
        cancel: mocks.cancelJob,
        artifact: mocks.artifact,
      },
      batch: { getConfig: mocks.getConfig, putConfig: mocks.putConfig },
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'tester',
    authEnabled: true,
    hasPermission: (resource: string, action: string) =>
      mocks.permissions.has(`${resource}:${action}`),
  }),
}));

vi.mock('@/lib/useEventStream', () => ({
  useEventStream: () => ({ live: false }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import BatchJobs from '../BatchJobs';

function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    job_id: 'job-export-1',
    kind: 'data_export_archive',
    actor: 'tester',
    created_at: '2026-08-13T10:00:00Z',
    started_at: '2026-08-13T10:00:01Z',
    finished_at: null,
    status: 'running',
    progress: { done: 2, total: 6, unit: 'scopes' },
    failures: [],
    failure_count: 0,
    failures_truncated: 0,
    request_fingerprint: 'fp',
    result: null,
    params: { scopes: ['cases'] },
    cancel_requested: false,
    ...overrides,
  };
}

function response(overrides: Partial<BackgroundJobsResponse> = {}): BackgroundJobsResponse {
  return {
    jobs: [],
    total: 0,
    limit: 100,
    offset: 0,
    related: null,
    system_workers: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <TooltipProvider>
      <BatchJobs />
    </TooltipProvider>,
  );
}

describe('unified Jobs surface', () => {
  beforeEach(() => {
    mocks.permissions = new Set();
    mocks.listJobs.mockReset().mockResolvedValue(response());
    mocks.cancelJob.mockReset();
    mocks.artifact.mockReset();
    mocks.genericGet.mockReset();
    mocks.getConfig.mockReset().mockResolvedValue({
      config: {
        enabled: false,
        severity_floor: 3,
        providers: ['anthropic', 'openai'],
        flex: false,
      },
    });
    mocks.putConfig.mockReset();
  });

  it('shows self-owned application jobs to an ordinary authenticated actor', async () => {
    mocks.listJobs.mockResolvedValue(
      response({ jobs: [job()], total: 1 }),
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
    expect(await screen.findByText('job-export-1')).toBeInTheDocument();
    expect(screen.getByText('Data export archive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByText('Related LLM Batch jobs')).not.toBeInTheDocument();
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it('shows the related LLM Batch projection and policy only with models:read', async () => {
    mocks.permissions = new Set(['models:read']);
    mocks.listJobs.mockResolvedValue(
      response({
        related: {
          total: 1,
          llm_batches: [
            {
              id: 'batch-abc123',
              provider: 'anthropic',
              state: 'retrieved',
              model: 'claude-opus-4-8',
              discount: 0.5,
              requests: 10,
              retrieved: 10,
              submitted_at: '2026-08-13T09:00:00Z',
              polled_at: '2026-08-13T09:30:00Z',
            },
          ],
        },
      }),
    );
    renderPage();

    expect(await screen.findByText('Related LLM Batch jobs')).toBeInTheDocument();
    expect(screen.getByText('batch-abc123')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4-8')).toBeInTheDocument();
    expect(screen.getByText('50% off')).toBeInTheDocument();
    // D30: the discounted-inference settings moved to their own Settings section (General,
    // Discounted inference, as built); Jobs keeps one line that names it and links there,
    // and no longer reads the policy itself.
    const moved = screen.getByTestId('jobs-discounted-inference-moved');
    expect(moved).toHaveTextContent('Discounted inference settings moved to Settings, General, Discounted inference.');
    expect(within(moved).getByRole('link', { name: 'Settings, General, Discounted inference' })).toHaveAttribute(
      'href',
      '#/settings?s=discounted-inference',
    );
    expect(screen.queryByRole('switch', { name: /prefer discounted alert inference/i })).toBeNull();
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it('reads like the Overview (Round 14): title, help and Refresh in the header, every module on a panel', async () => {
    mocks.permissions = new Set(['models:read']);
    renderPage();
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Jobs' });
    const header = h1.closest('[data-page-header]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'About Jobs' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Refresh jobs' })).toBeInTheDocument();
    const own = await screen.findByRole('region', { name: 'Your jobs' });
    expect(own).toHaveClass('surface-panel');
    // An empty list is the empty state on the panel, never a header row over nothing.
    expect(within(own).queryByRole('columnheader')).toBeNull();
    expect(within(own).getByText('No application jobs yet')).toBeInTheDocument();
    // The Batch figures sit inside the Batch panel, above its table, never as a
    // free-standing strip that reads as a summary of the whole page.
    const batch = screen.getByTestId('jobs-llm-batch');
    const summary = within(batch).getByRole('group', { name: 'Related LLM Batch summary' });
    const body = within(batch).getByText('No LLM Batch jobs yet');
    expect(summary.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('group', { name: 'Related LLM Batch summary' })).toHaveLength(1);
    expect(document.querySelector('[data-kpi-strip]')).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/playbook/i);
  });

  it('says "never" for a worker that has not succeeded yet, never a dash', async () => {
    mocks.permissions = new Set(['automation:read']);
    mocks.listJobs.mockResolvedValue(
      response({
        system_workers: {
          scheduler_runtime_running: false,
          workers: {
            baseline_producer: {
              enabled: true,
              gated: false,
              running: false,
              cadence: 'on_ingest',
              last_attempt_at: null,
              last_success_at: null,
              last_error: '',
              processed: 0,
            },
          },
        },
      }),
    );
    renderPage();
    const section = await screen.findByRole('region', { name: 'System workers' });
    expect(within(section).getByText(/last success never/)).toBeInTheDocument();
    // The schedule in words, never the raw token.
    expect(within(section).getByText(/^On every ingest · 0 processed/)).toBeInTheDocument();
    expect(section).not.toHaveTextContent('on_ingest');
    expect(within(section).getByText('Scheduler unavailable')).toBeInTheDocument();
  });

  it('shows automation-authorized worker health without turning workers into personal jobs', async () => {
    mocks.permissions = new Set(['automation:read']);
    mocks.listJobs.mockResolvedValue(
      response({
        system_workers: {
          scheduler_runtime_running: true,
          workers: {
            campaign_reconcile: {
              enabled: true,
              gated: false,
              running: false,
              cadence: 'daily',
              last_attempt_at: '2026-08-13T08:00:00Z',
              last_success_at: '2026-08-13T08:00:00Z',
              last_error: '',
              processed: 4,
            },
          },
        },
      }),
    );
    renderPage();

    const section = await screen.findByRole('region', { name: 'System workers' });
    expect(within(section).getByText('Scheduler running')).toBeInTheDocument();
    expect(within(section).getByText('Campaign reconcile')).toBeInTheDocument();
    expect(within(section).getByText(/never personal Inbox notifications/i)).toBeInTheDocument();
    expect(screen.getByText('No application jobs yet')).toBeInTheDocument();
    expect(mocks.genericGet).not.toHaveBeenCalledWith(
      'notifications/inbox',
      expect.anything(),
    );
  });

  it('exposes Download strictly when the terminal job has an artifact id', async () => {
    mocks.listJobs.mockResolvedValue(
      response({
        jobs: [
          job({
            job_id: 'job-no-artifact',
            status: 'succeeded',
            finished_at: '2026-08-13T10:01:00Z',
            result: { kind: 'data_export_archive', counts: { total: 1, succeeded: 1 } },
          }),
          job({
            job_id: 'job-with-artifact',
            status: 'succeeded',
            finished_at: '2026-08-13T10:01:00Z',
            result: {
              kind: 'data_export_archive',
              artifact_id: 'artifact-1',
              counts: { total: 1, succeeded: 1 },
            },
          }),
        ],
        total: 2,
      }),
    );
    renderPage();

    await screen.findByText('job-no-artifact');
    // Each Download names its job, so two rows never offer two identical controls.
    expect(screen.getAllByRole('button', { name: /^Download/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Download Data export archive job-with-artifact' })).toBeInTheDocument();
  });

  it('links a finished audit export into the audit log, in the view it holds (SPEC §4.5.8)', async () => {
    const exported = (id: string, overrides: Partial<BackgroundJob> = {}) =>
      job({
        job_id: id,
        kind: 'audit_export',
        status: 'succeeded',
        finished_at: '2026-10-29T17:58:20Z',
        progress: { done: 12, total: 12, unit: 'events' },
        result: { kind: 'audit_export', artifact_id: `a-${id}`, counts: { events: 12 } },
        params: {
          format: 'csv',
          order: 'asc',
          scope: 'people',
          from: '2026-09-29T17:58:15Z',
          to: '2026-10-29T17:58:15Z',
          q: 'Admin',
          filters: { outcome: 'denied' },
        },
        ...overrides,
      });
    mocks.listJobs.mockResolvedValue(
      response({
        jobs: [
          exported('job-audit-1'),
          exported('job-audit-2', { status: 'running', finished_at: null, result: null }),
        ],
        total: 2,
      }),
    );
    renderPage();

    await screen.findByText('job-audit-1');
    // A navigation is a link, never a button that changes the hash (SPEC §3.3).
    const link = screen.getByRole('link', { name: 'Open audit log for Audit export job-audit-1' });
    expect(link).toHaveTextContent('Open audit log');
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('#/audit?')).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(href.slice('#/audit?'.length)))).toEqual({
      scope: 'people',
      from: '2026-09-29T17:58:15Z',
      to: '2026-10-29T17:58:15Z',
      q: 'Admin',
      outcome: 'denied',
    });
    // Only a finished export links; a running one offers Cancel only.
    expect(screen.getAllByRole('link', { name: /^Open audit log/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Download Audit export job-audit-1' })).toBeInTheDocument();
  });

  it('keeps a named blocking state until the first authoritative snapshot', async () => {
    mocks.listJobs.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByRole('status', { name: 'Loading jobs' })).toBeInTheDocument();
  });

  it('surfaces a retry affordance when the unified registry cannot load', async () => {
    mocks.listJobs.mockRejectedValue(new Error('offline'));
    renderPage();
    expect(await screen.findByText('Could not load jobs')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
  });
});
