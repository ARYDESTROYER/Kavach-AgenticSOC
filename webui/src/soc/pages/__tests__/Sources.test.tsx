/**
 * Sources page (WS-C rebuild, migrated to the Round 14 console grammar, SPEC §4.9.4).
 *
 * Fully mocked / offline. Verifies the DataTable surface on its panel:
 *   - a row per source from the listSources mock, and the source count beside the title,
 *   - the filter bar's search and filters narrow the list client-side ("N of M shown"),
 *   - the inline per-row Enabled toggle round-trips through api.upsertSource,
 *   - "Add source" opens the SourceEditor dialog,
 *   - the Columns menu is present.
 *
 * The heavy manifest-driven <SourceEditor> and the <SourceLogsSheet> are stubbed so
 * the test exercises the PAGE (toolbar/table/toggle/actions), not those children.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  listConnectorsMock,
  listSourcesMock,
  sourcesHealthMock,
  sourcesCoverageMock,
  upsertSourceMock,
  demoStatusMock,
  deleteSourceMock,
} = vi.hoisted(() => ({
  listConnectorsMock: vi.fn(),
  listSourcesMock: vi.fn(),
  sourcesHealthMock: vi.fn(),
  sourcesCoverageMock: vi.fn(),
  upsertSourceMock: vi.fn(),
  demoStatusMock: vi.fn(),
  deleteSourceMock: vi.fn(),
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
      deleteSource: deleteSourceMock,
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
// The logs sheet keeps the real Sheet shell (so the page's focus return can be checked)
// around a stub body.
vi.mock('@/soc/components/SourceLogsSheet', async () => {
  const sheet = await vi.importActual<typeof import('@/ui/sheet')>('@/ui/sheet');
  return {
    SourceLogsSheet: ({
      source,
      onClose,
      onCloseAutoFocus,
    }: {
      source: unknown;
      onClose: () => void;
      onCloseAutoFocus?: (event: Event) => void;
    }) => (
      <sheet.Sheet open={!!source} onOpenChange={(o) => !o && onClose()}>
        <sheet.SheetContent aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
          <sheet.SheetTitle>Source logs</sheet.SheetTitle>
          <div data-testid="logs-sheet" />
        </sheet.SheetContent>
      </sheet.Sheet>
    ),
  };
});

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

/** The panel's "N of M shown" count (only while a filter is on). */
const shownCount = () => screen.getByTestId('sources-panel').querySelector('[data-panel-count]');

/** Open a filter-bar select by its accessible name and pick an option. */
async function pickFilter(name: string, option: string) {
  const trigger = screen.getByRole('combobox', { name });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByRole('option', { name: option }));
}

