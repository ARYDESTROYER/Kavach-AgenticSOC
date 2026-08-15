import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { getMock, postMock, submitJobMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  submitJobMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, jobs: { submit: submitJobMock } },
}));

import type {
  Preferences,
  StorageLifecycleConfig,
  StorageLifecycleStatus,
} from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { StorageLifecycleSection } from '../storage';

const POLICY: StorageLifecycleConfig = {
  enabled: true,
  hot_days: 180,
  warm_days: 90,
  archive_target: 'aws_glacier',
  glacier_storage_class: 'GLACIER',
  delete_after_archive: false,
};

const STATUS: StorageLifecycleStatus = {
  state_backend: 'elasticsearch',
  effective_state: 'not_configured',
  policy_name: 'tlsoc-agent-ledgers-hot-warm',
  capabilities: {
    supported: true,
    can_manage: true,
    privileged: true,
    index_privileged: true,
    hot_ready: true,
    warm_ready: true,
    roles: ['data_hot', 'data_warm'],
  },
  policy: { ...POLICY, archive_from_days: 270 },
  tiers: [
    { id: 'hot', label: 'Hot', from_day: 0, until_day: 180, enforcement: 'managed', status: 'active' },
    { id: 'warm', label: 'Warm', from_day: 180, until_day: 270, enforcement: 'managed', status: 'not_configured' },
    { id: 'archive', label: 'Glacier archive', from_day: 270, until_day: null, enforcement: 'advisory', status: 'not_configured' },
  ],
  targets: [
    { id: 'audit', label: 'Audit ledger', enforcement: 'managed', reason: 'Native ILM is available.' },
    { id: 'usage', label: 'Usage & cost ledger', enforcement: 'managed', reason: 'Native ILM is available.' },
    { id: 'cases', label: 'Cases', enforcement: 'hot_only', reason: 'Cases remain mutable.' },
    { id: 'live_metadata', label: 'Configuration, cursors, users and sessions', enforcement: 'hot_only', reason: 'Live operational metadata stays available.' },
    { id: 'source_logs', label: 'Connected source logs', enforcement: 'external', reason: 'Retention stays under the SIEM owner.' },
  ],
  archive: {
    enforcement: 'advisory',
    status: 'not_configured',
    storage_class: 'GLACIER',
    reason: 'An independent archive pipeline is required.',
  },
  delete_enabled: false,
};

function renderSection({
  draft = POLICY,
  persisted = POLICY,
  update = vi.fn(),
  readOnly = false,
}: {
  draft?: StorageLifecycleConfig;
  persisted?: StorageLifecycleConfig;
  update?: ReturnType<typeof vi.fn>;
  readOnly?: boolean;
} = {}) {
  const result = render(
    <TooltipProvider>
      <StorageLifecycleSection
        prefs={{ storage_lifecycle: draft } as Preferences}
        persistedPrefs={{ storage_lifecycle: persisted } as Preferences}
        update={update}
        readOnly={readOnly}
      />
    </TooltipProvider>,
  );
  return { ...result, update };
}

