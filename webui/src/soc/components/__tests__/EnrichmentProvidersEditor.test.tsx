/**
 * EnrichmentProvidersEditor tests (Group 6 / Feature 7).
 *
 * Mocks the co-located EnrichmentProviders.api module + the lib/api auth surface
 * (the editor uses useCan → useAuth). Asserts:
 *   - providers render with their manifest text + indicator kinds (plain),
 *   - a configured secret is shown as a BOOLEAN badge only, never the value (#10),
 *   - toggling a provider writes prefs.enrichment.use_* via setEnrichmentConfig,
 *   - saving a secret posts to setSecrets and flips the boolean,
 *   - the "Configured" state never exposes the secret value anywhere in the DOM,
 *   - in the full-width Enrichment section the off notice takes the switches' form row
 *     width (one right edge) while the provider list keeps the panel's width (FX6s),
 *   - in Demo Mode (wro-01) the switches show the listing's settings (the sandbox's copy)
 *     with a "Demo Mode is on" note in place of the off note, the settings are read again
 *     when Demo Mode is turned on or off or a save lands in the other stack, the host gets
 *     the cache lifetime of the same settings, and an empty lookup says why,
 *   - FX7d review fixes: the Demo note says provider keys are saved for real and the
 *     provider sheet repeats it above the keys; a reset (same Demo flag, new run) reads
 *     again; only the newest read is shown; the settings lock disables every control; a
 *     host field's save reports through the handle.
 *
 * Auth is OFF in the mock → useCan returns true (no-auth = transparent), so the
 * manage controls render.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { providersMock, lookupMock, setSecretsMock, setConfigMock, demoState } = vi.hoisted(() => ({
  providersMock: vi.fn(),
  lookupMock: vi.fn(),
  setSecretsMock: vi.fn(),
  setConfigMock: vi.fn(),
  // The Demo status the console's provider would report (a confirmed answer).
  demoState: {
    value: { active: false, confirmed: true } as {
      active: boolean;
      confirmed?: boolean;
      runId?: string | null;
    },
  },
}));

vi.mock('@/soc/demo', () => ({
  useDemo: () => ({
    status: {
      mode: demoState.value.active ? 'seeded' : 'off',
      active: demoState.value.active,
      run_id: demoState.value.runId ?? null,
    },
    active: demoState.value.active,
    loading: false,
    confirmed: demoState.value.confirmed,
    refresh: vi.fn(),
  }),
}));

// Mock the co-located data module (keep the real INDICATOR_KINDS catalog).
vi.mock('../EnrichmentProviders.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../EnrichmentProviders.api')>();
  return {
    ...actual,
    enrichmentApi: {
      providers: providersMock,
      lookup: lookupMock,
      setSecrets: setSecretsMock,
      setEnrichmentConfig: setConfigMock,
    },
  };
});

// Mock the auth surface so useAuth resolves (auth OFF → useCan transparent).
vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
    },
  };
});

import { AuthProvider } from '../../auth';
import { TooltipProvider } from '@/ui/tooltip';
import { SettingsSection } from '@/soc/pages/settings/primitives';
import { SETTINGS_ROW_CONTENT_MAX_WIDTH } from '../SettingsGrid';
import { EnrichmentProvidersEditor, lookupEmptyCopy } from '../EnrichmentProvidersEditor';

const PROVIDERS = [
  {
    name: 'abuseipdb',
    display_name: 'AbuseIPDB',
    description: 'Crowd-sourced IP abuse reputation.',
    indicator_kinds: ['ip'],
    config_key: 'use_abuseipdb',
    enabled_by_config: true,
    keyless: false,
    key_present: true,
    secret_fields: [
      {
        key: 'abuseipdb_api_key',
        label: 'AbuseIPDB API key',
        required: true,
        help: 'From your AbuseIPDB account.',
        help_link: null,
        configured: true,
      },
    ],
    free_tier: '1,000 checks/day free.',
    docs_url: 'https://www.abuseipdb.com/api',
    default_enabled: true,
    version: '1',
    setup_steps: [
      'Create a free account at abuseipdb.com.',
      'Set TLSOC_ABUSEIPDB_API_KEY in .env.',
    ],
    example: 'Separates known scanners from first-seen sources instantly.',
  },
  {
    name: 'urlhaus',
    display_name: 'URLhaus',
    description: 'Abuse.ch malware URL feed.',
    indicator_kinds: ['url', 'domain'],
    config_key: 'use_urlhaus',
    enabled_by_config: false,
    keyless: true,
    key_present: true,
    secret_fields: [],
    free_tier: 'Keyless / free.',
    docs_url: null,
    default_enabled: true,
    version: '1',
    setup_steps: ['Nothing required: URLhaus is keyless.'],
    example: 'Turns a suspicious URL into a confirmed malware-delivery case.',
  },
];

function editorTree(props: React.ComponentProps<typeof EnrichmentProvidersEditor> = {}) {
  return (
    <TooltipProvider>
      <AuthProvider>
        <EnrichmentProvidersEditor {...props} />
      </AuthProvider>
    </TooltipProvider>
  );
}

function renderEditor(props: React.ComponentProps<typeof EnrichmentProvidersEditor> = {}) {
  return render(editorTree(props));
}

/** The editor as the Enrichment section embeds it, in a section of the given measure. */
function renderInSection(width: 'form' | 'full') {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <SettingsSection title="Enrichment" width={width}>
          <EnrichmentProvidersEditor embedded />
        </SettingsSection>
      </AuthProvider>
    </TooltipProvider>,
  );
}

