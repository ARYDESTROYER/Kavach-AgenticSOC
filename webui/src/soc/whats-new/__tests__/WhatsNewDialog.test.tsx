/**
 * The What's new dialog and its host (Round 16 SPEC D7, [wn] §4.3): focus on the title,
 * every close path writes the marker once, focus returns to `#socMain`, a failed save
 * keeps a copy in this browser, it waits for another open dialog, Open is offered only
 * with the grant, the hero matches the theme, and the open dialog is axe-clean.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReleaseNotes } from '../notes';

expect.extend(toHaveNoViolations);

const { state } = vi.hoisted(() => ({
  state: {
    misc: {} as Record<string, unknown>,
    saved: true,
    isDark: false,
    granted: true,
    navigate: vi.fn(),
    patchMisc: vi.fn(),
    opts: undefined as Record<string, string> | undefined,
  },
}));

const { FIXTURE } = vi.hoisted(() => {
  const shot = (name: string) => ({
    light: { src: `assets/releases/0.3.0/${name}-light.webp`, width: 2880, height: 1800 },
    dark: { src: `assets/releases/0.3.0/${name}-dark.webp`, width: 2880, height: 1800 },
    alt: `The ${name} screen of the Console with its new controls in view.`,
    caption: `The ${name} screen`,
  });

  const FIXTURE: ReleaseNotes = {
    schema: 1,
    latest: '0.3.0.2027-02-01',
    releases: [
      {
        version: '0.3.0', status: 'released', date: '2027-02-01', title: 'Three', summary: 'The third line in one release.',
        docs: 'releases/0.3.0/', records: [],
        updates: [
          {
            id: '0.3.0.2027-02-01', date: '2027-02-01', title: 'February', highlights: [
              { id: 'tabs', kind: 'improved', area: 'cases', title: 'Case tabs', summary: 'Alt+6 opens **Chat**.', details: [],
                featured: true, requires: null, open: 'case_manager', help: null, screenshot: shot('tabs') },
              { id: 'team', kind: 'new', area: 'administration', title: 'Team activity', summary: 'Work counts.', details: [],
                featured: true, requires: null, open: 'team', help: null, screenshot: shot('team') },
            ],
          },
          { id: '0.3.0.2027-01-10', date: '2027-01-10', title: 'January', highlights: [
            { id: 'old', kind: 'fixed', area: 'platform', title: 'Old fix', summary: 'Fixed.', details: [],
              featured: false, requires: null, open: null, help: null, screenshot: null },
          ] },
        ],
      },
    ],
  };
  return { FIXTURE };
});

vi.mock('../notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes')>()),
  RELEASE_NOTES: FIXTURE,
}));
vi.mock('../../prefs', () => ({
  usePrefs: () => ({ prefs: { misc: state.misc }, patchMisc: state.patchMisc }),
}));
vi.mock('../../auth', () => ({
  useAuth: () => ({
    username: 'ana',
    hasPermission: (resource: string) => state.granted || resource !== 'team',
  }),
}));
vi.mock('../../theme', () => ({ useTheme: () => ({ isDark: state.isDark }) }));
vi.mock('../../router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../router')>()),
  useNavigateOptional: () => state.navigate,
  useRoute: () => ({ page: 'overview', opts: state.opts, navigate: state.navigate }),
}));

import WhatsNewHost from '../WhatsNewHost';
import { seenMirrorKey } from '../notes';

function renderHost(props: React.ComponentProps<typeof WhatsNewHost> = {}) {
  return render(
    <>
      <main id="socMain" tabIndex={-1}>
        Page
      </main>
      <WhatsNewHost openDelayMs={0} {...props} />
    </>,
  );
}

const dialog = () => screen.findByTestId('whats-new-dialog');

beforeEach(() => {
  state.misc = {};
  state.saved = true;
  state.isDark = false;
  state.granted = true;
  state.navigate = vi.fn();
  state.patchMisc = vi.fn(async () => state.saved);
  state.opts = undefined;
  window.localStorage.clear();
});

afterEach(() => {
  document.querySelectorAll('[data-test-other-dialog]').forEach((node) => node.remove());
});

describe('the welcome dialog', () => {
  it('opens on its title, names the release and lists the highlights', async () => {
    renderHost();
    const panel = await dialog();
    const title = within(panel).getByRole('heading', { name: 'Welcome to Agentic SOC 0.3.0' });
    await waitFor(() => expect(title).toHaveFocus());
    expect(within(panel).getByTestId('whats-new-eyebrow')).toHaveTextContent("What's new · v0.3.0 · 1 Feb 2027");
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('The third line in one release.');
    const rows = within(panel).getAllByRole('button', { pressed: undefined }).filter((b) => b.hasAttribute('aria-pressed'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
    // Plain text: the summary's bold mark is an element, never markup.
    expect(within(panel).getByText('Chat', { selector: 'strong' })).toBeInTheDocument();
  });

  it('shows the hero in the current theme and switches it with a row', async () => {
    state.isDark = true;
    renderHost();
    const panel = await dialog();
    const hero = within(panel).getByRole('img', { name: /tabs screen/ });
    expect(hero).toHaveAttribute('src', expect.stringMatching(/\/docs\/\d+\.\d+\/assets\/releases\/0\.3\.0\/tabs-dark\.webp$/));
    expect(hero).toHaveAttribute('width', '2880');
    expect(hero).toHaveAttribute('height', '1800');
    expect(hero).toHaveAttribute('loading', 'eager');
    await userEvent.click(within(panel).getByRole('button', { name: /Team activity/ }));
    expect(within(panel).getByRole('img', { name: /team screen/ })).toHaveAttribute('src', expect.stringMatching(/team-dark\.webp$/));
    expect(within(panel).getByRole('button', { name: /Team activity/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers Open only for a page the viewer may open', async () => {
    state.granted = false;
    renderHost();
    const panel = await dialog();
    expect(within(panel).getByRole('link', { name: 'Open Case tabs' })).toHaveAttribute('href', '#/case_manager');
    expect(within(panel).queryByRole('link', { name: 'Open Team activity' })).toBeNull();
  });

  it('is axe-clean while open', async () => {
    renderHost();
    await dialog();
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe('every way out writes the marker once', () => {
  const closers: [string, () => Promise<void>][] = [
    ['Got it', async () => userEvent.click(screen.getByRole('button', { name: 'Got it' }))],
    ['Escape', async () => userEvent.keyboard('{Escape}')],
    ['the close button', async () => userEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['See all changes', async () => userEvent.click(screen.getByRole('link', { name: 'See all changes' }))],
    ['Open', async () => userEvent.click(screen.getByRole('link', { name: 'Open Case tabs' }))],
    ['a press outside', async () => {
      const overlay = document.querySelector('[data-state="open"].fixed.inset-0') as HTMLElement;
      fireEvent.pointerDown(overlay);
      fireEvent.pointerUp(overlay);
      fireEvent.click(overlay);
    }],
  ];

  it.each(closers)('%s', async (_name, close) => {
    const onDone = vi.fn();
    renderHost({ onDone });
    await dialog();
    await act(close);
    await waitFor(() => expect(screen.queryByTestId('whats-new-dialog')).toBeNull());
    expect(state.patchMisc).toHaveBeenCalledTimes(1);
    expect(state.patchMisc).toHaveBeenCalledWith({ whats_new_seen: '0.3.0.2027-02-01' });
    expect(onDone).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.getElementById('socMain')).toHaveFocus());
  });

  it('See all changes and Open go where they say', async () => {
    renderHost();
    await dialog();
    await userEvent.click(screen.getByRole('link', { name: 'See all changes' }));
    expect(state.navigate).toHaveBeenCalledWith('whats_new', { v: '0.3.0' });
  });

  it('keeps a copy in this browser when the save fails, and never throws', async () => {
    state.saved = false;
    renderHost();
    await dialog();
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(window.localStorage.getItem(seenMirrorKey('ana'))).toBe('0.3.0.2027-02-01'));
  });
});

describe('when the host shows nothing, or waits', () => {
  it('renders nothing and finishes at once when the marker is current', async () => {
    state.misc = { whats_new_seen: '0.3.0.2027-02-01' };
    const onDone = vi.fn();
    renderHost({ onDone });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(state.patchMisc).not.toHaveBeenCalled();
  });

  it('lists the newer update for an older marker', async () => {
    state.misc = { whats_new_seen: '0.3.0.2027-01-10' };
    renderHost();
    const panel = await dialog();
    expect(within(panel).getByRole('heading', { name: "What's new in Agentic SOC 0.3.0" })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('One update since you last looked.');
  });

  it('re-opens on demand without writing a marker that is already current', async () => {
    state.misc = { whats_new_seen: '0.3.0.2027-02-01' };
    renderHost({ force: true });
    await dialog();
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByTestId('whats-new-dialog')).toBeNull());
    expect(state.patchMisc).not.toHaveBeenCalled();
  });

  it('returns focus to the control that re-opened it, not to the page', async () => {
    // "Show the welcome screen" opens it on demand: unlike the automatic welcome, it has
    // an invoker, and closing must not drop the person back at the top of the page.
    state.misc = { whats_new_seen: '0.3.0.2027-02-01' };
    function Reopen() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <main id="socMain" tabIndex={-1}>
            <button type="button" onClick={() => setOpen(true)}>
              Show the welcome screen
            </button>
          </main>
          {open ? <WhatsNewHost force onDone={() => setOpen(false)} /> : null}
        </>
      );
    }
    render(<Reopen />);
    const invoker = screen.getByRole('button', { name: 'Show the welcome screen' });
    await userEvent.click(invoker);
    await dialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('whats-new-dialog')).toBeNull());
    await waitFor(() => expect(invoker).toHaveFocus());
  });

  it('waits while another dialog is open', async () => {
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.setAttribute('data-state', 'open');
    other.setAttribute('data-test-other-dialog', '');
    document.body.append(other);
    renderHost();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    other.remove();
    expect(await screen.findByTestId('whats-new-dialog', {}, { timeout: 2_500 })).toBeInTheDocument();
  });
});

describe('when the welcome waits', () => {
  it('opens only after the landing page had a moment to show', async () => {
    renderHost({ openDelayMs: 150 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(await dialog()).toBeInTheDocument();
  });

  it('never covers a record the person opened, and opens once they reach a page that is not one', async () => {
    state.opts = { caseId: 'case-0042' };
    const { rerender } = renderHost();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    state.opts = { tab: 'performance' };
    rerender(
      <>
        <main id="socMain" tabIndex={-1}>
          Page
        </main>
        <WhatsNewHost openDelayMs={0} />
      </>,
    );
    expect(await dialog()).toBeInTheDocument();
  });

  it.each([{ reportId: 'r1' }, { conversationId: 'c1' }, { rule: 'Rule A' }, { record: 'mem:1' }, { id: 'rb-1' }])(
    'treats %o as a record',
    async (opts) => {
      state.opts = opts;
      renderHost();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    },
  );

  it("counts this browser's copy of the marker, kept after a failed save, as seen", async () => {
    window.localStorage.setItem(seenMirrorKey('ana'), '0.3.0.2027-02-01');
    const onDone = vi.fn();
    renderHost({ onDone });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('whats-new-dialog')).toBeNull();
    expect(seenMirrorKey(null)).toBe('soc.whatsNew.seen:default');
  });
});
