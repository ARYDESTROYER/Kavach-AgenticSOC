/**
 * Applies when (Round 14, SPEC §4.10.12): "Add condition" opens a picker per criterion that
 * stays open, with focus inside it, until a value is chosen or the person dismisses it, by
 * mouse and by keyboard (second acceptance pass, wrb-03). The menu that offers the criteria
 * must not hand focus back to its trigger when it closes, or the picker would read that as
 * focus leaving it and close at once.
 *
 * Re-review: a click on another field closes the picker and leaves focus in that field (only
 * Escape, Done or a click where nothing takes focus gives it back to the opener), and Done
 * adds a value still typed in the picker's field, or keeps the picker open with its error.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AppliesWhen } from '@/lib/types-runbooks';
import { TooltipProvider } from '@/ui/tooltip';

import { AppliesWhenEditor, type CriteriaSuggestions } from '../AppliesWhenEditor';
import { makeDefinition } from './fixtures';

const SUGGESTIONS: CriteriaSuggestions = { rules: ['ssh_auth_failed', 'vpn_auth_failed'], techniques: ['T1110'], sources: [] };

function emptyCriteria(): AppliesWhen {
  return { ...makeDefinition().applies_when, rule_ids: [] };
}

/** A controlled editor, as the runbook editor holds it. */
function Harness({ initial, onChange }: { initial: AppliesWhen; onChange?: (next: AppliesWhen) => void }) {
  const [value, setValue] = React.useState(initial);
  return (
    <TooltipProvider>
      <AppliesWhenEditor
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        readOnly={false}
        suggestions={SUGGESTIONS}
      />
    </TooltipProvider>
  );
}

