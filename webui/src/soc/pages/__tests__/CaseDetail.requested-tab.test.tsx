/**
 * CaseDetail opens the tab a link asks for (closing QA integ-06): the audit log's "Open
 * case trace" links to `#/case_manager?caseId=…&tab=investigation`, and the case opens on
 * its Investigation tab, where the trace is, never on Overview. The request applies when
 * it or the case changes; the analyst's own tab choice stands until then. Anything that
 * is not a case tab is ignored, and the Runbook tab opens only for a viewer who has it.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { permissions } = vi.hoisted(() => ({ permissions: { runbooks: true } }));

const CASE = {
  case_id: 'c-tab-1',
  case_number: 'CASE-2026-0410',
  title: 'Repeated SSH failures from one source',
  status: 'closed',
  verdict: 'FALSE_POSITIVE',
  decision_by: 'agent',
  risk_score: 30,
  severity_band: 'low',
  updated_at: '2026-10-10T10:00:00Z',
  created_at: '2026-10-10T09:00:00Z',
  history: [],
};

vi.mock('@/lib/api', () => {
  const target: Record<string, unknown> = {
    getCase: vi.fn((id: string) => Promise.resolve({ ...CASE, case_id: id })),
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
  useAuth: () => ({
    username: 'probe',
    user: null,
    hasPermission: (resource: string) => resource !== 'runbooks' || permissions.runbooks,
  }),
  useCan: () => () => true,
}));

import { CaseDetail } from '@/soc/pages/CaseDetail';

function Host({ caseId = CASE.case_id, tab }: { caseId?: string; tab?: string | null }) {
  return <CaseDetail caseId={caseId} presentation="embedded" onClose={() => undefined} requestedTab={tab} />;
}

const selectedTab = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');

async function loaded() {
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/Repeated SSH failures/));
}

beforeEach(() => {
  permissions.runbooks = true;
});

describe('CaseDetail: the tab a link asks for', () => {
  it('opens on Investigation for "Open case trace"', async () => {
    render(<Host tab="investigation" />);
    await loaded();
    expect(selectedTab()).toHaveTextContent(/^Investigation/);
    expect(screen.getByRole('tab', { name: /^Overview/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('opens on Overview with no request, and ignores a value that is not a case tab', async () => {
    const { unmount } = render(<Host />);
    await loaded();
    expect(selectedTab()).toHaveTextContent(/^Overview/);
    unmount();
    render(<Host tab="trace" />);
    await loaded();
    expect(selectedTab()).toHaveTextContent(/^Overview/);
  });

  it('keeps the analyst’s own choice until the link or the case changes', async () => {
    const { rerender } = render(<Host tab="investigation" />);
    await loaded();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Timeline/ }));
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Timeline/));
    // The same request re-rendered changes nothing.
    rerender(<Host tab="investigation" />);
    expect(selectedTab()).toHaveTextContent(/^Timeline/);
    // The queue opened another case without a tab: the analyst's tab stays.
    rerender(<Host caseId="c-tab-2" tab={null} />);
    expect(selectedTab()).toHaveTextContent(/^Timeline/);
    // A link to a case's trace applies again.
    rerender(<Host caseId="c-tab-3" tab="investigation" />);
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Investigation/));
  });

  it('opens the Runbook tab only for a viewer who has it', async () => {
    const { unmount } = render(<Host tab="runbook" />);
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Runbook/));
    unmount();
    permissions.runbooks = false;
    render(<Host tab="runbook" />);
    await loaded();
    expect(selectedTab()).toHaveTextContent(/^Overview/);
    expect(screen.queryByRole('tab', { name: /^Runbook/ })).toBeNull();
  });
});
