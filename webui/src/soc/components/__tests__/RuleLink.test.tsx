/**
 * RuleLink and the rule sheet's module store (Round 14, SPEC §4.6.5): one entry point to a
 * rule's picture. Pinned here: the link's name and look (a quiet dotted underline at
 * rest), the one open sheet for the whole Console (a second rule replaces the first), the
 * opened link's mark, focus to the title and back to the link, a link with no host closes
 * its sheet when it leaves the screen while a shared host keeps it open until the host
 * itself goes (focus then finds the same rule's link again, or the main region), a row's
 * own click handler never fires, a value the server would refuse opens nothing, and a
 * sheet chunk that cannot be fetched never replaces the page with an error.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { summaryMock, logsMock } = vi.hoisted(() => ({ summaryMock: vi.fn(), logsMock: vi.fn() }));

vi.mock('@/lib/api-rules', () => ({ getRuleSummary: summaryMock }));
vi.mock('@/soc/UnifiedLogs.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/UnifiedLogs.api')>()),
  fetchUnifiedLogs: logsMock,
}));
vi.mock('@/soc/auth', () => {
  const auth = () => ({ username: 'analyst', hasPermission: () => true });
  return { useAuth: auth, useOptionalAuth: auth };
});

import { TooltipProvider } from '@/ui/tooltip';
import { ErrorBoundary } from '@/soc/ErrorBoundary';
import { RuleLink, RuleSheetHost, useRuleSheet } from '../RuleLink';
import {
  closeRuleSheet,
  getRuleSheetRequest,
  isRuleValue,
  openRuleSheet,
  resetRuleSheetStoreForTests,
} from '../rule-sheet-store';
import { latestFixture, summaryFixture } from './rule-sheet.fixtures';

// The sheet is loaded on the first click; load its chunk up front, as the app has it
// cached after the first open, so a test waits on the sheet, not on module evaluation.
beforeAll(async () => {
  await import('../RuleSheet');
});

beforeEach(() => {
  summaryMock.mockImplementation(async ({ rule }: { rule: string }) => summaryFixture({ rule }));
  logsMock.mockResolvedValue(latestFixture());
});

afterEach(() => {
  act(() => resetRuleSheetStoreForTests());
  summaryMock.mockReset();
  logsMock.mockReset();
});

function wrap(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('the rule value grammar', () => {
  it('takes 1 to 256 characters on one line, spaces and any letters included', () => {
    expect(isRuleValue('ssh_bruteforce')).toBe(true);
    expect(isRuleValue('Fehlgeschlagene Anmeldung über SSH')).toBe(true);
    expect(isRuleValue('x'.repeat(256))).toBe(true);
    expect(isRuleValue('x'.repeat(257))).toBe(false);
    expect(isRuleValue('')).toBe(false);
    expect(isRuleValue('two\nlines')).toBe(false);
    expect(isRuleValue(`sep${String.fromCharCode(0x2028)}arator`)).toBe(false);
    expect(isRuleValue(`zero${String.fromCharCode(0x200b)}width`)).toBe(false);
    expect(isRuleValue(42)).toBe(false);
  });

  it('opens nothing for a value it refuses', () => {
    expect(openRuleSheet({ rule: 'bad\u0000' }, 'host')).toBe(false);
    expect(getRuleSheetRequest()).toBeNull();
  });
});

describe('RuleLink', () => {
  it('is a button named after the rule, in mono text, that announces a dialog', () => {
    wrap(<RuleLink rule="ssh_bruteforce" />);
    const link = screen.getByRole('button', { name: 'Open rule ssh_bruteforce' });
    expect(link).toHaveTextContent('ssh_bruteforce');
    expect(link).toHaveClass('font-mono');
    expect(link).toHaveAttribute('aria-haspopup', 'dialog');
    expect(link).toHaveAttribute('aria-expanded', 'false');
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('reads as something to open at rest: a quiet dotted underline, solid on hover and focus', () => {
    wrap(<RuleLink rule="ssh_bruteforce" />);
    const link = screen.getByRole('button', { name: 'Open rule ssh_bruteforce' });
    // At rest, with no hover on a phone, the link is not plain text beside plain values.
    expect(link).toHaveClass('underline', 'decoration-dotted', 'decoration-muted-foreground');
    expect(link).toHaveClass('hover:decoration-solid', 'focus-visible:decoration-solid');
    expect(link).toHaveClass('focus-visible:ring-2');
  });

  it('renders a refused value as plain text with no control', () => {
    wrap(<RuleLink rule={'two\nlines'} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/two/)).toBeInTheDocument();
  });

  it('opens the sheet, marks itself while open and gives focus back on close', async () => {
    const user = userEvent.setup();
    wrap(<RuleLink rule="ssh_bruteforce" origin="CASE-000214" window={{ from: 'now-7d', to: 'now' }} />);
    const link = screen.getByRole('button', { name: 'Open rule ssh_bruteforce' });
    await user.click(link);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'ssh_bruteforce' })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription('From CASE-000214');
    await waitFor(() => expect(summaryMock).toHaveBeenCalledWith({ rule: 'ssh_bruteforce', window: 'now-7d' }, expect.any(AbortSignal)));
    expect(link).toHaveAttribute('aria-current', 'true');
    expect(link).toHaveAttribute('aria-expanded', 'true');
    expect(link).toHaveAttribute('aria-controls', dialog.id);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'ssh_bruteforce' })));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(link).not.toHaveAttribute('aria-current');
    expect(document.activeElement).toBe(link);
  });

  it('opens from the keyboard and never fires the row it sits in', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onRowKey = vi.fn();
    wrap(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onRowClick} onKeyDown={onRowKey}>
        <RuleLink rule="ssh_bruteforce" />
      </div>,
    );
    screen.getByRole('button', { name: 'Open rule ssh_bruteforce' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(onRowKey).not.toHaveBeenCalled();
  });

  it('keeps one sheet for the whole Console: a second rule replaces the first', async () => {
    wrap(
      <>
        <RuleLink rule="rule-a" />
        <RuleLink rule="rule-b" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open rule rule-a' }));
    await screen.findByRole('heading', { name: 'rule-a' });
    // A programmatic open (a chart bar) of another rule while one is open.
    act(() => {
      openRuleSheet({ rule: 'rule-b' }, getRuleSheetRequest()!.hostId);
    });
    await screen.findByRole('heading', { name: 'rule-b' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    act(() => closeRuleSheet());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Open rule rule-b' }));
    await screen.findByRole('heading', { name: 'rule-b' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Open rule rule-b', hidden: true })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Open rule rule-a', hidden: true })).not.toHaveAttribute('aria-current');
  });

  it('closes its own sheet when it leaves the screen, with no host above it', async () => {
    const { rerender } = wrap(<RuleLink rule="ssh_bruteforce" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open rule ssh_bruteforce' }));
    await screen.findByRole('dialog');
    rerender(<TooltipProvider>{null}</TooltipProvider>);
    expect(getRuleSheetRequest()).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reads the rule exactly as shown, spaces and other letters included', async () => {
    const rule = 'Fehlgeschlagene Anmeldung über SSH';
    wrap(<RuleLink rule={rule} />);
    fireEvent.click(screen.getByRole('button', { name: `Open rule ${rule}` }));
    await screen.findByRole('heading', { name: rule });
    await waitFor(() => expect(summaryMock).toHaveBeenCalledWith({ rule, window: 'now-3d' }, expect.any(AbortSignal)));
  });
});

describe('a shared host (RuleSheetHost)', () => {
  function List({ rules, hosted = true }: { rules: string[]; hosted?: boolean }) {
    const rows = (
      <ul>
        {rules.map((rule) => (
          <li key={rule}>
            <RuleLink rule={rule} origin="Logs" />
          </li>
        ))}
      </ul>
    );
    return hosted ? <RuleSheetHost>{rows}</RuleSheetHost> : rows;
  }

  function Page({ children }: { children: React.ReactNode }) {
    return (
      <TooltipProvider>
        <main id="socMain" tabIndex={-1}>
          {children}
        </main>
      </TooltipProvider>
    );
  }

  it('keeps the sheet open when a refresh drops the row that opened it, and gives focus to the main region on close', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Page>
        <List rules={['rule-a', 'rule-b']} />
      </Page>,
    );
    await user.click(screen.getByRole('button', { name: 'Open rule rule-b' }));
    const dialog = await screen.findByRole('dialog');
    // A refresh: rule-b leaves the list.
    rerender(
      <Page>
        <List rules={['rule-a', 'rule-c']} />
      </Page>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(getRuleSheetRequest()?.rule).toBe('rule-b');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The opener is gone: focus lands on the main region, never on the page body.
    expect(document.activeElement).toBe(document.getElementById('socMain'));
  });

  it('gives focus to the same rule link when a refresh re-rendered the row', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Page>
        <List rules={['rule-a', 'rule-b']} />
      </Page>,
    );
    const opener = screen.getByRole('button', { name: 'Open rule rule-b' });
    await user.click(opener);
    await screen.findByRole('dialog');
    // A refresh that re-renders rule-b's row as a new element (a new key).
    rerender(
      <Page>
        <List rules={['rule-b ', 'rule-a']} />
      </Page>,
    );
    rerender(
      <Page>
        <List rules={['rule-a', 'rule-b']} />
      </Page>,
    );
    const again = screen.getByRole('button', { name: 'Open rule rule-b', hidden: true });
    expect(again).not.toBe(opener);
    expect(opener.isConnected).toBe(false);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(again);
  });

  it('marks only the link that opened it', async () => {
    render(
      <Page>
        <RuleSheetHost>
          <RuleLink rule="rule-a" />
          <RuleLink rule="rule-a" />
          <RuleLink rule="rule-b" />
        </RuleSheetHost>
      </Page>,
    );
    const [first, second] = screen.getAllByRole('button', { name: 'Open rule rule-a' });
    fireEvent.click(second);
    const dialog = await screen.findByRole('dialog');
    expect(second).toHaveAttribute('aria-current', 'true');
    expect(second).toHaveAttribute('aria-controls', dialog.id);
    expect(first).not.toHaveAttribute('aria-current');
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Open rule rule-b', hidden: true })).not.toHaveAttribute('aria-current');
  });

  it('closes the sheet when the host itself leaves the screen (a navigation)', async () => {
    const { rerender } = render(
      <Page>
        <List rules={['rule-a']} />
      </Page>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open rule rule-a' }));
    await screen.findByRole('dialog');
    rerender(<Page>{null}</Page>);
    expect(getRuleSheetRequest()).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('a sheet chunk that cannot be fetched', () => {
  afterEach(() => {
    vi.doUnmock('../RuleSheet');
    vi.resetModules();
  });

  it('keeps the page and says the rule view could not be loaded, with a reload', async () => {
    vi.resetModules();
    vi.doMock('../RuleSheet', () => {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/RuleSheet-abc123.js');
    });
    const fresh = await import('../RuleLink');
    const store = await import('../rule-sheet-store');
    const user = userEvent.setup();
    try {
      render(
        <ErrorBoundary>
          <main>
            Work in progress on CASE-000214 <fresh.RuleLink rule="ssh_bruteforce" origin="CASE-000214" />
          </main>
        </ErrorBoundary>,
      );
      const link = screen.getByRole('button', { name: 'Open rule ssh_bruteforce' });
      await user.click(link);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: 'ssh_bruteforce' })).toBeInTheDocument();
      expect(dialog).toHaveTextContent('The rule view could not be loaded. Reload the page to try again.');
      expect(within(dialog).getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
      // The page the person was working on is still there, not an error screen.
      expect(screen.queryByText(/Something went wrong/)).toBeNull();
      expect(screen.getByText(/Work in progress on CASE-000214/)).toBeInTheDocument();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(link);
    } finally {
      act(() => store.resetRuleSheetStoreForTests());
    }
  });
});

describe('useRuleSheet', () => {
  function ChartHost() {
    const sheet = useRuleSheet();
    return (
      <div>
        <button type="button" onClick={(event) => sheet.open({ rule: 'bar-rule', origin: 'your answer' }, event.currentTarget)}>
          Bar
        </button>
        <span data-testid="open-rule">{sheet.openRule ?? 'none'}</span>
        {sheet.sheet}
      </div>
    );
  }

  it('lets a host without a link open the sheet and know what it has open', async () => {
    wrap(<ChartHost />);
    expect(screen.getByTestId('open-rule')).toHaveTextContent('none');
    fireEvent.click(screen.getByRole('button', { name: 'Bar' }));
    await screen.findByRole('heading', { name: 'bar-rule' });
    expect(screen.getByTestId('open-rule')).toHaveTextContent('bar-rule');
  });
});