/** Let every deferred focus move (the menu's close hand-back runs on a timer) settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function chooseFromMenu(item: string, how: 'click' | 'enter') {
  const add = screen.getByRole('button', { name: 'Add condition' });
  fireEvent.keyDown(add, { key: 'Enter' });
  const menu = await screen.findByRole('menu');
  const option = within(menu).getByRole('menuitem', { name: item });
  if (how === 'click') fireEvent.click(option);
  else {
    act(() => option.focus());
    fireEvent.keyDown(option, { key: 'Enter' });
  }
  await settle();
}

describe('Add condition', () => {
  it('keeps the rule picker open with focus in it after choosing Rule with the pointer, and adds the value', async () => {
    const onChange = vi.fn();
    render(<Harness initial={emptyCriteria()} onChange={onChange} />);
    await chooseFromMenu('Rule', 'click');
    const input = screen.getByLabelText('Add a rule');
    expect(input).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'ssh_auth_failed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rule_ids: ['ssh_auth_failed'] }));
    expect(screen.getByText('ssh_auth_failed', { selector: '[data-criterion-chip] *' })).toBeInTheDocument();
    // Still open for a second value until the person is done.
    expect(screen.getByLabelText('Add a rule')).toBeInTheDocument();
  });

  it('keeps the picker open after choosing with Enter, for every kind of criterion', async () => {
    render(<Harness initial={emptyCriteria()} />);
    for (const [item, control] of [
      ['Technique', () => screen.getByLabelText('Add an ATT&CK technique')],
      ['Tag', () => screen.getByLabelText('Add a tag')],
      ['Severity', () => screen.getByRole('radiogroup')],
    ] as const) {
      await chooseFromMenu(item, 'enter');
      const picker = control();
      expect(picker).toBeInTheDocument();
      const content = picker.closest('[data-radix-popper-content-wrapper]');
      expect(content).not.toBeNull();
      expect(content?.contains(document.activeElement)).toBe(true);
      if (item === 'Severity') expect(document.activeElement?.getAttribute('role')).toBe('radio');
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Done' })).toBeNull());
      // Done hands focus back to Add condition, ready for the next one.
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' }));
    }
  });

  it('closes the picker when the person presses Escape, and focus returns to Add condition', async () => {
    render(<Harness initial={emptyCriteria()} />);
    await chooseFromMenu('Tag', 'click');
    const input = screen.getByLabelText('Add a tag');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Add a tag')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' }));
  });

  it('still opens an existing chip in place', async () => {
    render(<Harness initial={{ ...emptyCriteria(), entity_types: ['ip'] }} />);
    fireEvent.click(screen.getByRole('button', { name: /Entity/ }));
    await settle();
    expect(screen.getByRole('group', { name: 'The case has an entity of one of these types' })).toBeInTheDocument();
  });

  it('names each picker for its condition (SPEC §3.3)', async () => {
    render(<Harness initial={emptyCriteria()} />);
    for (const [item, name] of [
      ['Rule', 'Rule condition'],
      ['Technique', 'Technique condition'],
      ['Minimum events', 'Minimum events condition'],
      ['Fallback for any case', 'Fallback condition'],
    ] as const) {
      await chooseFromMenu(item, 'click');
      expect(screen.getByRole('dialog', { name })).toBeInTheDocument();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('gives focus back to the chip a picker was opened from, on Escape and on Done', async () => {
    render(<Harness initial={{ ...emptyCriteria(), entity_types: ['ip'], verdicts: ['TRUE_POSITIVE'] }} />);
    const entity = screen.getByRole('button', { name: /^Entity/ });
    act(() => entity.focus());
    fireEvent.click(entity);
    await settle();
    expect(screen.getByRole('dialog', { name: 'Entity condition' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Entity/ }));
    // Opened by the pointer without focusing the chip first (as Safari does), and closed with Done.
    const verdict = screen.getByRole('button', { name: /^Verdict/ });
    fireEvent.click(verdict);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Verdict/ }));
  });

  it('falls back to Add condition when the chip it opened from is gone', async () => {
    render(<Harness initial={{ ...emptyCriteria(), entity_types: ['ip'] }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Entity/ }));
    await settle();
    // Unticking the only type removes the chip the picker came from.
    fireEvent.click(screen.getByRole('checkbox', { name: 'IP address' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' }));
  });

  it('adds the minimum shown when Done is pressed without changing the number', async () => {
    const onChange = vi.fn();
    render(<Harness initial={emptyCriteria()} onChange={onChange} />);
    await chooseFromMenu('Minimum events', 'click');
    expect(screen.getByRole('dialog', { name: 'Minimum events condition' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ min_event_count: 1 }));
    expect(screen.getByText('1 or more', { selector: '[data-criterion-chip="Events"] *' })).toBeInTheDocument();
  });

  it('adds no minimum when the picker is dismissed with Escape', async () => {
    const onChange = vi.fn();
    render(<Harness initial={emptyCriteria()} onChange={onChange} />);
    await chooseFromMenu('Minimum events', 'click');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('No condition yet.')).toBeInTheDocument();
  });
});

/** The editor beside another field of the form, as the runbook header places it. */
function FormHarness({ onChange }: { onChange?: (next: AppliesWhen) => void }) {
  return (
    <>
      <input aria-label="Title" defaultValue="" />
      <p>Plain text outside the picker</p>
      <Harness initial={emptyCriteria()} onChange={onChange} />
    </>
  );
}

/** Let the picker's close (and the focus return Radix runs on a timer after it) finish. */
async function letCloseFinish() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('Leaving a picker by clicking elsewhere (re-review, SPEC §3.3)', () => {
  it.each(['Tag', 'Rule'] as const)(
    'keeps focus in the field the person clicked after choosing %s, so what they type goes there',
    async (item) => {
      const user = userEvent.setup();
      render(<FormHarness />);
      await chooseFromMenu(item, 'click');
      expect(screen.getByRole('dialog', { name: `${item} condition` })).toBeInTheDocument();
      const title = screen.getByRole('textbox', { name: 'Title' });
      await user.click(title);
      await letCloseFinish();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(title);
      // A Space here must not press Add condition and open its menu.
      await user.keyboard(' ab cd');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(title).toHaveValue(' ab cd');
    },
  );

  it('gives focus back to Add condition when the click lands where nothing takes focus', async () => {
    const user = userEvent.setup();
    render(<FormHarness />);
    await chooseFromMenu('Tag', 'click');
    await user.click(screen.getByText('Plain text outside the picker'));
    await letCloseFinish();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' }));
  });

  it('adds nothing typed but not added when the person clicks elsewhere or presses Escape', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FormHarness onChange={onChange} />);
    await chooseFromMenu('Tag', 'click');
    fireEvent.change(screen.getByLabelText('Add a tag'), { target: { value: 'vip' } });
    await user.click(screen.getByRole('textbox', { name: 'Title' }));
    await letCloseFinish();
    await chooseFromMenu('Tag', 'click');
    fireEvent.change(screen.getByLabelText('Add a tag'), { target: { value: 'vip' } });
    fireEvent.keyDown(screen.getByLabelText('Add a tag'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('No condition yet.')).toBeInTheDocument();
  });
});

