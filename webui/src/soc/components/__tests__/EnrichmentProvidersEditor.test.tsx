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
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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

    // Expand the AbuseIPDB keys section.
    const keyToggle = screen.getByRole('button', { name: /^key$/i });
    fireEvent.click(keyToggle);

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

    fireEvent.click(screen.getByRole('button', { name: /^key$/i }));
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

  it('renders the manifest example blurb under the description (plain text)', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');

    expect(
      screen.getByText('Separates known scanners from first-seen sources instantly.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Turns a suspicious URL into a confirmed malware-delivery case.'),
    ).toBeInTheDocument();
  });

  it('shows setup steps in a collapsible, keyboard-reachable ordered list', async () => {
    renderEditor();
    await screen.findByText('AbuseIPDB');

    // Steps are hidden until the "How to set up" toggle is expanded.
    expect(screen.queryByText('Create a free account at abuseipdb.com.')).not.toBeInTheDocument();

    const toggles = screen.getAllByRole('button', { name: /how to set up/i });
    expect(toggles.length).toBe(2); // one per provider with steps
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggles[0]);
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');

    // The steps render as an ORDERED list of plain-text items.
    const step1 = await screen.findByText('Create a free account at abuseipdb.com.');
    expect(step1.tagName).toBe('LI');
    expect(step1.closest('ol')).not.toBeNull();
    expect(screen.getByText('Set TLSOC_ABUSEIPDB_API_KEY in .env.')).toBeInTheDocument();

    // Collapsing hides them again.
    fireEvent.click(toggles[0]);
    await waitFor(() =>
      expect(
        screen.queryByText('Create a free account at abuseipdb.com.'),
      ).not.toBeInTheDocument(),
    );
  });
});
