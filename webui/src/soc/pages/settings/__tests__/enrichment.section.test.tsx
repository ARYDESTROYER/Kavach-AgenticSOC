/**
 * The Enrichment settings section reads and writes one set of settings (Round 14, wro-01,
 * and its FX7d review fixes).
 *
 * The cache lifetime field sits outside the provider editor. It first paints the page's
 * stored value, then shows the lifetime of the settings the editor read: in Demo Mode the
 * Demo sandbox's copy, the same settings its save changes. A save goes through the
 * enrichment save (never the shared settings PUT, which always writes the real settings)
 * and is reported to the editor, which reads the settings again when Demo Mode moved; a
 * refused save puts back the lifetime that was shown. The settings lock disables the field
 * and the editor's switches, and the field accepts at most the server's 30-day bound.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { providersMock, setConfigMock } = vi.hoisted(() => ({
  providersMock: vi.fn(),
  setConfigMock: vi.fn(),
}));

vi.mock('@/soc/components/EnrichmentProviders.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/EnrichmentProviders.api')>();
  return {
    ...actual,
    enrichmentApi: {
      providers: providersMock,
      lookup: vi.fn(),
      setSecrets: vi.fn(),
      setEnrichmentConfig: setConfigMock,
    },
  };
});

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

import type { Preferences } from '@/lib/types';
import { AuthProvider } from '@/soc/auth';
import { TooltipProvider } from '@/ui/tooltip';
import { CACHE_TTL_MAX_SECONDS } from '@/soc/components/EnrichmentProviders.api';
import { EnrichmentSection } from '../enrichment';

function renderSection(ttl = 21600, readOnly = false) {
  const prefs = { enrichment: { cache_ttl_seconds: ttl } } as unknown as Preferences;
  return render(
    <TooltipProvider>
      <AuthProvider>
        <EnrichmentSection prefs={prefs} update={vi.fn()} readOnly={readOnly} />
      </AuthProvider>
    </TooltipProvider>,
  );
}

const demoListing = {
  enrichment_enabled: true,
  fusion_enabled: false,
  cache_ttl_seconds: 600,
  demo_active: true,
  demo_run_id: 'run-a',
  providers: [],
};

describe('EnrichmentSection (wro-01)', () => {
  beforeEach(() => {
    providersMock.mockReset();
    setConfigMock.mockReset();
    setConfigMock.mockResolvedValue({
      ok: true, changed: true, demo_active: true, demo_run_id: 'run-a', config: {},
    });
  });

  it('shows the cache lifetime of the settings the editor read, not the page copy', async () => {
    providersMock.mockResolvedValue(demoListing);
    renderSection(21600);
    const field = await screen.findByRole('spinbutton', { name: /cache lifetime/i });
    await waitFor(() => expect(field).toHaveAttribute('aria-valuenow', '600'));
    expect(await screen.findByTestId('enrichment-demo-callout')).toBeInTheDocument();
  });

  it('keeps the page value when the listing has no lifetime', async () => {
    providersMock.mockResolvedValue({
      enrichment_enabled: true, fusion_enabled: false, providers: [],
    });
    renderSection(1800);
    await waitFor(() => expect(providersMock).toHaveBeenCalled());
    expect(screen.getByRole('spinbutton', { name: /cache lifetime/i })).toHaveAttribute('aria-valuenow', '1800');
  });

  it('saves the lifetime through the enrichment save', async () => {
    providersMock.mockResolvedValue(demoListing);
    renderSection(21600);
    const field = await screen.findByRole('spinbutton', { name: /cache lifetime/i });
    await waitFor(() => expect(field).toHaveAttribute('aria-valuenow', '600'));
    fireEvent.change(field, { target: { value: '1200' } });
    fireEvent.blur(field);
    await waitFor(() => expect(setConfigMock).toHaveBeenCalledWith({ cache_ttl_seconds: 1200 }));
    // The save stayed in the run the editor read: nothing is read again.
    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  it('caps the lifetime at the 30-day bound the server accepts', async () => {
    providersMock.mockResolvedValue(demoListing);
    renderSection(21600);
    const field = await screen.findByRole('spinbutton', { name: /cache lifetime/i });
    await waitFor(() => expect(field).toHaveAttribute('aria-valuenow', '600'));
    expect(field).toHaveAttribute('aria-valuemax', String(CACHE_TTL_MAX_SECONDS));
    expect(screen.getByText(/looked up again \(10 minutes\)\. The longest is 30 days\./)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '99999999' } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(setConfigMock).toHaveBeenCalledWith({ cache_ttl_seconds: CACHE_TTL_MAX_SECONDS }),
    );
  });

  it('puts back the shown lifetime and reads again when Demo Mode moved during the save', async () => {
    providersMock.mockResolvedValue(demoListing);
    renderSection(21600);
    const field = await screen.findByRole('spinbutton', { name: /cache lifetime/i });
    await waitFor(() => expect(field).toHaveAttribute('aria-valuenow', '600'));

    setConfigMock.mockRejectedValue(
      Object.assign(new Error('Demo Mode was turned on or off while saving, so nothing was saved. Try again.'), {
        status: 409,
        body: { detail: { code: 'demo_mode_changed', message: 'Demo Mode was turned on or off.' } },
      }),
    );
    // Demo Mode ended meanwhile: the read after the refusal is the real settings.
    providersMock.mockResolvedValue({
      ...demoListing, cache_ttl_seconds: 21600, demo_active: false, demo_run_id: null,
    });
    fireEvent.change(field, { target: { value: '1200' } });
    fireEvent.blur(field);
    await waitFor(() => expect(providersMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(field).toHaveAttribute('aria-valuenow', '21600'));
    await waitFor(() => expect(screen.queryByTestId('enrichment-demo-callout')).toBeNull());
  });

  it('puts back the shown lifetime when the save is refused for another reason', async () => {
    providersMock.mockResolvedValue(demoListing);
    renderSection(21600);
    const field = await screen.findByRole('spinbutton', { name: /cache lifetime/i });
    await waitFor(() => expect(field).toHaveAttribute('aria-valuenow', '600'));
    setConfigMock.mockRejectedValue(
      Object.assign(new Error('Settings are in read-only mode'), { status: 403, body: {} }),
    );
    fireEvent.change(field, { target: { value: '1200' } });
    fireEvent.blur(field);
    await waitFor(() => expect(setConfigMock).toHaveBeenCalled());
    await waitFor(() => expect(field).toHaveAttribute('aria-valuenow', '600'));
    expect(providersMock).toHaveBeenCalledTimes(1);
  });

  it('disables the field and the switches while the settings lock is on', async () => {
    providersMock.mockResolvedValue({ ...demoListing, demo_active: false, demo_run_id: null });
    renderSection(21600, true);
    const field = await screen.findByRole('spinbutton', { name: /cache lifetime/i });
    expect(field).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Enrichment enabled' })).toBeDisabled(),
    );
    expect(screen.getByRole('switch', { name: 'Fuse provider scores' })).toBeDisabled();
    // Both groups say why: the Caching group and the editor's Lookups group.
    expect(screen.getAllByText('Read-only while the settings lock is on.')).toHaveLength(2);
    expect(screen.queryByText('Saved as soon as you leave the field.')).toBeNull();
  });
});
