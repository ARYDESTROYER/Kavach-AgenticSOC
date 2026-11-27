/**
 * DetectionRulesHome + registration spec (Round-5 G6, R2; Round 14 W9b).
 *
 * Proves:
 *  - the home lists BOTH rule families (detection catalog + case-automation) plainly, in
 *    one compact table on a group panel, with no explanation box above it (Round 14 DR1,
 *    F11: the section's help tip carries that sentence);
 *  - a row opens its editor on click; Test and history and Delete live in the row menu,
 *    neutral at rest (DR2); closing either sheet or the delete confirmation returns focus
 *    to what opened it, and the rule name carries the panel focus ring (SPEC §3.3);
 *  - a rule is Enabled or Disabled, its one wire flag: no "shadow" state is offered;
 *  - a config edit (delete) flows through the deep-merge `update` buffer, writing the
 *    exact wire key, never a `decide()` call;
 *  - a case-automation rule that attaches a runbook the server would skip shows "Needs a
 *    runbook" (the same resolution the rule editor and the server use);
 *  - the "Detection & rules" section is REGISTERED in the settings registry under the
 *    General group, ON BY DEFAULT, gated on the unified `rules` resource (M2 / R9), the
 *    SAME resource the backend `routes_rules.py` enforces, end-to-end.
 *
 * `useCan` is mocked to grant manage (auth-off back-compat) so the table and actions
 * render; one test turns it off for the read-only viewer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

const grants = vi.hoisted(() => ({ all: true }));
const runbooks = vi.hoisted(() => ({ list: vi.fn() }));

// Grant manage so mutations render (mirrors the auth-off default where useCan===true).
vi.mock('@/soc/components/Can', async () => {
  const actual = await vi.importActual<typeof import('@/soc/components/Can')>('@/soc/components/Can');
  return { ...actual, useCan: () => grants.all };
});

vi.mock('@/lib/api-runbooks', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-runbooks')>('@/lib/api-runbooks');
  return { ...actual, listRunbookLibrary: (...args: unknown[]) => runbooks.list(...args) };
});

import { DetectionRulesHome, automationIdFromName } from '../DetectionRulesHome';
import { MOBILE_QUERY } from '@/soc/hooks/useMediaQuery';
import { RULES_PERM, RULES_READ_PERM } from '../types';
import type { AutomationRule, Preferences } from '@/lib/types';
import type { RunbookSummary } from '@/lib/types-runbooks';

import {
  SECTION_BY_ID,
  SECTION_GROUPS,
  SECTION_KEYS,
  isSectionId,
} from '@/soc/pages/settings/settings-sections';

const PREFS: Preferences = {
  rule_catalog: [
    {
      name: 'ssh-bruteforce',
      enabled: true,
      description: 'many failed logins',
      match: { field: 'rule.id', op: 'equals', value: '5710' },
      correlation: { mode: 'threshold', n: 5, window_seconds: 120, group_by: 'ip' },
      priority: 100,
    },
  ],
  threshold_automation: {
    enabled: true,
    rules: [{ id: 'rule-tag', enabled: true, priority: 50, conditions: {}, action: 'tag', payload: { tags: ['x'] } }],
  },
};

beforeEach(() => {
  grants.all = true;
  runbooks.list.mockReset();
  runbooks.list.mockResolvedValue({ runbooks: [], migration: null });
});

/** A library row for the runbook resolver (only the fields it reads matter). */
function summary(over: Partial<RunbookSummary> & { id: string }): RunbookSummary {
  return {
    title: over.id,
    summary: '',
    origin: 'built_in',
    state: 'published',
    live_version: 1,
    draft_version: null,
    in_review_version: null,
    retired: false,
    replaces: null,
    replaced_by: null,
    derived_from: null,
    owner: null,
    phases: [],
    step_count: 1,
    applies_to: {},
    runs_30d: null,
    review_due_at: null,
    last_reviewed_at: null,
    last_reviewed_by: null,
    updated_at: null,
    updated_by: null,
    migrated_from: null,
    ...over,
  } as RunbookSummary;
}

