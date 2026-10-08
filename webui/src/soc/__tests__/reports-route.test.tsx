/**
 * Reports + Logs routing (chat revamp SPEC §10.6, §10.7): `reports` is a routable PageId
 * under the Workspace group (Chat · Investigate · Reports) with its own lazy route; the
 * `reportId` deep link round-trips through the hash; the Logs route is the page that reads
 * the logs deep link; the new pages compose the shared page anatomy; and the audit viewer
 * offers the new `report` action type.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      audit: { list: ok({ records: [] }) },
    },
  };
});

import { FEATURES, ROUTES, renderRoute } from '../registry';
import { NAV_CHILDREN, isPageId, navLabel, navParentOf } from '../nav';
import { optsFromHash, pageFromHash, pageHash, RouterProvider } from '../router';
import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import Audit from '../pages/Audit';

const SRC = path.resolve(process.cwd(), 'src');

afterEach(() => {
  window.location.hash = '';
});

describe('reports route', () => {
  it('is a routable PageId under Workspace: Chat · Investigate · Reports', () => {
    expect(isPageId('reports')).toBe(true);
    expect(navLabel('reports')).toBe('Reports');
    const workspace = FEATURES.find((f) => f.id === 'chat' && !f.hidden)!;
    expect(workspace.children?.map((c) => c.label)).toEqual(['Chat', 'Entity investigation', 'Reports']);
    expect(navParentOf('reports')?.id).toBe('chat');
    expect(NAV_CHILDREN.some((c) => c.id === 'reports' && c.icon)).toBe(true);
  });

  it('is gated on cases:read in the rail and the palette, like the reports API (SPEC §9.2)', () => {
    const workspace = FEATURES.find((f) => f.id === 'chat' && !f.hidden)!;
    expect(workspace.children?.find((c) => c.id === 'reports')?.perm).toEqual({ resource: 'cases', action: 'read' });
  });

  it('renders its own lazy page (not a Workspace tab)', () => {
    const el = ROUTES.reports.element as unknown as { $$typeof?: symbol };
    expect(el.$$typeof).toBe(Symbol.for('react.lazy'));
    expect(ROUTES.reports.element).not.toBe(ROUTES.chat.element);
    expect(renderRoute('reports', { onRerunWizard: () => undefined }).type).toBe(ROUTES.reports.element);
    expect(renderRoute('logs', { onRerunWizard: () => undefined }).type).toBe(ROUTES.logs.element);
  });

  it('round-trips the reportId deep link through the hash', () => {
    expect(pageHash('reports', { reportId: 'rep-1' })).toBe('#/reports?reportId=rep-1');
    window.location.hash = '#/reports?reportId=rep-1';
    expect(pageFromHash()).toBe('reports');
    expect(optsFromHash()).toEqual({ reportId: 'rep-1' });
    window.location.hash = '#/reports?reportId=..%2Fx';
    expect(optsFromHash()).toBeUndefined();
  });

  it('serialises the logs deep link the Logs page reads', () => {
    expect(pageHash('logs', { logQuery: 'source.ip:1.2.3.4', from: 'now-24h', sourceId: 'wazuh' })).toBe(
      '#/logs?logQuery=source.ip%3A1.2.3.4&from=now-24h&sourceId=wazuh',
    );
  });

  it('routes Logs through the page that reads the deep link', () => {
    const registry = readFileSync(path.join(SRC, 'soc', 'registry.tsx'), 'utf8');
    expect(registry).toContain("React.lazy(() => import('./pages/UnifiedLogs'))");
    expect(registry).toContain("React.lazy(() => import('./pages/Reports'))");
  });

  it.each(['soc/pages/Reports.tsx', 'soc/pages/UnifiedLogs.tsx'])('%s composes the shared page container and header', (file) => {
    const text = readFileSync(path.join(SRC, file), 'utf8');
    expect(text).toContain('<PageContainer');
    expect(text).toContain('<PageHeader');
    expect(text).not.toMatch(/<PageContainer\b[^>]*className="[^"]*animate-fade-in/);
  });
});

describe('audit action filter', () => {
  it('offers the chat report action type', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <AuthProvider>
          <RouterProvider>
            <Audit />
          </RouterProvider>
        </AuthProvider>
      </TooltipProvider>,
    );
    const trigger = await screen.findByRole('combobox', { name: 'Filter by action' });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    await waitFor(() => expect(within(listbox).getByRole('option', { name: 'Report' })).toBeInTheDocument());
    expect(within(listbox).getByRole('option', { name: 'System update' })).toBeInTheDocument();
  });
});
