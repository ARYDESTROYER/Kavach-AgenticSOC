/**
 * CaseDetail — campaign membership chip (#51).
 *
 * The case→campaign linkage (`campaignsApi.forCase` + the exported `CampaignChip`) was
 * fully built but never mounted, so an operator viewing a case could not see which
 * campaign it belongs to. This spec locks the now-wired behaviour:
 *
 *   1. CaseDetail fetches the campaign a case belongs to on open (`campaignsApi.forCase`)
 *      and surfaces a "Part of campaign: X" chip in the case header (name = plain text, #9);
 *   2. clicking the chip deep-links to the Campaigns surface via `onNavigate('campaigns')`;
 *   3. an uncampaigned case (or a disabled/erroring campaigns feature) renders NO chip
 *      (fail-quiet). A campaign is advisory only (#3/#4) — it never closes/escalates/
 *      re-clusters the case, so the chip is purely informational.
 *
 * Like CaseDetail.footer.test.tsx this is a live mount over a mocked `@/lib/api`; the
 * campaign client is mocked separately so it returns a deterministic membership.
 */
import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { forCaseMock } = vi.hoisted(() => ({ forCaseMock: vi.fn() }));

vi.mock('@/soc/pages/Campaigns.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Campaigns.api')>();
  return { ...actual, campaignsApi: { ...actual.campaignsApi, forCase: forCaseMock } };
});

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  const openCase = {
    case_id: 'case-88',
    case_number: 'TLSOC-088',
    title: 'Suspicious lateral movement',
    status: 'open',
    disposition: null,
    verdict: 'needs_human',
    confidence: 0.5,
    risk_score: 60,
    created_at: '2026-06-29T00:00:00Z',
    updated_at: '2026-06-29T01:00:00Z',
    escalation_level: 0,
    evidence: [],
  };
  return {
    setUnauthorizedHandler: vi.fn(),
    api: {
      getCase: ok(openCase),
      getPlaybooks: ok({ enabled: false, playbooks: [] }),
      getModels: ok({ providers: {} }),
      getSettings: ok({ prefs: {}, configured: {}, read_only: false }),
      cases: {
        threatContext: ok(null),
        runPlaybook: ok(openCase),
        notify: ok({ sent: [] }),
      },
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

import { AuthProvider } from '../../auth';
import { RouterProvider } from '../../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../CaseDetail';
import type { Navigate } from '../../router';
import type { Campaign } from '../Campaigns.api';

const CAMPAIGN: Campaign = {
  id: 'camp-xyz',
  name: 'Lateral movement — 10.0.0.5',
  status: 'open',
  case_ids: ['case-88', 'case-90'],
  case_count: 2,
  entities: [{ entity_type: 'ip', value: '10.0.0.5' }],
  mitre: ['T1021'],
  severity_rollup: 'high',
  first_seen: null,
  last_seen: null,
  created_at: '2026-06-29T00:00:00Z',
};

function renderCase(onNavigate?: Navigate) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>
          <CaseDetail caseId="case-88" onClose={vi.fn()} onNavigate={onNavigate} />
        </TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

describe('CaseDetail — campaign membership chip (#51)', () => {
  beforeEach(() => {
    forCaseMock.mockReset();
  });

  it('surfaces the "Part of campaign" chip when the case belongs to a campaign', async () => {
    forCaseMock.mockResolvedValue({ case_id: 'case-88', campaign: CAMPAIGN });
    renderCase();

    await waitFor(
      () => expect(screen.getByText('Suspicious lateral movement')).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // The chip renders the campaign name as PLAIN text (#9), fetched for THIS case.
    expect(
      await screen.findByText(/part of campaign: lateral movement — 10\.0\.0\.5/i),
    ).toBeInTheDocument();
    expect(forCaseMock).toHaveBeenCalledWith('case-88');
  });

  it('deep-links to the Campaigns surface when the chip is clicked', async () => {
    forCaseMock.mockResolvedValue({ case_id: 'case-88', campaign: CAMPAIGN });
    const onNavigate = vi.fn() as unknown as Navigate;
    renderCase(onNavigate);

    const chip = await screen.findByRole('button', {
      name: /part of campaign lateral movement/i,
    });
    fireEvent.click(chip);
    expect(onNavigate).toHaveBeenCalledWith('campaigns');
  });

  it('renders NO campaign chip when the case is uncampaigned (fail-quiet)', async () => {
    forCaseMock.mockResolvedValue({ case_id: 'case-88', campaign: null });
    renderCase();

    await waitFor(
      () => expect(screen.getByText('Suspicious lateral movement')).toBeInTheDocument(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(forCaseMock).toHaveBeenCalled());
    expect(screen.queryByText(/part of campaign/i)).toBeNull();
  });

  it('STATIC: the orchestrator wires campaignsApi.forCase + the CampaignChip deep-link', () => {
    // Defence against silent re-rot back into dead code (mirrors CaseDetail.live.test).
    const src = readFileSync(path.resolve(__dirname, '..', 'CaseDetail.tsx'), 'utf8');
    expect(src).toMatch(/campaignsApi\.forCase\(id\)/);
    expect(src).toMatch(/onNavigate\('campaigns'\)/);
    // Round 12: the chip renders in the sticky header meta row (its one home).
    const header = readFileSync(
      path.resolve(__dirname, '..', 'casedetail', 'CaseHeaderMeta.tsx'),
      'utf8',
    );
    expect(header).toMatch(/<CampaignChip/);
    expect(src).toMatch(/<CaseHeaderMeta/);
  });
});
