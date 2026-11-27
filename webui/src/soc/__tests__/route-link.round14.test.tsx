/**
 * In-app links (Round 14, SPEC §3.3): only a safe href becomes a link (#9), and a plain
 * click on a link to a Console route goes through the router, so a page's route-leave
 * guard (an unsaved Settings draft, typed secrets included) is asked before the page
 * changes. The router's hashchange handler cannot pause a navigation, so a bare
 * `<a href="#/...">` would drop the draft without asking. Covers the helpers and every
 * shared link primitive: ListRow titles and RowActions links, inline and in the menu (the
 * Settings link row is pinned in `primitives.round14.test.tsx`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ExternalLink } from 'lucide-react';

import { TooltipProvider } from '@/ui/tooltip';
import { ListRow, ListRows, RowActions } from '@/design-system';

import { RouterProvider, useNavigationBlocker } from '../router';
import { hashRoute, safeRouteHref } from '../route-link';

describe('safeRouteHref', () => {
  it('keeps hash routes, same-origin paths and http(s) URLs', () => {
    expect(safeRouteHref('#/sources')).toBe('#/sources');
    expect(safeRouteHref('/docs/0.1/')).toBe('/docs/0.1/');
    expect(safeRouteHref('https://attack.mitre.org/techniques/T1110/')).toBe('https://attack.mitre.org/techniques/T1110/');
  });

  it('refuses script, data, protocol-relative and look-alike targets', () => {
    for (const href of [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,hi',
      '//evil.test/x',
      '/\\evil.test',
      '/\t/evil.test',
      '\\\\evil.test',
      'mailto:soc@example.test',
      'relative/path',
      '',
      undefined,
      null,
    ]) {
      expect(safeRouteHref(href)).toBeUndefined();
    }
  });
});

describe('hashRoute', () => {
  it('reads a Console route the way the router does', () => {
    expect(hashRoute('#/sources')).toEqual({ page: 'sources', opts: undefined });
    expect(hashRoute('#/settings?s=users&a=invite')).toEqual({ page: 'settings', opts: { section: 'users', anchor: 'invite' } });
    expect(hashRoute('#/no-such-page')).toBeUndefined();
    expect(hashRoute('/docs/0.1/')).toBeUndefined();
    expect(hashRoute('https://example.test')).toBeUndefined();
  });
});

describe('shared link primitives and the route-leave guard', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  function Guarded({ on }: { on: boolean }) {
    useNavigationBlocker(on, { title: 'Discard unsaved changes?', confirmLabel: 'Discard' });
    return null;
  }

  function mount(guarded: boolean) {
    window.location.hash = '#/settings?s=enrichment';
    return render(
      <RouterProvider>
        <TooltipProvider>
          <Guarded on={guarded} />
          <ListRows aria-label="Providers">
            <ListRow
              title="AbuseIPDB"
              href="#/sources"
              actions={
                <RowActions
                  subject="AbuseIPDB"
                  actions={[
                    { id: 'logs', label: 'Open in Logs', icon: ExternalLink, href: '#/logs' },
                    { id: 'cases', label: 'Open cases', href: '#/cases' },
                  ]}
                />
              }
            />
          </ListRows>
        </TooltipProvider>
      </RouterProvider>,
    );
  }

  it('a list row title asks the guard first on a plain click', async () => {
    mount(true);
    expect(fireEvent.click(screen.getByRole('link', { name: 'AbuseIPDB' }))).toBe(false);
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings?s=enrichment');
  });

  it('an inline row action link asks the guard first on a plain click', async () => {
    mount(true);
    expect(fireEvent.click(screen.getByRole('link', { name: 'Open in Logs' }))).toBe(false);
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings?s=enrichment');
  });

  it('a menu row action link asks the guard first and closes the menu', async () => {
    mount(true);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for AbuseIPDB' }), { key: 'ArrowDown' });
    const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open cases' });
    expect(item.tagName).toBe('A');
    expect(item).toHaveAttribute('href', '#/cases');
    expect(fireEvent.click(item)).toBe(false);
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(window.location.hash).toBe('#/settings?s=enrichment');
  });

  it('navigates in-app on a plain click when nothing guards the page', () => {
    mount(false);
    fireEvent.click(screen.getByRole('link', { name: 'Open in Logs' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(window.location.hash).toBe('#/logs');
  });

  it('leaves a modified click (new tab, new window) to the browser', () => {
    mount(true);
    for (const name of ['AbuseIPDB', 'Open in Logs']) {
      const link = screen.getByRole('link', { name });
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
        expect(fireEvent.click(link, modifier)).toBe(true);
      }
    }
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
