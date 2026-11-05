/**
 * CaseDetail: the manual Notify toast (Take action → Notify → Send) over a mocked client.
 *
 * `POST /api/cases/{id}/notify` returns the notification service's results unchanged. When
 * the dispatch fails as a whole the service appends a result of its own
 * (`{channel_id: "dispatch", type: "dispatch", ok: false}`, Round 14 SPEC §11.1 "Notify
 * outcomes"). That record is not a channel: a webhook that took the notification before the
 * in-app fan-in raised reads "Sent to 1 channel(s), then the notification service failed
 * (KeyError).", never "Sent to 1, 1 failed." for a case with one channel. Sending never
 * changes the case (#3).
 */
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { getCase, notify, toastMock } = vi.hoisted(() => ({
  getCase: vi.fn(),
  notify: vi.fn(),
  toastMock: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));

const OPEN_CASE = {
  case_id: 'case-7',
  case_number: 'CASE-000007',
  title: 'Beaconing from a build server',
  status: 'open',
  disposition: null,
  verdict: null,
  confidence: 0.6,
  risk_score: 58,
  created_at: '2026-11-01T09:00:00Z',
  updated_at: '2026-11-01T09:30:00Z',
  escalation_level: 0,
  evidence: [],
  assets: {},
  iocs: [],
  tags: [],
  comments: [],
};

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    ...actual,
    setUnauthorizedHandler: vi.fn(),
    api: {
      getCase,
      getModels: ok({ providers: {} }),
      getSettings: ok({
        prefs: {
          notifications: {
            enabled: true,
            channels: [{ id: 'w', type: 'webhook', name: 'SOC webhook', enabled: true }],
          },
        },
        configured: {},
        read_only: false,
      }),
      cases: { threatContext: ok(null), notify },
    },
  };
});

vi.mock('@/lib/api-runbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-runbooks')>();
  return {
    ...actual,
    getCaseRunbooks: vi.fn().mockResolvedValue({
      runs: [],
      progress: {},
      newer_versions: {},
      other_tasks: [],
      revision: 1,
    }),
    getRunbookProgress: vi.fn().mockResolvedValue({}),
    getRunbookCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
  };
});

vi.mock('@/lib/useEventStream', () => ({ useEventStream: vi.fn(() => ({ live: false })) }));

import { AuthProvider } from '../../auth';
import { RouterProvider } from '../../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../CaseDetail';

function renderCase() {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>
          <CaseDetail caseId="case-7" onClose={vi.fn()} presentation="embedded" />
        </TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

async function sendNotify(): Promise<void> {
  const user = userEvent.setup();
  renderCase();
  await screen.findByText('Beaconing from a build server', undefined, { timeout: 5000 });
  const takeAction = screen.getByRole('button', { name: /take action/i });
  act(() => takeAction.focus());
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'Notify' }));
  const dialog = await screen.findByRole('dialog', { name: /notify/i });
  const send = await within(dialog).findByRole('button', { name: 'Send' });
  await waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
  await waitFor(() => expect(notify).toHaveBeenCalledWith('case-7', undefined));
}

describe('CaseDetail: the manual Notify toast', () => {
  beforeEach(() => {
    getCase.mockReset().mockResolvedValue(OPEN_CASE);
    notify.mockReset();
    for (const fn of Object.values(toastMock)) fn.mockReset();
  });

  it('reads a channel that took it, then a failed notification service, as partly sent', async () => {
    notify.mockResolvedValue({
      ok: true,
      sent: [
        { channel_id: 'w', type: 'webhook', ok: true },
        { channel_id: 'dispatch', type: 'dispatch', ok: false, detail: 'dispatch error: KeyError' },
      ],
    });
    await sendNotify();
    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        'Sent to 1 channel(s), then the notification service failed (KeyError).',
      ),
    );
    expect(toastMock.warning).not.toHaveBeenCalledWith('Sent to 1, 1 failed.');
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('reads a notification service that failed before any channel as not sent', async () => {
    notify.mockResolvedValue({
      ok: true,
      sent: [
        { channel_id: 'dispatch', type: 'dispatch', ok: false, detail: 'dispatch error: RuntimeError' },
      ],
    });
    await sendNotify();
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        'Not sent: the notification service failed (RuntimeError).',
      ),
    );
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('keeps the per-channel reading when the service itself did not fail', async () => {
    notify.mockResolvedValue({
      ok: true,
      sent: [
        { channel_id: 'w', type: 'webhook', ok: true },
        { channel_id: 'e', type: 'email', ok: false, detail: 'dispatch error: SMTPException' },
      ],
    });
    await sendNotify();
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith('Sent to 1, 1 failed.'));
  });
});
