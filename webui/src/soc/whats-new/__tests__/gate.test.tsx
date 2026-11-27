/**
 * The entry gate (Round 16 SPEC D7, §3.1): it loads the lazy What's new chunk only when
 * the marker differs from the newest update, the preferences were actually read and the
 * personal switch is on; a failed chunk load renders nothing (no error reaches the
 * shell). The gate sits in the shell branch of App only, never beside sign-in, the
 * password change or the wizard, and the registry route shares its import thunk.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prefsState } = vi.hoisted(() => ({
  prefsState: { loaded: true, misc: {} as Record<string, unknown> | undefined },
}));

vi.mock('../../prefs', () => ({
  usePrefs: () => ({ prefs: { misc: prefsState.misc }, loaded: prefsState.loaded }),
}));
vi.mock('../../pages/WhatsNew', () => ({
  default: () => <div data-testid="whats-new-page" />,
  WhatsNewHost: () => <div data-testid="whats-new-host" />,
}));

/** Long enough for a dynamic import of the (mocked) chunk to land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

beforeEach(() => {
  prefsState.loaded = true;
  prefsState.misc = {};
});

async function freshGate() {
  // Each test gets its own module graph, so the lazy component starts unresolved.
  vi.resetModules();
  return import('../WhatsNewGate');
}

describe('WhatsNewGate', () => {
  it('loads nothing when the marker is the newest update', async () => {
    const { WhatsNewGate, WHATS_NEW_LATEST } = await freshGate();
    prefsState.misc = { whats_new_seen: WHATS_NEW_LATEST };
    render(<WhatsNewGate />);
    await settle();
    expect(screen.queryByTestId('whats-new-host')).toBeNull();
  });

  it('loads the host when the marker is older or absent, and renders the host, not the page', async () => {
    const { WhatsNewGate } = await freshGate();
    prefsState.misc = { whats_new_seen: '0.1.1.2026-07-31' };
    render(<WhatsNewGate />);
    expect(await screen.findByTestId('whats-new-host')).toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-page')).toBeNull();
  });

  it('loads the host for an account with no marker and no misc at all', async () => {
    const { WhatsNewGate } = await freshGate();
    prefsState.misc = undefined;
    render(<WhatsNewGate />);
    expect(await screen.findByTestId('whats-new-host')).toBeInTheDocument();
  });

  it('waits while the preferences were not read (a failed read is not "never seen")', async () => {
    const { WhatsNewGate } = await freshGate();
    prefsState.loaded = false;
    const { rerender } = render(<WhatsNewGate />);
    await settle();
    expect(screen.queryByTestId('whats-new-host')).toBeNull();
    prefsState.loaded = true;
    rerender(<WhatsNewGate />);
    expect(await screen.findByTestId('whats-new-host')).toBeInTheDocument();
  });

  it('loads nothing while the personal switch is off', async () => {
    const { WhatsNewGate } = await freshGate();
    prefsState.misc = { whats_new_auto: false };
    render(<WhatsNewGate />);
    await settle();
    expect(screen.queryByTestId('whats-new-host')).toBeNull();
  });

  it('renders nothing, and throws nothing, when the chunk cannot load', async () => {
    vi.doMock('../../pages/WhatsNew', () => {
      throw new Error('chunk unavailable');
    });
    try {
      const { WhatsNewGate } = await freshGate();
      const { container } = render(<WhatsNewGate />);
      await settle();
      await settle();
      expect(container).toBeEmptyDOMElement();
    } finally {
      vi.doUnmock('../../pages/WhatsNew');
    }
  });
});

describe('where the gate is mounted and what it shares', () => {
  const source = (file: string) => readFileSync(path.resolve(process.cwd(), 'src/soc', file), 'utf8');

  it('sits beside the re-authentication dialog in the shell branch of Boot only', () => {
    const app = source('App.tsx');
    const gate = app.indexOf('<WhatsNewGate');
    expect(gate).toBeGreaterThan(-1);
    expect(app.indexOf('<WhatsNewGate', gate + 1)).toBe(-1);
    // After every early return of Boot: the login, setup error and wizard branches.
    for (const branch of ['return <Login', 'return <CenterSpinner', '<Wizard']) {
      const at = app.lastIndexOf(branch);
      expect(at, branch).toBeGreaterThan(-1);
      expect(gate, branch).toBeGreaterThan(at);
    }
    expect(gate).toBeGreaterThan(app.indexOf('<ReauthDialog'));
  });

  it('stamps the marker when the first-run wizard completes, not on a re-run', () => {
    expect(source('App.tsx')).toMatch(/if \(!forceWizard\) void patchMisc\(\{ whats_new_seen: WHATS_NEW_LATEST \}\)/);
  });

  it('shares one import thunk with the registry route', () => {
    expect(source('registry.tsx')).toMatch(/const WhatsNewPage = React\.lazy\(loadWhatsNew\);/);
    expect(source('whats-new/WhatsNewGate.tsx')).toMatch(/export const loadWhatsNew = \(\) => import\('\.\.\/pages\/WhatsNew'\);/);
    expect(source('pages/WhatsNew.tsx')).toMatch(/export \{ WhatsNewHost \};/);
  });
});
