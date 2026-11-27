/**
 * B49 (Round 16 SPEC §4.5 WP15E): durable jobs never run in Demo Mode (the server answers
 * `409 durable jobs are unavailable in Demo Mode`). Every Job submitter on the setup and
 * administration pages is disabled in Demo with a plain reason, and nothing is sent:
 * Data export, the storage lifecycle apply, the Danger zone resets and the Knowledge
 * imports and precedent bootstrap.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { submitMock, getMock, postMock, demoState } = vi.hoisted(() => ({
  submitMock: vi.fn(),
  getMock: vi.fn(),
  postMock: vi.fn(),
  demoState: { active: true },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: getMock,
      post: postMock,
      jobs: { ...actual.api.jobs, submit: submitMock },
    },
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/soc/components/Can', () => ({
  useCan: () => true,
  Can: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/soc/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/demo')>();
  return {
    ...actual,
    useDemo: () => ({
      status: { mode: demoState.active ? 'seeded' : 'off' },
      active: demoState.active,
      loading: false,
      confirmed: true,
      refresh: vi.fn(),
    }),
  };
});

import type { Preferences, StorageLifecycleConfig, StorageLifecycleStatus } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { DataExportSection } from '../data-export';
import { StorageLifecycleSection } from '../storage';
import { DangerZone } from '@/soc/components/DangerZone';
import { ImportCard, PrecedentBootstrapCard, ThreatIntelImportCard } from '@/soc/pages/Knowledge';
import { DEMO_JOB_REASON } from '../demo-jobs';

const POLICY: StorageLifecycleConfig = {
  enabled: true,
  hot_days: 180,
  warm_days: 90,
  archive_target: 'aws_glacier',
  glacier_storage_class: 'GLACIER',
  delete_after_archive: false,
};

const STATUS = {
  state_backend: 'elasticsearch',
  effective_state: 'not_configured',
  policy_name: 'p',
  capabilities: { supported: true, can_manage: true },
  policy: { ...POLICY, archive_from_days: 270 },
  tiers: [],
  targets: [],
  archive: { enforcement: 'advisory', status: 'not_configured', storage_class: 'GLACIER', reason: '' },
  delete_enabled: false,
} as unknown as StorageLifecycleStatus;

beforeEach(() => {
  demoState.active = true;
  submitMock.mockReset().mockResolvedValue({ job_id: 'j', kind: 'x', status: 'queued' });
  getMock.mockReset().mockImplementation((path: string) =>
    path.startsWith('rag/precedent')
      ? Promise.resolve({
          tier_enabled: true,
          pending: 3,
          eligible: 3,
          max_batch: 50,
          trust_class: 'lower_trust',
          acknowledgement_required: 'I understand',
          does_not: [],
        })
      : Promise.resolve(STATUS),
  );
  postMock.mockReset().mockResolvedValue(STATUS);
});

describe('B49: Job submitters in Demo Mode', () => {
  it('Data export is disabled with the reason and sends nothing', () => {
    render(<DataExportSection />);
    const button = screen.getByRole('button', { name: /Build ZIP in background/ });
    expect(button).toBeDisabled();
    expect(
      screen.getByText('Data exports are not available in Demo Mode. Turn Demo Mode off to export.'),
    ).toBeInTheDocument();
    fireEvent.click(button);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('Data export stays available with Demo Mode off', () => {
    demoState.active = false;
    render(<DataExportSection />);
    expect(screen.getByRole('button', { name: /Build ZIP in background/ })).toBeEnabled();
    expect(screen.queryByText(/not available in Demo Mode/)).toBeNull();
  });

  it('the storage lifecycle apply is locked with the reason', async () => {
    render(
      <TooltipProvider>
        <StorageLifecycleSection
          prefs={{ storage_lifecycle: POLICY } as Preferences}
          persistedPrefs={{ storage_lifecycle: POLICY } as Preferences}
          update={vi.fn()}
          readOnly={false}
        />
      </TooltipProvider>,
    );
    expect(await screen.findByText(DEMO_JOB_REASON)).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: /^Apply/ })) expect(button).toBeDisabled();
  });

  it('every Danger zone reset is disabled with the reason', () => {
    render(<DangerZone />);
    expect(screen.getByText(DEMO_JOB_REASON)).toBeInTheDocument();
    const resets = screen.getAllByRole('button', { name: /reset/i });
    expect(resets.length).toBeGreaterThan(0);
    for (const button of resets) expect(button).toBeDisabled();
  });

  it('the Knowledge imports and the precedent bootstrap are disabled with the reason', async () => {
    render(
      <>
        <ImportCard />
        <ThreatIntelImportCard />
        <PrecedentBootstrapCard />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Title', { selector: '#rag-title' }), { target: { value: 'Guide' } });
    fireEvent.change(screen.getByLabelText('Document text'), { target: { value: 'Some text' } });
    fireEvent.change(screen.getByLabelText('Title', { selector: '#ti-title' }), { target: { value: 'Advisory' } });
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'IOC list' } });
    expect(screen.getByRole('button', { name: 'Queue document' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Queue threat intel' })).toBeDisabled();
    const ack = await screen.findByLabelText(/Type the exact acknowledgement/);
    fireEvent.change(ack, { target: { value: 'I understand' } });
    expect(screen.getByRole('button', { name: /Start bootstrap job/ })).toBeDisabled();
    expect(screen.getAllByText(DEMO_JOB_REASON).length).toBe(3);
    expect(submitMock).not.toHaveBeenCalled();
  });
});