/** The capped content box a row's content sits in, if any. */
function contentBox(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('[data-setting-row-content]');
}

describe('EnrichmentProvidersEditor (Feature 7)', () => {
  beforeEach(() => {
    providersMock.mockReset();
    setSecretsMock.mockReset();
    setConfigMock.mockReset();
    providersMock.mockResolvedValue({
      enrichment_enabled: true,
      fusion_enabled: false,
      providers: PROVIDERS,
    });
    setConfigMock.mockResolvedValue({ ok: true });
    setSecretsMock.mockResolvedValue({
      ok: true,
      provider: 'abuseipdb',
      configured: { abuseipdb_api_key: true },
      key_present: true,
    });
  });

  it('renders providers with manifest text + indicator kinds (plain)', async () => {
    renderEditor();
    await waitFor(() => expect(providersMock).toHaveBeenCalled());

    expect(await screen.findByText('AbuseIPDB')).toBeInTheDocument();
    expect(screen.getByText('Crowd-sourced IP abuse reputation.')).toBeInTheDocument();
    expect(screen.getByText('URLhaus')).toBeInTheDocument();
    // The keyless provider is badged Free.
    expect(screen.getAllByText('Free').length).toBeGreaterThanOrEqual(1);
  });

  it('shows a configured secret as a boolean badge only: never the value (#10)', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');

    // Round 14 (SE6): the keys live in the provider's detail sheet, opened from its row.
    fireEvent.click(screen.getByRole('button', { name: 'AbuseIPDB' }));

    // The configured state shows as the shared SecretField boolean pill ("Configured ✓").
    expect(await screen.findByText(/configured ✓/i)).toBeInTheDocument();
    // The secret <input> is a password field, empty (placeholder only): no value leaks.
    const input = screen.getByPlaceholderText(/enter a new value to replace/i) as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'password');
    expect(input.value).toBe('');
    // The literal manifest key is never rendered as a value anywhere.
    expect(screen.queryByText(/^secret-value/i)).not.toBeInTheDocument();
  });

  it('toggles a provider through setEnrichmentConfig with its config_key', async () => {
    renderEditor();
    await screen.findByText('URLhaus');

    // URLhaus is disabled; its switch enables it → use_urlhaus: true.
    const sw = screen.getByRole('switch', { name: /enable urlhaus/i });
    fireEvent.click(sw);
    await waitFor(() =>
      expect(setConfigMock).toHaveBeenCalledWith({ use_urlhaus: true }),
    );
  });

  it('saves a secret via setSecrets and keeps it write-only', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');

    fireEvent.click(screen.getByRole('button', { name: 'AbuseIPDB' }));
    const input = await screen.findByPlaceholderText(/enter a new value to replace/i);
    fireEvent.change(input, { target: { value: 'sk-test-123' } });

    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(setSecretsMock).toHaveBeenCalledWith('abuseipdb', {
        abuseipdb_api_key: 'sk-test-123',
      }),
    );
    // After save the input is cleared (the value never persists in the DOM).
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  });

  it('flips the master enrichment-enabled flag', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');

    const master = screen.getByRole('switch', { name: /^enrichment enabled$/i });
    fireEvent.click(master);
    await waitFor(() => expect(setConfigMock).toHaveBeenCalledWith({ enabled: false }));
  });

  it('renders the manifest example blurb in the provider sheet (plain text)', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');

    fireEvent.click(screen.getByRole('button', { name: 'AbuseIPDB' }));
    const sheet = await screen.findByTestId('enrichment-provider-sheet');
    expect(
      within(sheet).getByText('Separates known scanners from first-seen sources instantly.'),
    ).toBeInTheDocument();
  });

  it('shows setup steps in the provider sheet as an ordered list of plain text', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');

    // The steps are not on the list; they open with the provider.
    expect(screen.queryByText('Create a free account at abuseipdb.com.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'AbuseIPDB' }));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'How to set up' })).toBeInTheDocument();
    const step1 = within(sheet).getByText('Create a free account at abuseipdb.com.');
    expect(step1.tagName).toBe('LI');
    expect(step1.closest('ol')).not.toBeNull();
    expect(within(sheet).getByText('Set TLSOC_ABUSEIPDB_API_KEY in .env.')).toBeInTheDocument();
  });
});

