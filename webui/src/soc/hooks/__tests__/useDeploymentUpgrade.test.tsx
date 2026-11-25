import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  SystemUpdateJob,
  SystemUpdatePreflightResponse,
  SystemUpdateStatusResponse,
} from '@/lib/types';
import { useDeploymentUpgrade } from '@/soc/hooks/useDeploymentUpgrade';
import { ApiError } from '@/lib/api';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const release = {
  release_id: 'v0.1.3',
  version: '0.1.3',
  tag: 'v0.1.3',
  commit_sha: 'd'.repeat(40),
  channel: 'stable' as const,
  repository_url: 'https://github.com/ARYDESTROYER/Kavach-AgenticSOC',
};

const observedRelease = {
  release_id: 'v0.1.3',
  version: '0.1.3',
  channel: 'stable' as const,
  provenance: 'mutable_stable_branch_metadata' as const,
  verification: 'signed_supervisor_preflight_required' as const,
};

const baseJob: SystemUpdateJob = {
  job_id: 'job-1234567890',
  release_id: release.release_id,
  status: 'running',
  stage: 'pulling_images',
  progress: 24,
  message: 'Preparing verified component images.',
};

const capability: SystemUpdateStatusResponse['capability'] = {
  supported: true,
  blockers: [],
  warnings: [],
  scope: {
    deployment_profile: 'standalone_compose_postgres_v1',
    state_backend: 'postgres',
    components_updated: ['updater', 'backend', 'webui', 'help_center'],
    infrastructure_not_updated: ['postgres', 'redis'],
  },
  supervisor: {
    available: true,
    protocol_version: '1',
    updater_version: '0.1.2',
    min_protocol_version: '1',
  },
  bootstrap_required: false,
};

function status(
  patch: Partial<SystemUpdateStatusResponse> = {},
): SystemUpdateStatusResponse {
  return {
    capability,
    current: { version: '0.1.2', channel: 'testing', commit_sha: 'abc123' },
    release_discovery: {
      state: 'candidate_observed',
      checked_at: '2026-08-03T03:45:00Z',
      branch: 'main',
      observed_release: observedRelease,
      issue: null,
    },
    active_job: null,
    last_job: null,
    checked_at: '2026-08-03T03:45:00Z',
    ...patch,
  };
}

const preflight: SystemUpdatePreflightResponse = {
  preflight_token: 'server-bound-token',
  expires_at: '2026-08-03T04:00:00Z',
  release,
  checks: [{ code: 'signature', label: 'Release signature', status: 'pass', detail: 'Verified.' }],
  blockers: [],
  warnings: [],
  components: [
    {
      id: 'backend',
      label: 'Backend',
      current_version: '0.1.2',
      target_version: '0.1.3',
      scope: 'updated',
      will_update: true,
    },
  ],
  backup: {
    required: true,
    kind: 'postgres_custom_format',
    state: 'planned',
    verified: false,
    description: 'A verified PostgreSQL backup is created before replacement.',
  },
  rollback: {
    automatic: true,
    supported: true,
    state: 'planned',
    description: 'The previous verified release is restored automatically on failure.',
  },
};

function deps(statusResponse = status()) {
  return {
    status: vi.fn(async () => statusResponse),
    preflight: vi.fn(async () => preflight),
    start: vi.fn(async () => baseJob),
    job: vi.fn(async () => baseJob),
    cancel: vi.fn(async () => ({ ...baseJob, status: 'cancelled' as const })),
    rollback: vi.fn(async () => ({ ...baseJob, status: 'rolling_back' as const, stage: 'rolling_back' as const })),
    receipt: vi.fn(async () => ({
      job_id: baseJob.job_id,
      release_id: release.release_id,
      status: 'succeeded' as const,
      before: { version: '0.1.2', commit_sha: 'abc123' },
      after: { version: '0.1.3', commit_sha: 'deadbeef' },
      components: ['backend', 'webui', 'help_center'],
      backup_id: 'backup-1',
      rollback_performed: false,
      started_at: '2026-08-03T03:30:00Z',
      completed_at: '2026-08-03T03:35:00Z',
    })),
  };
}

afterEach(() => vi.useRealTimers());

