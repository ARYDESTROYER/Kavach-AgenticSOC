/**
 * Round 15 (SPEC §3.1): the setup wizard's AI runtime and review stages are a lazy chunk.
 *
 *  - They never ride first paint: Wizard.tsx (an entry module) reaches their module (and
 *    SecretField and Field, which only the AI runtime stage used at first paint) only
 *    through `import()`, no first-paint module imports any of them, and the D2.3 copy
 *    lives in the chunk.
 *  - Once the browser is idle after the wizard mounts, the chunk is prefetched, never
 *    imported (soc/lazy-retry.ts); offline or without `requestIdleCallback` nothing is
 *    warmed, and the warm is cancelled when the wizard unmounts.
 *  - While the chunk loads, the stage shows one loading state, the rail already marks the
 *    new stage, and focus stays on the control that moved on; once the stage mounts, its
 *    heading takes focus, as it does when the chunk is already loaded. One lazy component
 *    serves both stages, so the second stage reached shows no loader at all.
 *  - A chunk that cannot load shows a focused "could not load" heading with Reload in both
 *    stages, the wizard's own navigation keeps working, and launch still completes setup.
 *
 * Each case imports a fresh Wizard (`vi.resetModules`), so the lazy stages start unloaded.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { gate, stageImports, updateSecretsMock, completeSetupMock, demoStatusMock, authMeMock } = vi.hoisted(() => ({
  // The stages' module waits for `gate.ready` (a test holds it to watch the load).
  gate: { ready: Promise.resolve() as Promise<void>, fail: false },
  stageImports: { count: 0 },
  updateSecretsMock: vi.fn(),
  completeSetupMock: vi.fn(),
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
      completeSetup: completeSetupMock,
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

async function renderFreshWizard({ prefetchSpy }: { prefetchSpy?: (list: string, base: string) => void } = {}) {
  vi.resetModules();
  // Registered per render: a mocked module is cached until it is mocked again.
  vi.doMock('../wizard/RuntimeReviewSteps', async (importOriginal) => {
    stageImports.count += 1;
    await gate.ready;
    if (gate.fail) throw new Error('Failed to fetch dynamically imported module: /assets/RuntimeReviewSteps-x.js');
    return importOriginal();
  });
  if (prefetchSpy) {
    vi.doMock('@/soc/lazy-retry', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/soc/lazy-retry')>()),
      prefetchChunks: prefetchSpy,
    }));
  }
  const { default: FreshWizard } = await import('../Wizard');
  const { TooltipProvider } = await import('@/ui/tooltip');
  const { AuthProvider } = await import('../../auth');
  const { DemoProvider } = await import('../../demo');
  const onComplete = vi.fn();
  const view = render(
    <TooltipProvider>
      <AuthProvider>
        <DemoProvider>
          <FreshWizard onComplete={onComplete} />
        </DemoProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'How do you want to start?' });
  return { ...view, onComplete };
}

/** Records whether the stage loader is ever on the page while `run` runs. */
async function loaderShownDuring(run: () => Promise<void>): Promise<boolean> {
  let shown = Boolean(document.querySelector('[aria-label="Loading this step"]'));
  const observer = new MutationObserver(() => {
    if (document.querySelector('[aria-label="Loading this step"]')) shown = true;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    await run();
  } finally {
    observer.disconnect();
  }
  return shown;
}

const WEBUI_SRC = path.resolve(__dirname, '../../..');

/**
 * The static import graph of the first-paint entry (src/main.tsx), read from source as
 * bundle-first-paint.test.ts reads it: value imports and re-exports only (`import type`
 * is erased, `import()` is a lazy chunk). File -> the file that first imported it.
 */
function firstPaintGraph(): Map<string, string> {
  const IMPORT_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const files = new Map<string, string>();
  const resolveSpec = (from: string, spec: string): string | null => {
    const bare = spec.split('?')[0];
    let base: string;
    if (bare.startsWith('@/')) base = path.join(WEBUI_SRC, bare.slice(2));
    else if (bare.startsWith('.')) base = path.resolve(path.dirname(from), bare);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const start = path.join(WEBUI_SRC, 'main.tsx');
  const stack = [start];
  files.set(start, '');
  while (stack.length) {
    const file = stack.pop() as string;
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const target = resolveSpec(file, match[1]);
      if (target && !files.has(target)) {
        files.set(target, path.relative(WEBUI_SRC, file));
        stack.push(target);
      }
    }
  }
  return files;
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
  completeSetupMock.mockReset().mockResolvedValue({ ok: true });
  demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
  authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../wizard/RuntimeReviewSteps');
  vi.doUnmock('@/soc/lazy-retry');
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
    // One open for both stages (one lazy component, so the second stage needs no load).
    expect(wizard.match(/import\(\s*'\.\/wizard\/RuntimeReviewSteps'\s*\)/g)).toHaveLength(1);
    expect(wizard.match(/React\.lazy\(/g)).toHaveLength(2); // the source editor and the stages
  });

  it('keeps the stages, SecretField and Field off the whole first-paint graph', () => {
    // The saving is the stages and the two field components only they used at first paint;
    // a value import of any of them from any first-paint module would bring the bytes back.
    const files = firstPaintGraph();
    expect(files.has(path.join(PAGES, 'Wizard.tsx')), 'the walk follows the entry to the wizard').toBe(true);
    expect(files.has(path.join(PAGES, 'wizard', 'StepHeading.tsx'))).toBe(true);
    const lazyOnly = [
      path.join(PAGES, 'wizard', 'RuntimeReviewSteps.tsx'),
      path.join(WEBUI_SRC, 'soc', 'components', 'SecretField.tsx'),
      path.join(WEBUI_SRC, 'soc', 'components', 'Field.tsx'),
    ];
    for (const file of lazyOnly) expect(existsSync(file), file).toBe(true);
    const reached = lazyOnly
      .filter((file) => files.has(file))
      .map((file) => `${path.relative(WEBUI_SRC, file)} (imported by ${files.get(file)})`);
    expect(reached, 'lazy-only modules on the first-paint graph').toEqual([]);
  });
});