describe('EnrichmentProvidersEditor on the Round 14 grammar (SE6, F13)', () => {
  beforeEach(() => {
    providersMock.mockReset();
    providersMock.mockResolvedValue({
      enrichment_enabled: true,
      fusion_enabled: false,
      providers: [
        ...PROVIDERS,
        {
          ...PROVIDERS[0],
          name: 'greynoise',
          display_name: 'GreyNoise',
          config_key: 'use_greynoise',
          enabled_by_config: true,
          key_present: false,
          secret_fields: [{ ...PROVIDERS[0].secret_fields[0], key: 'greynoise_api_key', configured: false }],
        },
      ],
    });
  });

  it('lists providers as hairline rows, not bordered cards, with one switch each', async () => {
    renderEditor();
    const list = await screen.findByRole('list', { name: 'Enrichment providers' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(list.querySelector('.rounded-lg.border')).toBeNull();
    expect(within(list).getAllByRole('switch')).toHaveLength(3);
  });

  it('shows "Needs key" as a status only for an enabled provider without its key', async () => {
    renderEditor();
    const row = await screen.findByTestId('enrichment-provider-greynoise');
    expect(row.querySelector('[data-status-tone="warning"]')).toHaveTextContent('Needs key');
    const healthy = screen.getByTestId('enrichment-provider-abuseipdb');
    expect(healthy.querySelector('[data-status-tone]')).toBeNull();
  });

  it('puts the master switches in setting rows and Refresh as an icon on the providers group', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');
    expect(screen.getByRole('switch', { name: 'Fuse provider scores' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh providers' })).toBeInTheDocument();
    // SettingsGroup is a labelled group (role="group", aria-labelledby its title).
    expect(screen.getByRole('group', { name: 'Try a lookup' })).toBeInTheDocument();
  });

  it('states enrichment off in words under the master switch and never dims the editable list', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: false,
      fusion_enabled: false,
      providers: PROVIDERS,
    });
    const { container } = renderEditor();
    const list = await screen.findByRole('list', { name: 'Enrichment providers' });
    expect(screen.getByTestId('enrichment-off-callout')).toHaveTextContent(
      'Enrichment is off. No provider is queried until you turn it on.',
    );
    expect(screen.getByTestId('enrichment-off-callout')).toHaveAttribute('role', 'status');
    // The rows stay at full contrast: they remain editable while the master switch is off.
    for (let node: HTMLElement | null = list; node && node !== container; node = node.parentElement) {
      expect(node.className).not.toMatch(/opacity-/);
    }
    expect(within(list).getAllByRole('switch')[0]).not.toBeDisabled();
  });

  it('caps the off notice with the switches around it in the full-width section (FX6s)', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: false,
      fusion_enabled: false,
      providers: PROVIDERS,
    });
    renderInSection('full');
    const list = await screen.findByRole('list', { name: 'Enrichment providers' });
    const cap = SETTINGS_ROW_CONTENT_MAX_WIDTH.split(' ');
    const notice = contentBox(screen.getByTestId('enrichment-off-callout'));
    expect(notice).not.toBeNull();
    expect(notice!.className.split(/\s+/)).toEqual(expect.arrayContaining(cap));
    // Its row still spans the panel: the hairline between the switches stays whole.
    expect(notice!.closest<HTMLElement>('[data-setting-row="block"]')!.className).not.toMatch(/max-w-/);
    // The two switches around it end at the same cap, so the group has one right edge.
    for (const name of ['Enrichment enabled', 'Fuse provider scores']) {
      const box = contentBox(screen.getByRole('switch', { name }));
      expect(box).not.toBeNull();
      expect(box!.className.split(/\s+/)).toEqual(expect.arrayContaining(cap));
    }
    // The provider list is a list on the panel's full width: each switch stays on its row's end.
    expect(contentBox(list)).toBeNull();
    for (const sw of within(list).getAllByRole('switch')) expect(contentBox(sw)).toBeNull();
  });

  it('renders the off notice as a plain block in a form section (FX6s)', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: false,
      fusion_enabled: false,
      providers: PROVIDERS,
    });
    renderInSection('form');
    await screen.findByRole('list', { name: 'Enrichment providers' });
    // A 44rem form section is already a form row's width: nothing is wrapped or capped.
    expect(contentBox(screen.getByTestId('enrichment-off-callout'))).toBeNull();
    expect(contentBox(screen.getByRole('switch', { name: 'Enrichment enabled' }))).toBeNull();
  });

  it('shows no off notice while enrichment is on', async () => {
    renderEditor();
    await screen.findByRole('list', { name: 'Enrichment providers' });
    expect(screen.queryByTestId('enrichment-off-callout')).toBeNull();
  });

  it('returns focus to the provider row when its sheet closes (SPEC §3.3)', async () => {
    renderEditor();
    const opener = await screen.findByRole('button', { name: 'AbuseIPDB' });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('uses no text under 12px and no em dash in its copy', async () => {
    const { container } = renderEditor();
    await screen.findByText('AbuseIPDB');
    expect(container.innerHTML).not.toMatch(/text-\[(?:[0-9]|10)px\]/);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      if (text.trim() !== '\u2014') expect(text).not.toContain('\u2014');
    }
  });
});