describe('Done adds a value typed but not yet added (re-review)', () => {
  it('turns a valid typed rule into a chip and closes the picker', async () => {
    const onChange = vi.fn();
    render(<Harness initial={emptyCriteria()} onChange={onChange} />);
    await chooseFromMenu('Rule', 'click');
    fireEvent.change(screen.getByLabelText('Add a rule'), { target: { value: '  qa_rule ' } });
    const done = screen.getByRole('button', { name: 'Done' });
    act(() => done.focus());
    fireEvent.click(done);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rule_ids: ['qa_rule'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('qa_rule', { selector: '[data-criterion-chip="Rule"] *' })).toBeInTheDocument();
    await letCloseFinish();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' }));
  });

  it('does the same for a technique, a source and a tag', async () => {
    const onChange = vi.fn();
    render(<Harness initial={emptyCriteria()} onChange={onChange} />);
    for (const [item, label, typed] of [
      ['Technique', 'Add an ATT&CK technique', 't1110.003'],
      ['Source', 'Add a source', 'type:wazuh'],
      ['Tag', 'Add a tag', 'vip'],
    ] as const) {
      await chooseFromMenu(item, 'click');
      fireEvent.change(screen.getByLabelText(label), { target: { value: typed } });
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mitre: ['T1110.003'], sources: ['type:wazuh'], any_tags: ['vip'] }),
    );
    expect(screen.getByText('T1110.003', { selector: '[data-criterion-chip="Technique"] *' })).toBeInTheDocument();
    expect(screen.getByText('type:wazuh', { selector: '[data-criterion-chip="Source"] *' })).toBeInTheDocument();
    expect(screen.getByText('vip', { selector: '[data-criterion-chip="Tag"] *' })).toBeInTheDocument();
  });

  it('keeps the picker open with the field error and focus on the field when the typed value is refused', async () => {
    const onChange = vi.fn();
    render(<Harness initial={emptyCriteria()} onChange={onChange} />);
    await chooseFromMenu('Technique', 'click');
    const input = screen.getByLabelText('Add an ATT&CK technique');
    fireEvent.change(input, { target: { value: 'X123' } });
    const done = screen.getByRole('button', { name: 'Done' });
    act(() => done.focus());
    fireEvent.click(done);
    await letCloseFinish();
    expect(screen.getByRole('dialog', { name: 'Technique condition' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('X123');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Use a technique id such as T1110 or T1110.003.');
    expect(document.activeElement).toBe(input);
    // Focus carries the message to the field, so it is not spoken a second time as an alert.
    expect(screen.queryByRole('alert')).toBeNull();
    // Fixing the value and pressing Done again adds it.
    fireEvent.change(input, { target: { value: 'T1110' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mitre: ['T1110'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('still announces a refusal from Enter, where focus stays in the field', async () => {
    render(<Harness initial={emptyCriteria()} />);
    await chooseFromMenu('Technique', 'click');
    const input = screen.getByLabelText('Add an ATT&CK technique');
    fireEvent.change(input, { target: { value: 'X123' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Use a technique id such as T1110 or T1110.003.');
    expect(screen.getByRole('dialog', { name: 'Technique condition' })).toBeInTheDocument();
  });

  it('refuses a typed rule that is already listed rather than closing over it', async () => {
    const onChange = vi.fn();
    render(<Harness initial={{ ...emptyCriteria(), rule_ids: ['ssh_auth_failed'] }} onChange={onChange} />);
    await chooseFromMenu('Rule', 'click');
    const input = screen.getByLabelText('Add a rule');
    fireEvent.change(input, { target: { value: 'ssh_auth_failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await letCloseFinish();
    expect(screen.getByRole('dialog', { name: 'Rule condition' })).toBeInTheDocument();
    expect(input).toHaveAccessibleDescription('This rule is already listed.');
    expect(onChange).not.toHaveBeenCalled();
  });
});
