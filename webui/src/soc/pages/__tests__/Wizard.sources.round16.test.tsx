/**
 * Round 16 (SPEC §4.5 WP15E, B43 and B46): the setup wizard's Data sources step offers
 * only what the server honours.
 *
 *  - B43: while Demo Mode is on, the list holds the Demo overlay rows. They show "Managed
 *    by Demo Mode" and no Make primary, Edit or Remove, so the wizard never writes a Demo
 *    source into the live configuration. Add source stays: real-source adds are allowed.
 *  - B46: Make primary shows only for a source whose own ingest mode is pull (a push
 *    Wazuh source whose connector also supports pull gets none), and success is toasted
 *    only when the returned list holds the source as primary; otherwise the wizard warns
 *    "Only a pull source can be the primary source."
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';

const {
  listConnectorsMock,
  listSourcesMock,
  deleteSourceMock,
  upsertSourceMock,
  demoStatusMock,
  authMeMock,
  rolesGetMock,
} = vi.hoisted(() => ({
  listConnectorsMock: vi.fn(),
  listSourcesMock: vi.fn(),
  deleteSourceMock: vi.fn(),
  upsertSourceMock: vi.fn(),
  demoStatusMock: vi.fn(),
  authMeMock: vi.fn(),
  rolesGetMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (v: unknown) => vi.fn().mockResolvedValue(v);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      setupStatus: ok({ setup_complete: false, configured: {} }),
      listConnectors: listConnectorsMock,
      listSources: listSourcesMock,
      deleteSource: deleteSourceMock,
      upsertSource: upsertSourceMock,
      getSettings: ok({ prefs: {} }),
      putSettings: ok({ ok: true }),
      completeSetup: ok({ ok: true }),
      auth: { me: authMeMock, logout: ok({ ok: true }) },
      roles: { get: rolesGetMock },
      demo: {
        status: demoStatusMock,
        enable: ok({ mode: 'seeded', active: true }),
        disable: ok({ mode: 'off', active: false }),
        reset: ok({ mode: 'off', active: false }),
      },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

vi.mock('@/soc/components/SourceEditor', () => ({
  SourceEditor: (props: { existing?: { id: string } }) => (
    <div data-testid="source-editor-stub">{props.existing ? `editing ${props.existing.id}` : 'new source form'}</div>
  ),
}));

import { TooltipProvider } from '@/ui/tooltip';
import { AuthProvider } from '../../auth';
import { DemoProvider } from '../../demo';
import Wizard from '../Wizard';

const CONNECTORS = [
  { source_type: 'wazuh', display_name: 'Wazuh', category: 'edr', ingest_modes: ['pull', 'push_http'], fields: [] },
  { source_type: 'elasticsearch', display_name: 'Elasticsearch', category: 'siem', ingest_modes: ['pull'], fields: [] },
  { source_type: 'webhook', display_name: 'Webhook', category: 'push', ingest_modes: ['push_http'], fields: [] },
];

/** The rows GET /api/sources returns while Demo Mode is on (the overlay). */
const DEMO_ROWS = [
  {
    id: 'demo-wazuh',
    source_type: 'wazuh',
    display_name: 'Wazuh Manager (endpoint telemetry)',
    enabled: true,
    is_primary: false,
    ingest_mode: 'push_http',
    config: { protocol: 'Wazuh JSON', format: 'archives.json events + alerts.json alerts' },
    configured_secrets: [],
    demo: true,
  },
  {
    id: 'demo-splunk',
    source_type: 'splunk',
    display_name: 'Splunk Enterprise Security (HEC)',
    enabled: true,
    is_primary: false,
    ingest_mode: 'push_http',
    config: {},
    configured_secrets: [],
    demo: true,
  },
];

const PUSH_WAZUH = {
  id: 'wz-1',
  source_type: 'wazuh',
  display_name: 'Wazuh push',
  enabled: true,
  is_primary: false,
  ingest_mode: 'push_http',
  config: {},
  configured_secrets: [],
};

const PULL_ES = {
  id: 'es-2',
  source_type: 'elasticsearch',
  display_name: 'Lake search',
  enabled: true,
  is_primary: false,
  ingest_mode: 'pull',
  config: {},
  configured_secrets: [],
};

function renderWizard() {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <DemoProvider>
          <Wizard onComplete={vi.fn()} />
        </DemoProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
}

async function openDataSources() {
  const user = userEvent.setup();
  renderWizard();
  await user.click(await screen.findByRole('button', { name: /Data sources/i }));
  await screen.findByRole('heading', { level: 1, name: /Connect the systems you already use/i });
  return { user };
}

/** The list row that holds a source's name. */
function rowOf(name: string): HTMLElement {
  const label = screen.getByText(name);
  const row = label.closest<HTMLElement>('.py-5');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe('Wizard Data sources step (Round 16 B43, B46)', () => {
  beforeEach(() => {
    listConnectorsMock.mockReset().mockResolvedValue({ connectors: CONNECTORS });
    listSourcesMock.mockReset().mockResolvedValue({ sources: [] });
    deleteSourceMock.mockReset().mockResolvedValue({ ok: true, sources: [] });
    upsertSourceMock.mockReset().mockResolvedValue({ ok: true, sources: [] });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    rolesGetMock
      .mockReset()
      .mockResolvedValue({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} });
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.warning).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it('shows Demo rows as managed by Demo Mode, with no actions (B43)', async () => {
    demoStatusMock.mockResolvedValue({ mode: 'seeded', active: true });
    listSourcesMock.mockResolvedValue({ sources: DEMO_ROWS });
    await openDataSources();

    await screen.findByText('Wazuh Manager (endpoint telemetry)');
    for (const row of DEMO_ROWS) {
      const scope = within(rowOf(row.display_name));
      expect(scope.getByText('Managed by Demo Mode')).toBeInTheDocument();
      expect(scope.queryByRole('button')).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Make primary' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    // A real source can still be added while Demo is on.
    expect(screen.getByRole('button', { name: /Add source/ })).toBeInTheDocument();
    expect(upsertSourceMock).not.toHaveBeenCalled();
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });

  it('offers Make primary only for a pull source (B46)', async () => {
    listSourcesMock.mockResolvedValue({ sources: [PUSH_WAZUH, PULL_ES] });
    await openDataSources();

    await screen.findByText('Wazuh push');
    // The Wazuh connector also supports pull, but this source is push: no Make primary.
    expect(within(rowOf('Wazuh push')).queryByRole('button', { name: 'Make primary' })).toBeNull();
    expect(within(rowOf('Lake search')).getByRole('button', { name: 'Make primary' })).toBeInTheDocument();
  });

  it('toasts success only when the server confirms the source is primary (B46)', async () => {
    listSourcesMock.mockResolvedValue({ sources: [PULL_ES] });
    const { user } = await openDataSources();

    upsertSourceMock.mockResolvedValueOnce({ ok: true, sources: [{ ...PULL_ES, is_primary: true }] });
    await user.click(await screen.findByRole('button', { name: 'Make primary' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Lake search is now the primary source'));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('warns instead of claiming success when the server did not make it primary (B46)', async () => {
    listSourcesMock.mockResolvedValue({ sources: [PULL_ES] });
    const { user } = await openDataSources();

    upsertSourceMock.mockResolvedValueOnce({ ok: true, sources: [{ ...PULL_ES, is_primary: false }] });
    await user.click(await screen.findByRole('button', { name: 'Make primary' }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Only a pull source can be the primary source.'),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