describe('EnrichmentProvidersEditor in Demo Mode (wro-01)', () => {
  beforeEach(() => {
    providersMock.mockReset();
    setConfigMock.mockReset();
    lookupMock.mockReset();
    demoState.value = { active: false, confirmed: true };
    setConfigMock.mockResolvedValue({ ok: true, changed: true, demo_active: false, config: {} });
  });

  it('shows the stored switches with the Demo note in place of the off note', async () => {
    demoState.value = { active: true, confirmed: true };
    providersMock.mockResolvedValue({
      enrichment_enabled: true,
      fusion_enabled: true,
      cache_ttl_seconds: 600,
      demo_active: true,
      providers: PROVIDERS,
    });
    renderEditor();
    const note = await screen.findByTestId('enrichment-demo-callout');
    expect(note).toHaveTextContent('Demo Mode is on');
    expect(note).toHaveTextContent(
      'No provider is queried in Demo Mode. Changes to these switches and the cache lifetime apply to the demo only and are discarded when Demo Mode ends or is reset. Provider keys you save are saved for real.',
    );
    expect(note).toHaveAttribute('role', 'status');
    // The switches are the listing's values, never a forced Off.
    expect(screen.getByRole('switch', { name: 'Enrichment enabled' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Fuse provider scores' })).toBeChecked();
    expect(screen.getByRole('switch', { name: /enable abuseipdb/i })).toBeChecked();
    expect(screen.queryByTestId('enrichment-off-callout')).toBeNull();
  });

  it('keeps one note when the master switch is off in Demo Mode', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: false,
      fusion_enabled: false,
      demo_active: true,
      providers: PROVIDERS,
    });
    renderEditor();
    await screen.findByTestId('enrichment-demo-callout');
    expect(screen.getByRole('switch', { name: 'Enrichment enabled' })).not.toBeChecked();
    expect(screen.queryByTestId('enrichment-off-callout')).toBeNull();
  });

  it('shows no Demo note off Demo Mode', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: false, providers: PROVIDERS,
    });
    renderEditor();
    await screen.findByRole('list', { name: 'Enrichment providers' });
    expect(screen.queryByTestId('enrichment-demo-callout')).toBeNull();
  });

  it('hands the host the cache lifetime of the same settings, each time it reads them', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, cache_ttl_seconds: 900, demo_active: true,
      providers: PROVIDERS,
    });
    const onSettingsLoaded = vi.fn();
    renderEditor({ onSettingsLoaded });
    await waitFor(() =>
      expect(onSettingsLoaded).toHaveBeenCalledWith({ cacheTtlSeconds: 900, demoActive: true }),
    );
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, cache_ttl_seconds: 21600, demo_active: false,
      providers: PROVIDERS,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));
    await waitFor(() =>
      expect(onSettingsLoaded).toHaveBeenLastCalledWith({ cacheTtlSeconds: 21600, demoActive: false }),
    );
  });

  it('reads the settings again when Demo Mode is turned on while it is open', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: false, providers: PROVIDERS,
    });
    const { rerender } = renderEditor();
    await screen.findByRole('list', { name: 'Enrichment providers' });
    expect(providersMock).toHaveBeenCalledTimes(1);

    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: true, providers: PROVIDERS,
    });
    demoState.value = { active: true, confirmed: true };
    rerender(editorTree());
    await screen.findByTestId('enrichment-demo-callout');
    expect(providersMock).toHaveBeenCalledTimes(2);
  });

  it('ignores the unconfirmed Demo stand-in before the first status read', async () => {
    demoState.value = { active: false, confirmed: false };
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: true, providers: PROVIDERS,
    });
    const { rerender } = renderEditor();
    await screen.findByTestId('enrichment-demo-callout');
    // The first confirmed answer is no change of Demo Mode: nothing is read again.
    demoState.value = { active: true, confirmed: true };
    rerender(editorTree());
    await screen.findByTestId('enrichment-demo-callout');
    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  it('reads the settings again when a save landed in the other stack', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: false, providers: PROVIDERS,
    });
    renderEditor();
    await screen.findByText('URLhaus');
    setConfigMock.mockResolvedValue({ ok: true, changed: true, demo_active: true, config: {} });
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: true, providers: PROVIDERS,
    });
    fireEvent.click(screen.getByRole('switch', { name: /enable urlhaus/i }));
    await waitFor(() => expect(setConfigMock).toHaveBeenCalledWith({ use_urlhaus: true }));
    await screen.findByTestId('enrichment-demo-callout');
    expect(providersMock).toHaveBeenCalledTimes(2);
  });

  it('does not read again after a save in the same stack', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: true, providers: PROVIDERS,
    });
    setConfigMock.mockResolvedValue({ ok: true, changed: true, demo_active: true, config: {} });
    renderEditor();
    await screen.findByText('URLhaus');
    fireEvent.click(screen.getByRole('switch', { name: 'Fuse provider scores' }));
    await waitFor(() => expect(setConfigMock).toHaveBeenCalledWith({ fusion_enabled: true }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Fuse provider scores' })).not.toBeDisabled());
    expect(providersMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('switch', { name: 'Fuse provider scores' })).toBeChecked();
  });

  it('reverts and reads again when the save is refused because Demo Mode moved', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: false, providers: PROVIDERS,
    });
    renderEditor();
    await screen.findByText('URLhaus');
    setConfigMock.mockRejectedValue(
      Object.assign(new Error('Demo Mode was turned on or off while saving, so nothing was saved. Try again.'), {
        status: 409,
        body: { detail: { code: 'demo_mode_changed', message: 'Demo Mode was turned on or off.' } },
      }),
    );
    const sw = screen.getByRole('switch', { name: /enable urlhaus/i });
    fireEvent.click(sw);
    await waitFor(() => expect(providersMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('switch', { name: /enable urlhaus/i })).not.toBeChecked());
  });

  it('does not read again after an unrelated failure', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: false, providers: PROVIDERS,
    });
    renderEditor();
    await screen.findByText('URLhaus');
    setConfigMock.mockRejectedValue(Object.assign(new Error('Server error'), { status: 500, body: {} }));
    fireEvent.click(screen.getByRole('switch', { name: /enable urlhaus/i }));
    await waitFor(() => expect(screen.getByRole('switch', { name: /enable urlhaus/i })).not.toBeDisabled());
    expect(providersMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('switch', { name: /enable urlhaus/i })).not.toBeChecked();
  });

  it('says why an empty lookup queried nothing', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, demo_active: true, providers: PROVIDERS,
    });
    lookupMock.mockResolvedValue({
      indicator: '8.8.8.8', kind: 'ip', reputation_score: 0, is_malicious: false,
      queried: 0, not_queried: 'demo_mode', providers: [],
    });
    renderEditor();
    await screen.findByText('URLhaus');
    fireEvent.change(screen.getByLabelText('Indicator to enrich'), { target: { value: '8.8.8.8' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    expect(await screen.findByText('No provider was queried')).toBeInTheDocument();
    expect(
      screen.getByText('Lookups do not run in Demo Mode, so the result is always empty.'),
    ).toBeInTheDocument();
  });

  it('words each empty lookup by its reason', () => {
    expect(lookupEmptyCopy('demo_mode').description).toMatch(/Demo Mode/);
    expect(lookupEmptyCopy('disabled')).toEqual({
      title: 'No provider was queried',
      description: 'Enrichment is off. Turn it on above to query the enabled providers.',
    });
    expect(lookupEmptyCopy(null).title).toBe('No provider returned data');
    expect(lookupEmptyCopy(undefined).title).toBe('No provider returned data');
    for (const reason of ['demo_mode', 'disabled', null] as const) {
      const copy = lookupEmptyCopy(reason);
      expect(`${copy.title} ${copy.description}`).not.toContain('\u2014');
    }
  });
});

