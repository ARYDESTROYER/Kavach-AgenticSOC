/**
 * Ask AI chips in the Cases list (Round 12 WP-ASK): the Case ID cell asks about the case
 * and the Entity cell about its value (kind from the entity type), each opening a NEW
 * Workspace chat with a TYPED reference (never free text), never opening the case row;
 * the entity value stays on one line, and the hidden chips are icons, not labels, so the
 * columns do not grow by a label's width. Real router + auth (auth disabled: every grant
 * allowed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { listCasesMock } = vi.hoisted(() => ({ listCasesMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: {}, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        }),
        putUser: ok({}),
      },
      views: { list: ok({ views: [], count: 0 }) },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }) },
      listCases: listCasesMock,
      cases: { bulk: vi.fn().mockResolvedValue({ results: [] }) },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider, useRoute } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Cases from '../pages/Cases';

const CASES = [
  {
    case_id: 'case-001',
    case_number: 'TLSOC-001',
    title: 'Alpha',
    status: 'open',
    entity: { type: 'ip', value: '203.0.113.77' },
    updated_at: '2026-06-29T00:00:00Z',
    tags: [],
    comments: [],
  },
  {
    case_id: 'case-002',
    case_number: 'TLSOC-002',
    title: 'Beta',
    status: 'open',
    entity: { type: 'process', value: 'cmd.exe /c whoami' },
    updated_at: '2026-06-28T00:00:00Z',
    tags: [],
    comments: [],
  },
];

function RouteProbe() {
  const { page, opts } = useRoute();
  return <output data-testid="route" data-page={page} data-opts={JSON.stringify(opts ?? null)} />;
}

function renderCases() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <RouteProbe />
                <Cases />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe('Ask AI in the Cases list', () => {
  beforeEach(() => {
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
    window.location.hash = '#/cases';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('asks about the case from its id and about the entity from its value', async () => {
    const user = userEvent.setup();
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const row = screen.getByText('Alpha').closest('tr')!;

    // The chip loads lazily (it is never a static chunk on the entry's preload lists).
    await user.click(await within(row).findByRole('button', { name: 'Ask AI about 203.0.113.77' }));
    const probe = screen.getByTestId('route');
    expect(probe).toHaveAttribute('data-page', 'chat');
    expect(JSON.parse(probe.getAttribute('data-opts')!)).toEqual({
      newChat: true,
      entity: { kind: 'ip', value: '203.0.113.77' },
    });
    // The reference never reaches the URL, and the row did not open the case.
    expect(window.location.hash).toBe('#/chat');
  });

  it('asks about the case itself from the Case ID cell', async () => {
    const user = userEvent.setup();
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: 'Ask AI about case TLSOC-001' }));
    const probe = screen.getByTestId('route');
    expect(probe).toHaveAttribute('data-page', 'chat');
    expect(JSON.parse(probe.getAttribute('data-opts')!)).toEqual({
      newChat: true,
      entity: { kind: 'case', value: 'TLSOC-001' },
    });
  });

  it('keeps the hidden chips to a 24 px icon that copying a row never picks up', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const row = screen.getByText('Alpha').closest('tr')!;
    for (const name of ['Ask AI about case TLSOC-001', 'Ask AI about 203.0.113.77']) {
      const chip = await within(row).findByRole('button', { name });
      expect(chip).toHaveTextContent(/^$/);
      expect(chip.className).toContain('size-6');
      expect(chip.className).toContain('select-none');
      expect(chip.className).toContain('opacity-0');
    }
  });

  it('offers no entity chip for a kind it cannot name, and keeps the value on one line', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
    const row = screen.getByText('Beta').closest('tr')!;
    // The case chip is there (so the lazy chip module has loaded)...
    expect(await within(row).findByRole('button', { name: 'Ask AI about case TLSOC-002' })).toBeInTheDocument();
    // ...and the entity it cannot name has none.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(row).queryByRole('button', { name: /^Ask AI about cmd/ })).toBeNull();
    const value = within(screen.getByText('Alpha').closest('tr')!).getByText('203.0.113.77');
    expect(value.className).toContain('truncate');
    expect(value).toHaveAttribute('title', '203.0.113.77');
  });
});
