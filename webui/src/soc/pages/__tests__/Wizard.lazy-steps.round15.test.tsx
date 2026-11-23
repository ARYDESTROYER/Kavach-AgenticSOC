/**
 * Round 15 (SPEC §3.1): the setup wizard's AI runtime and review stages are a lazy chunk.
 *
 *  - They never ride first paint: Wizard.tsx (an entry module) reaches their module (and
 *    SecretField, which only the AI runtime stage uses) only through `import()`, and the
 *    D2.3 copy lives in the chunk.
 *  - Once the browser is idle after the wizard mounts, the chunk is prefetched, never
 *    imported (soc/lazy-retry.ts), and the warm is cancelled when the wizard unmounts.
 *  - While the chunk loads, the stage shows one loading state, the rail already marks the
 *    new stage, and focus stays on the control that moved on; once the stage mounts, its
 *    heading takes focus, as it does when the chunk is already loaded (no loader then).
 *  - A chunk that cannot load shows a focused "could not load" heading with Reload, and
 *    the wizard's own navigation keeps working.
 *
 * Each case imports a fresh Wizard (`vi.resetModules`), so the lazy stages start unloaded.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { gate, stageImports, updateSecretsMock, demoStatusMock, authMeMock } = vi.hoisted(() => ({
  // The stages' module waits for `gate.ready` (a test holds it to watch the load).
  gate: { ready: Promise.resolve() as Promise<void>, fail: false },
  stageImports: { count: 0 },
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
      setupStatus: ok({ setup_complete: false, configured: {}, ai_runtime_ready: false }),
      listConnectors: ok({ connectors: [] }),
      listSources: ok({ sources: [] }),
      getSettings: ok({ prefs: {} }),
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

const PAGES = path.resolve(__dirname, '..');

/** Hold the stages' load until the returned function is called. */
function holdStages(): () => void {
  let open!: () => void;
  gate.ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => open();
}

async function renderFreshWizard() {
  vi.resetModules();
  // Registered per render: a mocked module is cached until it is mocked again.
  vi.doMock('../wizard/RuntimeReviewSteps', async (importOriginal) => {
    stageImports.count += 1;
    await gate.ready;
    if (gate.fail) throw new Error('Failed to fetch dynamically imported module: /assets/RuntimeReviewSteps-x.js');
    return importOriginal();
  });
  const { default: FreshWizard } = await import('../Wizard');
  const { TooltipProvider } = await import('@/ui/tooltip');
  const { AuthProvider } = await import('../../auth');
  const { DemoProvider } = await import('../../demo');
  const view = render(
    <TooltipProvider>
      <AuthProvider>
        <DemoProvider>
          <FreshWizard onComplete={vi.fn()} />
        </DemoProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'How do you want to start?' });
  return view;
}

