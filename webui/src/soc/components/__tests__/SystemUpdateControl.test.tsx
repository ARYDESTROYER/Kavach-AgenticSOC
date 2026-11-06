import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SystemUpdateJob,
  SystemUpdatePreflightResponse,
  SystemUpdateStatusResponse,
} from '@/lib/types';
import type { DeploymentUpgradeState } from '@/soc/hooks/useDeploymentUpgrade';

const motion = vi.hoisted(() => ({ reduced: true }));
vi.mock('@/soc/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => motion.reduced }));
vi.mock('@/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

import {
  SystemUpdateControl,
  systemUpdateTriggerPresentation,
} from '../SystemUpdateControl';

const release = {
  release_id: 'v0.1.3',
  version: '0.1.3',
  tag: 'v0.1.3',
  commit_sha: 'd'.repeat(40),
  channel: 'stable' as const,
  repository_url: 'https://github.com/ARYDESTROYER/Agentic-Kibana',
};

const observedRelease = {
  release_id: 'v0.1.3',
  version: '0.1.3',
  channel: 'stable' as const,
  provenance: 'mutable_stable_branch_metadata' as const,
  verification: 'signed_supervisor_preflight_required' as const,
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
  supervisor: { available: true, protocol_version: '1', updater_version: '0.1.2' },
  bootstrap_required: false,
};

const status: SystemUpdateStatusResponse = {
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
};

const preflight: SystemUpdatePreflightResponse = {
  preflight_token: 'bound-token',
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
    description: 'A verified backup is created before replacement.',
  },
  rollback: {
    automatic: true,
    supported: true,
    state: 'planned',
    description: 'The previous release is restored automatically if verification fails.',
  },
};

function upgrade(patch: Partial<DeploymentUpgradeState> = {}): DeploymentUpgradeState {
  return {
    checking: false,
    preparing: false,
    starting: false,
    status,
    job: null,
    preflight: null,
    receipt: null,
    error: null,
    connection: 'connected',
    progressOpen: false,
    needsBrowserActivation: false,
    checkNow: vi.fn(async () => undefined),
    prepare: vi.fn(async () => undefined),
    dismissPreflight: vi.fn(),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    setProgressOpen: vi.fn(),
    ...patch,
  };
}

const job: SystemUpdateJob = {
  job_id: 'job-1234567890',
  release_id: release.release_id,
  status: 'running',
  stage: 'updating_backend',
  progress: 56,
  message: 'Replacing the backend with the verified release.',
  rollback: preflight.rollback,
};

describe('SystemUpdateControl', () => {
  it('classifies candidate and active work as direct shell actions, not secondary utilities', () => {
    expect(systemUpdateTriggerPresentation(upgrade()).priority).toBe('actionable');
    expect(systemUpdateTriggerPresentation(upgrade({ job })).priority).toBe('actionable');
    expect(
      systemUpdateTriggerPresentation(
        upgrade({
          status: {
            ...status,
            capability: { ...capability, supported: false, bootstrap_required: true },
          },
        }),
      ).priority,
    ).toBe('secondary');
  });

  it('labels the mutable observation as a review and runs signed preflight before install', () => {
    const initial = upgrade();
    const { rerender } = render(
      <SystemUpdateControl upgrade={initial} hasUnsavedChanges={false} canRollback />,
    );
    fireEvent.click(screen.getByRole('button', { name: /verify and prepare stable v0\.1\.3 update/i }));
    expect(initial.prepare).toHaveBeenCalledOnce();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Preparing the update details/i);

    const ready = { ...initial, preflight };
    rerender(<SystemUpdateControl upgrade={ready} hasUnsavedChanges={false} canRollback />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/signed backend, Console, and bundled Help Center/i);
    fireEvent.click(screen.getByRole('button', { name: 'Install update' }));
    expect(ready.start).toHaveBeenCalledOnce();
  });

  it('blocks preflight and install while any registered draft is unsaved', () => {
    const state = upgrade();
    render(<SystemUpdateControl upgrade={state} hasUnsavedChanges canRollback />);
    fireEvent.click(screen.getByTestId('system-update-button'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Save or discard them before updating/i);
    expect(screen.queryByRole('button', { name: 'Install update' })).not.toBeInTheDocument();
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it('shows server blockers with remediation and never exposes the install action', () => {
    const blocked = upgrade({
      preflight: {
        ...preflight,
        blockers: [
          {
            code: 'secrets_not_durable',
            message: 'Runtime secrets are not durable.',
            remediation: 'Persist them in the deployment environment first.',
          },
        ],
      },
    });
    render(<SystemUpdateControl upgrade={blocked} hasUnsavedChanges={false} canRollback />);
    fireEvent.click(screen.getByTestId('system-update-button'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Runtime secrets are not durable/i);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Persist them in the deployment environment first/i);
    expect(screen.queryByRole('button', { name: 'Install update' })).not.toBeInTheDocument();
  });

  it('resumes a durable job and treats the service restart as planned reconnect', () => {
    const state = upgrade({ job, progressOpen: true, connection: 'reconnecting' });
    render(<SystemUpdateControl upgrade={state} hasUnsavedChanges={false} canRollback />);
    expect(screen.getByText('System update in progress: Updating backend')).toBeInTheDocument();
    expect(screen.getByText('Reconnecting to the updated services')).toBeVisible();
    expect(screen.getByText(/durable job and this view will resume automatically/i)).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '56');
  });

  it('reports automatic rollback and keeps the recovery evidence visible', () => {
    const rolledBack = upgrade({
      job: {
        ...job,
        status: 'rolled_back',
        stage: 'rolling_back',
        progress: 100,
        message: 'Previous release restored.',
      },
      progressOpen: true,
    });
    render(<SystemUpdateControl upgrade={rolledBack} hasUnsavedChanges={false} canRollback />);
    expect(screen.getByText('The last system update was rolled back')).toBeInTheDocument();
    expect(screen.getByText('Previous release restored')).toBeVisible();
    expect(screen.getByText(/restored automatically if verification fails/i)).toBeVisible();
  });

  it('keeps a successful receipt and permission-gated rollback reachable after reload', () => {
    const succeeded: SystemUpdateJob = {
      ...job,
      status: 'succeeded',
      stage: 'completed',
      progress: 100,
      message: 'Update completed and verified.',
      receipt: {
        job_id: job.job_id,
        release_id: job.release_id,
        status: 'succeeded',
        before: { version: '0.1.2', commit_sha: 'a'.repeat(40) },
        after: { version: '0.1.3', commit_sha: 'd'.repeat(40) },
        components: ['updater', 'backend', 'webui', 'help_center'],
        backup_id: job.job_id,
        rollback_performed: false,
        started_at: '2026-08-03T03:45:00Z',
        completed_at: '2026-08-03T03:50:00Z',
      },
    };
    const currentStatus: SystemUpdateStatusResponse = {
      ...status,
      current: { version: '0.1.3', channel: 'stable', commit_sha: 'd'.repeat(40) },
      release_discovery: {
        state: 'current',
        checked_at: '2026-08-03T03:51:00Z',
        branch: 'main',
        observed_release: null,
        issue: null,
      },
      last_job: succeeded,
    };
    const state = upgrade({
      status: currentStatus,
      job: succeeded,
      receipt: succeeded.receipt ?? null,
      progressOpen: false,
    });
    const { rerender } = render(
      <SystemUpdateControl upgrade={state} hasUnsavedChanges={false} canRollback />,
    );

    expect(
      screen.getByRole('button', {
        name: /last system update completed; open verified receipt and rollback controls/i,
      }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', {
        name: /last system update completed; open verified receipt and rollback controls/i,
      }),
    );
    expect(state.setProgressOpen).toHaveBeenCalledWith(true);

    rerender(
      <SystemUpdateControl
        upgrade={{ ...state, progressOpen: true }}
        hasUnsavedChanges={false}
        canRollback
      />,
    );
    expect(screen.getByText('Verified receipt')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Roll back' })).toBeVisible();

    rerender(
      <SystemUpdateControl
        upgrade={{ ...state, progressOpen: true }}
        hasUnsavedChanges={false}
        canRollback={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Roll back' })).not.toBeInTheDocument();
  });

  it('lets a newer candidate replace the successful receipt trigger and starts fresh preflight', () => {
    const succeeded: SystemUpdateJob = {
      ...job,
      status: 'succeeded',
      stage: 'completed',
      progress: 100,
      message: 'Update completed and verified.',
    };
    const state = upgrade({ job: succeeded });
    render(<SystemUpdateControl upgrade={state} hasUnsavedChanges={false} canRollback />);

    fireEvent.click(
      screen.getByRole('button', { name: /verify and prepare stable v0\.1\.3 update/i }),
    );
    expect(state.prepare).toHaveBeenCalledOnce();
    expect(state.setProgressOpen).not.toHaveBeenCalled();
  });

  it('distinguishes one-time bootstrap from a transient supervisor outage', () => {
    const bootstrap = upgrade({
      status: {
        ...status,
        capability: {
          ...capability,
          supported: false,
          bootstrap_required: true,
          supervisor: { available: false },
          blockers: [
            {
              code: 'bootstrap_required',
              message: 'This deployment predates the update supervisor.',
              remediation: 'Run the documented one-time bootstrap on the host.',
            },
          ],
        },
      },
    });
    render(<SystemUpdateControl upgrade={bootstrap} hasUnsavedChanges={false} canRollback />);
    fireEvent.click(screen.getByRole('button', { name: /one-time update supervisor setup is required/i }));
    expect(bootstrap.setProgressOpen).toHaveBeenCalledWith(true);
  });

  it('does not let a mutable candidate outrank an unsupported runtime', () => {
    const unsupported = upgrade({
      status: {
        ...status,
        capability: {
          ...capability,
          supported: false,
          bootstrap_required: true,
          supervisor: { available: false },
          blockers: [
            {
              code: 'bootstrap_required',
              message: 'The updater boundary is not installed.',
              remediation: 'Run the one-time host bootstrap.',
            },
          ],
        },
      },
    });
    render(<SystemUpdateControl upgrade={unsupported} hasUnsavedChanges={false} canRollback />);
    expect(
      screen.getByRole('button', { name: /one-time update supervisor setup is required/i }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /verify and prepare stable/i })).not.toBeInTheDocument();
  });

  it('reports source-check failure without claiming that the system is current', () => {
    const unavailable = upgrade({
      status: {
        ...status,
        release_discovery: {
          state: 'unavailable',
          branch: 'main',
          checked_at: '2026-08-03T03:45:00Z',
          observed_release: null,
          issue: {
            code: 'release_discovery_unavailable',
            message: 'Stable release metadata could not be read.',
            remediation: 'Check the public repository and try again.',
          },
        },
      },
      progressOpen: true,
    });
    render(<SystemUpdateControl upgrade={unavailable} hasUnsavedChanges={false} canRollback />);
    expect(screen.getByText('Stable release check needs attention')).toBeVisible();
    expect(screen.queryByText('System is current')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeVisible();
  });

  it('surfaces a transient update-status outage without mislabelling it as bootstrap', () => {
    const unavailable = upgrade({
      status: null,
      connection: 'unavailable',
      error: 'The update supervisor could not be reached.',
    });
    render(<SystemUpdateControl upgrade={unavailable} hasUnsavedChanges={false} canRollback />);
    fireEvent.click(screen.getByRole('button', { name: /system update status is unavailable/i }));
    expect(unavailable.setProgressOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByText(/one-time setup required/i)).not.toBeInTheDocument();
  });
});

describe('SystemUpdateControl spinners (Round 14, SPEC §4.9.2)', () => {
  beforeEach(() => {
    motion.reduced = false;
  });
  afterEach(() => {
    motion.reduced = true;
  });

  /** A refresh glyph turning anywhere outside RefreshButton breaks the console grammar. */
  const spinningRefreshGlyphs = () => document.querySelectorAll('svg.lucide-refresh-cw.animate-spin');

  it('shows a running update as progress, never a spinning refresh glyph', () => {
    const state = upgrade({ job, progressOpen: true, connection: 'reconnecting' });
    render(<SystemUpdateControl upgrade={state} hasUnsavedChanges={false} canRollback />);
    const trigger = screen.getByTestId('system-update-button');
    const progress = trigger.querySelector('[data-update-progress]');
    expect(progress).not.toBeNull();
    expect(progress).toHaveClass('animate-spin');
    expect(trigger.querySelector('svg.lucide-refresh-cw')).toBeNull();
    // The reconnect notice turns a progress ring too.
    expect(screen.getByText('Reconnecting to the updated services')).toBeVisible();
    expect(spinningRefreshGlyphs()).toHaveLength(0);
  });

  it('rests the update glyph when nothing is running', () => {
    render(<SystemUpdateControl upgrade={upgrade()} hasUnsavedChanges={false} canRollback />);
    const trigger = screen.getByTestId('system-update-button');
    expect(trigger.querySelector('[data-update-progress]')).toBeNull();
    expect(trigger.querySelector('svg.lucide-refresh-cw')).not.toBeNull();
    expect(spinningRefreshGlyphs()).toHaveLength(0);
  });

  it('says "Checking" while the release check runs, busy and disabled, with a resting glyph', () => {
    const checking = upgrade({
      checking: true,
      status: {
        ...status,
        release_discovery: {
          state: 'error',
          branch: 'main',
          checked_at: '2026-08-03T03:45:00Z',
          observed_release: null,
          issue: { code: 'release_discovery_failed', message: 'The check failed.', remediation: null },
        },
      },
      progressOpen: true,
    });
    render(<SystemUpdateControl upgrade={checking} hasUnsavedChanges={false} canRollback />);
    const button = screen.getByRole('button', { name: 'Checking…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(spinningRefreshGlyphs()).toHaveLength(0);
  });
});