describe('Wizard prefetches the later stages when idle', () => {
  function installIdle() {
    const callbacks: Array<() => void> = [];
    const requestIdleCallback = vi.fn((cb: () => void) => {
      callbacks.push(cb);
      return 7;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);
    return { callbacks, requestIdleCallback, cancelIdleCallback };
  }

  it('schedules one idle prefetch on mount, never imports the stages, and cancels it on unmount', async () => {
    const { callbacks, requestIdleCallback, cancelIdleCallback } = installIdle();

    const view = await renderFreshWizard();
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000 });

    // The warm only fills the HTTP cache (a built page writes the chunk list in); it
    // never loads the stages' module.
    act(() => callbacks.forEach((cb) => cb()));
    expect(stageImports.count).toBe(0);
    expect(document.head.querySelector('link[rel="prefetch"]')).toBeNull();

    view.unmount();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it('prefetches the stages chunk list from the idle callback, relative to the module URL', async () => {
    const { callbacks } = installIdle();
    const prefetchSpy = vi.fn();
    await renderFreshWizard({ prefetchSpy });

    expect(prefetchSpy).not.toHaveBeenCalled(); // only once the browser is idle
    act(() => callbacks.forEach((cb) => cb()));
    expect(prefetchSpy).toHaveBeenCalledTimes(1);
    expect(prefetchSpy).toHaveBeenCalledWith(
      '__CHUNK_LIST:src/soc/pages/wizard/RuntimeReviewSteps.tsx__',
      expect.stringMatching(/Wizard\.tsx/),
    );
    expect(stageImports.count).toBe(0);
  });

  it('skips the prefetch offline, and the stage still loads when it is reached', async () => {
    const { callbacks } = installIdle();
    const prefetchSpy = vi.fn();
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const user = userEvent.setup();
      await renderFreshWizard({ prefetchSpy });

      act(() => callbacks.forEach((cb) => cb()));
      expect(prefetchSpy).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Step 3: AI runtime' }));
      const heading = await screen.findByRole('heading', { level: 1, name: 'Connect the models that investigate cases' });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(stageImports.count).toBe(1);
    } finally {
      onLine.mockRestore();
    }
  });

  it('schedules nothing in a browser without requestIdleCallback, and the stage still loads', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const prefetchSpy = vi.fn();
    const user = userEvent.setup();
    await renderFreshWizard({ prefetchSpy });

    await user.click(screen.getByRole('button', { name: 'Step 4: Review & launch' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Ready with limited capabilities' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(prefetchSpy).not.toHaveBeenCalled();
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

  it('loads the chunk once for both stages: the second stage reached shows no loader', async () => {
    const user = userEvent.setup();
    await renderFreshWizard();

    await user.click(screen.getByRole('button', { name: 'Step 3: AI runtime' }));
    const keys = await screen.findByRole('heading', { level: 1, name: 'Connect the models that investigate cases' });
    await waitFor(() => expect(keys).toHaveFocus());

    // The review stage has never been shown, yet it renders at once: one lazy component
    // serves both stages, so there is nothing left to load (not even for one frame).
    const reviewLoader = await loaderShownDuring(async () => {
      await pressContinue(user, /Skip for now/);
    });
    expect(reviewLoader).toBe(false);
    expect(screen.getByRole('heading', { level: 1, name: 'Ready with limited capabilities' })).toHaveFocus();
    expect(stageImports.count).toBe(1);

    // Back to the AI runtime stage: it renders at once, with its heading focused.
    const backLoader = await loaderShownDuring(async () => {
      await user.click(screen.getByRole('button', { name: /Back/ }));
    });
    expect(backLoader).toBe(false);
    expect(screen.getByRole('heading', { level: 1, name: 'Connect the models that investigate cases' })).toHaveFocus();
    expect(stageImports.count).toBe(1);
  });

  it('renders the AI runtime stage at once after the review stage was reached first', async () => {
    const user = userEvent.setup();
    await renderFreshWizard();

    await user.click(screen.getByRole('button', { name: 'Step 4: Review & launch' }));
    const review = await screen.findByRole('heading', { level: 1, name: 'Ready with limited capabilities' });
    await waitFor(() => expect(review).toHaveFocus());

    const shown = await loaderShownDuring(async () => {
      await user.click(screen.getByRole('button', { name: /Back/ }));
    });
    expect(shown).toBe(false);
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
    // Never "try again" alone: a failed module stays failed until the page reloads.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Connect the systems you already use' })).toHaveFocus();
  });

  it('shows the same notice on the review stage, and launch still completes setup', async () => {
    gate.fail = true;
    const user = userEvent.setup();
    const { onComplete } = await renderFreshWizard();

    await user.click(screen.getByRole('button', { name: 'Step 3: AI runtime' }));
    await screen.findByRole('heading', { level: 1, name: 'This step could not load' });
    // Nothing was typed, so moving on saves nothing and the review stage shows the notice.
    await pressContinue(user, /Skip for now/);
    const heading = await screen.findByRole('heading', { level: 1, name: 'This step could not load' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Step 4: Review & launch' })).toHaveAttribute('aria-current', 'step');
    expect(updateSecretsMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Launch Agentic SOC/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(completeSetupMock).toHaveBeenCalledTimes(1);
  });
});
