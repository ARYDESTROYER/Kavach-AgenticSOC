/**
 * AppShell top bar — what gives way, and in what order (Round 12 screenshot tour).
 *
 * The tour found the breadcrumb collapsed to "A... / W..." at 1440, "Agentic ... /
 * Worksp..." at 1600 and ". /" at 768, while the search field kept its full width, icon
 * buttons squeezed from 32px to 25px and the "Demo mode" chip wrapped onto two lines.
 * The bar now compacts by its OWN width (`@container/topbar`, TOP_BAR_TIERS): the page
 * name keeps priority, the search field shrinks and then becomes an icon, chips go
 * icon-only with tooltips and full accessible names, and what still does not fit moves
 * into the Console controls sheet. Nothing wraps; nothing squeezes. A second tour found
 * the width tiers alone could not know a crowded chip set (source notice, Enable updates,
 * a store outage, a long name): labels now also fold by what is in the bar
 * (top-bar-fold.ts, unit-tested in top-bar-fold.test.tsx), the field reads by its own
 * width, and the notification bell stays in the bar at every desktop width.
 *
 * jsdom has no layout and ignores container queries, so these specs pin the class
 * contract that produces the behaviour (the live 390-2560 sweep measures the geometry),
 * and pin the documented tiers against the source so the two cannot drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {
      status: number;
      body: unknown;
      constructor(status = 0, message = '', body: unknown = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
      }
    },
    api: {
      get: ok({ unread: 0, items: [] }),
      post: ok({ ok: true }),
      put: ok({}),
      del: ok({}),
      auth: { me: ok({ auth_enabled: false, authenticated: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: {}, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        }),
        putUser: ok({}),
      },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }), enable: ok({}) },
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      account: { get: ok({}) },
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell, TOP_BAR_TIERS } from '../AppShell';
import { TOP_BAR_FOLD_HIDDEN } from '../top-bar-fold';
import type { PageId } from '../nav';

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('max-width') ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
}

function renderShell(page: PageId = 'chat') {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page={page} onNavigate={vi.fn()}>
                  <div>routed content</div>
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const SRC = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('AppShell top bar — priority and compaction', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setMobileViewport(false);
  });

  it('measures its own width: the bar is the size container every tier reads', async () => {
    renderShell();
    const header = (await screen.findByTestId('top-bar-breadcrumb')).closest('header')!;
    expect(header).toHaveClass('@container/topbar');
    // ...and the group the content-aware fold (`data-fold`, top-bar-fold.ts) is read from.
    expect(header).toHaveClass('group/topbar');
  });

  it('gives the current page name priority: never wraps, never squeezed while search can give, full name kept', async () => {
    renderShell('chat');
    const crumb = await screen.findByTestId('top-bar-breadcrumb');
    // While the search field shows, it absorbs every squeeze and the nav never shrinks
    // (even a 0.01 share took half a pixel and ellipsized "Workspace"); below that the
    // nav is the only thing left that can give.
    expect(crumb).toHaveClass(
      `@[${TOP_BAR_TIERS.search}]/topbar:shrink-0`,
      `@[${TOP_BAR_TIERS.search}]/topbar:whitespace-nowrap`,
      'min-w-0',
    );
    expect(crumb.className).not.toMatch(/shrink-\[/);
    const leaf = within(crumb).getByText('Workspace');
    expect(leaf).toHaveAttribute('aria-current', 'page');
    expect(leaf).toHaveAttribute('title', 'Workspace');
    expect(leaf).toHaveClass('font-semibold', 'text-foreground');
    // On a phone a long name takes a second line instead of an ellipsis, wrapping only
    // between words: at 360 "Workspace" broke as "Workspac" / "e" (closing pass). A word
    // wider than its room ends in an ellipsis instead of breaking.
    expect(leaf).toHaveClass('line-clamp-2', 'text-ellipsis');
    expect(leaf.className).not.toMatch(/\b(?:break-words|break-all|truncate)\b|\[overflow-wrap|\[word-break/);
    // 6 px gaps below `sm` leave "Workspace" its 71 px beside "v0.1.13 · Testing" at 360.
    expect(crumb.closest('header')).toHaveClass('gap-1.5', 'sm:gap-3');
    // The product name is the first thing to go (the rail carries the logo).
    const product = within(crumb).getByText('Agentic SOC');
    expect(product).toHaveClass('hidden', `@[${TOP_BAR_TIERS.product}]/topbar:block`);
  });

  it('lets the search field give way first: a shrinking field, then an icon opener', async () => {
    renderShell();
    const wide = await screen.findByRole('button', { name: 'Search cases, sources, and actions' });
    expect(wide).toHaveClass('hidden', `@[${TOP_BAR_TIERS.search}]/topbar:flex`);
    const compact = screen.getByRole('button', { name: 'Open search' });
    expect(compact).toHaveClass('shrink-0', `@[${TOP_BAR_TIERS.search}]/topbar:hidden`);
  });

  it('reads the search field by its OWN width: never "S…", never a hint over the bell', async () => {
    // Live tour: with every chip present the field squeezed to 26px with its icon cut in
    // half, its shortcut hint 45px past the button over the bell, and on Workspace it read
    // "S…". It is now its own size container that clips nothing outside itself and never
    // shrinks past its icon.
    renderShell();
    const wide = await screen.findByTestId('top-bar-search');
    expect(wide).toHaveAccessibleName('Search cases, sources, and actions');
    expect(wide).toHaveClass('@container/search', 'min-w-9', 'overflow-hidden');
    expect(wide.className).not.toMatch(/\bmin-w-0\b/);
    // Below 9.5rem of its own width only the icon shows, centred; the words and the
    // shortcut need that much, and the full placeholder needs 19rem, so neither truncates
    // to a stub. No viewport breakpoint decides any of it.
    const inner = wide.firstElementChild as HTMLElement;
    expect(inner).toHaveClass('justify-center', '@[9.5rem]/search:justify-start');
    const short = within(wide).getByText('Search…');
    expect(short).toHaveClass('hidden', '@[9.5rem]/search:block', '@[19rem]/search:hidden');
    const long = within(wide).getByText('Search cases, sources, actions…');
    expect(long).toHaveClass('hidden', '@[19rem]/search:block');
    const kbd = within(wide).getByText('⌘K');
    expect(kbd).toHaveClass('hidden', '@[9.5rem]/search:inline-block');
    expect(kbd.className).not.toMatch(/\b(?:sm|md|lg|xl):/);
  });

  it('never squeezes or wraps the right cluster or anything in it', async () => {
    renderShell();
    const badge = await screen.findByTestId('release-badge');
    const cluster = badge.parentElement!;
    expect(cluster).toHaveClass('shrink-0', 'whitespace-nowrap');
    // 4px gaps below 40rem of bar keep "Automated scans (legacy)" on one line beside the
    // bell at 768 with the rail pinned; 8px once the bar has room.
    expect(cluster).toHaveClass('gap-1', `@[${TOP_BAR_TIERS.overflow}]/topbar:gap-2`);
    for (const control of [
      badge,
      screen.getByRole('button', { name: 'Open search' }),
      screen.getByRole('button', { name: /switch to (light|dark) mode/i }),
      screen.getByRole('button', { name: /^Notifications, / }),
      await screen.findByTestId('top-bar-health'),
      screen.getByRole('button', { name: 'Open console controls' }),
    ]) {
      expect(control).toHaveClass('shrink-0');
    }
    expect(badge).toHaveClass('whitespace-nowrap');
  });

  it('folds chip labels by the bar, keeping a tooltip-able icon and the full accessible name', async () => {
    renderShell();
    const health = await screen.findByTestId('top-bar-health');
    expect(health).toHaveAccessibleName(/^Platform health: /);
    const label = health.querySelector('span') as HTMLElement;
    expect(label).toHaveClass('hidden', `@[${TOP_BAR_TIERS.labels}]/topbar:inline`);
  });

  it('moves what no longer fits into the Console controls sheet on a narrow desktop bar', async () => {
    renderShell();
    const opener = await screen.findByRole('button', { name: 'Open console controls' });
    // Desktop: the overflow opener exists for a narrow bar and hides once the bar fits.
    expect(opener).toHaveClass(`@[${TOP_BAR_TIERS.overflow}]/topbar:hidden`);
    const toggle = screen.getByRole('button', { name: /switch to (light|dark) mode/i });
    expect(toggle).toHaveClass('hidden', `@[${TOP_BAR_TIERS.overflow}]/topbar:inline-flex`);
    // Every control the bar hides is reachable, by keyboard, from the sheet.
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog', { name: 'Console controls' });
    expect(within(sheet).getByRole('button', { name: /switch to (light|dark) mode/i })).toBeVisible();
    expect(within(sheet).getByRole('status', { name: /platform health/i })).toBeVisible();
  });

  it('keeps the notification bell in the bar at every desktop width, so unread and jobs never hide', async () => {
    // Live tour: at 768 with the rail pinned (a 528px bar) the bell had moved into the
    // sheet, whose opener marked only agent health, so three unread notifications showed
    // nowhere in the bar and were not announced. Before that change the bell stayed inline.
    renderShell();
    const bell = await screen.findByRole('button', { name: /^Notifications, none unread/ });
    expect(bell).toHaveClass('shrink-0');
    // No ancestor inside the bar hides it at any bar width.
    const header = bell.closest('header')!;
    for (let node = bell.parentElement; node && node !== header; node = node.parentElement) {
      expect(node.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
    }
    expect(bell.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
    // The desktop sheet does not repeat it, and its opener does not repeat the bell's
    // health mark; the opener's name stays plain because the bell beside it carries the
    // counts.
    const opener = screen.getByRole('button', { name: 'Open console controls' });
    expect(within(opener).queryByTestId('compact-controls-health-marker')).toBeNull();
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog', { name: 'Console controls' });
    expect(within(sheet).queryByRole('button', { name: /^Notifications, / })).toBeNull();
    expect(sheet).toHaveAccessibleDescription('Appearance, platform status, and account controls.');
  });

  it('always shows the sheet opener on mobile, whatever the bar width, and hands it the bell', async () => {
    setMobileViewport(true);
    renderShell();
    const opener = await screen.findByRole('button', { name: 'Open console controls' });
    expect(opener.className).not.toContain('topbar:hidden');
    expect(screen.queryByRole('button', { name: /^Notifications, / })).toBeNull();
    fireEvent.click(opener);
    const sheet = await screen.findByRole('dialog', { name: 'Console controls' });
    expect(within(sheet).getByRole('button', { name: /^Notifications, none unread/ })).toBeVisible();
    expect(sheet).toHaveAccessibleDescription(
      'Notifications, appearance, platform status, and account controls.',
    );
  });

  it('folds labels by what is in the bar: every foldable label carries its fold class', async () => {
    renderShell();
    const header = (await screen.findByTestId('top-bar-breadcrumb')).closest('header')!;
    // The product name folds first...
    expect(within(header).getByText('Agentic SOC')).toHaveClass(TOP_BAR_FOLD_HIDDEN.product);
    // ...and the health words fold before the demo chip's (rendered here, demo is off).
    const health = await screen.findByTestId('top-bar-health');
    expect(health.querySelector('span')).toHaveClass(TOP_BAR_FOLD_HIDDEN.health);
    expect(health).toHaveClass('group-data-[fold~=health]/topbar:px-2');
    // Chips that need a state this harness does not produce are pinned at the source.
    const shell = read('soc/AppShell.tsx');
    for (const item of ['account', 'source', 'update'] as const) {
      expect(shell).toContain(`TOP_BAR_FOLD_HIDDEN.${item}`);
    }
    expect(read('soc/components/DemoIndicator.tsx')).toContain('TOP_BAR_FOLD_HIDDEN.demo');
    expect(read('soc/components/SystemUpdateControl.tsx')).toContain('TOP_BAR_FOLD_HIDDEN.update');
    // jsdom has no layout, so the bar never reports a crowded fold here.
    expect(header).not.toHaveAttribute('data-fold');
  });

  it('pins the documented tiers to the source (no viewport breakpoints left on bar chips)', () => {
    const shell = read('soc/AppShell.tsx');
    for (const tier of Object.values(TOP_BAR_TIERS)) expect(shell).toContain(`@[${tier}]/topbar:`);
    const labelTier = `@[${TOP_BAR_TIERS.labels}]/topbar:inline`;
    expect(read('soc/components/DemoIndicator.tsx')).toContain(labelTier);
    expect(read('soc/components/SystemUpdateControl.tsx')).toContain(labelTier);
    // A chip's label used to fold on the VIEWPORT (`lg:inline`, `xl:inline`), which
    // ignored the rail: at 1440 with the rail pinned the bar is only 1200px.
    for (const file of ['soc/components/DemoIndicator.tsx', 'soc/components/SystemUpdateControl.tsx']) {
      expect(read(file)).not.toMatch(/\bhidden (?:lg|xl|2xl):inline\b/);
    }
  });
});
