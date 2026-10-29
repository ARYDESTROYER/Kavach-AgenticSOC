/**
 * "Automation applied" names a runbook attach in runbook words (Round 14, SPEC §4.10.16):
 * since Round 14 the stored `run_playbook` action is the rule editor's "Attach a runbook"
 * and records whether it attached one (`engine/threshold_automation.py`), so its badge
 * says what happened; a record from before Round 14 keeps its legacy name (SPEC §3.1).
 * Console-authored copy never says "playbook".
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    listCases: vi.fn().mockResolvedValue({ cases: [] }),
    get: vi.fn().mockResolvedValue({ found: false }),
  },
}));

import type { AutomationActionRecord, Case } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import { OverviewPanel } from '../OverviewPanel';

const CASE = {
  case_id: 'case-1',
  case_number: 'CASE-000214',
  title: 'Password spray against the VPN',
  status: 'open',
  verdict: 'NEEDS_HUMAN',
  confidence: 0.6,
  risk_score: 62,
  rule_ids: ['auth-failures'],
  created_at: '2026-10-28T12:50:00Z',
  updated_at: '2026-10-28T13:00:00Z',
  evidence: [],
} as unknown as Case;

function showActions(actions: AutomationActionRecord[]) {
  render(
    <TooltipProvider>
      <OverviewPanel c={{ ...CASE, automation_actions: actions } as Case} fpPolicy={null} triage={null} triageLoading={false} />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Provenance & audit/ }));
}

const record = (detail: string): AutomationActionRecord => ({
  action: 'run_playbook',
  rule_id: 'r1',
  detail,
  at: '2026-10-28T13:00:00Z',
});

describe('Automation applied names a runbook attach in runbook words', () => {
  it('says the runbook was attached', () => {
    showActions([record('attach_runbook=brute-force attached=True')]);
    expect(screen.getByText('Runbook attached')).toBeInTheDocument();
    expect(screen.queryByText(/before Round 14/)).toBeNull();
  });

  it.each([
    ['the run already existed or the runbook is gone', 'attach_runbook=brute-force attached=False'],
    ['no runbook resolved', 'attach_runbook=(none) attached=False'],
  ])('says it was not attached when %s', (_name, detail) => {
    showActions([record(detail)]);
    expect(screen.getByText('Runbook not attached')).toBeInTheDocument();
  });

  it('keeps the legacy name for a record from before Round 14', () => {
    showActions([record('Queued')]);
    expect(screen.getByText('Runbook automation (before Round 14)')).toBeInTheDocument();
  });

  it('lists attaching a runbook among what automation may do, and never says "playbook"', () => {
    showActions([record('attach_runbook=brute-force attached=True'), { action: 'tag', detail: 'tag=vpn' }]);
    const about = screen.getByText(/automation can tag, recommend, notify, attach a runbook, queue a/);
    expect(screen.getByText('Tagged')).toBeInTheDocument();
    const EM_DASH = String.fromCharCode(0x2014);
    for (const text of [about.textContent ?? '', 'Runbook attached', 'Runbook not attached', 'Runbook automation (before Round 14)']) {
      expect(text).not.toMatch(/playbook/i);
      expect(text.includes(EM_DASH)).toBe(false);
    }
    // The stored token appears nowhere on the panel.
    expect(document.body.textContent ?? '').not.toMatch(/playbook/i);
  });
});
