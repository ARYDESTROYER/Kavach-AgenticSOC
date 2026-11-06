/**
 * Settings — jest-axe accessibility smoke (Round-5 G9 · DESIGN_STANDARD §6).
 *
 * The god-surface: a two-scope section rail + a form-dense active section (labels,
 * inputs, switches, selects, a sticky save bar). A dropped label / mis-wired rail
 * button / bad tab semantics here is high blast-radius. We mount the real <Settings/>
 * in the full provider stack with an offline-mocked api, wait for the rail to render
 * the "Data scope" section, and assert no axe violations on the default section.
 *
 * Offline: no network, no #3 / runtime behaviour touched.
 *
 * The narrow section chooser now mounts its grouped navigation only while its Sheet is
 * open, and the desktop category rail has a distinct landmark name from the in-section
 * anchor navigation. The smoke therefore runs with the complete axe ruleset—there are
 * no responsive duplicate-landmark exclusions.
 *
 * `button-name` / `select-name` are ENABLED (H4 fixed): every Field-wrapped Radix
 *    Select now forwards the Field id + `aria-labelledby` to its `<SelectTrigger>`, and
 *    the non-Field Selects carry an explicit `aria-label`, so every `role="combobox"`
 *    trigger has an accessible name. These rules guard against the regression returning.
 */
import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  const prefs = {
    data_view_pattern: 'all-logs-*', time_field: '@timestamp', source_ip_field: 'source.ip',
    user_field: 'user.name', host_field: 'host.name', rule_field: 'rule.id',
    rule_name_field: 'rule.name', severity_field: 'event.severity', severity_threshold: 3,
    investigate_lookback: 'now-24h', polling_enabled: false, poll_interval_seconds: 60,
    poll_batch_size: 100, cold_start_lookback_minutes: 60, sources: [], setup_complete: true,
  };
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: {
        me: ok({ auth_enabled: false, authenticated: true, user: null }),
        logout: ok({ ok: true }),
        sso: { setSecret: ok({ configured: true }) },
      },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      getSettings: ok({ prefs, configured: {}, read_only: false }),
      getModels: ok({ providers: { anthropic: ['claude-sonnet'] } }),
      getSettingsSchema: ok({ sections: [] }),
      getBranding: ok({}),
      caseIdPreview: ok({ samples: [], valid: true }),
      account: { get: ok({ username: '', role: '', env_managed: false }), put: ok({}), avatar: ok({}) },
      account_activity: ok({ events: [] }),
      sessions: { list: ok({ sessions: [] }), revoke: ok({ ok: true }), revokeOthers: ok({ revoked: 0 }) },
      users: { list: ok({ users: [] }), create: ok({}), update: ok({}), remove: ok({}) },
      admin: {
        sessions: { list: ok({ sessions: [] }), revoke: ok({ ok: true }) },
        users: { revokeAll: ok({ ok: true, revoked: 0 }) },
      },
    },
  };
});

import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Settings from '../pages/Settings';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

describe('Settings — a11y smoke (jest-axe)', () => {
  it('has no axe violations on the loaded default section', async () => {
    const { container } = renderWithProviders(<Settings />);
    // Wait out the loading→ready transition (rail + default section rendered).
    await waitFor(
      () => expect(screen.getByTestId('settings-section-general')).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
