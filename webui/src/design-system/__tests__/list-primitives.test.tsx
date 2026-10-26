/**
 * The Round 14 list and message primitives (SPEC §4.9.2): StatusDot, RowActions,
 * ListRow/ListRows and Callout. Each pins its own contract: status never by colour alone,
 * neutral row actions that turn red only on intent, one open control per row with the
 * rest separately reachable, and three callout intents with a remembered dismissal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { Pencil, Trash2 } from 'lucide-react';

import { TooltipProvider } from '@/ui/tooltip';
import { Switch } from '@/ui/switch';

expect.extend(toHaveNoViolations);

// The Callout reads the viewer's preferences; a small stand-in for the provider.
const prefsState: {
  value: null | { ready: boolean; prefs: { misc: Record<string, unknown> }; patchMisc: ReturnType<typeof vi.fn> };
} = { value: null };
vi.mock('@/soc/prefs', () => ({
  useOptionalPrefs: () => prefsState.value,
}));

// Imported after the mock so the Callout sees it.
const { StatusDot, RowActions, ListRow, ListRows, Callout, DISMISSED_INTROS_KEY, DISMISSED_INTRO_ID_PATTERN } = await import(
  '@/design-system'
);

beforeEach(() => {
  prefsState.value = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('StatusDot', () => {
  it('says the status in words, with a decorative dot', () => {
    const { container } = render(<StatusDot tone="warning">Needs key</StatusDot>);
    const status = screen.getByText('Needs key').parentElement!;
    expect(status).toHaveAttribute('data-status-tone', 'warning');
    expect(status).toHaveClass('text-foreground');
    const dot = container.querySelector('[aria-hidden="true"]')!;
    expect(dot).toHaveClass('size-1.5', 'rounded-full', 'bg-warning');
  });

  it('keeps the healthy default quiet: a neutral dot and muted text', () => {
    const { container } = render(<StatusDot>Ready</StatusDot>);
    expect(screen.getByText('Ready').parentElement).toHaveClass('text-muted-foreground');
    expect(container.querySelector('[aria-hidden="true"]')).toHaveClass('bg-muted-foreground/60');
  });
});

describe('RowActions', () => {
  function renderActions(onDelete = vi.fn(), onEdit = vi.fn()) {
    render(
      <TooltipProvider>
        <RowActions
          subject="CASE-000048"
          actions={[
            { id: 'edit', label: 'Edit rule', icon: Pencil, onSelect: onEdit },
            { id: 'delete', label: 'Delete rule', icon: Trash2, onSelect: onDelete, destructive: true },
            { id: 'copy', label: 'Copy rule id', onSelect: vi.fn() },
          ]}
        />
      </TooltipProvider>,
    );
    return { onDelete, onEdit };
  }

  it('shows one action and puts the rest in a menu named for the row, destructive last', () => {
    const { onEdit, onDelete } = renderActions();
    const edit = screen.getByRole('button', { name: 'Edit rule' });
    fireEvent.click(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
    const more = screen.getByRole('button', { name: 'More actions for CASE-000048' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    // Keyboard opening (Radix opens the menu on Enter, Space or ArrowDown).
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Copy rule id', 'Delete rule']);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
    fireEvent.click(items[1]);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps a destructive action neutral at rest and red only on hover and focus', () => {
    render(
      <TooltipProvider>
        <RowActions actions={[{ id: 'delete', label: 'Delete rule', icon: Trash2, onSelect: vi.fn(), destructive: true }]} />
      </TooltipProvider>,
    );
    const button = screen.getByRole('button', { name: 'Delete rule' });
    const tokens = button.className.split(/\s+/);
    expect(tokens).toContain('text-muted-foreground');
    expect(tokens).not.toContain('text-critical-text');
    expect(tokens).not.toContain('text-critical');
    expect(tokens).toContain('hover:text-critical-text');
    expect(tokens).toContain('focus-visible:text-critical-text');
  });

  it('makes a navigating action a link', () => {
    render(
      <TooltipProvider>
        <RowActions actions={[{ id: 'open', label: 'Open in Logs', href: '#/logs?rule=r1' }]} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('link', { name: 'Open in Logs' })).toHaveAttribute('href', '#/logs?rule=r1');
  });

  it('never renders an unsafe href as a link: the action shows disabled, inline and in the menu', () => {
    for (const href of ['javascript:alert(1)', '//evil.test/x', 'data:text/html,hi']) {
      const { unmount } = render(
        <TooltipProvider>
          <RowActions
            actions={[
              { id: 'open', label: 'Open runbook', icon: Pencil, href },
              { id: 'text', label: 'Open provider page', href },
            ]}
            inline={1}
          />
        </TooltipProvider>,
      );
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByRole('button', { name: 'Open runbook' })).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'ArrowDown' });
      const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open provider page' });
      expect(item.tagName).not.toBe('A');
      expect(item).toHaveAttribute('aria-disabled', 'true');
      unmount();
    }
    // A text action too.
    render(
      <TooltipProvider>
        <RowActions actions={[{ id: 'text', label: 'Open provider page', href: 'javascript:alert(2)' }]} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Open provider page' })).toBeDisabled();
  });

  it('gives its targets 44px on a phone and 32px from 640px', () => {
    render(
      <TooltipProvider>
        <RowActions
          actions={[
            { id: 'edit', label: 'Edit rule', icon: Pencil, onSelect: vi.fn() },
            { id: 'copy', label: 'Copy rule id', onSelect: vi.fn() },
          ]}
        />
        <RowActions actions={[{ id: 'revoke', label: 'Revoke', onSelect: vi.fn() }]} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Edit rule' })).toHaveClass('size-11', 'sm:size-8');
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveClass('size-11', 'sm:size-8');
    expect(screen.getByRole('button', { name: 'Revoke' })).toHaveClass('h-11', 'sm:h-8');
  });

  it('renders nothing without actions', () => {
    const { container } = render(<RowActions actions={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ListRow', () => {
  it('opens the record from one named control whose hit area covers the row; the switch stays separate', async () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    const { container } = render(
      <ListRows aria-label="Enrichment providers">
        <ListRow
          title="AbuseIPDB"
          description="IP reputation"
          status={<StatusDot tone="warning">Needs key</StatusDot>}
          onOpen={onOpen}
          openLabel="Open AbuseIPDB settings"
          control={<Switch aria-label="AbuseIPDB enabled" checked onCheckedChange={onToggle} />}
        />
        <ListRow title="RDAP" description="Registration data" href="#/settings?s=enrichment&a=rdap" />
      </ListRows>,
    );
    const list = screen.getByRole('list', { name: 'Enrichment providers' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const open = screen.getByRole('button', { name: 'Open AbuseIPDB settings' });
    expect(open.className).toContain('after:absolute');
    expect(open.className).toContain('after:inset-0');
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const toggle = screen.getByRole('switch', { name: 'AbuseIPDB enabled' });
    expect(toggle.parentElement).toHaveClass('relative', 'z-[1]');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'RDAP' })).toHaveAttribute('href', '#/settings?s=enrichment&a=rdap');
    // The status is in words, once per breakpoint (one copy displayed at a time).
    expect(screen.getAllByText('Needs key')).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('leaves the title as plain text for an unsafe href', () => {
    render(
      <ListRows aria-label="Runbooks">
        <ListRow title="Phishing" href="javascript:alert(1)" />
        <ListRow title="Malware" href="//evil.test/runbooks" />
      </ListRows>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Phishing').closest('li')).not.toHaveClass('hover:bg-hover');
  });

  it('marks the current record', () => {
    render(
      <ListRows aria-label="Runbooks">
        <ListRow title="Phishing" onOpen={() => {}} selected />
      </ListRows>,
    );
    expect(screen.getByRole('button', { name: 'Phishing' })).toHaveAttribute('aria-current', 'true');
  });
});

describe('Callout', () => {
  it('has three intents with their semantics', () => {
    render(
      <>
        <Callout intent="warning" title="RBAC is disabled">
          Every signed-in person has every permission.
        </Callout>
        <Callout intent="error" title="Could not load sources" />
        <Callout intent="intro" title="Runbooks replaced playbooks" />
      </>,
    );
    expect(screen.getByRole('status')).toHaveAttribute('data-callout', 'warning');
    expect(screen.getByRole('alert')).toHaveAttribute('data-callout', 'error');
    expect(screen.getByRole('note')).toHaveAttribute('data-callout', 'intro');
    expect(screen.getByText('RBAC is disabled')).toHaveClass('text-warning-text');
    // The body stays in the foreground ink.
    expect(screen.getByText('Every signed-in person has every permission.')).toHaveClass('text-foreground');
  });

  it('remembers a dismissed intro per user and moves focus on', () => {
    const patchMisc = vi.fn();
    prefsState.value = { ready: true, prefs: { misc: { [DISMISSED_INTROS_KEY]: ['older-note'] } }, patchMisc };
    render(
      <>
        <Callout intent="intro" introId="runbook-migration" title="Runbooks replaced playbooks">
          Your procedures were converted once.
        </Callout>
        <button type="button">Next control</button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(patchMisc).toHaveBeenCalledWith({ [DISMISSED_INTROS_KEY]: ['older-note', 'runbook-migration'] });
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
  });

  it('stays hidden once dismissed, and waits for the preferences rather than flashing', () => {
    prefsState.value = { ready: true, prefs: { misc: { [DISMISSED_INTROS_KEY]: ['runbook-migration'] } }, patchMisc: vi.fn() };
    const { rerender } = render(<Callout intent="intro" introId="runbook-migration" title="Runbooks replaced playbooks" />);
    expect(screen.queryByRole('note')).toBeNull();
    prefsState.value = { ready: false, prefs: { misc: {} }, patchMisc: vi.fn() };
    rerender(<Callout intent="intro" introId="another-note" title="Something new" />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('keeps at most 50 dismissed ids', () => {
    const patchMisc = vi.fn();
    const many = Array.from({ length: 50 }, (_, i) => `note-${i}`);
    prefsState.value = { ready: true, prefs: { misc: { [DISMISSED_INTROS_KEY]: many } }, patchMisc };
    render(<Callout intent="intro" introId="new-note" title="New" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const list = patchMisc.mock.calls[0][0][DISMISSED_INTROS_KEY] as string[];
    expect(list).toHaveLength(50);
    expect(list[49]).toBe('new-note');
    expect(list[0]).toBe('note-1');
  });

  it('never offers a dismissal for a warning or an error, or an intro without an id', () => {
    render(
      <>
        <Callout intent="warning" title="Storage is near its limit" />
        <Callout intent="intro" title="An intro without an id" />
      </>,
    );
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('is not dismissible with an id the server would drop, and says so in development', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const patchMisc = vi.fn();
    prefsState.value = { ready: true, prefs: { misc: {} }, patchMisc };
    for (const id of ['Runbook migration', 'runbookIntro', '-leading-dash', 'x'.repeat(65)]) {
      expect(DISMISSED_INTRO_ID_PATTERN.test(id)).toBe(false);
      const { unmount } = render(<Callout intent="intro" introId={id} title="Runbooks replaced playbooks" />);
      expect(screen.getByRole('note')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
      unmount();
    }
    expect(error).toHaveBeenCalledTimes(4);
    expect(String(error.mock.calls[0][0])).toContain('cannot be dismissed');
    expect(patchMisc).not.toHaveBeenCalled();
    for (const id of ['runbook-migration', 'r14:runbooks.intro_v2', '0']) {
      expect(DISMISSED_INTRO_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('skips a hidden control when it moves focus on after a dismissal', () => {
    render(
      <>
        <Callout intent="intro" introId="local-note" title="Local" />
        <button type="button" style={{ display: 'none' }}>
          Phone copy
        </button>
        <div hidden>
          <button type="button">Closed region</button>
        </div>
        <button type="button">Visible control</button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('button', { name: 'Visible control' })).toHaveFocus();
  });

  it('dismisses locally outside a preferences provider', () => {
    render(<Callout intent="intro" introId="local-note" title="Local" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