describe('useDeploymentUpgrade', () => {
  it('does not probe or expose update authority when the strict auth/RBAC gate is off', async () => {
    const dependencies = deps();
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: false, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    expect(result.current.status).toBeNull();
    expect(result.current.checking).toBe(false);
    expect(dependencies.status).not.toHaveBeenCalled();
  });

  it('submits only the server release id, preflight token, and distinct operation keys', async () => {
    const dependencies = deps();
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    await waitFor(() =>
      expect(result.current.status?.release_discovery.observed_release).toEqual(observedRelease),
    );

    await act(async () => result.current.prepare());
    expect(dependencies.preflight).toHaveBeenCalledTimes(1);
    expect(dependencies.preflight.mock.calls[0]?.[0]).toBe(release.release_id);
    expect(dependencies.preflight.mock.calls[0]?.[1]).toEqual(expect.any(String));
    const preflightKey = dependencies.preflight.mock.calls[0]?.[1];

    await act(async () => result.current.start());
    const startKey = dependencies.start.mock.calls[0]?.[2];
    expect(dependencies.start).toHaveBeenCalledWith(
      release.release_id,
      preflight.preflight_token,
      expect.any(String),
    );
    expect(startKey).not.toBe(preflightKey);
    expect(result.current.job).toEqual(baseJob);
    expect(result.current.progressOpen).toBe(true);
  });

  it('reuses the exact preflight operation key after a transient request failure', async () => {
    const dependencies = deps();
    dependencies.preflight
      .mockRejectedValueOnce(new ApiError(0, 'Connection interrupted'))
      .mockResolvedValueOnce(preflight);
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => result.current.prepare());
    await act(async () => result.current.prepare());

    expect(dependencies.preflight).toHaveBeenCalledTimes(2);
    expect(dependencies.preflight.mock.calls[1]?.[1]).toBe(
      dependencies.preflight.mock.calls[0]?.[1],
    );
  });

  it('reuses the exact start operation key after a transient request failure', async () => {
    const dependencies = deps();
    dependencies.start
      .mockRejectedValueOnce(new ApiError(0, 'Connection interrupted'))
      .mockResolvedValueOnce(baseJob);
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    await waitFor(() => expect(result.current.status).not.toBeNull());
    await act(async () => result.current.prepare());

    await act(async () => result.current.start());
    await act(async () => result.current.start());

    expect(dependencies.start).toHaveBeenCalledTimes(2);
    expect(dependencies.start.mock.calls[1]?.[2]).toBe(dependencies.start.mock.calls[0]?.[2]);
    expect(dependencies.start.mock.calls[0]?.[2]).not.toBe(
      dependencies.preflight.mock.calls[0]?.[1],
    );
  });

  it('does not start when the server-bound preflight reports a blocker', async () => {
    const dependencies = deps();
    dependencies.preflight.mockResolvedValue({
      ...preflight,
      blockers: [{ code: 'backup', message: 'Backup is unavailable.', remediation: 'Repair PostgreSQL access.' }],
    });
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    await waitFor(() => expect(result.current.status).not.toBeNull());
    await act(async () => result.current.prepare());
    await act(async () => result.current.start());
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it('resumes a durable active job returned by status and opens its progress sheet', async () => {
    const dependencies = deps(status({ active_job: baseJob }));
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    await waitFor(() => expect(result.current.job?.job_id).toBe(baseJob.job_id));
    expect(result.current.progressOpen).toBe(true);
  });

  it('treats an updater-driven backend restart as reconnecting and keeps the durable job', async () => {
    const dependencies = deps(status({ active_job: baseJob }));
    dependencies.job.mockRejectedValue(new ApiError(0, 'Cannot reach backend'));
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 10_000 }),
    );
    await waitFor(() => expect(result.current.job?.job_id).toBe(baseJob.job_id));
    await waitFor(() => expect(dependencies.job).toHaveBeenCalledWith(baseJob.job_id, expect.any(AbortSignal)));
    await waitFor(() => expect(result.current.connection).toBe('reconnecting'));
    expect(result.current.job).toEqual(baseJob);
    expect(result.current.error).toBeNull();
  });

  it('requests rollback with only the durable job id and an opaque idempotency key', async () => {
    const succeeded = {
      ...baseJob,
      status: 'succeeded' as const,
      stage: 'completed' as const,
      progress: 100,
      rollback: preflight.rollback,
    };
    const dependencies = deps(status({ active_job: null, last_job: succeeded }));
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    await waitFor(() => expect(result.current.job?.status).toBe('succeeded'));
    await act(async () => result.current.rollback());
    expect(dependencies.rollback).toHaveBeenCalledWith(baseJob.job_id, expect.any(String));
    expect(result.current.job?.status).toBe('rolling_back');
    expect(result.current.progressOpen).toBe(true);
  });

  it('reuses the exact cancel operation key after a transient request failure', async () => {
    const dependencies = deps(status({ active_job: baseJob }));
    dependencies.cancel
      .mockRejectedValueOnce(new ApiError(0, 'Connection interrupted'))
      .mockResolvedValueOnce({ ...baseJob, status: 'cancelled' as const });
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    await waitFor(() => expect(result.current.job?.status).toBe('running'));

    await act(async () => result.current.cancel());
    await act(async () => result.current.cancel());

    expect(dependencies.cancel).toHaveBeenCalledTimes(2);
    expect(dependencies.cancel.mock.calls[1]?.[1]).toBe(
      dependencies.cancel.mock.calls[0]?.[1],
    );
  });

  it('reuses the exact rollback operation key after a transient request failure', async () => {
    const succeeded = {
      ...baseJob,
      status: 'succeeded' as const,
      stage: 'completed' as const,
      progress: 100,
      rollback: preflight.rollback,
    };
    const dependencies = deps(status({ last_job: succeeded }));
    dependencies.rollback
      .mockRejectedValueOnce(new ApiError(0, 'Connection interrupted'))
      .mockResolvedValueOnce({
        ...succeeded,
        status: 'rolling_back' as const,
        stage: 'rolling_back' as const,
      });
    const { result } = renderHook(() =>
      useDeploymentUpgrade({ enabled: true, dependencies, idlePollMs: 0, activePollMs: 0 }),
    );
    await waitFor(() => expect(result.current.job?.status).toBe('succeeded'));

    await act(async () => result.current.rollback());
    await act(async () => result.current.rollback());

    expect(dependencies.rollback).toHaveBeenCalledTimes(2);
    expect(dependencies.rollback.mock.calls[1]?.[1]).toBe(
      dependencies.rollback.mock.calls[0]?.[1],
    );
  });

  it('requests browser activation only after a succeeded job reports a newer running pair', async () => {
    const succeeded = { ...baseJob, status: 'succeeded' as const, stage: 'completed' as const, progress: 100 };
    const dependencies = deps(
      status({
        current: { version: '0.1.3', channel: 'stable', commit_sha: 'deadbeef' },
        release_discovery: {
          state: 'current',
          checked_at: '2026-08-03T03:45:00Z',
          branch: 'main',
          observed_release: null,
          issue: null,
        },
        last_job: succeeded,
      }),
    );
    const { result } = renderHook(() =>
      useDeploymentUpgrade({
        enabled: true,
        dependencies,
        idlePollMs: 0,
        activePollMs: 0,
        consoleIdentity: {
          version: '0.1.2',
          channel: 'testing',
          commitSha: 'abc123',
          buildTime: '2026-08-01T00:00:00Z',
        },
      }),
    );
    await waitFor(() => expect(result.current.job?.status).toBe('succeeded'));
    expect(result.current.needsBrowserActivation).toBe(true);
    await waitFor(() => expect(dependencies.receipt).toHaveBeenCalledWith(baseJob.job_id));
  });

  it('considers the Console current only for an exact, fully stamped Stable pair', async () => {
    const succeeded = { ...baseJob, status: 'succeeded' as const, stage: 'completed' as const, progress: 100 };
    const dependencies = deps(
      status({
        current: { version: '0.1.3', channel: 'stable', commit_sha: 'deadbeef' },
        release_discovery: {
          state: 'current',
          checked_at: '2026-08-03T03:45:00Z',
          branch: 'main',
          observed_release: null,
          issue: null,
        },
        last_job: succeeded,
      }),
    );
    const { result } = renderHook(() =>
      useDeploymentUpgrade({
        enabled: true,
        dependencies,
        idlePollMs: 0,
        activePollMs: 0,
        consoleIdentity: {
          version: '0.1.3',
          channel: 'stable',
          commitSha: 'deadbeef',
          buildTime: '2026-08-03T03:35:00Z',
        },
      }),
    );
    await waitFor(() => expect(result.current.job?.status).toBe('succeeded'));
    expect(result.current.needsBrowserActivation).toBe(false);
  });

  it('fails closed when a supposedly installed pair has unknown provenance', async () => {
    const succeeded = { ...baseJob, status: 'succeeded' as const, stage: 'completed' as const, progress: 100 };
    const dependencies = deps(
      status({
        current: { version: '0.1.3', channel: 'stable', commit_sha: 'unknown' },
        release_discovery: {
          state: 'current',
          checked_at: '2026-08-03T03:45:00Z',
          branch: 'main',
          observed_release: null,
          issue: null,
        },
        last_job: succeeded,
      }),
    );
    const { result } = renderHook(() =>
      useDeploymentUpgrade({
        enabled: true,
        dependencies,
        idlePollMs: 0,
        activePollMs: 0,
        consoleIdentity: {
          version: '0.1.3',
          channel: 'stable',
          commitSha: 'unknown',
          buildTime: 'unknown',
        },
      }),
    );
    await waitFor(() => expect(result.current.job?.status).toBe('succeeded'));
    expect(result.current.needsBrowserActivation).toBe(true);
  });
});
