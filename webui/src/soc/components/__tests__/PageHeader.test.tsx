/**
 * PageHeader: the Overview header grammar on every page (Round 14, SPEC §4.9.3, operator
 * choice C8 option 1). Rewritten from the Round 7 compaction spec, whose `hero` border and
 * glow wash, icon chip, breadcrumb and clamped description line C8 removes.
 *
 * Pinned here (jsdom has no layout, so structure and classes; the measured title top at
 * 89px and the 144px first content are live-harness checks, SPEC §8.3):
 *   1. the title is the page's one `h1`: 20px, 24px from `sm`, 30px from 1536px, weight
 *      from the size step, NO `tracking-tight` (the step carries Inter's tracking);
 *   2. no icon chip, no overline, no breadcrumb, no description line, no hero chrome;
 *   3. the explanation is a help tip beside the title (a popover, reachable by touch and
 *      keyboard), `description` feeding it on a routed page;
 *   4. DOM order: back link, title, help, controls, then actions;
 *   5. `back` is a real link (the one sanctioned extra), never a breadcrumb, and an unsafe
 *      href never becomes a link (#9);
 *   6. an embedded header is an `h2` and still shows its description line;
 *   7. plain text only (#9) and no axe violations.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { Briefcase } from 'lucide-react';

import { TooltipProvider } from '@/ui/tooltip';

import { RouterProvider, useNavigationBlocker } from '../../router';
import { PageHeader, backRoute, safeBackHref } from '../PageHeader';

expect.extend(toHaveNoViolations);

function renderHeader(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('PageHeader: the Overview grammar (C8)', () => {
  it('renders the title as the one h1 at the Overview size ladder, with no tracking-tight', () => {
    renderHeader(<PageHeader title="Cases" />);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Cases' });
    expect(h1).toHaveClass('text-2xl', 'sm:text-3xl', '2xl:text-4xl', 'font-semibold');
    expect(h1.className).not.toMatch(/(^|\s)tracking-/);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('starts the title row 8px below the content inset, like the Overview masthead', () => {
    renderHeader(<PageHeader title="Cases" data-testid="hdr" />);
    const root = screen.getByTestId('hdr');
    expect(root).toHaveClass('pt-2');
    expect(root).toHaveAttribute('data-page-header', 'page');
  });

  it('keeps the title at one height whatever the actions hold (32px title row, top-aligned)', () => {
    renderHeader(
      <PageHeader title="Standup" actions={<div style={{ height: 120 }}>tall actions</div>} />,
    );
    const titleRow = screen.getByRole('heading', { level: 1 }).closest('[data-page-header-title-row]') as HTMLElement;
    expect(titleRow).toHaveClass('min-h-8', 'items-center');
    // The row that holds the title column and the actions is top-aligned, never centred on
    // a tall actions block (which pushed the Standup title 30px down).
    expect(titleRow.parentElement?.parentElement).toHaveClass('sm:items-start');
    expect(titleRow.parentElement?.parentElement).not.toHaveClass('sm:items-center');
    expect(screen.getByText('tall actions').closest('[data-page-header-actions]')).toHaveClass('sm:min-h-8');
  });

  it('draws no icon chip, overline, breadcrumb, description line or hero chrome', () => {
    renderHeader(
      <PageHeader
        variant="hero"
        icon={Briefcase}
        eyebrow="Triage"
        breadcrumb={[{ label: 'Triage', href: '#/cases' }, { label: 'Cases' }]}
        title="Cases"
        description="Every case the agent opened, newest activity first."
        data-testid="hdr"
      />,
    );
    const root = screen.getByTestId('hdr');
    expect(root.querySelector('svg.lucide-briefcase')).toBeNull();
    expect(screen.queryByText('Triage')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.queryByText('Every case the agent opened, newest activity first.')).toBeNull();
    expect(root.className).not.toMatch(/\b(rounded-lg|border|bg-card)\b/);
    expect(root.querySelector('.bg-hero-glow')).toBeNull();
  });

  it('turns a routed page description into the help tip beside the title (popover)', () => {
    renderHeader(<PageHeader title="Standup" description="The handover for the next shift." />);
    const trigger = screen.getByRole('button', { name: 'About Standup' });
    // Beside the title, in the same cluster.
    const title = screen.getByRole('heading', { level: 1, name: 'Standup' });
    expect(title.parentElement).toContainElement(trigger);
    // A relocated explanation is a popover (opens on click, so on touch and keyboard).
    fireEvent.click(trigger);
    expect(screen.getByText('The handover for the next shift.')).toBeInTheDocument();
  });

  it('prefers `help` over `description` and takes a custom help label', () => {
    renderHeader(
      <PageHeader title="Audit log" help="Who did what, and when." helpLabel="About the audit log" description="Older text." />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'About the audit log' }));
    expect(screen.getByText('Who did what, and when.')).toBeInTheDocument();
    expect(screen.queryByText('Older text.')).toBeNull();
  });

  it('places controls beside the title and actions on the right, in reading order', () => {
    renderHeader(
      <PageHeader
        title="Analytics"
        controls={<button type="button">Last 24 hours</button>}
        actions={<button type="button">Export</button>}
        back={{ label: 'All dashboards', href: '#/dashboards' }}
        help="How the team is doing."
      />,
    );
    const order = [
      screen.getByRole('link', { name: 'All dashboards' }),
      screen.getByRole('heading', { level: 1 }),
      screen.getByRole('button', { name: 'About Analytics' }),
      screen.getByRole('button', { name: 'Last 24 hours' }),
      screen.getByRole('button', { name: 'Export' }),
    ];
    for (let i = 1; i < order.length; i += 1) {
      // DOCUMENT_POSITION_FOLLOWING: each element comes after the one before it.
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const controls = screen.getByRole('button', { name: 'Last 24 hours' }).closest('[data-page-header-controls]');
    expect(controls).not.toBeNull();
  });

  it('keeps `meta` as an alias of `controls`, with `controls` winning when both are set', () => {
    const { rerender } = renderHeader(<PageHeader title="Cases" meta={<span>77 cases</span>} />);
    expect(screen.getByText('77 cases').closest('[data-page-header-controls]')).not.toBeNull();
    rerender(
      <TooltipProvider>
        <PageHeader title="Cases" meta={<span>old</span>} controls={<span>new</span>} />
      </TooltipProvider>,
    );
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.queryByText('old')).toBeNull();
  });

  it('keeps long page titles readable instead of silently truncating them', () => {
    renderHeader(<PageHeader title="A long operator-visible workspace title that must remain available" />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveClass('break-words');
    expect(heading).not.toHaveClass('truncate');
  });
});

describe('PageHeader back link (the one sanctioned extra)', () => {
  it('renders a 13px primary link with a back arrow above the title', () => {
    renderHeader(<PageHeader title="SOC operations" back={{ label: 'All dashboards', href: '#/dashboards' }} />);
    const link = screen.getByRole('link', { name: 'All dashboards' });
    expect(link).toHaveAttribute('href', '#/dashboards');
    expect(link).toHaveClass('text-sm', 'text-primary', 'min-h-6');
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // A link, not a breadcrumb trail.
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('never turns an unsafe href into a link (#9)', () => {
    renderHeader(<PageHeader title="Board" back={{ label: 'Back', href: 'javascript:alert(1)' }} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Back')).toBeInTheDocument();
  });

  it('accepts only hash routes, root-relative paths and http(s) URLs', () => {
    expect(safeBackHref('#/dashboards')).toBe('#/dashboards');
    expect(safeBackHref('/docs/0.1/')).toBe('/docs/0.1/');
    expect(safeBackHref('https://example.test/x')).toBe('https://example.test/x');
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', '//evil.test', 'vbscript:x', 'mailto:a@b.c', '']) {
      expect(safeBackHref(bad)).toBeUndefined();
    }
  });

  it('refuses what the browser would resolve to another origin (backslashes, stripped tabs and newlines)', () => {
    for (const bad of [
      '/\\evil.test',
      '\\\\evil.test',
      '\\/evil.test',
      '/\t/evil.test',
      '/\n/evil.test',
      '/\r/evil.test',
      '\t//evil.test',
      ' //evil.test ',
      'java\tscript:alert(1)',
      'https:/\\evil.test',
      'http:\\\\evil.test',
      'cases',
    ]) {
      expect(safeBackHref(bad), JSON.stringify(bad)).toBeUndefined();
      // Every one of them really is cross-origin (or not http) for the URL parser.
      const resolved = (() => {
        try {
          return new URL(bad, 'https://soc.example/app/');
        } catch {
          return null;
        }
      })();
      if (bad !== 'cases' && resolved) {
        expect(resolved.origin === 'https://soc.example' && /^https?:$/.test(resolved.protocol), JSON.stringify(bad)).toBe(false);
      }
    }
    // What survives is exactly what the browser follows: stripped, same-origin.
    expect(safeBackHref(' #/dashboards ')).toBe('#/dashboards');
    expect(safeBackHref('/docs/\t0.1/')).toBe('/docs/0.1/');
  });

  it('reads an in-app back link as the router does (page, its own keys, redirects)', () => {
    expect(backRoute('#/dashboards')).toEqual({ page: 'dashboards', opts: undefined });
    expect(backRoute('#/dashboards?board=builtin%3Asoc-operations')).toEqual({
      page: 'dashboards',
      opts: { board: 'builtin:soc-operations' },
    });
    expect(backRoute('#/settings?s=users&a=invite')).toEqual({ page: 'settings', opts: { section: 'users', anchor: 'invite' } });
    expect(backRoute('#/scans')).toEqual({ page: 'case_manager', opts: { closedBy: 'agent' } });
    expect(backRoute('#/no-such-page')).toBeUndefined();
    expect(backRoute('/docs/0.1/')).toBeUndefined();
    expect(backRoute('https://example.test/x')).toBeUndefined();
  });
});

describe('PageHeader back link goes through the router', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  function Guarded({ on }: { on: boolean }) {
    useNavigationBlocker(on, { title: 'Discard changes to My dashboard?', confirmLabel: 'Discard', sameRoute: true });
    return null;
  }

  function mountBoard(guarded: boolean) {
    window.location.hash = '#/dashboards?board=overview';
    return render(
      <RouterProvider>
        <TooltipProvider>
          <Guarded on={guarded} />
          <PageHeader title="My dashboard" back={{ label: 'All dashboards', href: '#/dashboards' }} />
        </TooltipProvider>
      </RouterProvider>,
    );
  }

  it('asks a route-leave guard before following a plain click (an unsaved draft is never lost)', async () => {
    mountBoard(true);
    const link = screen.getByRole('link', { name: 'All dashboards' });
    // The browser's own hash change is cancelled; the router asks first.
    expect(fireEvent.click(link)).toBe(false);
    expect(await screen.findByRole('alertdialog', { name: 'Discard changes to My dashboard?' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/dashboards?board=overview');
  });

  it('navigates in-app on a plain click when nothing guards the page', () => {
    mountBoard(false);
    fireEvent.click(screen.getByRole('link', { name: 'All dashboards' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(window.location.hash).toBe('#/dashboards');
  });

  it('leaves a modified click (new tab, new window) to the browser', () => {
    mountBoard(true);
    const link = screen.getByRole('link', { name: 'All dashboards' });
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect(fireEvent.click(link, modifier)).toBe(true);
    }
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('PageHeader embedded (a section under a host page)', () => {
  it('uses a section-scaled h2 and keeps its description as a line', () => {
    renderHeader(<PageHeader embedded title="Profile" description="Personal account settings." data-testid="hdr" />);
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: 'Profile', level: 2 });
    expect(heading.className).toContain('text-xl');
    expect(heading.className).not.toContain('sm:text-3xl');
    expect(screen.getByText('Personal account settings.')).toBeVisible();
    expect(screen.getByTestId('hdr')).toHaveAttribute('data-page-header', 'embedded');
  });
});

describe('PageHeader content safety and accessibility', () => {
  it('renders title, help and controls as plain text (UNTRUSTED-safe, #9)', () => {
    renderHeader(
      <PageHeader
        title="<img src=x onerror=alert(1)>"
        help="<script>evil()</script>"
        controls={<span>{'<b>meta</b>'}</span>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('<img src=x onerror=alert(1)>');
    fireEvent.click(screen.getByRole('button', { name: 'About <img src=x onerror=alert(1)>' }));
    expect(screen.getByText('<script>evil()</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('has no axe violations with every slot filled', async () => {
    const { container } = renderHeader(
      <PageHeader
        title="SOC operations"
        back={{ label: 'All dashboards', href: '#/dashboards' }}
        help="For SOC managers and shift leads. Is the team keeping up today?"
        controls={<button type="button">Last 24 hours</button>}
        actions={<button type="button">Duplicate to customise</button>}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('carries no em dash or en dash in the copy it adds', () => {
    renderHeader(<PageHeader title="Cases" help="Every case." back={{ label: 'All dashboards', href: '#/dashboards' }} />);
    const root = screen.getByRole('heading', { level: 1 }).closest('section') as HTMLElement;
    expect(root.textContent).not.toMatch(/[–—]/);
    expect(within(root).getByRole('button', { name: 'About Cases' }).getAttribute('aria-label')).not.toMatch(
      /[–—]/,
    );
  });
});
