/**
 * Log Sources page (WS-C rebuild) — QRadar-style Log Source Management table.
 *
 * Fully mocked / offline. Verifies the rebuilt DataTable surface:
 *   - renders a row per source from the listSources mock (+ a live count),
 *   - the toolbar search filters the list client-side,
 *   - the inline per-row Enabled toggle round-trips through api.upsertSource,
 *   - "+ New Log Source" opens the SourceEditor dialog,
 *   - the Manage-Columns gear is present.
 *
 * The heavy manifest-driven <SourceEditor> and the <SourceLogsSheet> are stubbed so
 * the test exercises the PAGE (toolbar/table/toggle/actions), not those children.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  listConnectorsMock,
  listSourcesMock,
  sourcesHealthMock,
  sourcesCoverageMock,
  upsertSourceMock,
  demoStatusMock,
} = vi.hoisted(() => ({
  listConnectorsMock: vi.fn(),
  listSourcesMock: vi.fn(),
  sourcesHealthMock: vi.fn(),
  sourcesCoverageMock: vi.fn(),
  upsertSourceMock: vi.fn(),
  demoStatusMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
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
        tables: { put: ok({}) },
      },
      views: { list: ok({ views: [], count: 0 }) },
      demo: { status: demoStatusMock },
      listConnectors: listConnectorsMock,
      listSources: listSourcesMock,
      sourcesHealth: sourcesHealthMock,
      sourcesCoverage: sourcesCoverageMock,
      upsertSource: upsertSourceMock,
      deleteSource: vi.fn().mockResolvedValue({ ok: true, sources: [] }),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Stub the heavy children so the test targets the Log Sources PAGE, not the editor.
vi.mock('@/soc/components/SourceEditor', () => ({
  SourceEditor: () => <div data-testid="source-editor" />,
}));
vi.mock('@/soc/components/SourceLogsSheet', () => ({
  SourceLogsSheet: ({ source }: { source: unknown }) =>
    source ? <div data-testid="logs-sheet" /> : null,
}));

import { ThemeProvider } from '../../theme';
import { PrefsProvider } from '../../prefs';
import { AuthProvider } from '../../auth';
import { DemoProvider } from '../../demo';
import { TooltipProvider } from '@/ui/tooltip';
import Sources from '../Sources';
import type {
  ConnectorManifest,
  SourceInstance,
  SourceHealthRow,
  SourceCoverage,
} from '@/lib/types';

const CONNECTORS: ConnectorManifest[] = [
  {
    source_type: 'elasticsearch',
    display_name: 'Elasticsearch',
    category: 'siem',
    capabilities: ['browse'],
    ingest_modes: ['pull'],
  },
  {
    source_type: 'webhook',
    display_name: 'Webhook',
    category: 'transport',
    capabilities: ['browse'],
    ingest_modes: ['push'],
  },
] as unknown as ConnectorManifest[];

const SOURCES: SourceInstance[] = [
  {
    id: 'es-1',
    source_type: 'elasticsearch',
    display_name: 'Prod ES',
    enabled: true,
    is_primary: true,
    ingest_mode: 'pull',
    can_browse: true,
    config: {},
    configured_secrets: ['es_api_key'],
  },
  {
    id: 'wh-1',
    source_type: 'webhook',
    display_name: 'Webhook Ingest',
    enabled: false,
    is_primary: false,
    ingest_mode: 'push_http',
    can_browse: true,
    config: {},
    configured_secrets: [],
  },
];

const HEALTH: SourceHealthRow[] = [
  {
    source_id: 'es-1',
    source_name: 'Prod ES',
    source_type: 'elasticsearch',
    enabled: true,
    is_primary: true,
    ingest_mode: 'pull',
    kind: 'pull',
    can_browse: true,
    buffer_depth: 0,
    last_poll_millis: Date.now() - 5 * 60 * 1000,
  },
  {
    source_id: 'wh-1',
    source_name: 'Webhook Ingest',
    source_type: 'webhook',
    enabled: false,
    is_primary: false,
    ingest_mode: 'push_http',
    kind: 'push',
    can_browse: true,
    buffer_depth: 3,
    last_poll_millis: 0,
  },
];

const DEMO_SPLUNK: SourceInstance = {
  id: 'demo-splunk',
  source_type: 'splunk',
  display_name: 'Splunk Enterprise (Demo)',
  enabled: true,
  is_primary: false,
  ingest_mode: 'push_http',
  can_browse: true,
  config: { protocol: 'HEC' },
  configured_secrets: [],
  demo: true,
};

const DEMO_SPLUNK_HEALTH: SourceHealthRow = {
  source_id: 'demo-splunk',
  source_name: 'Splunk Enterprise (Demo)',
  source_type: 'splunk',
  enabled: true,
  is_primary: false,
  ingest_mode: 'push_http',
  kind: 'push',
  can_browse: true,
  buffer_depth: 6,
  last_poll_millis: Date.now() - 10_000,
  demo: true,
};

/** The aggregate coverage rollup (GET /api/sources/coverage) — 1 enabled of 2 configured. */
const COVERAGE: SourceCoverage = {
  sources_total: 2,
  sources_enabled: 1,
  sources_silent: 0,
  events_per_min: 42,
  alerts_triaged_24h: 7,
  worst_last_event_seconds: 300,
};

