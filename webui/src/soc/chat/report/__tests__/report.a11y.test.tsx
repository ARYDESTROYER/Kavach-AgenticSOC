/**
 * Accessibility of the report surfaces (SPEC §10.9): the panel (loaded, with an expanded
 * item and an open summary) and the library's document view are axe-clean, mint no DOM
 * id twice, and expose no chat-local live region (announcements go through the shell).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/ui/tooltip';

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => () => undefined }));
vi.mock('@/soc/auth', () => ({ useAuth: () => ({ username: 'ana', hasPermission: () => true }) }));

const api = vi.hoisted(() => ({
  getReport: vi.fn(),
  patchReport: vi.fn(),
  deleteReport: vi.fn(),
  estimateReportSummary: vi.fn(),
  generateReportSummary: vi.fn(),
  getConversation: vi.fn(),
  listReports: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock('@/soc/chat/chat-api', () => api);

import { RouterProvider } from '@/soc/router';
import ReportPanel from '../ReportPanel';
import ReportsLibrary from '../ReportsLibrary';
import { clearSourceTurnCache } from '../useSourceTurns';
import { sampleConversation, sampleReport } from './fixtures';

expect.extend(toHaveNoViolations);

function duplicateIds(root: HTMLElement): string[] {
  const seen = new Map<string, number>();
  root.querySelectorAll('[id]').forEach((el) => seen.set(el.id, (seen.get(el.id) ?? 0) + 1));
  return Array.from(seen.entries())
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  clearSourceTurnCache();
  api.getReport.mockResolvedValue(sampleReport());
  api.getConversation.mockResolvedValue(sampleConversation());
  api.listConversations.mockResolvedValue({ conversations: [] });
  api.estimateReportSummary.mockResolvedValue({ prompt_tokens: 1, max_output_tokens: 1, total_tokens: 2, cost: null, simulated: false, model: null });
});

describe('report surfaces a11y', () => {
  it('the panel is axe-clean with an expanded item', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TooltipProvider>
        <ReportPanel conversationId="conv-1" reportId="rep-1" mode="split" onClose={() => undefined} />
      </TooltipProvider>,
    );
    await user.click(await screen.findByRole('button', { name: /2\. Recent sign-in failures/ }));
    await screen.findByRole('heading', { name: 'Recent sign-in failures' }, { timeout: 15_000 });
    expect(await axe(container)).toHaveNoViolations();
    expect(duplicateIds(container)).toEqual([]);
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="alert"],[role="status"]')).toBeNull();
  }, 30_000);

  it('the library document view is axe-clean', async () => {
    const { container } = render(
      <TooltipProvider>
        <RouterProvider>
          <ReportsLibrary reportId="rep-1" />
        </RouterProvider>
      </TooltipProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Brute force on vpn-gw-2' });
    await waitFor(() => expect(container.querySelector('[data-testid="answer-blocks"]')).not.toBeNull(), { timeout: 15_000 });
    expect(await axe(container)).toHaveNoViolations();
    expect(duplicateIds(container)).toEqual([]);
  }, 30_000);
});