describe('EnrichmentProvidersEditor review fixes (FX7d)', () => {
  beforeEach(() => {
    providersMock.mockReset();
    setConfigMock.mockReset();
    setSecretsMock.mockReset();
    lookupMock.mockReset();
    demoState.value = { active: false, confirmed: true };
    setConfigMock.mockResolvedValue({ ok: true, changed: true, demo_active: false, config: {} });
  });

  const listing = (over: Record<string, unknown> = {}) => ({
    enrichment_enabled: true,
    fusion_enabled: false,
    demo_active: false,
    demo_run_id: null,
    providers: PROVIDERS,
    ...over,
  });

  it('says in the provider sheet that keys are saved for real while Demo Mode is on', async () => {
    demoState.value = { active: true, confirmed: true, runId: 'run-a' };
    providersMock.mockResolvedValue(listing({ demo_active: true, demo_run_id: 'run-a' }));
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: /abuseipdb/i }));
    const sheet = await screen.findByTestId('enrichment-provider-sheet');
    expect(within(sheet).getByTestId('enrichment-demo-key-note')).toHaveTextContent(
      'Keys are saved for real, also in Demo Mode, and stay after it ends.',
    );
  });

  it('shows no Demo key note off Demo Mode', async () => {
    providersMock.mockResolvedValue(listing());
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: /abuseipdb/i }));
    const sheet = await screen.findByTestId('enrichment-provider-sheet');
    expect(within(sheet).queryByTestId('enrichment-demo-key-note')).toBeNull();
    expect(within(sheet).getByPlaceholderText(/enter a new value to replace/i)).not.toBeDisabled();
  });

  it('reads the settings again when Demo Mode is reset (same flag, new run)', async () => {
    demoState.value = { active: true, confirmed: true, runId: 'run-a' };
    providersMock.mockResolvedValue(listing({ demo_active: true, demo_run_id: 'run-a' }));
    const { rerender } = renderEditor();
    await screen.findByTestId('enrichment-demo-callout');
    expect(providersMock).toHaveBeenCalledTimes(1);

    // The reset's fresh copy follows the real settings: the provider is on again.
    providersMock.mockResolvedValue(
      listing({
        demo_active: true,
        demo_run_id: 'run-b',
        providers: PROVIDERS.map((p) => ({ ...p, enabled_by_config: true })),
      }),
    );
    demoState.value = { active: true, confirmed: true, runId: 'run-b' };
    rerender(editorTree());
    await waitFor(() => expect(providersMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('switch', { name: /enable urlhaus/i })).toBeChecked());
  });

  it('reads the settings again when a save landed in another Demo run', async () => {
    demoState.value = { active: true, confirmed: true, runId: 'run-a' };
    providersMock.mockResolvedValue(listing({ demo_active: true, demo_run_id: 'run-a' }));
    renderEditor();
    await screen.findByText('URLhaus');
    setConfigMock.mockResolvedValue({
      ok: true, changed: true, demo_active: true, demo_run_id: 'run-b', config: {},
    });
    fireEvent.click(screen.getByRole('switch', { name: /enable urlhaus/i }));
    await waitFor(() => expect(providersMock).toHaveBeenCalledTimes(2));
  });

  it('does not read again after a save in the same Demo run', async () => {
    demoState.value = { active: true, confirmed: true, runId: 'run-a' };
    providersMock.mockResolvedValue(listing({ demo_active: true, demo_run_id: 'run-a' }));
    renderEditor();
    await screen.findByText('URLhaus');
    setConfigMock.mockResolvedValue({
      ok: true, changed: true, demo_active: true, demo_run_id: 'run-a', config: {},
    });
    fireEvent.click(screen.getByRole('switch', { name: /enable urlhaus/i }));
    await waitFor(() => expect(setConfigMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('switch', { name: /enable urlhaus/i })).not.toBeDisabled());
    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  it('shows only the newest read when an older one answers last', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    providersMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        answerFirst = resolve;
      }),
    );
    const { rerender } = renderEditor();
    await waitFor(() => expect(providersMock).toHaveBeenCalledTimes(1));

    // Demo Mode turns on: the second read (the Demo copy) answers first.
    providersMock.mockResolvedValueOnce(listing({ demo_active: true, demo_run_id: 'run-a' }));
    demoState.value = { active: true, confirmed: true, runId: 'run-a' };
    rerender(editorTree());
    await screen.findByTestId('enrichment-demo-callout');
    expect(providersMock).toHaveBeenCalledTimes(2);

    // The mount read (the real settings, Demo off) lands late: it is dropped.
    await act(async () => {
      answerFirst(
        listing({ providers: PROVIDERS.map((p) => ({ ...p, enabled_by_config: true })) }),
      );
    });
    expect(screen.getByTestId('enrichment-demo-callout')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /enable urlhaus/i })).not.toBeChecked();
  });

  it('disables every switch and key field while the settings lock is on', async () => {
    providersMock.mockResolvedValue(listing());
    renderEditor({ readOnly: true });
    await screen.findByText('URLhaus');
    expect(screen.getByText('Read-only while the settings lock is on.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enrichment enabled' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Fuse provider scores' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /enable urlhaus/i })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /enable abuseipdb/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: /enable urlhaus/i }));
    expect(setConfigMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /abuseipdb/i }));
    const sheet = await screen.findByTestId('enrichment-provider-sheet');
    expect(within(sheet).getByTestId('enrichment-locked-key-note')).toHaveTextContent(
      'Keys cannot be changed while the settings lock is on.',
    );
    expect(within(sheet).getByPlaceholderText(/enter a new value to replace/i)).toBeDisabled();
    expect(within(sheet).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps the switches live with the lock off', async () => {
    providersMock.mockResolvedValue(listing());
    renderEditor();
    await screen.findByText('URLhaus');
    expect(screen.getByText('Saved as soon as you change a switch.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /enable urlhaus/i })).not.toBeDisabled();
  });

  it('reads again when a host field reports a save refused because Demo Mode moved', async () => {
    providersMock.mockResolvedValue(listing());
    const handleRef = React.createRef<import('../EnrichmentProvidersEditor').EnrichmentProvidersEditorHandle>();
    renderEditor({ handleRef });
    await screen.findByText('URLhaus');
    expect(handleRef.current).not.toBeNull();

    // Same stack: nothing to read.
    handleRef.current!.afterSave({ ok: true, changed: true, demo_active: false, demo_run_id: null, config: {} });
    expect(providersMock).toHaveBeenCalledTimes(1);

    providersMock.mockResolvedValue(listing({ demo_active: true, demo_run_id: 'run-a' }));
    await act(async () => {
      handleRef.current!.afterSave(null, {
        status: 409,
        body: { detail: { code: 'demo_mode_changed', message: 'Demo Mode was turned on or off.' } },
      });
    });
    await screen.findByTestId('enrichment-demo-callout');
    expect(providersMock).toHaveBeenCalledTimes(2);
  });
});
