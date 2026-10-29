/**
 * Smoke test for the rebuilt (Tailwind + shadcn) SOC console.
 *
 * Mounts the whole <App/> with a mocked API surface and asserts it boots through
 * auth -> setup -> shell and renders the Overview dashboard WITHOUT tripping the
 * top-level error boundary. This exercises ThemeProvider, RouterProvider,
 * AppShell, and the Overview page (KPI tiles, risk gauge, bar lists) together.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  const branding = {
    org_name: '',
    product_name: '',
    logo_data_url: '',
    favicon_data_url: '',
    accent_color: '',
    accent_color2: '',
    theme: '',
    login_subtitle: '',
    footer_text: '',
    support_url: '',
    dark_mode_default: false,
  };
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    // ApiError is imported by several co-located *.api.ts modules (e.g. Models /
    // Roles error-message helpers); keep it a real Error subclass so `instanceof`
    // checks behave.
    ApiError: class ApiError extends Error {
      status: number;
      body: unknown;
      constructor(status = 0, message = '', body: unknown = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
      }
    },
    api: {
      // Round-3 generic verbs. The integrated shell mounts the NotificationBell
      // (polls `api.get('notifications/inbox/unread-count')`) and every co-located
      // *.api.ts module (Inbox / Models / Roles / Metrics / CaseDetail / Enrichment)
      // calls these top-level verbs. Without them the smoke test throws synchronously
      // inside an effect. Empty resolutions are safe — the bell shows 0 unread.
      get: ok({}),
      post: ok({}),
      put: ok({}),
      del: ok({}),
      auth: {
        me: ok({ auth_enabled: false, authenticated: true, user: null }),
        login: ok({ token: 't', user: { username: 'x' } }),
        logout: ok({ ok: true }),
        changePassword: ok({ ok: true }),
      },
      setup: {
        status: ok({ setup_complete: true }),
      },
      roles: {
        get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }),
      },
      getBranding: ok(branding),
      setupStatus: ok({ setup_complete: true }),
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      getMetrics: ok({ by_status: {}, by_verdict: {}, total_cases: 0 }),
      listCases: ok({ cases: [], total: 0 }),
      usageSummary: ok({
        total_cost: 0,
        total_tokens: 0,
        total_calls: 0,
        by_model: [],
        by_role: [],
        by_surface: [],
        series: [],
      }),
      ragStats: ok({ total_chunks: 0, document_count: 0, embedding_model: '', vector_dims: 0, by_source: [] }),
      getFeedbackStats: ok({}),
    },
  };
});

import { App } from '../App';
import { PAGE_TITLE } from '../pages/Overview';

describe('SOC console — app smoke', () => {
  it('boots to the Overview dashboard without throwing', async () => {
    render(<App />);
    // Boot guard: the app must reach the Overview hero. We anchor on the stable
    // `page-hero` testid (survives any reword/restyle) AND assert the current hero
    // title constant renders inside it — proving the console booted, not white-screened.
    await waitFor(() => expect(screen.getByTestId('page-hero')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getByTestId('page-hero')).toHaveTextContent(PAGE_TITLE);
    // The top-level ErrorBoundary fallback must NOT be showing.
    expect(screen.queryByText(/Something went wrong/i)).toBeNull();
  });

  it('exposes a focusable skip-to-main link that targets #socMain (WCAG 2.4.1)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('page-hero')).toBeInTheDocument(), {
      timeout: 5000,
    });
    // The skip link is a real anchor (in the tab order) pointing at the main region.
    const skip = screen.getByRole('link', { name: /skip to main content/i });
    expect(skip).toHaveAttribute('href', '#socMain');
    // It is sr-only until focused (no aria-hidden — it must be reachable by a SR/AT).
    expect(skip).not.toHaveAttribute('aria-hidden');
    expect(skip).toHaveClass('sr-only');
    expect(skip).toHaveClass('focus:not-sr-only');
    // Its target exists and is programmatically focusable (tabIndex=-1).
    const main = document.getElementById('socMain');
    expect(main).not.toBeNull();
    expect(main?.tagName).toBe('MAIN');
    expect(main).toHaveAttribute('tabindex', '-1');
    // Wide, intentionally scrollable child surfaces (for example the rules table)
    // must never leak their intrinsic width into the whole Console viewport. CLIP, not
    // hidden: `overflow-x: hidden` makes the element a vertical scroll container too, so
    // every sticky descendant (the top bar, sticky material bars, sticky table headers)
    // would pin to a box that never scrolls and scroll away with the page.
    for (const el of [main, main?.parentElement?.parentElement]) {
      expect(el).toHaveClass('overflow-x-clip');
      expect(el).not.toHaveClass('overflow-x-hidden');
    }
  });
});
