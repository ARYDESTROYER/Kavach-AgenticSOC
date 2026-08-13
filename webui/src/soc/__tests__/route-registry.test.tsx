/**
 * Route registry + navigation-seam tests (Round-5 Coupling-A).
 *
 * The hand-maintained `App.renderPage` switch + the parallel eager lazy-import table
 * were replaced by ONE `FEATURES[]`-derived `ROUTES` table in `soc/registry.tsx`. These
 * tests lock the load-bearing contract of that refactor WITHOUT a browser:
 *   - every routable PageId (all 31 + custom-dashboards) resolves to a lazy route,
 *   - every route element is a React.lazy chunk (so the entry stays code-split),
 *   - `renderRoute` falls back to Overview for an unknown id (no white-screen),
 *   - `useNavigateOptional()` returns a no-op OUTSIDE a provider (so a provider-less
 *     page render never throws) and the REAL navigate INSIDE one.
 */
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';

import { ROUTES, renderRoute } from '../registry';
import { PAGE_IDS } from '../nav';
import { RouterProvider, useNavigateOptional, useRoute } from '../router';

describe('ROUTES registry', () => {
  it('has a route for every routable PageId (deep-link back-compat)', () => {
    // The router validates hashes against PAGE_IDS; each MUST resolve in ROUTES so a
    // deep-link never falls through to Overview by accident.
    for (const id of PAGE_IDS) {
      expect(ROUTES[id], `missing ROUTES entry for "${id}"`).toBeDefined();
      expect(ROUTES[id].element).toBeTruthy();
    }
  });

  it('covers every documented page id, including custom dashboards and Docs', () => {
    // The DESIGN_STANDARD deep-link contract: these ids must remain routable.
    const EXPECTED = [
      'overview', 'dashboard', 'dashboards', 'cases', 'case_manager', 'investigate', 'chat',
      'intelligence', 'metrics', 'effectiveness', 'models', 'scans', 'standup', 'catalog', 'runbooks', 'playbooks', 'personas',
      'approvals', 'knowledge', 'memory', 'sources', 'cost', 'inbox', 'account',
      'sessions', 'settings', 'security', 'roles', 'users', 'audit', 'admin_sessions',
      'logs', 'campaigns', 'tuning', 'batchjobs', 'baseline',
      'docs',
    ] as const;
    for (const id of EXPECTED) {
      expect(ROUTES[id as keyof typeof ROUTES], `missing route "${id}"`).toBeDefined();
    }
  });

  it('every route element is a React.lazy chunk (entry stays code-split)', () => {
    // A React.lazy component is an exotic object with `$$typeof === react.lazy` and a
    // `_payload`/`_init` pair — never an eagerly-imported function component. This is
    // what keeps the page bodies OUT of the first-paint entry chunk.
    const LAZY = Symbol.for('react.lazy');
    for (const [id, def] of Object.entries(ROUTES)) {
      const el = def.element as unknown as { $$typeof?: symbol; _init?: unknown };
      expect(el.$$typeof, `route "${id}" element is not React.lazy`).toBe(LAZY);
      expect(typeof el._init).toBe('function');
    }
  });

  it('renderRoute falls back to Overview for an unknown id', () => {
    // Unknown id → the Overview route element (mirrors router pageFromHash default).
    const el = renderRoute('does-not-exist' as never, { onRerunWizard: () => {} });
    expect(el.type).toBe(ROUTES.overview.element);
  });

  it('renderRoute threads config props (not onNavigate) for special routes', () => {
    // `cases` seeds initialStatus from opts.status; `dashboard` forces the tab; neither
    // receives an onNavigate prop (pages use useNavigate/useNavigateOptional now).
    const cases = renderRoute('cases', {
      opts: { status: 'needs_human', assignee: 'ana', tag: 'phishing', window: 24 },
      onRerunWizard: () => {},
    });
    expect((cases.props as { initialStatus?: string }).initialStatus).toBe('needs_human');
    expect((cases.props as { initialAssignee?: string }).initialAssignee).toBe('ana');
    expect((cases.props as { initialTag?: string }).initialTag).toBe('phishing');
    expect((cases.props as { initialWindowHours?: number }).initialWindowHours).toBe(24);
    expect((cases.props as Record<string, unknown>).onNavigate).toBeUndefined();

    const manager = renderRoute('case_manager', {
      opts: { caseId: 'case-123' },
      onRerunWizard: () => {},
    });
    expect((manager.props as { initialCaseId?: string }).initialCaseId).toBe('case-123');

    const dash = renderRoute('dashboard', { onRerunWizard: () => {} });
    expect((dash.props as { tab?: string }).tab).toBe('dashboard');
  });
});

describe('useNavigateOptional', () => {
  function Probe({ onNav }: { onNav: (fn: ReturnType<typeof useNavigateOptional>) => void }) {
    const nav = useNavigateOptional();
    onNav(nav);
    return null;
  }

  it('returns a callable no-op OUTSIDE a RouterProvider (never throws)', () => {
    let nav: ReturnType<typeof useNavigateOptional> | null = null;
    // No provider: must NOT throw (unlike useRoute/useNavigate) and must be callable.
    expect(() => render(<Probe onNav={(n) => (nav = n)} />)).not.toThrow();
    expect(typeof nav).toBe('function');
    expect(() => nav!('cases')).not.toThrow();
  });

  it('returns the REAL navigate INSIDE a RouterProvider', () => {
    let nav: ReturnType<typeof useNavigateOptional> | null = null;
    let currentPage = '';
    function Reader() {
      currentPage = useRoute().page;
      return null;
    }
    render(
      <RouterProvider>
        <Probe onNav={(n) => (nav = n)} />
        <Reader />
      </RouterProvider>,
    );
    // Driving the real navigate changes the router's current page (in-memory).
    act(() => nav!('cases'));
    expect(currentPage).toBe('cases');
  });
});