describe('StorageLifecycleSection', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    getMock.mockResolvedValue(STATUS);
    postMock.mockResolvedValue(STATUS);
    submitJobMock.mockReset().mockResolvedValue({
      job_id: 'job-storage', kind: 'storage_lifecycle_apply', actor: 'operator',
      created_at: '2026-08-13T00:00:00Z', status: 'queued',
      progress: { done: 0, total: 1, unit: 'apply' }, failures: [], failure_count: 0,
      failures_truncated: 0, request_fingerprint: 'e'.repeat(64), params: {}, cancel_requested: false,
    });
  });

  it('shows the effective 180-day Hot, 90-day Warm, and truthful archive boundary', async () => {
    renderSection();

    await screen.findByTestId('storage-lifecycle-status');
    expect(screen.getAllByText('First 180 days')).toHaveLength(2);
    expect(screen.getAllByText('Next 90 days · until day 270')).toHaveLength(2);
    expect(screen.getAllByText('From day 270')).toHaveLength(2);
    expect(screen.getByText('Desired · not configured.')).toBeInTheDocument();
    expect(screen.getByText('Connected source logs')).toBeInTheDocument();
    expect(screen.getByText('external')).toBeInTheDocument();
    expect(screen.getByText('Cases')).toBeInTheDocument();
    expect(screen.getAllByText('hot only').length).toBeGreaterThan(0);
    expect(screen.getByText(/Automatic deletion is off/i)).toBeInTheDocument();
  });

  it('edits desired policy through the page-wide preferences draft', async () => {
    const { update } = renderSection();
    await screen.findByTestId('storage-lifecycle-status');

    const hotDays = screen.getByLabelText('Hot retention (days)');
    fireEvent.focus(hotDays);
    fireEvent.change(hotDays, { target: { value: '200' } });
    fireEvent.blur(hotDays);

    expect(update).toHaveBeenCalledWith({
      storage_lifecycle: { ...POLICY, hot_days: 200 },
    });
  });

  it('previews the draft without applying infrastructure', async () => {
    renderSection();
    await screen.findByTestId('storage-lifecycle-status');

    fireEvent.click(screen.getByRole('button', { name: 'Preview draft' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('storage/lifecycle/preview', POLICY),
    );
    expect(postMock).not.toHaveBeenCalledWith('storage/lifecycle/apply');
  });

  it('locks Apply while the draft differs from the persisted policy', async () => {
    renderSection({ draft: { ...POLICY, hot_days: 200 }, persisted: POLICY });
    await screen.findByTestId('storage-lifecycle-status');

    expect(screen.getByRole('button', { name: 'Apply saved policy' })).toBeDisabled();
    expect(screen.getByText(/Save the desired policy first/i)).toBeInTheDocument();
  });

  it('applies only a backend-confirmed persisted policy', async () => {
    renderSection();
    await screen.findByTestId('storage-lifecycle-status');
    const apply = screen.getByRole('button', { name: 'Apply saved policy' });
    expect(apply).toBeEnabled();

    fireEvent.click(apply);
    await waitFor(() => expect(submitJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'storage_lifecycle_apply',
      params: { acknowledge: true, policy: POLICY },
    })));
    expect(postMock).not.toHaveBeenCalledWith('storage/lifecycle/apply');
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('allows explicit disable when management remains available but Warm is degraded', async () => {
    const disabledPolicy = { ...POLICY, enabled: false };
    getMock.mockResolvedValue({
      ...STATUS,
      effective_state: 'pending_disable',
      capabilities: {
        ...STATUS.capabilities,
        supported: false,
        can_manage: true,
        warm_ready: false,
      },
      policy: { ...disabledPolicy, archive_from_days: 270 },
    } satisfies StorageLifecycleStatus);
    renderSection({ draft: disabledPolicy, persisted: disabledPolicy });

    await screen.findByTestId('storage-lifecycle-status');
    const apply = screen.getByRole('button', { name: 'Apply saved policy' });
    expect(apply).toBeEnabled();

    fireEvent.click(apply);
    await waitFor(() => expect(submitJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'storage_lifecycle_apply',
      params: { acknowledge: true, policy: disabledPolicy },
    })));
  });

  it('keeps native Apply unavailable for an advisory PostgreSQL backend', async () => {
    getMock.mockResolvedValue({
      ...STATUS,
      state_backend: 'postgres',
      effective_state: 'advisory',
      policy_name: null,
      capabilities: { supported: false, reason: 'Native lifecycle is unavailable.' },
    } satisfies StorageLifecycleStatus);
    renderSection();

    await screen.findByTestId('storage-lifecycle-status');
    expect(screen.getByRole('button', { name: 'Apply saved policy' })).toBeDisabled();
    expect(screen.getByText(/PostgreSQL reports this policy as advisory or unavailable/i)).toBeInTheDocument();
  });

  it('keeps Apply locked and explains the deployment read-only state', async () => {
    renderSection({ readOnly: true });

    await screen.findByTestId('storage-lifecycle-status');
    expect(screen.getByRole('button', { name: 'Apply saved policy' })).toBeDisabled();
    expect(screen.getByText(/Settings are read-only in this deployment/i)).toBeInTheDocument();
  });

  it('keeps Apply locked when the authoritative status refresh fails', async () => {
    getMock.mockRejectedValue(new Error('offline'));
    renderSection();

    expect(await screen.findByText('Storage status unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply saved policy' })).toBeDisabled();
    expect(screen.getByText(/Reload storage status before applying/i)).toBeInTheDocument();
  });
});
