/**
 * RuleLifecycleSheet spec (Round 14, W9b): the per-rule "Test and history" sheet.
 *
 * Proves:
 *  - the sheet is titled with the rule's name and states that it writes configuration
 *    only, in plain sentences (no em dash, no internal references);
 *  - the state control offers Enabled and Disabled only: a rule has one wire flag, so the
 *    sheet never promises a "shadow" state that would in fact switch the rule on;
 *  - turning a live rule off asks first, and the confirmed change goes back to the parent
 *    as a lifecycle state (a config write the parent performs, never a case decision, #3);
 *  - a read-only viewer sees the state control disabled;
 *  - the parent's focus-return handler runs when the sheet closes, and the disable
 *    confirmation hands focus back to the state control's checked option (SPEC §3.3).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

const { versionsSpy, previewSpy } = vi.hoisted(() => ({
  versionsSpy: vi.fn(),
  previewSpy: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    rules: { versions: versionsSpy, rollback: vi.fn(), preview: previewSpy },
  },
}));

import { RuleLifecycleSheet } from '../RuleLifecycleSheet';
import type { RuleForm } from '../../types';
import type { RuleStateChoice } from '../RuleLifecycleSheet';

const RULE: RuleForm = {
  tier: 'detection_match',
  about: { name: 'ssh-bruteforce', description: '', enabled: true, priority: 100 },
  predicates: [{ field: 'rule.id', op: 'equals', value: '5710' }],
  threshold: { groupBy: 'ip', n: 5, windowSeconds: 120, mode: 'threshold' },
};

/**
 * The preview panel is a `React.lazy` chunk. Wait (inside act, through findBy*) until it
 * has rendered, so its Suspense resolution never lands after a test has ended (a busy
 * machine resolves the import late, and React then warns outside act on stderr).
 */
async function previewLoaded(): Promise<void> {
  await screen.findByTestId('rule-preview-idle');
}

async function renderSheet(
  state: RuleStateChoice = 'enabled',
  opts: {
    canManage?: boolean;
    onLifecycleChange?: (next: RuleStateChoice) => void;
    onOpenChange?: (open: boolean) => void;
    onCloseAutoFocus?: (event: Event) => void;
  } = {},
) {
  const onLifecycleChange = opts.onLifecycleChange ?? vi.fn();
  render(
    <TooltipProvider>
      <RuleLifecycleSheet
        open
        onOpenChange={opts.onOpenChange ?? vi.fn()}
        onCloseAutoFocus={opts.onCloseAutoFocus}
        rule={RULE}
        kind="detection"
        ruleId="ssh-bruteforce"
        state={state}
        canManage={opts.canManage ?? true}
        onLifecycleChange={onLifecycleChange}
        onTune={vi.fn()}
      />
    </TooltipProvider>,
  );
  await previewLoaded();
  return { onLifecycleChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  versionsSpy.mockResolvedValue({ kind: 'detection', rule_id: 'ssh-bruteforce', versions: [] });
});