/** The footer's forward control, activated from the keyboard. */
async function pressContinue(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const forward = screen.getByRole('button', { name });
  forward.focus();
  await user.keyboard('{Enter}');
  return forward;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

beforeEach(() => {
  gate.ready = Promise.resolve();
  gate.fail = false;
  stageImports.count = 0;
  updateSecretsMock.mockReset().mockResolvedValue({ ok: true, configured: {} });
  demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
  authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../wizard/RuntimeReviewSteps');
});

describe('Wizard AI runtime and review stages stay off first paint (source guard)', () => {
  it('reaches the stages only through import() and keeps their copy in the chunk', () => {
    const wizard = stripComments(readFileSync(path.join(PAGES, 'Wizard.tsx'), 'utf8'));
    const statics = [...wizard.matchAll(/^[ \t]*import\s+(?!type\b)[^'";]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(statics.filter((spec) => /RuntimeReviewSteps|SecretField|ui\/alert/.test(spec))).toEqual([]);
    expect(wizard).toContain("import('./wizard/RuntimeReviewSteps')");
    // The idle warm names the same module, and that module exists.
    expect(wizard).toContain("'__CHUNK_LIST:src/soc/pages/wizard/RuntimeReviewSteps.tsx__'");
    expect(existsSync(path.join(PAGES, 'wizard', 'RuntimeReviewSteps.tsx'))).toBe(true);
    for (const copy of [
      'No usable AI provider yet',
      'Your key does not match the default models',
      'Ready for live triage',
      'No usable provider · cases wait for a person',
      'OpenAI-compatible endpoint',
    ]) {
      expect(wizard, copy).not.toContain(copy);
    }
  });
});

describe('Wizard prefetches the later stages when idle', () => {
  it('schedules one idle prefetch on mount, never imports the stages, and cancels it on unmount', async () => {
    const callbacks: Array<() => void> = [];
    const requestIdleCallback = vi.fn((cb: () => void) => {
      callbacks.push(cb);
      return 7;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const view = await renderFreshWizard();
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000 });

    // The warm only fills the HTTP cache (a built page writes the chunk list in); it
    // never loads the stages' module.
    act(() => callbacks.forEach((cb) => cb()));
    expect(stageImports.count).toBe(0);

    view.unmount();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });
});

describe('Wizard lazy stages keep the step flow', () => {
  it('shows one loader for the AI runtime stage, keeps focus, then focuses its heading', async () => {
    const open = holdStages();
    const user = userEvent.setup();
    await renderFreshWizard();

    await pressContinue(user, /^Continue/);
    expect(await screen.findByRole('heading', { level: 1, name: 'Connect the systems you already use' })).toHaveFocus();
    const forward = await pressContinue(user, /Skip for now/);

    // The stage is current at once; its body waits for the chunk.
    expect(screen.getByRole('button', { name: 'Step 3: AI runtime' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('status', { name: 'Loading this step' })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.activeElement).toBe(forward);
    await waitFor(() => expect(stageImports.count).toBe(1));

    await act(async () => open());
    const heading = await screen.findByRole('heading', { level: 1, name: 'Connect the models that investigate cases' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByRole('status', { name: 'Loading this step' })).toBeNull();
    expect(screen.getByLabelText(/OpenAI API key/i)).toBeVisible();
  });

  it('shows one loader for the review stage, then focuses its heading', async () => {
    const open = holdStages();
    const user = userEvent.setup();
    await renderFreshWizard();

    const rail = screen.getByRole('button', { name: 'Step 4: Review & launch' });
    await user.click(rail);
    expect(rail).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('status', { name: 'Loading this step' })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.activeElement).toBe(rail);
    // Launch is the review stage's footer action and is offered while the stage loads.
    expect(screen.getByRole('button', { name: /Launch Agentic SOC/i })).toBeEnabled();

    await act(async () => open());
    const heading = await screen.findByRole('heading', { level: 1, name: 'Ready with limited capabilities' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('No usable provider · cases wait for a person')).toBeVisible();
  });

  it('loads the chunk once for both stages and shows no loader once it has loaded', async () => {
    const user = userEvent.setup();
    await renderFreshWizard();

    await user.click(screen.getByRole('button', { name: 'Step 3: AI runtime' }));
    const keys = await screen.findByRole('heading', { level: 1, name: 'Connect the models that investigate cases' });
    await waitFor(() => expect(keys).toHaveFocus());

    await pressContinue(user, /Skip for now/);
    const review = await screen.findByRole('heading', { level: 1, name: 'Ready with limited capabilities' });
    await waitFor(() => expect(review).toHaveFocus());
    expect(stageImports.count).toBe(1);

    // Back to the AI runtime stage: it renders at once, with its heading focused.
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.queryByRole('status', { name: 'Loading this step' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Connect the models that investigate cases' })).toHaveFocus();
    expect(stageImports.count).toBe(1);
  });

  it('keeps typed keys across the lazy stage and saves them on the way to review', async () => {
    const user = userEvent.setup();
    await renderFreshWizard();

    await user.click(screen.getByRole('button', { name: 'Step 3: AI runtime' }));
    await user.type(await screen.findByLabelText(/Anthropic API key/i), '  sk-ant-typed  ');
    await pressContinue(user, /^Continue/);
    await waitFor(() => expect(updateSecretsMock).toHaveBeenCalledWith({ anthropic_api_key: 'sk-ant-typed' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Ready with limited capabilities' })).toBeVisible();
  });
});

describe('Wizard lazy stage chunk that cannot load', () => {
  it('shows a focused reload notice and keeps the wizard navigation working', async () => {
    gate.fail = true;
    const user = userEvent.setup();
    await renderFreshWizard();

    await user.click(screen.getByRole('button', { name: 'Step 3: AI runtime' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'This step could not load' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText('Reload the page to try again.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Connect the systems you already use' })).toHaveFocus();
  });
});
