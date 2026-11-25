/**
 * Communication, What's new: the release tracker page (Round 16 SPEC D5, D7, [wn] §4.4).
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReleaseNotes } from '@/soc/whats-new/notes';

expect.extend(toHaveNoViolations);

const { state, FIXTURE } = vi.hoisted(() => {
  const shot = (version: string, name: string) => ({
    light: { src: `assets/releases/${version}/${name}-light.webp`, width: 2880, height: 1800 },
    dark: { src: `assets/releases/${version}/${name}-dark.webp`, width: 2880, height: 1800 },
    alt: `The ${name} screen of the Console with its new controls in view.`,
    caption: `The ${name} screen`,
  });
  const h = (id: string, extra: Record<string, unknown> = {}) => ({
    id, kind: 'new', area: 'cases', title: `Title ${id}`, summary: `Summary of ${id}.`, details: [],
    featured: false, requires: null, open: null, help: null, screenshot: null, ...extra,
  });
  const FIXTURE = {
    schema: 1,
    latest: '0.3.0.2027-02-01',
    releases: [
      {
        version: '0.3.0', status: 'testing', date: null, title: 'The third line', summary: 'Everything new in three.',
        docs: 'releases/0.3.0/',
        records: [{ version: '0.2.9', date: '2027-01-02', summary: 'Failed publication', docs: 'releases/0.2.9/' }],
        updates: [
          { id: '0.3.0.2027-02-01', date: null, title: 'February work', highlights: [
            h('tabs', { kind: 'improved', details: ['Alt+6 opens `Chat`.'], open: 'case_manager', help: 'analyst/case-manager/#tabs', screenshot: shot('0.3.0', 'tabs') }),
            h('team', { area: 'administration', open: 'team', screenshot: shot('0.3.0', 'team') }),
          ] },
          { id: '0.3.0.2027-01-10', date: '2027-01-10', title: 'January work', highlights: [
            h('chat-fix', { kind: 'fixed', area: 'chat', title: 'A chat fix', summary: 'Answers keep their order.' }),
          ] },
        ],
      },
      {
        version: '0.2.0', status: 'released', date: '2026-12-01', title: 'The second line', summary: 'Everything in two.',
        docs: 'releases/0.2.0/', records: [],
        updates: [{ id: '0.2.0.2026-12-01', date: '2026-12-01', title: 'December', highlights: [h('two-thing')] }],
      },
    ],
  } as unknown as ReleaseNotes;
  return {
    FIXTURE,
    state: {
      opts: undefined as Record<string, string> | undefined,
      misc: {} as Record<string, unknown>,
      loaded: true,
      granted: true,
      isDark: false,
      patchMisc: vi.fn(),
      navigate: vi.fn(),
    },
  };
});

vi.mock('@/soc/whats-new/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/whats-new/notes')>()),
  RELEASE_NOTES: FIXTURE,
}));
vi.mock('@/soc/prefs', () => ({
  usePrefs: () => ({ prefs: { misc: state.misc }, loaded: state.loaded, patchMisc: state.patchMisc }),
}));
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: (resource: string) => state.granted || resource !== 'team' }),
}));
vi.mock('@/soc/theme', () => ({ useTheme: () => ({ isDark: state.isDark }) }));
vi.mock('@/soc/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/router')>()),
  useRoute: () => ({ page: 'whats_new', opts: state.opts, navigate: state.navigate }),
  useNavigateOptional: () => state.navigate,
}));
vi.mock('@/soc/whats-new/WhatsNewHost', () => ({
  default: ({ force, onDone }: { force?: boolean; onDone?: () => void }) => (
    <button type="button" data-testid="forced-host" data-force={String(force)} onClick={onDone}>
      Welcome host
    </button>
  ),
}));

import WhatsNew from '../WhatsNew';
import { rememberMarkerBeforeClose } from '@/soc/whats-new/notes';

beforeEach(() => {
  state.opts = undefined;
  state.misc = {};
  state.loaded = true;
  state.granted = true;
  state.isDark = false;
  state.patchMisc = vi.fn(async () => true);
  state.navigate = vi.fn();
});

const highlightIds = () => screen.getAllByTestId('whats-new-highlight').map((el) => el.getAttribute('data-highlight'));

describe('the release tracker', () => {
  it('is titled by its navigation label and shows the newest release first', () => {
    render(<WhatsNew />);
    expect(screen.getByRole('heading', { level: 1, name: "What's new" })).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-release-line')).toHaveTextContent(/^Running v\d+\.\d+\.\d+ · (Testing|Stable)$/);
    const rail = screen.getByRole('navigation', { name: 'Releases' });
    expect(within(rail).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('Agentic SOC 0.3.0'),
      expect.stringContaining('Agentic SOC 0.2.0'),
    ]);
    expect(within(rail).getAllByRole('button')[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'Agentic SOC 0.3.0' })).toBeInTheDocument();
    expect(screen.getByText('Testing candidate')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Not yet released · February work' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: '10 Jan 2027 · January work' })).toBeInTheDocument();
    expect(highlightIds()).toEqual(['tabs', 'team', 'chat-fix']);
    expect(screen.getByRole('link', { name: /Release record/ })).toHaveAttribute('href', expect.stringMatching(/^\/docs\/[\d.]+\/releases\/0\.3\.0\/$/));
  });

  it('opens another release from the rail', async () => {
    render(<WhatsNew />);
    const rail = screen.getByRole('navigation', { name: 'Releases' });
    await userEvent.click(within(rail).getByRole('button', { name: /0\.2\.0/ }));
    expect(screen.getByRole('heading', { level: 2, name: 'Agentic SOC 0.2.0' })).toBeInTheDocument();
    expect(screen.getByText('Released 1 Dec 2026')).toBeInTheDocument();
    expect(highlightIds()).toEqual(['two-thing']);
  });

  it('follows a #/whats_new?v=&h= link: that release, and focus on that highlight', async () => {
    state.opts = { v: '0.3.0', h: 'chat-fix' };
    render(<WhatsNew />);
    const target = screen.getAllByTestId('whats-new-highlight').find((el) => el.getAttribute('data-highlight') === 'chat-fix');
    await waitFor(() => expect(target).toHaveFocus());
  });

  it('opens the requested release from a link', () => {
    state.opts = { v: '0.2.0' };
    render(<WhatsNew />);
    expect(screen.getByRole('heading', { level: 2, name: 'Agentic SOC 0.2.0' })).toBeInTheDocument();
  });

  it('filters by area and by search, and says how many remain', async () => {
    render(<WhatsNew />);
    const filters = screen.getByRole('group', { name: 'Filter by area' });
    expect(within(filters).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Cases', 'Administration', 'Chat']);
    await userEvent.click(within(filters).getByRole('button', { name: 'Chat' }));
    expect(within(filters).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true');
    expect(highlightIds()).toEqual(['chat-fix']);
    expect(screen.getByText('1 highlight')).toBeInTheDocument();
    await userEvent.click(within(filters).getByRole('button', { name: 'All' }));
    await userEvent.type(screen.getByLabelText('Search this release'), 'alt+6');
    expect(highlightIds()).toEqual(['tabs']);
    await userEvent.clear(screen.getByLabelText('Search this release'));
    await userEvent.type(screen.getByLabelText('Search this release'), 'nothing like this');
    expect(screen.getByText(/No highlight matches/)).toBeInTheDocument();
    expect(screen.getByText('0 highlights')).toBeInTheDocument();
  });

  it('marks what is newer than the marker the person had when the page opened', () => {
    state.misc = { whats_new_seen: '0.3.0.2027-01-10' };
    render(<WhatsNew />);
    const marked = screen
      .getAllByTestId('whats-new-highlight')
      .filter((el) => within(el).queryByTestId('whats-new-new-badge'))
      .map((el) => el.getAttribute('data-highlight'));
    expect(marked).toEqual(['tabs', 'team']);
  });

  it('after "See all changes", marks what the dialog showed, also when React renders twice (StrictMode)', () => {
    // The dialog has already written the newest marker; the page must still mark what
    // was new to the person. The Console renders under StrictMode, which runs a state
    // initializer twice, so the hand-off must survive a second read in the same mount.
    state.misc = { whats_new_seen: '0.3.0.2027-02-01' };
    rememberMarkerBeforeClose('0.3.0.2027-01-10');
    const marked = () =>
      screen
        .queryAllByTestId('whats-new-highlight')
        .filter((el) => within(el).queryByTestId('whats-new-new-badge'))
        .map((el) => el.getAttribute('data-highlight'));
    const { unmount } = render(
      <React.StrictMode>
        <WhatsNew />
      </React.StrictMode>,
    );
    expect(marked()).toEqual(['tabs', 'team']);
    unmount();
    // Used once: the next visit reads the stored marker, which is the newest.
    render(<WhatsNew />);
    expect(marked()).toEqual([]);
  });

  it('marks nothing as new for an account with no marker yet', () => {
    render(<WhatsNew />);
    expect(screen.queryByTestId('whats-new-new-badge')).toBeNull();
  });

  it('offers Open only for a page the viewer may open', () => {
    state.granted = false;
    const { unmount } = render(<WhatsNew />);
    expect(screen.getByRole('link', { name: 'Open Title tabs' })).toHaveAttribute('href', '#/case_manager');
    expect(screen.queryByRole('link', { name: 'Open Title team' })).toBeNull();
    unmount();
    state.granted = true;
    render(<WhatsNew />);
    expect(screen.getByRole('link', { name: 'Open Title team' })).toHaveAttribute('href', '#/team');
  });

  it('links Read more to the Help Center, keeping the anchor', () => {
    render(<WhatsNew />);
    expect(screen.getByRole('link', { name: /Read more about Title tabs/ })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/docs\/[\d.]+\/analyst\/case-manager\/#tabs$/),
    );
  });

  it('draws the first figure eagerly and the rest lazily, sized, in the current theme', () => {
    state.isDark = true;
    render(<WhatsNew />);
    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('loading', 'eager');
    expect(images[1]).toHaveAttribute('loading', 'lazy');
    for (const image of images) {
      expect(image).toHaveAttribute('width', '2880');
      expect(image).toHaveAttribute('height', '1800');
      expect(image.getAttribute('src')).toMatch(/-dark\.webp$/);
    }
  });

  it('collapses a broken image to its caption', () => {
    render(<WhatsNew />);
    const [first] = screen.getAllByRole('img');
    fireEvent.error(first);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByText('The tabs screen')).toBeInTheDocument();
  });

  it('lists the earlier release records in a collapsed group', async () => {
    render(<WhatsNew />);
    const group = screen.getByTestId('whats-new-records-group');
    expect(group).not.toHaveAttribute('open');
    await userEvent.click(within(group).getByText('Earlier release records'));
    expect(group).toHaveAttribute('open');
    const records = screen.getByTestId('whats-new-records');
    expect(within(records).getByRole('link', { name: 'Agentic SOC 0.2.9' })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/releases\/0\.2\.9\/$/),
    );
    expect(records).toHaveTextContent('Failed publication');
  });

  it('turns the welcome off and on with the personal switch', async () => {
    render(<WhatsNew />);
    const toggle = screen.getByRole('switch', { name: 'Show after updates' });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(state.patchMisc).toHaveBeenCalledWith({ whats_new_auto: false });
  });

  it('shows the welcome screen again on demand', async () => {
    render(<WhatsNew />);
    await userEvent.click(screen.getByRole('button', { name: 'Show the welcome screen' }));
    const host = await screen.findByTestId('forced-host');
    expect(host).toHaveAttribute('data-force', 'true');
    await act(async () => {
      host.click();
    });
    expect(screen.queryByTestId('forced-host')).toBeNull();
  });

  it.each([false, true])('is axe-clean (dark %s)', async (dark) => {
    state.isDark = dark;
    const { container } = render(<WhatsNew />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
