import { describe, expect, it } from 'vitest';

import { upstreamReleaseNotice } from '@/lib/upstream-release';
import type { UpstreamReleasesResponse } from '@/lib/types';

const response: UpstreamReleasesResponse = {
  enabled: true,
  repository_url: 'https://github.com/ARYDESTROYER/Kavach-AgenticSOC',
  checked_at: '2026-07-31T10:00:00Z',
  cache: { hit: false, stale: false, max_age_seconds: 21_600 },
  channels: {
    stable: {
      channel: 'stable',
      branch: 'main',
      state: 'available',
      version: '0.1.2',
      commit_sha: 'b'.repeat(40),
      commit_url: `https://github.com/example/repo/commit/${'b'.repeat(40)}`,
      source_url: 'https://github.com/example/repo/tree/main',
      checked_at: '2026-07-31T10:00:00Z',
      stale: false,
      error_code: null,
      error_message: null,
    },
    testing: {
      channel: 'testing',
      branch: 'Testing',
      state: 'available',
      version: '0.1.1',
      commit_sha: 'c'.repeat(40),
      commit_url: `https://github.com/example/repo/commit/${'c'.repeat(40)}`,
      source_url: 'https://github.com/example/repo/tree/Testing',
      checked_at: '2026-07-31T10:00:00Z',
      stale: false,
      error_code: null,
      error_message: null,
    },
  },
};

describe('upstreamReleaseNotice', () => {
  it('selects only the running release channel', () => {
    expect(
      upstreamReleaseNotice(response, {
        version: '0.1.1',
        channel: 'stable',
        commitSha: 'a'.repeat(40),
      }),
    ).toMatchObject({ kind: 'version', candidate: { branch: 'main' } });
  });

  it('reports a same-version branch-head change as a source revision', () => {
    expect(
      upstreamReleaseNotice(response, {
        version: '0.1.1',
        channel: 'testing',
        commitSha: 'a'.repeat(40),
      }),
    ).toMatchObject({ kind: 'revision', candidate: { branch: 'Testing' } });
  });

  it('accepts short and full forms of the same commit', () => {
    expect(
      upstreamReleaseNotice(response, {
        version: '0.1.1',
        channel: 'testing',
        commitSha: 'c'.repeat(12),
      }),
    ).toBeNull();
  });

  it('does not claim an update from disabled, failed, older, or unknown metadata', () => {
    expect(
      upstreamReleaseNotice({ ...response, enabled: false }, {
        version: '0.1.1', channel: 'stable', commitSha: 'a'.repeat(40),
      }),
    ).toBeNull();
    expect(
      upstreamReleaseNotice({
        ...response,
        channels: {
          ...response.channels,
          testing: { ...response.channels.testing, state: 'unavailable' },
        },
      }, { version: '0.1.1', channel: 'testing', commitSha: 'a'.repeat(40) }),
    ).toBeNull();
    expect(
      upstreamReleaseNotice({
        ...response,
        channels: {
          ...response.channels,
          stable: { ...response.channels.stable, version: '0.1.0' },
        },
      }, { version: '0.1.1', channel: 'stable', commitSha: 'a'.repeat(40) }),
    ).toBeNull();
    expect(
      upstreamReleaseNotice({
        ...response,
        channels: {
          ...response.channels,
          stable: { ...response.channels.stable, version: 'next' },
        },
      }, { version: '0.1.1', channel: 'stable', commitSha: 'a'.repeat(40) }),
    ).toBeNull();
  });

  it('does not turn an unknown local SHA into a noisy same-version notice', () => {
    expect(
      upstreamReleaseNotice(response, {
        version: '0.1.1',
        channel: 'testing',
        commitSha: 'unknown',
      }),
    ).toBeNull();
  });

  it('does not promote stale, pre-release, or underspecified revision metadata', () => {
    expect(
      upstreamReleaseNotice({
        ...response,
        channels: {
          ...response.channels,
          testing: { ...response.channels.testing, stale: true },
        },
      }, {
        version: '0.1.1', channel: 'testing', commitSha: 'a'.repeat(40),
      }),
    ).toBeNull();
    expect(
      upstreamReleaseNotice({
        ...response,
        channels: {
          ...response.channels,
          testing: { ...response.channels.testing, version: '0.1.1-rc.1' },
        },
      }, {
        version: '0.1.1', channel: 'testing', commitSha: 'a'.repeat(40),
      }),
    ).toBeNull();
    expect(
      upstreamReleaseNotice(response, {
        version: '0.1.1', channel: 'testing', commitSha: 'abc123',
      }),
    ).toBeNull();
  });
});
