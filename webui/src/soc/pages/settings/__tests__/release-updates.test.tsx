import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { upstreamMock, checkMock } = vi.hoisted(() => ({
  upstreamMock: vi.fn(),
  checkMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    upstreamReleases: upstreamMock,
    checkUpstreamReleases: checkMock,
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type {
  Preferences,
  ReleaseUpdateConfig,
  UpstreamReleasesResponse,
} from '@/lib/types';
import { ReleaseUpdatesSection } from '../release-updates';

const CONFIG: ReleaseUpdateConfig = {
  enabled: true,
  repository_url: 'https://github.com/ARYDESTROYER/Kavach-AgenticSOC',
  stable_branch: 'main',
  testing_branch: 'Testing',
  check_interval_minutes: 360,
};

const STATUS: UpstreamReleasesResponse = {
  enabled: true,
  repository_url: CONFIG.repository_url,
  checked_at: '2026-07-31T10:00:00Z',
  cache: { hit: false, stale: false, max_age_seconds: 21_600 },
  channels: {
    stable: {
      channel: 'stable', branch: 'main', state: 'unavailable', version: null,
      commit_sha: null, commit_url: null, source_url: null,
      checked_at: '2026-07-31T10:00:00Z', stale: false,
      error_code: 'not_found', error_message: 'Repository, branch, or VERSION file was not found.',
    },
    testing: {
      channel: 'testing', branch: 'Testing', state: 'available', version: '0.1.1',
      commit_sha: 'a'.repeat(40),
      commit_url: `https://github.com/ARYDESTROYER/Kavach-AgenticSOC/commit/${'a'.repeat(40)}`,
      source_url: 'https://github.com/ARYDESTROYER/Kavach-AgenticSOC/tree/Testing',
      checked_at: '2026-07-31T10:00:00Z', stale: false,
      error_code: null, error_message: null,
    },
  },
};

function renderSection({
  draft = CONFIG,
  persisted = CONFIG,
  update = vi.fn(),
  readOnly = false,
}: {
  draft?: ReleaseUpdateConfig;
  persisted?: ReleaseUpdateConfig;
  update?: ReturnType<typeof vi.fn>;
  readOnly?: boolean;
} = {}) {
  const result = render(
    <ReleaseUpdatesSection
      prefs={{ release_updates: draft } as Preferences}
      persistedPrefs={{ release_updates: persisted } as Preferences}
      update={update}
      readOnly={readOnly}
    />,
  );
  return { ...result, update };
}

describe('ReleaseUpdatesSection', () => {
  beforeEach(() => {
    upstreamMock.mockReset().mockResolvedValue(STATUS);
    checkMock.mockReset().mockResolvedValue(STATUS);
  });

  it('shows truthful per-channel observations and the deployment boundary', async () => {
    renderSection();
    expect(
      await screen.findByRole('heading', { name: 'Observed revisions' }),
    ).toBeVisible();
    expect(screen.getByText('Repository, branch, or VERSION file was not found.')).toBeVisible();
    expect(screen.getByText('0.1.1')).toBeVisible();
    expect(screen.getByText(/Discovery is not deployment/i)).toBeVisible();
    expect(screen.getByText(/same-origin Console manifest exactly matches/i)).toBeVisible();
    expect(screen.getByRole('link', { name: /Open branch/i })).toHaveAttribute(
      'href',
      STATUS.channels.testing.source_url,
    );
  });

  it('writes repository and branch edits through the page-wide settings draft', async () => {
    const { update } = renderSection();
    await screen.findByRole('heading', { name: 'Observed revisions' });
    fireEvent.change(screen.getByLabelText('Testing branch'), {
      target: { value: 'release/testing' },
    });
    expect(update).toHaveBeenCalledWith({
      release_updates: { ...CONFIG, testing_branch: 'release/testing' },
    });
  });

  it('forces a cached-safe manual check only for the saved configuration', async () => {
    const first = renderSection();
    const check = await screen.findByRole('button', { name: 'Check now' });
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);
    await waitFor(() => expect(checkMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled(),
    );
    first.unmount();

    renderSection({
      draft: { ...CONFIG, repository_url: 'https://github.com/example/fork' },
      persisted: CONFIG,
    });
    expect(await screen.findByText('0.1.1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
    expect(screen.getByText(/Save or discard the source changes before checking/i)).toBeVisible();
  });

  it('labels last-known-good metadata as stale without hiding it', async () => {
    upstreamMock.mockResolvedValue({
      ...STATUS,
      cache: { ...STATUS.cache, stale: true },
      channels: {
        ...STATUS.channels,
        testing: {
          ...STATUS.channels.testing,
          stale: true,
          error_code: 'unreachable',
          error_message: 'Latest GitHub check failed; showing the last verified metadata.',
        },
      },
    } satisfies UpstreamReleasesResponse);
    renderSection();
    expect(await screen.findByText('Last verified')).toBeVisible();
    expect(screen.getByText(/Latest GitHub check failed/i)).toBeVisible();
    expect(screen.getByText('0.1.1')).toBeVisible();
  });

  it('keeps source configuration read-only when the deployment locks settings', async () => {
    renderSection({ readOnly: true });
    await screen.findByRole('heading', { name: 'Observed revisions' });
    expect(screen.getByLabelText('Public repository')).toBeDisabled();
    expect(screen.getByLabelText('Stable branch')).toBeDisabled();
    expect(screen.getByLabelText('Testing branch')).toBeDisabled();
    expect(screen.getByLabelText('Check for source updates')).toBeDisabled();
  });

  it('ignores an old source response after the saved repository changes', async () => {
    let resolveOld!: (value: UpstreamReleasesResponse) => void;
    let resolveNew!: (value: UpstreamReleasesResponse) => void;
    upstreamMock
      .mockImplementationOnce(() => new Promise<UpstreamReleasesResponse>((done) => {
        resolveOld = done;
      }))
      .mockImplementationOnce(() => new Promise<UpstreamReleasesResponse>((done) => {
        resolveNew = done;
      }));
    const nextConfig = {
      ...CONFIG,
      repository_url: 'https://github.com/example/fork',
    };
    const nextStatus = {
      ...STATUS,
      repository_url: nextConfig.repository_url,
      channels: {
        ...STATUS.channels,
        testing: { ...STATUS.channels.testing, version: '0.2.0' },
      },
    } satisfies UpstreamReleasesResponse;

    const view = renderSection();
    await waitFor(() => expect(upstreamMock).toHaveBeenCalledOnce());
    view.rerender(
      <ReleaseUpdatesSection
        prefs={{ release_updates: nextConfig } as Preferences}
        persistedPrefs={{ release_updates: nextConfig } as Preferences}
        update={view.update}
      />,
    );
    await waitFor(() => expect(upstreamMock).toHaveBeenCalledTimes(2));
    await act(async () => resolveNew(nextStatus));
    expect(await screen.findByText('0.2.0')).toBeVisible();

    await act(async () => resolveOld(STATUS));
    expect(screen.getByText('0.2.0')).toBeVisible();
    expect(screen.queryByText('0.1.1')).not.toBeInTheDocument();
  });
});
