/**
 * Round 15 (SPEC D2.1 to D2.3): the setup wizard says what really happens without a
 * usable AI provider.
 *
 *  - Readiness is the server's `ai_runtime_ready` (both default investigation models can
 *    be called), never "an OpenAI or Anthropic key is set": an Anthropic key for OpenAI
 *    models is not ready.
 *  - The AI runtime step has three live states: ready ("Live provider configured"), a key
 *    that the default models cannot use ("Your key does not match the default models",
 *    naming the provider when known), and no key ("No usable AI provider yet").
 *  - The default provider comes from the authenticated settings read; when that fails
 *    the provider sentence is left out.
 *  - Saving a key patches `ai_runtime_ready` and `ai_runtime_provider` from the write
 *    answer, so a briefly stale status read cannot undo it.
 *  - The review row and heading follow the same readiness, and the ready row names every
 *    configured provider family.
 *  - No live-mode string says "mock runtime"; Demo copy is unchanged; no new string says
 *    "Needs attention".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { setupStatusMock, listSourcesMock, getSettingsMock, updateSecretsMock, demoStatusMock, authMeMock } =
  vi.hoisted(() => ({
    setupStatusMock: vi.fn(),
    listSourcesMock: vi.fn(),
    getSettingsMock: vi.fn(),
    updateSecretsMock: vi.fn(),
    demoStatusMock: vi.fn(),
    authMeMock: vi.fn(),
  }));

vi.mock('@/lib/api', () => {
  const ok = (v: unknown) => vi.fn().mockResolvedValue(v);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      get: ok({}),
      put: ok({ ok: true }),
      setupStatus: setupStatusMock,
      listConnectors: ok({ connectors: [] }),
      listSources: listSourcesMock,
      getSettings: getSettingsMock,
      putSettings: ok({ ok: true }),
      updateSecrets: updateSecretsMock,
      completeSetup: ok({ ok: true }),
      auth: { me: authMeMock, logout: ok({ ok: true }) },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      demo: {
        status: demoStatusMock,
        enable: ok({ mode: 'seeded', active: true }),
        disable: ok({ mode: 'off', active: false }),
        reset: ok({ mode: 'off', active: false }),
      },
    },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import { AuthProvider } from '../../auth';
import { DemoProvider } from '../../demo';
import Wizard from '../Wizard';

const SOURCE = {
  id: 'es-1',
  source_type: 'elasticsearch',
  display_name: 'Production SIEM',
  enabled: true,
  is_primary: true,
  ingest_mode: 'pull',
};

function settingsWith(provider: string, routerProvider: string = provider) {
  return {
    prefs: {
      investigator_model: { provider, model: 'm' },
      router_model: { provider: routerProvider, model: 'r' },
    },
    configured: {},
  };
}

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

async function openStep(name: RegExp) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name }));
  return user;
}

function alertText(): string {
  return screen
    .getAllByRole('alert')
    .map((el) => el.textContent ?? '')
    .join(' ');
}

describe('Wizard AI runtime wording (Round 15)', () => {
  beforeEach(() => {
    setupStatusMock.mockReset().mockResolvedValue({ setup_complete: false, configured: {}, ai_runtime_ready: false });
    listSourcesMock.mockReset().mockResolvedValue({ sources: [] });
    getSettingsMock.mockReset().mockResolvedValue(settingsWith('openai'));
    updateSecretsMock.mockReset().mockResolvedValue({ ok: true, configured: {} });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
  });

  it('describes the AI runtime step without the mock runtime', async () => {
    renderWizard();
    const descriptions = await screen.findAllByText('Add a provider key so the AI agent can investigate cases.');
    expect(descriptions.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/mock runtime/i);
  });

  it('says plainly what happens with no key', async () => {
    renderWizard();
    await openStep(/AI runtime/i);
    expect(await screen.findByText('No usable AI provider yet')).toBeVisible();
    expect(
      screen.getByText(
        'You can continue without a key. Until you add one, the AI agent investigates nothing: new cases wait for a person as Needs human review.',
      ),
    ).toBeVisible();
    expect(alertText()).not.toMatch(/mock runtime|Needs attention|recommended/i);
  });

  it('names the default provider when a key does not match the default models', async () => {
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { anthropic_api_key: true },
      ai_runtime_ready: false,
    });
    renderWizard();
    await openStep(/AI runtime/i);
    expect(await screen.findByText('Your key does not match the default models')).toBeVisible();
    expect(
      await screen.findByText(
        'The default investigation models use OpenAI. Add a key for OpenAI, or choose other models in Settings → Models after launch.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('Live provider configured')).toBeNull();
    expect(alertText()).not.toMatch(/mock runtime|Needs attention/i);
  });

  it.each([
    ['anthropic', 'Anthropic'],
    ['openai_compatible', 'OpenAI-compatible endpoint'],
    ['azure', 'Azure OpenAI'],
    ['bedrock', 'Amazon Bedrock'],
    ['vertex', 'Google Vertex AI'],
  ])('labels the %s provider family', async (token, label) => {
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { openai_api_key: true },
      ai_runtime_ready: false,
    });
    getSettingsMock.mockResolvedValue(settingsWith(token));
    renderWizard();
    await openStep(/AI runtime/i);
    expect(
      await screen.findByText(
        `The default investigation models use ${label}. Add a key for ${label}, or choose other models in Settings → Models after launch.`,
      ),
    ).toBeVisible();
  });

  it('leaves out the provider sentence when the settings cannot be read', async () => {
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { anthropic_api_key: true },
      ai_runtime_ready: false,
    });
    getSettingsMock.mockRejectedValue(new Error('forbidden'));
    renderWizard();
    await openStep(/AI runtime/i);
    expect(
      await screen.findByText('Add a key for the default models, or choose other models in Settings → Models after launch.'),
    ).toBeVisible();
    expect(screen.queryByText(/The default investigation models use/)).toBeNull();
  });

  it('leaves out the provider sentence when the router and the investigator use different providers', async () => {
    // An Anthropic investigator with its key and an OpenAI router without one: naming
    // Anthropic would ask for a key that is already set.
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { anthropic_api_key: true },
      ai_runtime_ready: false,
    });
    getSettingsMock.mockResolvedValue(settingsWith('anthropic', 'openai'));
    renderWizard();
    await openStep(/AI runtime/i);
    expect(
      await screen.findByText('Add a key for the default models, or choose other models in Settings → Models after launch.'),
    ).toBeVisible();
    expect(screen.queryByText(/The default investigation models use/)).toBeNull();
  });

  it('shows the ready state only when the server says the default models can be called', async () => {
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { openai_api_key: true },
      ai_runtime_ready: true,
    });
    renderWizard();
    await openStep(/AI runtime/i);
    expect(await screen.findByText('Live provider configured')).toBeVisible();
    expect(
      screen.getByText('New credentials replace only the provider you update; existing secret values are never shown.'),
    ).toBeVisible();
  });

  it('patches readiness from the key save even when the status re-read is stale', async () => {
    updateSecretsMock.mockResolvedValue({
      ok: true,
      configured: { openai_api_key: true },
      ai_runtime_ready: true,
      ai_runtime_provider: 'openai',
    });
    renderWizard();
    const user = await openStep(/AI runtime/i);
    await user.type(await screen.findByLabelText(/OpenAI API key/i), 'sk-openai-abc');
    await user.click(screen.getByRole('button', { name: /^Continue/i }));
    await waitFor(() => expect(updateSecretsMock).toHaveBeenCalledTimes(1));
    // The status re-read still says not ready; the write answer wins.
    expect(await screen.findByText('Configured: OpenAI')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /AI runtime/i }));
    expect(await screen.findByText('Live provider configured')).toBeVisible();
  });

  it('names the provider the key save reports', async () => {
    updateSecretsMock.mockResolvedValue({
      ok: true,
      configured: { openai_api_key: true },
      ai_runtime_ready: false,
      ai_runtime_provider: 'anthropic',
    });
    getSettingsMock.mockRejectedValue(new Error('offline'));
    renderWizard();
    const user = await openStep(/AI runtime/i);
    await user.type(await screen.findByLabelText(/OpenAI API key/i), 'sk-openai-abc');
    await user.click(screen.getByRole('button', { name: /Data sources/i }));
    await waitFor(() => expect(updateSecretsMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /AI runtime/i }));
    expect(
      await screen.findByText(
        'The default investigation models use Anthropic. Add a key for Anthropic, or choose other models in Settings → Models after launch.',
      ),
    ).toBeVisible();
  });

  it('reviews a live setup without a usable provider as limited, without the mock runtime', async () => {
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { anthropic_api_key: true },
      ai_runtime_ready: false,
    });
    listSourcesMock.mockResolvedValue({ sources: [SOURCE] });
    renderWizard();
    await openStep(/Review & launch/i);
    expect(await screen.findByRole('heading', { name: 'Ready with limited capabilities' })).toBeVisible();
    expect(screen.getByText('No usable provider · cases wait for a person')).toBeVisible();
    expect(screen.queryByText(/mock runtime/i)).toBeNull();
    // The one warning row (the AI runtime); no new string says "Needs attention".
    expect(screen.getAllByText('Needs attention')).toHaveLength(1);
  });

  it('is ready for live triage only with a source and a usable provider', async () => {
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { azure_openai_api_key: true, aws_access_key_id: true, vertex_api_key: true },
      ai_runtime_ready: true,
    });
    listSourcesMock.mockResolvedValue({ sources: [SOURCE] });
    renderWizard();
    await openStep(/Review & launch/i);
    expect(await screen.findByRole('heading', { name: 'Ready for live triage' })).toBeVisible();
    // Every configured family, not only OpenAI and Anthropic.
    expect(screen.getByText('Configured: Azure OpenAI, Amazon Bedrock, Google Vertex AI')).toBeVisible();
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  it('names a keyless self-hosted endpoint from the default provider', async () => {
    setupStatusMock.mockResolvedValue({ setup_complete: false, configured: {}, ai_runtime_ready: true });
    getSettingsMock.mockResolvedValue(settingsWith('openai_compatible'));
    renderWizard();
    await openStep(/Review & launch/i);
    expect(await screen.findByText('Configured: OpenAI-compatible endpoint')).toBeVisible();
  });

  it('keeps a key that only an older reading counted from looking ready', async () => {
    // The old rule called any OpenAI or Anthropic key "ready"; the server's answer decides.
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { anthropic_api_key: true, openai_api_key: true },
      ai_runtime_ready: false,
    });
    listSourcesMock.mockResolvedValue({ sources: [SOURCE] });
    renderWizard();
    await openStep(/Review & launch/i);
    expect(await screen.findByRole('heading', { name: 'Ready with limited capabilities' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Ready for live triage' })).toBeNull();
  });
});

describe('Wizard AI runtime wording in Demo Mode (unchanged)', () => {
  beforeEach(() => {
    setupStatusMock.mockReset().mockResolvedValue({ setup_complete: false, configured: {}, ai_runtime_ready: false });
    listSourcesMock.mockReset().mockResolvedValue({ sources: [] });
    getSettingsMock.mockReset().mockResolvedValue(settingsWith('openai'));
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'seeded', active: true });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
  });

  it('reads the sources and the readiness again after switching to live', async () => {
    // During Demo the Demo sources are listed and the mock runtime counts as usable; the
    // live workspace has neither, so the review must not keep the Demo answer.
    setupStatusMock.mockResolvedValue({ setup_complete: false, configured: {}, ai_runtime_ready: true });
    listSourcesMock.mockResolvedValue({ sources: [SOURCE] });
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(screen.getByRole('radio', { name: /Synthetic demo/i })).toBeChecked());
    await user.click(screen.getByRole('radio', { name: /Live environment/i }));

    setupStatusMock.mockResolvedValue({ setup_complete: false, configured: {}, ai_runtime_ready: false });
    listSourcesMock.mockResolvedValue({ sources: [] });
    demoStatusMock.mockResolvedValue({ mode: 'off', active: false });
    const statusReads = setupStatusMock.mock.calls.length;
    await user.click(await screen.findByRole('button', { name: /Disable demo and switch/i }));
    await waitFor(() => expect(setupStatusMock.mock.calls.length).toBeGreaterThan(statusReads));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Live environment/i })).toBeChecked());

    await user.click(screen.getByRole('button', { name: /Review & launch/i }));
    expect(await screen.findByRole('heading', { name: 'Ready with limited capabilities' })).toBeVisible();
    expect(screen.getByText('No source configured · live telemetry will not be ingested')).toBeVisible();
    expect(screen.getByText('No usable provider · cases wait for a person')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Ready for live triage' })).toBeNull();
  });

  it('keeps the true Demo copy about the mock runtime', async () => {
    renderWizard();
    await openStep(/AI runtime/i);
    expect(await screen.findByText('Mock runtime available')).toBeVisible();
    expect(
      screen.getByText(
        'Demo investigations run against the deterministic mock runtime at no inference cost. A live key is optional.',
      ),
    ).toBeVisible();
  });
});