describe('RuleLifecycleSheet', () => {
  it('is titled with the rule name and says it writes configuration only, in plain sentences', async () => {
    await renderSheet();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /ssh-bruteforce/ })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Lifecycle ·/)).toBeNull();
    expect(
      within(dialog).getByText(/Everything here writes configuration only\. It never changes a case decision\./),
    ).toBeInTheDocument();
    expect(dialog.textContent ?? '').not.toMatch(/—|#3/);
  });

  it('offers exactly Enabled and Disabled, the one wire flag, and promises no shadow state', async () => {
    await renderSheet('enabled');
    const dialog = await screen.findByRole('dialog');
    const states = within(dialog).getByRole('radiogroup', { name: 'Rule state' });
    expect(within(states).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      'Enabled',
      'Disabled',
    ]);
    expect(dialog.textContent ?? '').not.toMatch(/creates no cases|shadow/i);
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
  });

  it('says in the state help that disabling reduces coverage, and nothing about a shadow mode', async () => {
    await renderSheet('enabled');
    const dialog = await screen.findByRole('dialog');
    // Short help is a tooltip: it opens on keyboard focus.
    act(() => within(dialog).getByRole('button', { name: 'About rule states' }).focus());
    const tips = await screen.findAllByText('Disabling a live rule reduces coverage; prefer tuning it.');
    expect(tips.length).toBeGreaterThan(0);
    expect(document.body.textContent ?? '').not.toMatch(/creates no cases/i);
  });

  it('asks before turning a live rule off, then reports the new state to the parent', async () => {
    const { onLifecycleChange } = await renderSheet('enabled');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(within(dialog).getByRole('radiogroup', { name: 'Rule state' })).getByRole('radio', { name: 'Disabled' }));
    expect(onLifecycleChange).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent ?? '').not.toContain('—');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Disable rule' }));
    await waitFor(() => expect(onLifecycleChange).toHaveBeenCalledWith('disabled'));
  });

  it('returns focus to the checked state when the disable confirmation is cancelled (SPEC §3.3)', async () => {
    const { onLifecycleChange } = await renderSheet('enabled');
    const dialog = await screen.findByRole('dialog');
    const states = within(dialog).getByRole('radiogroup', { name: 'Rule state' });
    const enabled = within(states).getByRole('radio', { name: 'Enabled' });
    const disabled = within(states).getByRole('radio', { name: 'Disabled' });
    act(() => disabled.focus());
    fireEvent.click(disabled);
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // The sheet stays open and the rule stays on: focus is on its checked option.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(enabled));
    expect(onLifecycleChange).not.toHaveBeenCalled();
  });

  it('puts focus on Disabled once a confirmed disable has been applied', async () => {
    function Host() {
      const [state, setState] = React.useState<RuleStateChoice>('enabled');
      return (
        <TooltipProvider>
          <RuleLifecycleSheet
            open
            onOpenChange={vi.fn()}
            rule={RULE}
            kind="detection"
            ruleId="ssh-bruteforce"
            state={state}
            canManage
            onLifecycleChange={setState}
          />
        </TooltipProvider>
      );
    }
    render(<Host />);
    const dialog = await screen.findByRole('dialog');
    await previewLoaded();
    const states = within(dialog).getByRole('radiogroup', { name: 'Rule state' });
    fireEvent.click(within(states).getByRole('radio', { name: 'Disabled' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disable rule' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(within(states).getByRole('radio', { name: 'Disabled' })),
    );
  });

  it('turns a disabled rule back on without a confirmation', async () => {
    const { onLifecycleChange } = await renderSheet('disabled');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(within(dialog).getByRole('radiogroup', { name: 'Rule state' })).getByRole('radio', { name: 'Enabled' }));
    expect(onLifecycleChange).toHaveBeenCalledWith('enabled');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it("runs the parent's focus-return handler when the sheet closes", async () => {
    const onCloseAutoFocus = vi.fn();
    function Host() {
      const [open, setOpen] = React.useState(true);
      return (
        <TooltipProvider>
          <RuleLifecycleSheet
            open={open}
            onOpenChange={setOpen}
            onCloseAutoFocus={onCloseAutoFocus}
            rule={RULE}
            kind="detection"
            ruleId="ssh-bruteforce"
            state="enabled"
          />
        </TooltipProvider>
      );
    }
    render(<Host />);
    const dialog = await screen.findByRole('dialog');
    await previewLoaded();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalled());
  });

  it('disables the state control for a viewer who cannot manage rules', async () => {
    await renderSheet('enabled', { canManage: false });
    const dialog = await screen.findByRole('dialog');
    const states = within(dialog).getByRole('radiogroup', { name: 'Rule state' });
    within(states)
      .getAllByRole('radio')
      .forEach((radio) => expect(radio).toBeDisabled());
  });
});
