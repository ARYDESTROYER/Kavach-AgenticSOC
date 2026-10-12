/**
 * CaseDetail header severity after a lifecycle action (Round 12 final review, L4).
 *
 * The header reads `severity_band`, falling back to the risk-score ladder only when no
 * band is present. A lifecycle-action response from an older backend (or a band
 * derivation that failed open) carries no read-time bands, so the header used to relabel
 * a source-asserted Critical case with a low risk total as Info after Acknowledge. The
 * backend now returns the bands on every mutation; `commitCase` also keeps the bands on
 * screen when a response for the same case omits them (`keepAdvisoryBands`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const CRITICAL_NEW = {
  case_id: 'c-band-1',
  case_number: 'CASE-2026-0501',
  title: 'ip:203.0.113.50 source-asserted critical with a low risk total',
  status: 'new',
  verdict: 'NEEDS_HUMAN',
  disposition: 'undetermined',
  risk_score: 7.41,
  severity_band: 'critical',
  severity_source: 'source_asserted',
  updated_at: '2026-10-10T10:00:00Z',
  created_at: '2026-10-10T09:00:00Z',
  history: [],
};

const { caseActionExec } = vi.hoisted(() => ({ caseActionExec: vi.fn() }));

vi.mock('@/lib/api', () => {
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(CRITICAL_NEW)),
    caseActionExec,
  };
  return {
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'probe', hasPermission: () => true, user: null }),
  useCan: () => () => true,
}));

import { CaseDetail } from '@/soc/pages/CaseDetail';

async function acknowledgeWith(response: Record<string, unknown>) {
  caseActionExec.mockResolvedValue(response);
  render(<CaseDetail caseId={CRITICAL_NEW.case_id} presentation="embedded" onClose={() => undefined} />);
  const meta = await screen.findByTestId('case-detail-meta');
  await waitFor(() => expect(meta).toHaveTextContent(/Critical severity/));

  fireEvent.click(screen.getAllByRole('button', { name: /^Acknowledge/ })[0]);
  const dialog = await screen.findByTestId('confirm-action-dialog');
  const submit = within(dialog)
    .getAllByRole('button')
    .find((b) => /^acknowledge/i.test(b.textContent?.trim() ?? ''));
  expect(submit).toBeDefined();
  fireEvent.click(submit!);
  await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('case-detail-status')).toHaveTextContent(/Investigating/i));
  return screen.getByTestId('case-detail-meta');
}

describe('CaseDetail header severity after a lifecycle action', () => {
  beforeEach(() => {
    caseActionExec.mockReset();
  });

  it('keeps Critical when the action response omits the read-time bands', async () => {
    const { severity_band: _band, severity_source: _source, ...stored } = CRITICAL_NEW;
    const meta = await acknowledgeWith({ ...stored, status: 'investigating' });
    expect(meta).toHaveTextContent(/Critical severity/);
    expect(meta).not.toHaveTextContent(/Info severity/);
  });

  it('shows the band the response carries when it has one', async () => {
    const meta = await acknowledgeWith({ ...CRITICAL_NEW, status: 'investigating', severity_band: 'high' });
    expect(meta).toHaveTextContent(/High severity/);
    expect(meta).not.toHaveTextContent(/Critical severity/);
  });
});