/** A three-source enabled fleet exercising the server-truth statuses: active / silent / error. */
const SOURCES_STATUS: SourceInstance[] = [
  { id: 'ok-1', source_type: 'elasticsearch', display_name: 'Healthy ES', enabled: true, is_primary: true, ingest_mode: 'pull', config: {}, configured_secrets: [] },
  { id: 'silent-1', source_type: 'elasticsearch', display_name: 'Quiet ES', enabled: true, is_primary: false, ingest_mode: 'pull', config: {}, configured_secrets: [] },
  { id: 'broken-1', source_type: 'elasticsearch', display_name: 'Broken ES', enabled: true, is_primary: false, ingest_mode: 'pull', config: {}, configured_secrets: [] },
];

const HEALTH_STATUS: SourceHealthRow[] = [
  {
    source_id: 'ok-1', source_name: 'Healthy ES', source_type: 'elasticsearch',
    enabled: true, is_primary: true, ingest_mode: 'pull', kind: 'pull', can_browse: true,
    buffer_depth: 0, last_poll_millis: Date.now() - 60 * 1000,
    last_poll_at: new Date().toISOString(), last_poll_ok: true, last_poll_error: null,
    last_event_millis: Date.now() - 60 * 1000, events_per_min: 30, silent: false,
  },
  {
    source_id: 'silent-1', source_name: 'Quiet ES', source_type: 'elasticsearch',
    enabled: true, is_primary: false, ingest_mode: 'pull', kind: 'pull', can_browse: true,
    buffer_depth: 0, last_poll_millis: Date.now() - 2 * 3600 * 1000,
    last_poll_at: new Date().toISOString(), last_poll_ok: true, last_poll_error: null,
    last_event_millis: Date.now() - 6 * 3600 * 1000, events_per_min: 0, silent: true,
  },
  {
    source_id: 'broken-1', source_name: 'Broken ES', source_type: 'elasticsearch',
    enabled: true, is_primary: false, ingest_mode: 'pull', kind: 'pull', can_browse: true,
    buffer_depth: 0, last_poll_millis: 0,
    last_poll_at: new Date().toISOString(), last_poll_ok: false,
    last_poll_error: 'index_not_found_exception', last_event_millis: 0,
    events_per_min: 0, silent: false,
  },
];

const COVERAGE_STATUS: SourceCoverage = {
  sources_total: 3,
  sources_enabled: 3,
  sources_silent: 1,
  events_per_min: 30,
  alerts_triaged_24h: 12,
  worst_last_event_seconds: 6 * 3600,
};

