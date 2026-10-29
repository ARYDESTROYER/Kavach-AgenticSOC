/**
 * EnrichmentProvidersEditor tests (Group 6 / Feature 7).
 *
 * Mocks the co-located EnrichmentProviders.api module + the lib/api auth surface
 * (the editor uses useCan → useAuth). Asserts:
 *   - providers render with their manifest text + indicator kinds (plain),
 *   - a configured secret is shown as a BOOLEAN badge only, never the value (#10),
 *   - toggling a provider writes prefs.enrichment.use_* via setEnrichmentConfig,
 *   - saving a secret posts to setSecrets and flips the boolean,
 *   - the "Configured" state never exposes the secret value anywhere in the DOM.
 *
 * Auth is OFF in the mock → useCan returns true (no-auth = transparent), so the
 * manage controls render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { providersMock, lookupMock, setSecretsMock, setConfigMock } = vi.hoisted(() => ({
  providersMock: vi.fn(),
  lookupMock: vi.fn(),
  setSecretsMock: vi.fn(),
  setConfigMock: vi.fn(),
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
import { EnrichmentProvidersEditor } from '../EnrichmentProvidersEditor';

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
    setup_steps: ['Nothing required — URLhaus is keyless.'],
    example: 'Turns a suspicious URL into a confirmed malware-delivery case.',
  },
];

function renderEditor() {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <EnrichmentProvidersEditor />
      </AuthProvider>
    </TooltipProvider>,
  );
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

  it('shows a configured secret as a boolean badge only — never the value (#10)', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');

    // Round 14 (SE6): the keys live in the provider's detail sheet, opened from its row.
    fireEvent.click(screen.getByRole('button', { name: 'AbuseIPDB' }));

    // The configured state shows as the shared SecretField boolean pill ("Configured ✓").
    expect(await screen.findByText(/configured ✓/i)).toBeInTheDocument();
    // The secret <input> is a password field, empty (placeholder only) — no value leaks.
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
