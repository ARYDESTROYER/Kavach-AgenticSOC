/**
 * B44 (Round 16 SPEC §4.5 WP15E): a browser Back, Forward or a typed hash that leaves a
 * page with an unsaved draft runs the same leave guard as `navigate()`. The router puts
 * the guarded URL back with `history.pushState` first (no second `hashchange`), opens the
 * one ConfirmDialog, and goes on to the target only on confirm. Cancel keeps the page,
 * its draft and its URL.
 */
import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { RouterProvider, useNavigationBlocker, useRoute, type NavigationBlockerOptions } from '../router';

let route: ReturnType<typeof useRoute>;

function Probe() {
  route = useRoute();
  return <div data-testid="probe">{`${route.page}|${JSON.stringify(route.opts ?? null)}`}</div>;
}

const LEAVE: NavigationBlockerOptions = {
  title: 'Leave Settings with unsaved changes?',
  confirmLabel: 'Leave page',
  cancelLabel: 'Keep editing',
};

function Guarded({ options, on = true }: { options: NavigationBlockerOptions; on?: boolean }) {
  useNavigationBlocker(on, options);
  return null;
}

function mount(hash: string, options: NavigationBlockerOptions = LEAVE, on = true) {
  window.location.hash = hash;
  return render(
    <RouterProvider>
      <Probe />
      <Guarded options={options} on={on} />
    </RouterProvider>,
  );
}

/** What Back or a typed address does: the hash changes under the router, then the event. */
function typeHash(hash: string, withUrls = true) {
  act(() => {
    const oldURL = window.location.href;
    window.location.hash = hash;
    window.dispatchEvent(
      new HashChangeEvent('hashchange', withUrls ? { oldURL, newURL: window.location.href } : {}),
    );
  });
}

const probe = () => screen.getByTestId('probe').textContent;

const BOARD: NavigationBlockerOptions = { ...LEAVE, title: 'Discard changes to My dashboard?', sameRoute: true };

/** Let jsdom fire the real `hashchange` a hash assignment queued (mount writes one). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

afterEach(() => {
  window.location.hash = '';
});

describe('B44: Back and typed links run the leave guard', () => {
  it('a typed hash to another page pauses, restores the URL and asks', async () => {
    mount('#/settings?s=general');
    typeHash('#/team');
    expect(await screen.findByRole('alertdialog', { name: LEAVE.title })).toBeInTheDocument();
    // The page and its URL stay; the draft is not thrown away.
    expect(probe()).toMatch(/^settings\|/);
    expect(window.location.hash).toBe('#/settings?s=general');
  });

  it('Keep editing stays; Leave page goes on to the target', async () => {
    const user = userEvent.setup();
    mount('#/settings?s=general');
    typeHash('#/team');
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(probe()).toMatch(/^settings\|/);
    expect(window.location.hash).toBe('#/settings?s=general');

    typeHash('#/team');
    await user.click(await screen.findByRole('button', { name: 'Leave page' }));
    expect(probe()).toBe('team|null');
    expect(window.location.hash).toBe('#/team');
  });

  it('carries the typed link\'s options to the target on confirm', async () => {
    const user = userEvent.setup();
    mount('#/settings?s=general');
    typeHash('#/audit?actor=zoe');
    await user.click(await screen.findByRole('button', { name: 'Leave page' }));
    expect(probe()).toBe('audit|{"actor":"zoe"}');
    expect(window.location.hash).toBe('#/audit?actor=zoe');
  });

  it('a same-page change asks only for a guard that opts in with sameRoute', async () => {
    mount('#/settings?s=general');
    typeHash('#/settings?s=detection');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(window.location.hash).toBe('#/settings?s=detection');
  });

  it('a board guard that opts in asks before Back to the library', async () => {
    mount('#/dashboards?board=overview', BOARD);
    await settle();
    // The browser's own hashchange (a trusted event), as Back fires it.
    await act(async () => {
      window.location.hash = '#/dashboards';
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(await screen.findByRole('alertdialog', { name: BOARD.title })).toBeInTheDocument();
    expect(probe()).toBe('dashboards|{"board":"overview"}');
    expect(window.location.hash).toBe('#/dashboards?board=overview');
  });

  it('a page that rewrites its own URL and tells the router is not asked', async () => {
    mount('#/dashboards?board=new', BOARD);
    await settle();
    // Dashboards after a save: replaceState, then a synthetic hashchange.
    act(() => {
      const oldURL = window.location.href;
      window.history.replaceState(window.history.state, '', '#/dashboards?board=saved-1');
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(probe()).toBe('dashboards|{"board":"saved-1"}');
  });

  it('an event without its URLs still restores the committed hash', async () => {
    mount('#/settings?s=general');
    typeHash('#/team', false);
    expect(await screen.findByRole('alertdialog', { name: LEAVE.title })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings?s=general');
  });

  it('without a guard a typed hash navigates as before', () => {
    mount('#/settings?s=general', LEAVE, false);
    typeHash('#/team');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(probe()).toBe('team|null');
  });

  it('the router\'s own navigate is not asked twice', async () => {
    const user = userEvent.setup();
    mount('#/settings?s=general');
    act(() => route.navigate('team'));
    await user.click(await screen.findByRole('button', { name: 'Leave page' }));
    expect(probe()).toBe('team|null');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
