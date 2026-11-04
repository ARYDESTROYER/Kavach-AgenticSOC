/**
 * Round 14 (SPEC §4.9.4, ask 8; [uib] WZ1): the first-run wizard on the console grammar.
 *
 *  - the stage heading has no tracked-capitals overline above it (the stage's name is the
 *    current rail item and the phone strip already), and it takes focus without an
 *    always-on outline (`outline-0`, not `outline-none`, which forced colours paint);
 *  - the rail heading is sentence case;
 *  - the Demo note on Data sources is a plain line, not an info alert;
 *  - the source editor is loaded on demand (the wizard is an entry module) and a chunk
 *    that cannot load shows a reload notice instead of throwing;
 *  - a source's Remove action is neutral at rest, and its confirmation names an unnamed
 *    source by its proper name (QRadar);
 *  - every confirmation hands focus back to what opened it when cancelled (SPEC §3.3):
 *    the row's Remove, the navigation control, the checked workspace mode; a confirmed
 *    removal moves focus to the next row's Remove, else the list heading, never the body;
 *  - the remove confirmation is an async confirm (ConfirmDialog `busy`): it stays open
 *    while the source is deleted, its button keeps focus and a second press does nothing,
 *    it closes as soon as the delete is done (the row leaves with it and the list reloads
 *    outside it), and a failed delete stays in it to retry;
 *  - a removal is announced, and a list that does not reload after it says the source was
 *    removed and offers to reload;
 *  - a row's Remove waits while that row's Make primary runs (that write would re-create a
 *    removed source).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  listConnectorsMock,
  listSourcesMock,
  deleteSourceMock,
  upsertSourceMock,
  demoStatusMock,
  authMeMock,
  rolesGetMock,
} = vi.hoisted(() => ({
  listConnectorsMock: vi.fn(),
  listSourcesMock: vi.fn(),
  deleteSourceMock: vi.fn(),
  upsertSourceMock: vi.fn(),
  demoStatusMock: vi.fn(),
  authMeMock: vi.fn(),
  rolesGetMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (v: unknown) => vi.fn().mockResolvedValue(v);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      setupStatus: ok({ setup_complete: false, configured: {} }),
      listConnectors: listConnectorsMock,
      listSources: listSourcesMock,
      deleteSource: deleteSourceMock,
      upsertSource: upsertSourceMock,
      getSettings: ok({ prefs: {} }),
      putSettings: ok({ ok: true }),
      completeSetup: ok({ ok: true }),
      auth: { me: authMeMock, logout: ok({ ok: true }) },
      roles: { get: rolesGetMock },
      demo: {
        status: demoStatusMock,
        enable: ok({ mode: 'seeded', active: true }),
        disable: ok({ mode: 'off', active: false }),
        reset: ok({ mode: 'off', active: false }),
      },
    },
  };
});

// The real editor is a large manifest-driven form with its own tests; here it is a stub
// so the test pins only how the wizard loads and hosts it.
vi.mock('@/soc/components/SourceEditor', () => ({
  SourceEditor: (props: { existing?: { id: string } }) => (
    <div data-testid="source-editor-stub">{props.existing ? `editing ${props.existing.id}` : 'new source form'}</div>
  ),
}));

import { TooltipProvider } from '@/ui/tooltip';
import { AuthProvider } from '../../auth';
import { DemoProvider } from '../../demo';
import Wizard from '../Wizard';

const CONNECTOR = {
  source_type: 'webhook',
  display_name: 'Webhook',
  category: 'push',
  ingest_modes: ['push'],
  fields: [],
};
const SOURCE = {
  id: 'src-1',
  source_type: 'webhook',
  display_name: 'Edge webhook',
  ingest_mode: 'push',
  enabled: true,
  configured_secrets: [],
};

function renderWizard() {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <DemoProvider>
          <Wizard onComplete={vi.fn()} />
        </DemoProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
}

async function openDataSources() {
  const user = userEvent.setup();
  renderWizard();
  await user.click(await screen.findByRole('button', { name: /Data sources/i }));
  const heading = await screen.findByRole('heading', { level: 1, name: /Connect the systems you already use/i });
  return { user, heading };
}

describe('Wizard on the Round 14 console grammar', () => {
  beforeEach(() => {
    listConnectorsMock.mockReset().mockResolvedValue({ connectors: [CONNECTOR] });
    listSourcesMock.mockReset().mockResolvedValue({ sources: [] });
    deleteSourceMock.mockReset().mockResolvedValue({ ok: true });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    rolesGetMock
      .mockReset()
      .mockResolvedValue({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} });
  });

  it('has no tracked-capitals overline and a sentence-case rail heading', async () => {
    const { container } = renderWizard();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText('Get operational')).not.toHaveClass('uppercase');
    for (const el of container.querySelectorAll('[class]')) {
      const cls = el.getAttribute('class') ?? '';
      expect(cls.includes('uppercase') && cls.includes('tracking-'), cls).toBe(false);
    }
  });

  it('focuses each stage heading without an always-on outline', async () => {
    const { heading } = await openDataSources();
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading.className).not.toMatch(/\boutline-none\b/);
    expect(heading).toHaveClass('outline-0');
    expect(heading.className).not.toMatch(/tracking-tight/);
    // The heading is the first thing in its block: no overline repeats the stage name.
    expect(heading.previousElementSibling).toBeNull();
  });

  it('says Demo makes a source optional as a plain line, not an alert', async () => {
    demoStatusMock.mockResolvedValue({ mode: 'seeded', active: true });
    await openDataSources();
    const note = await screen.findByText(/Optional in Demo mode/);
    expect(note.closest('[role="alert"]')).toBeNull();
    expect(note.textContent).not.toMatch(/—/);
  });

  it('loads the source editor on demand when the operator adds a source', async () => {
    const { user } = await openDataSources();
    expect(screen.queryByTestId('source-editor-stub')).toBeNull();
    await user.click(await screen.findByRole('button', { name: /Add your first source/i }));
    const editor = await screen.findByRole('region', { name: 'Source editor' });
    expect(await within(editor).findByTestId('source-editor-stub')).toHaveTextContent('new source form');
    expect(within(editor).getByText('New source')).not.toHaveClass('uppercase');
  });

  it('spells a source type as its owner does (QRadar), never "Qradar"', async () => {
    listSourcesMock.mockResolvedValue({
      sources: [{ ...SOURCE, id: 'qr-1', source_type: 'qradar', display_name: '', ingest_mode: 'pull' }],
    });
    await openDataSources();
    const names = await screen.findAllByText(/QRadar/);
    expect(names.length).toBeGreaterThan(0);
    expect(document.body.textContent ?? '').not.toMatch(/Qradar|\bqradar\b/);
  });

  it('keeps a source row Remove action neutral at rest', async () => {
    listSourcesMock.mockResolvedValue({ sources: [SOURCE] });
    await openDataSources();
    const remove = await screen.findByRole('button', { name: /Remove/i });
    expect(remove.className).not.toMatch(/(^|\s)text-critical(-text)?(\s|$)/);
    expect(remove).toHaveClass('hover:text-critical-text');
  });

  it('names an unnamed QRadar source by its proper name in the remove confirmation', async () => {
    listSourcesMock.mockResolvedValue({
      sources: [{ ...SOURCE, id: 'qr-1', source_type: 'qradar', display_name: '', ingest_mode: 'pull' }],
    });
    const { user } = await openDataSources();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('“QRadar” and its configuration');
    expect(confirm.textContent ?? '').not.toMatch(/“qradar”|Qradar/);
  });
});

describe('Wizard confirmations hand focus back (SPEC §3.3)', () => {
  const SECOND = { ...SOURCE, id: 'src-2', display_name: 'Branch syslog' };

  beforeEach(() => {
    listConnectorsMock.mockReset().mockResolvedValue({ connectors: [CONNECTOR] });
    listSourcesMock.mockReset().mockResolvedValue({ sources: [] });
    deleteSourceMock.mockReset().mockResolvedValue({ ok: true });
    upsertSourceMock.mockReset().mockResolvedValue({ ok: true });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    rolesGetMock
      .mockReset()
      .mockResolvedValue({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} });
  });

  it("returns focus to the row's Remove when the remove confirmation is cancelled", async () => {
    listSourcesMock.mockResolvedValue({ sources: [SOURCE, SECOND] });
    const { user } = await openDataSources();
    const [first] = await screen.findAllByRole('button', { name: 'Remove' });
    await user.click(first);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });

  it("moves focus to the next row's Remove after a removal, then to the list heading", async () => {
    listSourcesMock.mockResolvedValue({ sources: [SOURCE, SECOND] });
    const { user } = await openDataSources();
    const [first] = await screen.findAllByRole('button', { name: 'Remove' });

    listSourcesMock.mockResolvedValue({ sources: [SECOND] });
    await user.click(first);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove source' }));
    await waitFor(() => expect(deleteSourceMock).toHaveBeenCalledWith('src-1'));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1));
    const [next] = screen.getAllByRole('button', { name: 'Remove' });
    await waitFor(() => expect(document.activeElement).toBe(next));

    listSourcesMock.mockResolvedValue({ sources: [] });
    await user.click(next);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove source' }));
    const heading = await screen.findByRole('heading', { level: 2, name: 'No sources configured' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps the remove confirmation open and busy while the source is deleted', async () => {
    listSourcesMock.mockResolvedValue({ sources: [SOURCE, SECOND] });
    const { user } = await openDataSources();
    const [first] = await screen.findAllByRole('button', { name: 'Remove' });
    // At rest the row's Remove is not busy: the open dialog covers the removal itself.
    expect(first).not.toHaveAttribute('aria-disabled');
    let finish!: () => void;
    deleteSourceMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true });
        }),
    );
    listSourcesMock.mockResolvedValue({ sources: [SECOND] });
    await user.click(first);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove source' }));

    // Busy, not disabled: the confirm keeps focus and names its state.
    const busy = await within(dialog).findByRole('button', { name: 'Removing source' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).not.toBeDisabled();
    expect(document.activeElement).toBe(busy);
    // A second press, Cancel and Escape do nothing while the removal runs.
    await user.click(busy);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(deleteSourceMock).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleteSourceMock).toHaveBeenCalledTimes(1);
    const [next] = screen.getAllByRole('button', { name: 'Remove' });
    await waitFor(() => expect(document.activeElement).toBe(next));
  });

  it('closes the confirmation once the delete is done, without waiting for the list to reload', async () => {
    listSourcesMock.mockResolvedValue({ sources: [SOURCE, SECOND] });
    const { user } = await openDataSources();
    const [first] = await screen.findAllByRole('button', { name: 'Remove' });
    let listed!: () => void;
    listSourcesMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          listed = () => resolve({ sources: [SECOND] });
        }),
    );
    await user.click(first);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove source' }));

    // The delete is done and the list read is still out: the dialog has closed, the row
    // left with it, and focus moved to the next row's Remove.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleteSourceMock).toHaveBeenCalledWith('src-1');
    expect(screen.queryByText('Edge webhook')).toBeNull();
    const remaining = screen.getAllByRole('button', { name: 'Remove' });
    expect(remaining).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(remaining[0]));
    expect(screen.getByRole('heading', { level: 2, name: '1 enabled' })).toBeInTheDocument();
    // A screen reader hears that it worked, not just the next button's name.
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Edge webhook removed.');
    // The explicit aria-live is load-bearing: while the dialog's exit animation runs, the
    // Radix modal keeps the rest of the page aria-hidden, and its hideOthers pass leaves
    // only [aria-live] nodes exposed. A bare role="status" would be hidden when the text
    // lands and would show up with its text already set, so nothing would be announced.
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');

    await act(async () => listed());
    expect(screen.getByText('Branch syslog')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove' }));
  });

  it('says the source was removed when the list does not reload after it, and reloads on request', async () => {
    listSourcesMock.mockResolvedValue({ sources: [SOURCE, SECOND] });
    const { user } = await openDataSources();
    const [first] = await screen.findAllByRole('button', { name: 'Remove' });
    listSourcesMock.mockRejectedValueOnce(new Error('Network error'));
    await user.click(first);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove source' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      await screen.findByText('The source was removed, but the list didn’t refresh'),
    ).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
    // Never the generic "not applied" panel: the removal did happen.
    expect(screen.queryByText('Couldn’t update data sources')).toBeNull();
    // The removed source is not offered again, so Remove cannot run into a 404.
    expect(screen.queryByText('Edge webhook')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);

    listSourcesMock.mockResolvedValueOnce({ sources: [SECOND] });
    await user.click(screen.getByRole('button', { name: 'Reload list' }));
    await waitFor(() =>
      expect(screen.queryByText('The source was removed, but the list didn’t refresh')).toBeNull(),
    );
    expect(screen.getByText('Branch syslog')).toBeInTheDocument();
    expect(screen.queryByText('Edge webhook')).toBeNull();
    expect(deleteSourceMock).toHaveBeenCalledTimes(1);
  });

  it("does not offer a row's Remove while that row's Make primary is running", async () => {
    const PULL = { ...SOURCE, id: 'src-3', display_name: 'Lake pull', ingest_mode: 'pull', is_primary: false };
    listSourcesMock.mockResolvedValue({ sources: [PULL, SECOND] });
    const { user } = await openDataSources();
    let primaryDone!: () => void;
    upsertSourceMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          primaryDone = () => resolve({ ok: true });
        }),
    );
    await user.click(await screen.findByRole('button', { name: 'Make primary' }));
    const [pullRemove, otherRemove] = screen.getAllByRole('button', { name: 'Remove' });
    // Busy, not disabled: it keeps its place in the tab order.
    expect(pullRemove).toHaveAttribute('aria-disabled', 'true');
    expect(pullRemove).not.toBeDisabled();
    expect(otherRemove).not.toHaveAttribute('aria-disabled');

    await user.click(pullRemove);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteSourceMock).not.toHaveBeenCalled();

    // Once Make primary has finished, Remove opens its confirmation again.
    listSourcesMock.mockResolvedValue({ sources: [{ ...PULL, is_primary: true }, SECOND] });
    await act(async () => primaryDone());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Make primary' })).toBeNull());
    const [ready] = screen.getAllByRole('button', { name: 'Remove' });
    expect(ready).not.toHaveAttribute('aria-disabled');
    await user.click(ready);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(deleteSourceMock).not.toHaveBeenCalled();
  });

  it('shows a failed removal in the confirmation, retries it, and keeps the source on Cancel', async () => {
    listSourcesMock.mockResolvedValue({ sources: [SOURCE, SECOND] });
    const { user } = await openDataSources();
    const [first] = await screen.findAllByRole('button', { name: 'Remove' });
    deleteSourceMock.mockRejectedValueOnce(new Error('The source is in use by a running job.'));
    await user.click(first);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove source' }));

    expect(await within(dialog).findByText('Couldn’t remove the source')).toBeInTheDocument();
    expect(within(dialog).getByText('The source is in use by a running job.')).toBeInTheDocument();
    // The page shows no second copy of the error behind the dialog.
    expect(screen.getAllByText('The source is in use by a running job.')).toHaveLength(1);
    const retry = within(dialog).getByRole('button', { name: 'Remove source' });
    expect(retry).not.toHaveAttribute('aria-disabled');

    // Remove source tries again; a second failure, then Cancel keeps the source.
    deleteSourceMock.mockRejectedValueOnce(new Error('Still in use.'));
    await user.click(retry);
    expect(await within(dialog).findByText('Still in use.')).toBeInTheDocument();
    expect(deleteSourceMock).toHaveBeenCalledTimes(2);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByText('Still in use.')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
    await waitFor(() => expect(document.activeElement).toBe(first));

    // Opening the confirmation again starts clean.
    await user.click(first);
    const again = await screen.findByRole('alertdialog');
    expect(within(again).queryByText('Couldn’t remove the source')).toBeNull();
  });

  it('returns focus to the navigation control when discarding a draft is cancelled', async () => {
    const { user } = await openDataSources();
    await user.click(await screen.findByRole('button', { name: /Add your first source/i }));
    await screen.findByTestId('source-editor-stub');
    const skip = screen.getByRole('button', { name: /Skip for now/i });
    await user.click(skip);
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Discard this source draft?');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(skip));
  });

  it("leaves focus on the next stage's heading when the draft is discarded", async () => {
    const { user } = await openDataSources();
    await user.click(await screen.findByRole('button', { name: /Add your first source/i }));
    await screen.findByTestId('source-editor-stub');
    await user.click(screen.getByRole('button', { name: /Skip for now/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard and continue' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).not.toHaveTextContent(/Connect the systems you already use/);
    // The stage heading keeps focus after the dialog's close hand-off has run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(heading);
  });

  it('returns focus to the checked workspace mode when switching to live is cancelled', async () => {
    demoStatusMock.mockResolvedValue({ mode: 'seeded', active: true });
    const user = userEvent.setup();
    renderWizard();
    const demo = await screen.findByRole('radio', { name: /Synthetic demo/i });
    await waitFor(() => expect(demo).toBeChecked());
    await user.click(screen.getByRole('radio', { name: /Live environment/i }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Switch to a live workspace?');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(demo));
  });
});

describe('Wizard source editor chunk that cannot load', () => {
  it('shows a reload notice instead of throwing', async () => {
    vi.resetModules();
    vi.doMock('@/soc/components/SourceEditor', () => {
      throw new Error('Failed to fetch dynamically imported module: /assets/SourceEditor-x.js');
    });
    listConnectorsMock.mockReset().mockResolvedValue({ connectors: [CONNECTOR] });
    listSourcesMock.mockReset().mockResolvedValue({ sources: [] });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    rolesGetMock
      .mockReset()
      .mockResolvedValue({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} });
    const { default: FreshWizard } = await import('../Wizard');
    const { TooltipProvider: FreshTooltip } = await import('@/ui/tooltip');
    const { AuthProvider: FreshAuth } = await import('../../auth');
    const { DemoProvider: FreshDemo } = await import('../../demo');
    const user = userEvent.setup();
    render(
      <FreshTooltip>
        <FreshAuth>
          <FreshDemo>
            <FreshWizard onComplete={vi.fn()} />
          </FreshDemo>
        </FreshAuth>
      </FreshTooltip>,
    );
    await user.click(await screen.findByRole('button', { name: /Data sources/i }));
    await user.click(await screen.findByRole('button', { name: /Add your first source/i }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('The source editor could not load. Reload the page to try again.');
    expect(within(notice).getByRole('button', { name: 'Reload' })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole('region', { name: 'Source editor' })).toBeInTheDocument());
    vi.doUnmock('@/soc/components/SourceEditor');
  });
});
