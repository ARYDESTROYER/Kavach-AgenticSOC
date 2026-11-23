/**
 * Wizard onboarding fixes:
 *   - F5: clicking "Continue" on the Keys step auto-saves typed provider keys (they
 *     are lifted to the wizard, so they no longer vanish when the step unmounts).
 *   - F4/F9: a demo-toggle failure shows an INLINE demo error, never the finish-only
 *     "Could not complete setup" banner.
 *   - F2: the Review step offers a default-on automation posture, and launch enables
 *     the deterministic-safe engines (tuning + campaigns) before completing setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  updateSecretsMock,
  completeSetupMock,
  putSettingsMock,
  demoStatusMock,
  demoEnableMock,
  demoDisableMock,
  authMeMock,
  rolesGetMock,
  getMock,
  putMock,
  setupStatusMock,
  listSourcesMock,
} = vi.hoisted(() => ({
  updateSecretsMock: vi.fn(),
  completeSetupMock: vi.fn(),
  putSettingsMock: vi.fn(),
  demoStatusMock: vi.fn(),
  demoEnableMock: vi.fn(),
  demoDisableMock: vi.fn(),
  authMeMock: vi.fn(),
  rolesGetMock: vi.fn(),
  getMock: vi.fn(),
  putMock: vi.fn(),
  setupStatusMock: vi.fn(),
  listSourcesMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (v: unknown) => vi.fn().mockResolvedValue(v);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      get: getMock,
      put: putMock,
      setupStatus: setupStatusMock,
      listConnectors: ok({ connectors: [] }),
      listSources: listSourcesMock,
      getSettings: ok({ prefs: {} }),
      putSettings: putSettingsMock,
      updateSecrets: updateSecretsMock,
      completeSetup: completeSetupMock,
      auth: { me: authMeMock, logout: ok({ ok: true }) },
      roles: { get: rolesGetMock },
      demo: {
        status: demoStatusMock,
        enable: demoEnableMock,
        disable: demoDisableMock,
        reset: ok({ mode: 'off', active: false }),
      },
    },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import { AuthProvider } from '../../auth';
import { DemoProvider } from '../../demo';
import Wizard from '../Wizard';

function renderWizard(onComplete = vi.fn(), onExit?: () => void) {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <DemoProvider>
          <Wizard onComplete={onComplete} onExit={onExit} />
        </DemoProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
}

describe('Wizard onboarding fixes', () => {
  beforeEach(() => {
    updateSecretsMock.mockReset().mockResolvedValue({ ok: true });
    setupStatusMock.mockReset().mockResolvedValue({ setup_complete: false, configured: {} });
    listSourcesMock.mockReset().mockResolvedValue({ sources: [] });
    completeSetupMock.mockReset().mockResolvedValue({ ok: true });
    putSettingsMock.mockReset().mockResolvedValue({ ok: true });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    demoEnableMock.mockReset().mockResolvedValue({ mode: 'seeded', active: true });
    demoDisableMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    getMock.mockReset().mockResolvedValue({ config: { enabled: false } });
    putMock.mockReset().mockResolvedValue({ ok: true });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    rolesGetMock
      .mockReset()
      .mockResolvedValue({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} });
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  }

  it('uses one shared centered loading state while setup boots', async () => {
    setupStatusMock.mockReturnValue(new Promise(() => {}));
    renderWizard();

    // Let the surrounding Auth and Demo providers settle while the setup request
    // deliberately remains pending.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const loading = screen.getByRole('status', { name: 'Loading setup' });
    expect(loading).toHaveAttribute('data-loading-layout', 'panel');
    expect(loading).toHaveClass('items-center', 'justify-center');
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByTestId('loading-bar-indicator')).toBeNull();
    expect(screen.getByText(/Preparing workspace choices and deployment readiness/i)).toBeVisible();
  });

  it('F5: Continue on the Keys step auto-saves a typed provider key', async () => {
    const user = userEvent.setup();
    renderWizard();

    // Jump to the Keys step via the stepper.
    await user.click(await screen.findByRole('button', { name: /AI runtime/i }));
    const input = await screen.findByLabelText(/Anthropic API key/i);
    await user.type(input, 'sk-ant-abc123');

    // Click the forward CTA (NOT the Save button) — it must persist the key.
    await user.click(screen.getByRole('button', { name: /^Continue/i }));

    await waitFor(() =>
      expect(updateSecretsMock).toHaveBeenCalledWith(
        expect.objectContaining({ anthropic_api_key: 'sk-ant-abc123' }),
      ),
    );
  });

  it('routes every stepper jump through provider-key persistence', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: /AI runtime/i }));
    await user.type(await screen.findByLabelText(/OpenAI API key/i), 'sk-openai-abc123');
    await user.click(screen.getByRole('button', { name: /Data sources/i }));

    await waitFor(() =>
      expect(updateSecretsMock).toHaveBeenCalledWith(
        expect.objectContaining({ openai_api_key: 'sk-openai-abc123' }),
      ),
    );
    expect(await screen.findByRole('heading', { name: /Connect the systems you already use/i })).toBeVisible();
  });

  it('serializes provider-key persistence and ignores duplicate navigation while saving', async () => {
    const secretWrite = deferred<{ configured: Record<string, boolean> }>();
    updateSecretsMock.mockReturnValueOnce(secretWrite.promise);
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: /AI runtime/i }));
    await user.type(await screen.findByLabelText(/OpenAI API key/i), 'sk-openai-once');

    const continueButton = screen.getByRole('button', { name: /^Continue/i });
    const sourcesButton = screen.getByRole('button', { name: /Data sources/i });
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);
    fireEvent.click(sourcesButton);

    await waitFor(() => expect(updateSecretsMock).toHaveBeenCalledTimes(1));
    expect(sourcesButton).toBeDisabled();
    expect(
      screen.getByRole('heading', { name: /Connect the models that investigate cases/i }),
    ).toBeVisible();

    secretWrite.resolve({ configured: { openai_api_key: true } });
    expect(
      await screen.findByRole('heading', { name: /Ready for live triage|Ready with limited/i }),
    ).toBeVisible();
    expect(updateSecretsMock).toHaveBeenCalledTimes(1);
  });

  it('serializes setup completion and blocks navigation while launch is pending', async () => {
    const completion = deferred<{ ok: boolean }>();
    completeSetupMock.mockReturnValueOnce(completion.promise);
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWizard(onComplete);

    await user.click(await screen.findByRole('button', { name: /Review & launch/i }));
    // The review stage loads on demand (Round 15, SPEC §3.1): wait for it before launch.
    await screen.findByRole('heading', { name: /Ready with limited capabilities/i });
    const launch = screen.getByRole('button', { name: /Launch Agentic SOC/i });
    const sourcesButton = screen.getByRole('button', { name: /Data sources/i });
    fireEvent.click(launch);
    fireEvent.click(launch);
    fireEvent.click(sourcesButton);

    await waitFor(() => expect(completeSetupMock).toHaveBeenCalledTimes(1));
    expect(sourcesButton).toBeDisabled();
    expect(screen.getByRole('heading', { name: /Ready with limited capabilities/i })).toBeVisible();

    completion.resolve({ ok: true });
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(completeSetupMock).toHaveBeenCalledTimes(1);
  });

  it('F4/F9: a demo-toggle failure shows an inline demo error, not the finish banner', async () => {
    demoEnableMock.mockRejectedValue(new Error('demo backend down'));
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('radio', { name: /Synthetic demo/i }));

    await screen.findByText(/Couldn’t switch workspace mode/i);
    // The finish-only banner must NOT appear for a demo-toggle failure.
    expect(screen.queryByText(/Could not complete setup/i)).toBeNull();
  });

  it('shows automation posture without mutating policy during first-run launch', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: /Review & launch/i }));
    expect(await screen.findByText(/On by default/i)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Launch Agentic SOC/i }));

    await waitFor(() => expect(completeSetupMock).toHaveBeenCalled());
    expect(getMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('does not mutate automation policy when applying a setup rerun', async () => {
    const user = userEvent.setup();
    renderWizard(vi.fn(), vi.fn());

    await user.click(await screen.findByRole('button', { name: /Review & launch/i }));
    await user.click(screen.getByRole('button', { name: /Apply changes/i }));

    await waitFor(() => expect(completeSetupMock).toHaveBeenCalledTimes(1));
    expect(getMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('labels an incomplete live setup as limited rather than fully ready', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: /Review & launch/i }));

    expect(
      await screen.findByRole('heading', { name: /Ready with limited capabilities/i }),
    ).toBeVisible();
    expect(screen.getAllByText(/Needs attention/i)).toHaveLength(2);
  });

  it('treats configured-but-disabled sources as unavailable and reports them separately', async () => {
    // Round 15: the AI runtime row is ready when the server says the default models can
    // be called (`ai_runtime_ready`), so only the sources row needs attention here.
    setupStatusMock.mockResolvedValue({
      setup_complete: false,
      configured: { openai_api_key: true },
      ai_runtime_ready: true,
    });
    listSourcesMock.mockResolvedValue({
      sources: [
        {
          id: 'disabled-es',
          source_type: 'elasticsearch',
          display_name: 'Disabled production SIEM',
          enabled: false,
          is_primary: true,
          ingest_mode: 'pull',
        },
      ],
    });
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: /Review & launch/i }));

    expect(
      await screen.findByRole('heading', { name: /Ready with limited capabilities/i }),
    ).toBeVisible();
    expect(screen.getByText(/No enabled sources · 1 configured but disabled/i)).toBeVisible();
    expect(screen.getAllByText(/Needs attention/i)).toHaveLength(1);
  });

  it('keeps the desktop progress rail independently scrollable', async () => {
    renderWizard();

    const progressNav = await screen.findByRole('navigation', { name: /Setup progress/i });
    expect(progressNav).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
  });

  it('reconciles a lost completion response and completes exactly once', async () => {
    setupStatusMock
      .mockResolvedValueOnce({ setup_complete: false, configured: {} })
      .mockResolvedValueOnce({ setup_complete: true, configured: {} });
    completeSetupMock.mockRejectedValueOnce(new Error('response lost'));
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWizard(onComplete);

    await user.click(await screen.findByRole('button', { name: /Review & launch/i }));
    await user.click(screen.getByRole('button', { name: /Launch Agentic SOC/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Couldn’t complete setup/i)).toBeNull();
  });
});