describe('Sources page (WS-C)', () => {
  beforeEach(() => {
    listConnectorsMock.mockReset().mockResolvedValue({ connectors: CONNECTORS });
    listSourcesMock.mockReset().mockResolvedValue({ sources: SOURCES });
    sourcesHealthMock.mockReset().mockResolvedValue({ sources: HEALTH });
    sourcesCoverageMock.mockReset().mockResolvedValue(COVERAGE);
    upsertSourceMock.mockReset().mockResolvedValue({ ok: true, sources: SOURCES });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false, run_id: null });
    deleteSourceMock.mockReset().mockResolvedValue({ ok: true, sources: [] });
    window.localStorage.clear();
  });

  it('renders a table row per source with a live count', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByText('Prod ES')).toBeInTheDocument());
    expect(screen.getByText('Webhook Ingest')).toBeInTheDocument();
    // The count sits beside the title (C8); the panel repeats no total while unfiltered.
    expect(screen.getByTestId('sources-total')).toHaveTextContent('2 sources');
    expect(shownCount()).toBeNull();
  });

  it('filters the list client-side via the toolbar search', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByText('Webhook Ingest')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search sources' }), {
      target: { value: 'Prod' },
    });

    expect(screen.getByText('Prod ES')).toBeInTheDocument();
    expect(screen.queryByText('Webhook Ingest')).not.toBeInTheDocument();
    expect(shownCount()).toHaveTextContent('1 of 2 shown');

    // "Clear all" in the filter bar clears the search too.
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('searchbox', { name: 'Search sources' })).toHaveValue('');
    expect(screen.getByText('Webhook Ingest')).toBeInTheDocument();
    expect(shownCount()).toBeNull();
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

  it('"Add source" opens the SourceEditor dialog', async () => {
    renderSources();
    await waitFor(() => expect(screen.getByText('Prod ES')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));

    expect(await screen.findByText('Add a source')).toBeInTheDocument();
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
    expect(within(banner).getByTestId('kpi-coverage-sources')).toHaveTextContent('1 of 2');
    expect(within(banner).getByTestId('kpi-coverage-events')).toHaveTextContent('42');
    expect(within(banner).getByTestId('kpi-coverage-alerts')).toHaveTextContent('7');
    expect(within(banner).getByTestId('kpi-coverage-silent')).toHaveTextContent('0');
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
    expect(within(banner).getByTestId('kpi-coverage-sources')).toHaveTextContent('3 of 3');
    expect(within(banner).getByTestId('kpi-coverage-silent')).toHaveTextContent('1');
    expect(within(banner).getByTestId('kpi-coverage-silent')).toHaveTextContent(/need attention/i);
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
    expect(within(banner).getByTestId('kpi-coverage-sources')).toHaveTextContent('3 of 3');
    expect(within(banner).getByTestId('kpi-coverage-events')).toHaveTextContent('30');
    expect(within(banner).getByTestId('kpi-coverage-silent')).toHaveTextContent('1');
    // Alerts-triaged is server-only → an em-dash, never a fabricated number.
    expect(within(banner).getByTestId('kpi-coverage-alerts')).toHaveTextContent('—');
  });

  it('shows one retryable error state instead of a misleading empty table when the initial list fails', async () => {
    listSourcesMock.mockRejectedValue(new Error('source inventory unavailable'));

    renderSources();
    expect(await screen.findByText('Could not load sources')).toBeInTheDocument();
    expect(screen.getByText('source inventory unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Sources' })).toBeNull();
    expect(screen.queryByTestId('sources-total')).toBeNull();
    expect(screen.queryByTestId('sources-panel')).toBeNull();
  });

  it('keeps Pull/Push filtering useful when best-effort runtime health is unavailable', async () => {
    sourcesHealthMock.mockResolvedValue({ sources: [] });
    renderSources();
    await waitFor(() => expect(screen.getByText('Prod ES')).toBeInTheDocument());

    await pickFilter('Kind', 'Pull');
    expect(screen.getByText('Prod ES')).toBeInTheDocument();
    expect(screen.queryByText('Webhook Ingest')).toBeNull();
    // The active filter is a removable chip.
    expect(screen.getByRole('button', { name: 'Remove filter: Kind: Pull' })).toBeInTheDocument();

    await pickFilter('Kind', 'Push');
    expect(screen.getByText('Webhook Ingest')).toBeInTheDocument();
    expect(screen.queryByText('Prod ES')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Kind: Push' }));
    expect(screen.getByText('Prod ES')).toBeInTheDocument();
    expect(screen.getByText('Webhook Ingest')).toBeInTheDocument();
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
    // Said in words, never a disabled button whose reason only a hover could reach.
    expect(screen.queryByRole('button', { name: 'Add source' })).toBeNull();
    expect(screen.getByTestId('sources-demo-fixed')).toHaveTextContent('Sources are fixed in Demo mode');
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
    // rather than the generic push/pull transport direction. The list mixes a Demo source
    // with a real one, so the Demo row is marked too, beside the panel's own Demo note.
    expect(sourceName.tagName).toBe('SPAN');
    const demoMarks = screen.getAllByText('Demo');
    expect(demoMarks).toHaveLength(2);
    expect(demoMarks.some((mark) => mark.getAttribute('title') === 'Managed by Demo Mode')).toBe(true);
    expect(screen.getByText('HEC')).toBeInTheDocument();

    const enabled = screen.getByRole('switch', {
      name: 'Managed by Demo Mode: Splunk Enterprise (Demo)',
    });
    const selected = screen.getByRole('checkbox', {
      name: 'Managed by Demo Mode: demo-splunk',
    });
    expect(enabled).toBeDisabled();
    expect(selected).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Add source' })).toBeNull();
    expect(screen.getByTestId('sources-demo-fixed')).toBeInTheDocument();

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

/** Every visible text node, minus the lone DASH placeholder of an empty value. */
function visibleCopy(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (text && text !== '—') out.push(text);
  }
  return out;
}

describe('Sources on the Round 14 console grammar (SPEC §4.9.4, C7 and C8)', () => {
  beforeEach(() => {
    listConnectorsMock.mockReset().mockResolvedValue({ connectors: CONNECTORS });
    listSourcesMock.mockReset().mockResolvedValue({ sources: SOURCES_STATUS });
    sourcesHealthMock.mockReset().mockResolvedValue({ sources: HEALTH_STATUS });
    sourcesCoverageMock.mockReset().mockResolvedValue(COVERAGE_STATUS);
    upsertSourceMock.mockReset().mockResolvedValue({ ok: true, sources: SOURCES_STATUS });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false, run_id: null });
    deleteSourceMock.mockReset().mockResolvedValue({ ok: true, sources: [] });
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('titles the page "Sources" with the explanation in a help tip, the count and Refresh beside it', async () => {
    const user = userEvent.setup();
    const { container } = renderSources();
    await screen.findByText('Healthy ES');
    const header = container.querySelector('[data-page-header="page"]') as HTMLElement;
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Sources$/);
    // No description line, overline or breadcrumb: the explanation is in the help tip.
    expect(within(header).queryByText(/Connect and manage/)).toBeNull();
    await user.click(within(header).getByRole('button', { name: 'About Sources' }));
    expect(await screen.findByText('Connect and manage the systems the agent reads security events from.')).toBeInTheDocument();
    const controls = header.querySelector('[data-page-header-controls]') as HTMLElement;
    expect(within(controls).getByTestId('sources-total')).toHaveTextContent('3 sources');
    expect(within(controls).getByRole('button', { name: 'Refresh sources' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Add source' })).toBeInTheDocument();
  });

  it('puts the coverage on one KPI strip and the table on the "Connected sources" panel', async () => {
    renderSources();
    await screen.findByText('Healthy ES');
    const strip = screen.getByRole('group', { name: 'Ingest coverage' });
    // Compact, as on every other configuration page strip (C7).
    expect(strip).toHaveAttribute('data-kpi-strip', 'compact');
    expect(within(strip).getByTestId('kpi-coverage-silent')).toHaveTextContent('Silent sources');
    const panel = screen.getByRole('region', { name: 'Connected sources' });
    expect(panel).toHaveClass('surface-panel');
    expect(within(panel).getByRole('table', { name: 'Sources' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /customize columns/i })).toBeInTheDocument();
  });

  it('gives Name the spare width, shrinks every other column to its content, and drops the pager for one page', async () => {
    renderSources();
    await screen.findByText('Healthy ES');
    const table = screen.getByRole('table', { name: 'Sources' });
    const headers = within(table).getAllByRole('columnheader');
    const name = headers.find((th) => th.textContent?.includes('Name')) as HTMLElement;
    expect(name).toHaveClass('w-full');
    for (const label of ['Type', 'Status', 'Enabled', 'Last event', 'Protocol']) {
      const th = headers.find((h) => h.textContent?.includes(label)) as HTMLElement;
      expect(th, label).toHaveClass('w-px', 'whitespace-nowrap');
    }
    // Three sources fit one page: no pager, no page-size control.
    expect(screen.queryByRole('combobox', { name: /rows per page/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /next page/i })).toBeNull();
  });

  it('keeps healthy statuses quiet and colours only the exceptions', async () => {
    renderSources();
    await screen.findByText('Healthy ES');
    expect(screen.getByTestId('source-status-ok-1')).toHaveAttribute('data-status-tone', 'neutral');
    expect(screen.getByTestId('source-status-silent-1')).toHaveAttribute('data-status-tone', 'warning');
    expect(screen.getByTestId('source-status-broken-1')).toHaveAttribute('data-status-tone', 'critical');
  });

  it('notes Demo once beside the module title when every source is a Demo source', async () => {
    demoStatusMock.mockResolvedValue({ mode: 'live', active: true, run_id: 'demo-ui' });
    listSourcesMock.mockResolvedValue({ sources: [DEMO_SPLUNK] });
    sourcesHealthMock.mockResolvedValue({ sources: [DEMO_SPLUNK_HEALTH] });
    sourcesCoverageMock.mockResolvedValue({ ...COVERAGE, sources_total: 1, sources_enabled: 1 });
    renderSources();
    await screen.findByText('Splunk Enterprise (Demo)');
    const panel = screen.getByRole('region', { name: 'Connected sources' });
    const notes = within(panel).getAllByText('Demo');
    expect(notes).toHaveLength(1);
    expect(notes[0].closest('[data-panel-caption]')).not.toBeNull();
  });

  it('shows no em dash and never the word "playbook" in its copy', async () => {
    const { container } = renderSources();
    await screen.findByText('Healthy ES');
    const copy = visibleCopy(container);
    expect(copy.filter((text) => text.includes('—'))).toEqual([]);
    expect(copy.filter((text) => /playbook/i.test(text))).toEqual([]);
  });

  it('spells product names as their owners do (QRadar), in the type column, the subline and the type filter', async () => {
    listSourcesMock.mockResolvedValue({
      sources: [
        ...SOURCES_STATUS,
        { id: 'qr-1', source_type: 'qradar', display_name: '', enabled: true, is_primary: false, ingest_mode: 'pull', config: {}, configured_secrets: [] },
      ],
    });
    renderSources();
    await screen.findByText('Healthy ES');
    const table = screen.getByRole('table', { name: 'Sources' });
    expect(within(table).getAllByText('QRadar').length).toBeGreaterThan(0);
    expect(table.textContent ?? '').not.toContain('Qradar');
    expect(table.textContent ?? '').toContain('QRadar · Pull');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Type' }), { key: 'Enter' });
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'QRadar' })).toBeInTheDocument();
  });

  it('names the "any" filter options plainly', async () => {
    renderSources();
    await screen.findByText('Healthy ES');
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Enabled' }), { key: 'Enter' });
    expect(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Any state' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Kind' }), { key: 'Enter' });
    expect(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Any kind' })).toBeInTheDocument();
    expect(screen.queryByText('Enabled or not')).toBeNull();
    expect(screen.queryByText('Pull or push')).toBeNull();
  });

  it('keeps the row menu Remove neutral at rest, red only on focus (the RowActions rule)', async () => {
    const user = userEvent.setup();
    renderSources();
    await screen.findByText('Healthy ES');
    await user.click(screen.getByRole('button', { name: 'Actions for Quiet ES' }));
    const remove = await screen.findByRole('menuitem', { name: 'Remove' });
    const resting = remove.className.split(/\s+/).filter((cls) => !cls.includes(':'));
    expect(resting.filter((cls) => cls.includes('critical'))).toEqual([]);
    expect(remove.className).toContain('focus:text-critical-text');
    expect(remove.className).toContain('focus:bg-critical/10');
  });

  it('returns focus to the row Actions button when Browse logs closes (SPEC §3.3)', async () => {
    listSourcesMock.mockResolvedValue({ sources: SOURCES });
    sourcesHealthMock.mockResolvedValue({ sources: HEALTH });
    const user = userEvent.setup();
    renderSources();
    await screen.findByText('Prod ES');
    const trigger = screen.getByRole('button', { name: 'Actions for Prod ES' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Browse logs' }));
    const sheet = await screen.findByRole('dialog', { name: 'Source logs' });
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('returns focus to the row Actions button when the editor or the remove confirmation closes', async () => {
    const user = userEvent.setup();
    renderSources();
    await screen.findByText('Healthy ES');
    const trigger = screen.getByRole('button', { name: 'Actions for Broken ES' });

    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit Broken ES' });
    await user.click(within(editor).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("moves focus to the next row's Actions after a removal, never to the page body", async () => {
    const user = userEvent.setup();
    renderSources();
    await screen.findByText('Healthy ES');
    const triggers = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-source-row-actions]'));
    const trigger = screen.getByRole('button', { name: 'Actions for Quiet ES' });
    const before = triggers();
    const index = before.indexOf(trigger);
    const expected = before[index + 1] ?? before[index - 1];

    // The delete answers only after the confirmation has closed and handed focus back.
    let finishDelete!: () => void;
    deleteSourceMock.mockImplementationOnce(
      () => new Promise((resolve) => (finishDelete = () => resolve({ ok: true, sources: [] }))),
    );
    listSourcesMock.mockResolvedValue({ sources: SOURCES_STATUS.filter((s) => s.id !== 'silent-1') });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove source' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await act(async () => finishDelete());
    await waitFor(() => expect(screen.queryByText('Quiet ES')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(expected));
    expect(deleteSourceMock).toHaveBeenCalledWith('silent-1');
  });

  it('moves focus to the panel heading when a bulk removal hides the bulk bar', async () => {
    const user = userEvent.setup();
    renderSources();
    await screen.findByText('Healthy ES');
    await user.click(screen.getByRole('checkbox', { name: 'Select row silent-1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select row broken-1' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    listSourcesMock.mockResolvedValue({ sources: [SOURCES_STATUS[0]] });
    await user.click(within(bar).getByRole('button', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove sources' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull());
    const heading = screen.getByRole('heading', { name: 'Connected sources' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(deleteSourceMock).toHaveBeenCalledTimes(2);
  });

  it('moves focus to the panel heading when Clear selection hides the bulk bar', async () => {
    const user = userEvent.setup();
    renderSources();
    await screen.findByText('Healthy ES');
    await user.click(screen.getByRole('checkbox', { name: 'Select row silent-1' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    await user.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Connected sources' })),
    );
  });

  it('moves focus to the first-run panel when the last source is removed', async () => {
    listSourcesMock.mockResolvedValue({ sources: [SOURCES_STATUS[0]] });
    const user = userEvent.setup();
    renderSources();
    await screen.findByText('Healthy ES');

    listSourcesMock.mockResolvedValue({ sources: [] });
    await user.click(screen.getByRole('button', { name: 'Actions for Healthy ES' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove source' }));
    const firstRun = (await screen.findByText('Connect your first source')).closest<HTMLElement>('[data-panel]');
    await waitFor(() => expect(document.activeElement).toBe(firstRun));
  });

  it('returns focus to Add source when the editor closes', async () => {
    const user = userEvent.setup();
    renderSources();
    await screen.findByText('Healthy ES');
    const add = screen.getByRole('button', { name: 'Add source' });
    await user.click(add);
    const editor = await screen.findByRole('dialog', { name: 'Add a source' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(editor).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it('collapses the filters into one "Filters" sheet at phone width', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 767.98px)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    renderSources();
    await screen.findByText('Healthy ES');
    const bar = screen.getByRole('group', { name: 'Source filters' });
    expect(within(bar).getByRole('button', { name: /^Filters/ })).toBeInTheDocument();
    expect(within(bar).queryByRole('combobox', { name: 'Kind' })).toBeNull();
    vi.unstubAllGlobals();
  });
});