/** Open a row's "More actions" menu and choose an item (Radix opens on ArrowDown). */
function chooseRowAction(subject: string, item: string, index = 0) {
  const triggers = screen.getAllByRole('button', { name: `More actions for ${subject}` });
  fireEvent.keyDown(triggers[index], { key: 'ArrowDown' });
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: item }));
}

function renderWithContainer(prefs: Preferences = PREFS) {
  const update = vi.fn();
  const view = render(
    <TooltipProvider>
      <DetectionRulesHome prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  return { update, container: view.container };
}

function renderHome(prefs: Preferences = PREFS) {
  const update = vi.fn();
  render(
    <TooltipProvider>
      <DetectionRulesHome prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  return { update };
}

describe('DetectionRulesHome', () => {
  it('lists both rule families in one table (plain text), with no explanation box above it', () => {
    const { container } = renderWithContainer();
    expect(screen.getByRole('button', { name: 'ssh-bruteforce' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'rule-tag' })).toBeInTheDocument();
    // Round 14 (DR1, F11): the policy sentence lives in the section help tip, not in a
    // permanent box, and no internal reference such as "(#3)" reaches the operator.
    expect(screen.queryByText(/never the verdict/i)).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/#3|\u2014/);
    expect(screen.getByRole('heading', { name: 'Rules', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('2 rules, lower priority numbers run first')).toBeInTheDocument();
  });

  it('sits on one group panel with sentence-case headers', () => {
    const { container } = renderWithContainer();
    const table = screen.getByRole('table', { name: 'Detection and case automation rules' });
    expect(container.querySelector('[data-settings-panel]')?.contains(table)).toBe(true);
    expect(table).toHaveClass('table-fixed');
    for (const name of ['Name', 'Type', 'State', 'Priority']) {
      const header = screen.getByRole('columnheader', { name });
      expect(header.className).not.toMatch(/uppercase|tracking/);
    }
    expect(screen.getByRole('button', { name: 'ssh-bruteforce' })).toHaveClass('truncate');
    expect(screen.getAllByText('Match and threshold')).toHaveLength(1);
    expect(screen.getAllByText('Case automation')).toHaveLength(1);
  });

  it('on a phone keeps only the name, with its state under it, and the row menu', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === MOBILE_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      renderHome();
      const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
      expect(headers).toEqual(['Name', 'Actions']);
      const row = screen.getByRole('button', { name: 'ssh-bruteforce' }).closest('tr') as HTMLElement;
      expect(within(row).getByText('Enabled')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'More actions for ssh-bruteforce' })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('shows each rule state as a quiet word, never a green badge on every row', () => {
    renderHome();
    const enabled = screen.getAllByText('Enabled');
    expect(enabled).toHaveLength(2);
    enabled.forEach((node) => {
      expect(node.closest('[data-status-tone]')).toHaveAttribute('data-status-tone', 'neutral');
    });
  });

  it('keeps row actions neutral at rest and puts Test and history and Delete in the row menu', () => {
    renderHome();
    // No red trash icon on every row (DR2).
    expect(screen.queryByRole('button', { name: /^delete/i })).toBeNull();
    const more = screen.getAllByRole('button', { name: 'More actions for ssh-bruteforce' })[0];
    expect(more.className).not.toMatch(/text-critical/);
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Test and history', 'Delete rule']);
  });

  it('opens the editor when the row itself is clicked, not only its name', () => {
    renderHome();
    const row = screen.getByRole('button', { name: 'rule-tag' }).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('cell')[2]);
    expect(screen.getByRole('tab', { name: 'Define' })).toBeInTheDocument();
  });

  it('deleting a detection rule writes rule_catalog via the deep-merge buffer (never decide())', () => {
    const { update } = renderHome();
    // Delete is confirm-gated (no single-misclick data loss): click through the dialog.
    chooseRowAction('ssh-bruteforce', 'Delete rule');
    expect(update).not.toHaveBeenCalled(); // nothing written until confirmed
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent ?? '').not.toContain('\u2014');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete rule' }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as Partial<Preferences>;
    expect(patch).toHaveProperty('rule_catalog');
    expect(patch.rule_catalog).toEqual([]);
    // it does NOT touch the automation block on a detection delete
    expect(patch).not.toHaveProperty('threshold_automation');
  });

  it('deleting a case-automation rule writes threshold_automation.rules only', () => {
    const { update } = renderHome();
    chooseRowAction('rule-tag', 'Delete rule');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete rule' }));
    const patch = update.mock.calls[0][0] as Partial<Preferences>;
    expect(patch.threshold_automation?.rules).toEqual([]);
    // the master `enabled` flag is preserved (deep-merge friendly)
    expect(patch.threshold_automation?.enabled).toBe(true);
  });

  it('opens the editor sheet when a rule name is clicked', () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'ssh-bruteforce' }));
    expect(screen.getByRole('tab', { name: 'Define' })).toBeInTheDocument();
    expect(screen.getByText(/Saving writes configuration only\. It never changes a case decision\./)).toBeInTheDocument();
  });

  it('surfaces a validation message (not a silent no-op) when a new detection rule has no name/condition', () => {
    const { update } = renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    // A fresh detection_match rule has an empty name + empty first condition → invalid.
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Can't save yet/i);
    expect(screen.getByText(/at least one condition/i)).toBeInTheDocument();
  });

  it('cancelling the delete confirmation does not write anything', () => {
    const { update } = renderHome();
    chooseRowAction('ssh-bruteforce', 'Delete rule');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(update).not.toHaveBeenCalled();
  });

  it('deletes exactly the clicked row when two detection rules share a name (#24)', () => {
    const dupPrefs: Preferences = {
      rule_catalog: [
        {
          name: 'dup',
          enabled: true,
          description: 'first',
          match: { field: 'a', op: 'equals', value: '1' },
          correlation: { mode: 'threshold', n: 5, window_seconds: 120, group_by: 'ip' },
          priority: 100,
        },
        {
          name: 'dup',
          enabled: true,
          description: 'second',
          match: { field: 'b', op: 'equals', value: '2' },
          correlation: { mode: 'threshold', n: 5, window_seconds: 120, group_by: 'ip' },
          priority: 110,
        },
      ],
    };
    const { update } = renderHome(dupPrefs);
    // Both rows carry the same "More actions for dup" menu: a name filter would wipe BOTH.
    expect(screen.getAllByRole('button', { name: 'More actions for dup' })).toHaveLength(2);
    chooseRowAction('dup', 'Delete rule', 0); // the priority-100 row (sourceIndex 0, "first")
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete rule' }));
    const patch = update.mock.calls[0][0] as Partial<Preferences>;
    // Exactly ONE rule removed (the one clicked), leaving the other same-named rule.
    expect(patch.rule_catalog).toHaveLength(1);
    expect(patch.rule_catalog?.[0].description).toBe('second');
  });

  it('gives a read-only viewer the catalog and the history, but no New rule and no Delete', () => {
    grants.all = false;
    renderHome();
    expect(screen.getByRole('button', { name: 'ssh-bruteforce' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New rule' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for ssh-bruteforce' }), { key: 'ArrowDown' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Test and history']);
  });

  it('gives the rule name, the row keyboard control, the design-system focus ring on the panel', () => {
    renderHome();
    const name = screen.getByRole('button', { name: 'ssh-bruteforce' });
    expect(name.className).toContain('focus-visible:ring-2');
    expect(name.className).toContain('focus-visible:ring-ring');
    expect(name.className).toContain('focus-visible:ring-offset-panel');
    expect(name.className).toContain('focus-visible:outline-none');
  });

  it('returns focus to the rule name when the editor closes with Escape (SPEC §3.3)', async () => {
    renderHome();
    const name = screen.getByRole('button', { name: 'ssh-bruteforce' });
    name.focus();
    fireEvent.click(name);
    const sheet = await screen.findByRole('dialog');
    // Escape closes the topmost layer: a tooltip opened by focus inside the sheet first.
    while (screen.queryByRole('dialog')) {
      fireEvent.keyDown(document.activeElement ?? sheet, { key: 'Escape' });
      await act(async () => {});
    }
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  it('returns focus to the rule name after Cancel in the editor', async () => {
    renderHome();
    const name = screen.getByRole('button', { name: 'rule-tag' });
    fireEvent.click(name);
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  it('returns focus to the row menu button when Test and history closes', async () => {
    renderHome();
    const trigger = screen.getByRole('button', { name: 'More actions for ssh-bruteforce' });
    trigger.focus();
    chooseRowAction('ssh-bruteforce', 'Test and history');
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: /ssh-bruteforce/ })).toBeInTheDocument();
    // The preview panel is a lazy chunk: let it load inside act before closing.
    await within(sheet).findByTestId('rule-preview-idle');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('offers only Enabled and Disabled in Test and history, and keeps the table words to match', async () => {
    const { update } = renderHome();
    chooseRowAction('ssh-bruteforce', 'Test and history');
    const sheet = await screen.findByRole('dialog');
    await within(sheet).findByTestId('rule-preview-idle');
    const states = within(sheet).getByRole('radiogroup', { name: 'Rule state' });
    expect(within(states).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Enabled', 'Disabled']);
    expect(document.body.textContent ?? '').not.toMatch(/shadow/i);
    fireEvent.click(within(states).getByRole('radio', { name: 'Disabled' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disable rule' }));
    const patch = update.mock.calls[0][0] as Partial<Preferences>;
    expect(patch.rule_catalog?.[0].enabled).toBe(false);
  });

  it('returns focus to the row menu button when the delete confirmation is cancelled', async () => {
    renderHome();
    const trigger = screen.getByRole('button', { name: 'More actions for rule-tag' });
    trigger.focus();
    chooseRowAction('rule-tag', 'Delete rule');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('shows an empty state on the panel when there are no rules', () => {
    renderHome({});
    expect(screen.getByText('No rules yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'New rule' }).length).toBeGreaterThan(0);
  });
});

describe('DetectionRulesHome "Needs a runbook"', () => {
  const attach = (id: string, payload: Record<string, unknown>): AutomationRule => ({
    id,
    enabled: true,
    priority: 10,
    conditions: {},
    action: 'run_playbook',
    payload,
  });
  const prefsWith = (...rules: AutomationRule[]): Preferences => ({
    threshold_automation: { enabled: true, rules },
  });

  it('flags a rule whose runbook is not published, and not one whose runbook is', async () => {
    runbooks.list.mockResolvedValue({
      runbooks: [
        summary({ id: 'brute-force-password-spray' }),
        summary({ id: 'draft-only', live_version: null, draft_version: 1, state: 'draft' }),
      ],
      migration: null,
    });
    renderHome(
      prefsWith(
        attach('attach-published', { runbook_id: 'brute-force-password-spray' }),
        attach('attach-draft', { runbook_id: 'draft-only' }),
        attach('attach-missing', { runbook_id: 'gone' }),
      ),
    );
    await waitFor(() => expect(screen.getAllByText('Needs a runbook')).toHaveLength(2));
    expect(runbooks.list).toHaveBeenCalledWith({ show_replaced: true }, expect.any(AbortSignal));
    const rowOf = (name: string) => screen.getByRole('button', { name }).closest('tr') as HTMLElement;
    expect(within(rowOf('attach-published')).queryByText('Needs a runbook')).toBeNull();
    expect(within(rowOf('attach-draft')).getByText('Needs a runbook')).toBeInTheDocument();
    expect(within(rowOf('attach-missing')).getByText('Needs a runbook')).toBeInTheDocument();
    expect(screen.getByText(/2 need a runbook/)).toBeInTheDocument();
  });

  it('resolves a legacy procedure id the way the server does (a retired bundled id attaches its runbook)', async () => {
    runbooks.list.mockResolvedValue({ runbooks: [summary({ id: 'brute-force-password-spray' })], migration: null });
    renderHome(prefsWith(attach('legacy', { playbook_id: 'brute_force_login' })));
    await waitFor(() => expect(runbooks.list).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByText('Needs a runbook')).toBeNull();
  });

  it("prefers the server's migration map from the library read over the rows", async () => {
    runbooks.list.mockResolvedValue({
      runbooks: [summary({ id: 'brute-force-password-spray' }), summary({ id: 'old-proc' })],
      migration: null,
      migrated_procedures: { old_proc: 'old-proc', brute_force_login: 'gone-runbook' },
    });
    renderHome(
      prefsWith(attach('migrated', { playbook_id: 'old_proc' }), attach('mapped-away', { playbook_id: 'brute_force_login' })),
    );
    const rowOf = (name: string) => screen.getByRole('button', { name }).closest('tr') as HTMLElement;
    // The map sends brute_force_login to a runbook the library does not list, so the server
    // skips the rule even though the built-in exists; old_proc attaches through the map.
    await waitFor(() => expect(within(rowOf('mapped-away')).getByText('Needs a runbook')).toBeInTheDocument());
    expect(within(rowOf('migrated')).queryByText('Needs a runbook')).toBeNull();
  });

  it('flags only a rule that names no runbook when the library cannot be read (no false warning)', async () => {
    runbooks.list.mockRejectedValue(new Error('403'));
    renderHome(prefsWith(attach('named', { runbook_id: 'maybe-published' }), attach('blank', {})));
    await waitFor(() => expect(runbooks.list).toHaveBeenCalled());
    const rowOf = (name: string) => screen.getByRole('button', { name }).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(rowOf('blank')).getByText('Needs a runbook')).toBeInTheDocument());
    expect(within(rowOf('named')).queryByText('Needs a runbook')).toBeNull();
  });

  it('never reads the runbook library when no rule attaches a runbook', () => {
    renderHome();
    expect(runbooks.list).not.toHaveBeenCalled();
  });
});

describe('automationIdFromName (#25: the typed Name becomes the rule id)', () => {
  const rule = (id: string): AutomationRule => ({
    id,
    enabled: true,
    priority: 100,
    conditions: {},
    action: 'tag',
    payload: {},
  });

  it('uses the trimmed typed name as the id', () => {
    expect(automationIdFromName('  tag-true-positives  ', [])).toBe('tag-true-positives');
  });

  it('auto-generates an id when the name is blank', () => {
    expect(automationIdFromName('', [])).toMatch(/^rule-/);
    expect(automationIdFromName('   ', [])).toMatch(/^rule-/);
  });

  it('suffixes on a collision with an existing id (never overwrites another rule)', () => {
    expect(automationIdFromName('dup', [rule('dup')])).toBe('dup (2)');
    expect(automationIdFromName('dup', [rule('dup'), rule('dup (2)')])).toBe('dup (3)');
  });
});

describe('Detection & rules section registration', () => {
  it('is registered as `detection_rules`, ON BY DEFAULT, in the General group', () => {
    expect(isSectionId('detection_rules')).toBe(true);
    const def = SECTION_BY_ID.detection_rules;
    expect(def).toBeDefined();
    expect(def.group).toBe('general');
    expect(typeof def.Component).toBe('function');
    expect(def.title).toBe('Detection & rules');

    const general = SECTION_GROUPS.find((g) => g.id === 'general')!;
    expect(general.sections.map((s) => s.id)).toContain('detection_rules');
  });

  it('gates the section + mutations on the UNIFIED `rules` resource, matching the backend (M2 / R9)', () => {
    const def = SECTION_BY_ID.detection_rules;
    // M2 fix: the backend `routes_rules.py` enforces `rules:read`/`rules:manage` on the
    // WHOLE surface (nav → ledger → rollback → preview). The FE MUST gate on the SAME
    // resource end-to-end — NOT the legacy `automation` resource — so a custom role
    // granted the advertised unified `rules:*` can actually see/use the editor (and a
    // role without it is honestly blocked instead of seeing 403-ing buttons). For every
    // built-in role `rules`/`automation`/`settings` derive identically, so this is
    // behaviour-preserving for them and correct for custom roles.
    expect(def.perm).toEqual({ resource: 'rules', action: 'read' });
    expect(RULES_PERM).toEqual({ resource: 'rules', action: 'manage' });
    expect(RULES_READ_PERM).toEqual({ resource: 'rules', action: 'read' });
    // The section-visibility gate and the mutation gate agree on the resource (one
    // surface, one resource) — the exact drift M2 fixes.
    expect(def.perm?.resource).toBe(RULES_PERM.resource);
    expect(def.perm?.resource).toBe(RULES_READ_PERM.resource);
  });

  it('owns the rule_catalog + threshold_automation keys (dirty-map)', () => {
    expect(SECTION_KEYS.detection_rules).toEqual(['rule_catalog', 'threshold_automation']);
  });
});