function renderSources() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <Sources />
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe('Log Sources page (WS-C)', () => {
  beforeEach(() => {
    listConnectorsMock.mockReset().mockResolvedValue({ connectors: CONNECTORS });
    listSourcesMock.mockReset().mockResolvedValue({ sources: SOURCES });
    sourcesHealthMock.mockReset().mockResolvedValue({ sources: HEALTH });
    sourcesCoverageMock.mockReset().mockResolvedValue(COVERAGE);
    upsertSourceMock.mockReset().mockResolvedValue({ ok: true, sources: SOURCES });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false, run_id: null });
    window.localStorage.clear();
  });

  it('renders a table row per source with a live count', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByText('Prod ES')).toBeInTheDocument());
    expect(screen.getByText('Webhook Ingest')).toBeInTheDocument();
    // The QRadar-style count line "Log Sources (N)".
    expect(screen.getByTestId('sources-count')).toHaveTextContent('(2)');
  });

  it('filters the list client-side via the toolbar search', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByText('Webhook Ingest')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search log sources'), {
      target: { value: 'Prod' },
    });

    expect(screen.getByText('Prod ES')).toBeInTheDocument();
    expect(screen.queryByText('Webhook Ingest')).not.toBeInTheDocument();
    expect(screen.getByTestId('sources-count')).toHaveTextContent('(1)');

    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(clear).toHaveClass('min-h-6', 'min-w-6');
    expect(clear.querySelector('svg')).toHaveClass('size-4');
    fireEvent.click(clear);
    expect(screen.getByLabelText('Search log sources')).toHaveValue('');
    expect(screen.getByText('Webhook Ingest')).toBeInTheDocument();
  });

  it('the inline Enabled toggle round-trips through api.upsertSource', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByText('Prod ES')).toBeInTheDocument());

    // Prod ES is enabled → toggling requests enabled:false via the SAME upsert path.
    fireEvent.click(screen.getByLabelText('Enable Prod ES'));

    await waitFor(() => expect(upsertSourceMock).toHaveBeenCalled());
    expect(upsertSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'es-1', enabled: false }),
    );
  });

  it('"+ New Log Source" opens the SourceEditor dialog', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByText('Prod ES')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new log source/i }));

    expect(await screen.findByText('Add a log source')).toBeInTheDocument();
    expect(screen.getByTestId('source-editor')).toBeInTheDocument();
  });

  it('exposes the Manage-Columns gear', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByText('Prod ES')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /customize columns/i })).toBeInTheDocument();
  });

  it('renders the coverage banner from the server rollup (sources · events/min · triaged · silent)', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByTestId('coverage-banner')).toBeInTheDocument());
    expect(sourcesCoverageMock).toHaveBeenCalled();
    const banner = screen.getByTestId('coverage-banner');
    // 1 of 2 enabled · 42 events/min · 7 triaged · 0 silent (all from COVERAGE).
    expect(within(banner).getByTestId('coverage-sources')).toHaveTextContent('1 of 2');
    expect(within(banner).getByTestId('coverage-events')).toHaveTextContent('42');
    expect(within(banner).getByTestId('coverage-alerts')).toHaveTextContent('7');
    expect(within(banner).getByTestId('coverage-silent')).toHaveTextContent('0');
  });

  it('surfaces server-truth per-row status: Active / Silent / Error over the client 24h heuristic', async () => {
    listSourcesMock.mockResolvedValue({ sources: SOURCES_STATUS });
    sourcesHealthMock.mockResolvedValue({ sources: HEALTH_STATUS });
    sourcesCoverageMock.mockResolvedValue(COVERAGE_STATUS);

    renderSources();
    await waitFor(() => expect(screen.getByText('Healthy ES')).toBeInTheDocument());

    // The healthy source reads Active; the backend-flagged quiet source reads Silent;
    // the failed-poll source reads Error — all from the server fields, not a cursor guess.
    expect(screen.getByTestId('source-status-ok-1')).toHaveTextContent('Active');
    expect(screen.getByTestId('source-status-silent-1')).toHaveTextContent('Silent');
    expect(screen.getByTestId('source-status-broken-1')).toHaveTextContent('Error');

    // The connector error string is surfaced (plain text, #9) in the status tooltip.
    expect(screen.getByTestId('source-status-broken-1')).toHaveAttribute(
      'title',
      expect.stringContaining('index_not_found_exception'),
    );
  });

  it('the coverage banner shouts when sources are silent', async () => {
    listSourcesMock.mockResolvedValue({ sources: SOURCES_STATUS });
    sourcesHealthMock.mockResolvedValue({ sources: HEALTH_STATUS });
    sourcesCoverageMock.mockResolvedValue(COVERAGE_STATUS);

    renderSources();
    await waitFor(() => expect(screen.getByTestId('coverage-banner')).toBeInTheDocument());
    const banner = screen.getByTestId('coverage-banner');
    // 3 of 3 enabled, 1 silent → the Silent cell reports 1 with the "need attention" sub.
    expect(within(banner).getByTestId('coverage-sources')).toHaveTextContent('3 of 3');
    expect(within(banner).getByTestId('coverage-silent')).toHaveTextContent('1');
    expect(within(banner).getByTestId('coverage-silent')).toHaveTextContent(/need attention/i);
  });

  it('derives the banner client-side when the coverage endpoint is unavailable', async () => {
    // An older/mocked client with no coverage rollup: the banner falls back to the health
    // rows + source list (enabled count, summed events/min, silent count) and shows an
    // em-dash for the server-only alerts-triaged figure.
    listSourcesMock.mockResolvedValue({ sources: SOURCES_STATUS });
    sourcesHealthMock.mockResolvedValue({ sources: HEALTH_STATUS });
    sourcesCoverageMock.mockRejectedValue(new Error('not found'));

    renderSources();
    await waitFor(() => expect(screen.getByTestId('coverage-banner')).toBeInTheDocument());
    const banner = screen.getByTestId('coverage-banner');
    // Derived from health: 3 enabled, events/min 30 (only ok-1 flows), 1 silent.
    expect(within(banner).getByTestId('coverage-sources')).toHaveTextContent('3 of 3');
    expect(within(banner).getByTestId('coverage-events')).toHaveTextContent('30');
    expect(within(banner).getByTestId('coverage-silent')).toHaveTextContent('1');
    // Alerts-triaged is server-only → an em-dash, never a fabricated number.
    expect(within(banner).getByTestId('coverage-alerts')).toHaveTextContent('—');
  });

  it('shows one retryable error state instead of a misleading empty table when the initial list fails', async () => {
    listSourcesMock.mockRejectedValue(new Error('source inventory unavailable'));

    renderSources();
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('source inventory unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Log Sources' })).toBeNull();
    expect(screen.queryByTestId('sources-count')).toBeNull();
  });

  it('keeps Pull/Push filtering useful when best-effort runtime health is unavailable', async () => {
    sourcesHealthMock.mockResolvedValue({ sources: [] });
    renderSources();
    await waitFor(() => expect(screen.getByText('Prod ES')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Filter log sources' }));
    const kind = screen.getByRole('group', { name: 'Kind' });
    fireEvent.click(within(kind).getByRole('button', { name: 'Pull' }));
    expect(screen.getByText('Prod ES')).toBeInTheDocument();
    expect(screen.queryByText('Webhook Ingest')).toBeNull();

    fireEvent.click(within(kind).getByRole('button', { name: 'Push' }));
    expect(screen.getByText('Webhook Ingest')).toBeInTheDocument();
    expect(screen.queryByText('Prod ES')).toBeNull();
  });

  it('takes browse capability from the SERVER, not from connector manifests or health', async () => {
    // The connector fixture advertises capabilities:['browse'] and the health row says
    // can_browse:true — neither may resurrect the affordance once GET /api/sources says
    // the source is not browsable. One definition, server-side (R12).
    listSourcesMock.mockResolvedValue({
      sources: [{ ...SOURCES[0], can_browse: false }],
    });
    sourcesHealthMock.mockResolvedValue({ sources: [HEALTH[0]] });

    renderSources();
    await screen.findByText('Prod ES');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Prod ES' }));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Browse logs' })).toBeNull();
  });

  it('blocks add-source during demo-status hydration when the source overlay arrives first', async () => {
    // The independent status poll can lag one request behind /sources. The synthetic
    // overlay itself must close that race and prevent a real tenant write.
    demoStatusMock.mockResolvedValue({ mode: 'off', active: false, run_id: null });
    listSourcesMock.mockResolvedValue({ sources: [DEMO_SPLUNK] });
    sourcesHealthMock.mockResolvedValue({ sources: [DEMO_SPLUNK_HEALTH] });
    sourcesCoverageMock.mockResolvedValue({ ...COVERAGE, sources_total: 1, sources_enabled: 1 });

    renderSources();
    await screen.findByText('Splunk Enterprise (Demo)');
    expect(screen.getByRole('button', { name: /new log source/i })).toBeDisabled();
    expect(screen.queryByTestId('source-editor')).toBeNull();
  });

  it('keeps synthetic source overlays read-only while preserving native protocol and log browsing', async () => {
    demoStatusMock.mockResolvedValue({ mode: 'live', active: true, run_id: 'demo-ui' });
    listSourcesMock.mockResolvedValue({ sources: [DEMO_SPLUNK, SOURCES[0]] });
    sourcesHealthMock.mockResolvedValue({ sources: [DEMO_SPLUNK_HEALTH, HEALTH[0]] });
    sourcesCoverageMock.mockResolvedValue({
      ...COVERAGE,
      sources_total: 2,
      sources_enabled: 2,
    });

    renderSources();
    const sourceName = await screen.findByText('Splunk Enterprise (Demo)');

    // Demo rows explain their ownership and render the source-native wire format,
    // rather than the generic push/pull transport direction.
    expect(sourceName.tagName).toBe('SPAN');
    expect(screen.getByText('Demo')).toHaveAttribute('title', 'Managed by Demo Mode');
    expect(screen.getByText('HEC')).toBeInTheDocument();

    const enabled = screen.getByRole('switch', {
      name: 'Managed by Demo Mode: Splunk Enterprise (Demo)',
    });
    const selected = screen.getByRole('checkbox', {
      name: 'Managed by Demo Mode: demo-splunk',
    });
    expect(enabled).toBeDisabled();
    expect(selected).toBeDisabled();
    expect(screen.getByRole('button', { name: /new log source/i })).toBeDisabled();

    // Tenant mutations are absent/disabled, but read-only exploration remains useful.
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Actions for Splunk Enterprise (Demo)' }),
    );
    expect(await screen.findByRole('menuitem', { name: 'Browse logs' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Managed by Demo Mode' })).toHaveAttribute(
      'data-disabled',
    );
    expect(screen.queryByRole('menuitem', { name: 'Make primary' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();

    expect(upsertSourceMock).not.toHaveBeenCalled();
  });
});
