/**
 * "Attach a runbook" in the rule editor (Round 14, SPEC §4.10.16): a case-automation rule
 * picks a published runbook by name and keeps the stored `run_playbook` action, writing
 * `payload.runbook_id` and, for compatibility, `payload.playbook_id` with the same id. A rule
 * whose stored target is unknown, a draft only or retired shows "Needs a runbook" (a new rule
 * with nothing chosen yet shows only the field); an older rule that names a retired bundled id
 * resolves through the server's map; a built-in a published copy replaces still attaches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({ listRunbookLibrary: vi.fn() }));
vi.mock('@/lib/api-runbooks', () => ({ listRunbookLibrary: mocks.listRunbookLibrary }));

import { TooltipProvider } from '@/ui/tooltip';
import { RuleEditor } from '../RuleEditor';
import { AUTOMATION_ACTIONS, newRuleForm } from '../constants';
import type { RuleForm } from '../types';
import { makeSummary } from '@/soc/runbooks/editor/__tests__/fixtures';

type AutoForm = Extract<RuleForm, { tier: 'case_automation' }>;

function ruleWith(payload: Record<string, unknown>): AutoForm {
  const form = newRuleForm('case_automation') as AutoForm;
  return { ...form, automation: { ...form.automation, action: 'run_playbook', payload } };
}

async function renderActions(value: AutoForm) {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <RuleEditor value={value} onChange={onChange} />
    </TooltipProvider>,
  );
  await userEvent.click(screen.getByRole('tab', { name: 'Actions' }));
  return { onChange };
}

beforeEach(() => {
  mocks.listRunbookLibrary.mockReset().mockResolvedValue({
    runbooks: [
      makeSummary({ id: 'brute-force-password-spray', title: 'Brute force and password spray', origin: 'builtin', state: 'published', live_version: 1 }),
      makeSummary({ id: 'my-draft', title: 'My draft', state: 'draft', live_version: null, draft_version: 1 }),
    ],
    migration: null,
  });
});

describe('Attach a runbook', () => {
  it('names the action "Attach a runbook" and keeps the stored literal', () => {
    const entry = AUTOMATION_ACTIONS.find((a) => a.value === 'run_playbook');
    expect(entry?.label).toBe('Attach a runbook');
    expect(`${entry?.label} ${entry?.help}`).not.toMatch(/playbook/i);
  });

  it('picks a published runbook and writes runbook_id and playbook_id with the same id', async () => {
    const { onChange } = await renderActions(ruleWith({}));
    const trigger = await screen.findByRole('combobox', { name: /Runbook/ });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    // Nothing chosen yet is not a problem to flag: the placeholder and the description say it.
    expect(screen.queryByText('Needs a runbook')).toBeNull();
    expect(screen.getByText('Only published runbooks are listed.')).toBeInTheDocument();
    expect(mocks.listRunbookLibrary).toHaveBeenCalledWith({ show_replaced: true });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByText('My draft')).toBeNull();
    fireEvent.click(within(listbox).getByRole('option', { name: 'Brute force and password spray' }));
    const next = onChange.mock.calls.at(-1)?.[0] as AutoForm;
    expect(next.automation.action).toBe('run_playbook');
    expect(next.automation.payload).toEqual({ runbook_id: 'brute-force-password-spray', playbook_id: 'brute-force-password-spray' });
  });

  it('resolves a retired bundled id through the server map', async () => {
    await renderActions(ruleWith({ playbook_id: 'brute_force_login' }));
    expect(await screen.findByText('Found from the earlier id brute_force_login. It keeps working; pick the runbook again to record its id.')).toBeInTheDocument();
    expect(screen.queryByText('Needs a runbook')).toBeNull();
  });

  it("resolves a retired procedure id through the server's migration map from the library read", async () => {
    mocks.listRunbookLibrary.mockResolvedValue({
      runbooks: [
        makeSummary({ id: 'brute-force-password-spray', title: 'Brute force and password spray', origin: 'builtin', state: 'published', live_version: 1 }),
        makeSummary({ id: 'old-proc', title: 'Old procedure', origin: 'imported', state: 'published', live_version: 1 }),
        makeSummary({ id: 'bf-imported', title: 'Imported draft', origin: 'imported', state: 'draft', live_version: null, draft_version: 1 }),
      ],
      migration: null,
      migrated_procedures: { old_proc: 'old-proc', brute_force_login: 'bf-imported' },
    });
    await renderActions(ruleWith({ playbook_id: 'old_proc' }));
    expect(await screen.findByText('Found from the earlier id old_proc. It keeps working; pick the runbook again to record its id.')).toBeInTheDocument();
    expect(screen.queryByText('Needs a runbook')).toBeNull();
  });

  it("needs a runbook when the server's map sends a retired id to a draft (the built-in is not used)", async () => {
    mocks.listRunbookLibrary.mockResolvedValue({
      runbooks: [
        makeSummary({ id: 'brute-force-password-spray', title: 'Brute force and password spray', origin: 'builtin', state: 'published', live_version: 1 }),
        makeSummary({ id: 'bf-imported', title: 'Imported draft', origin: 'imported', state: 'draft', live_version: null, draft_version: 1 }),
      ],
      migration: null,
      migrated_procedures: { brute_force_login: 'bf-imported' },
    });
    await renderActions(ruleWith({ playbook_id: 'brute_force_login' }));
    expect(await screen.findByText('Needs a runbook')).toBeInTheDocument();
  });

  it('says a rule needs a runbook when its target is a draft only', async () => {
    await renderActions(ruleWith({ runbook_id: 'my-draft', playbook_id: 'my-draft' }));
    expect(await screen.findByText('Needs a runbook')).toBeInTheDocument();
    expect(screen.getByText(/The runbook this rule names \(my-draft\) is not published/)).toBeInTheDocument();
  });

  it('still attaches a built-in that a published copy replaces, and says the copy replaces it', async () => {
    mocks.listRunbookLibrary.mockResolvedValue({
      runbooks: [
        makeSummary({
          id: 'brute-force-password-spray',
          title: 'Brute force and password spray',
          origin: 'builtin',
          state: 'published',
          live_version: 1,
          replaced_by: 'brute-force-ours',
        }),
        makeSummary({ id: 'brute-force-ours', title: 'Our brute force runbook', state: 'published', live_version: 1, draft_version: null }),
      ],
      migration: null,
    });
    await renderActions(ruleWith({ runbook_id: 'brute-force-password-spray', playbook_id: 'brute-force-password-spray' }));
    expect(await screen.findByText(/Your team's copy, Our brute force runbook, replaces this built-in for matching/)).toBeInTheDocument();
    expect(screen.queryByText('Needs a runbook')).toBeNull();
    const trigger = screen.getByRole('combobox', { name: /Runbook/ });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'Brute force and password spray' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Our brute force runbook' })).toBeInTheDocument();
  });

  it('lists a replaced built-in only for the rule that already names it', async () => {
    mocks.listRunbookLibrary.mockResolvedValue({
      runbooks: [
        makeSummary({ id: 'brute-force-password-spray', title: 'Brute force and password spray', origin: 'builtin', state: 'published', live_version: 1, replaced_by: 'brute-force-ours' }),
        makeSummary({ id: 'brute-force-ours', title: 'Our brute force runbook', state: 'published', live_version: 1, draft_version: null }),
      ],
      migration: null,
    });
    await renderActions(ruleWith({}));
    const trigger = await screen.findByRole('combobox', { name: /Runbook/ });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByRole('option', { name: 'Brute force and password spray' })).toBeNull();
    expect(within(listbox).getByRole('option', { name: 'Our brute force runbook' })).toBeInTheDocument();
  });

  it('falls back to typing the id when the runbooks cannot be listed', async () => {
    mocks.listRunbookLibrary.mockRejectedValue(new Error('forbidden'));
    const { onChange } = await renderActions(ruleWith({}));
    const input = await screen.findByLabelText(/Runbook id/);
    fireEvent.change(input, { target: { value: 'phishing-triage' } });
    const next = onChange.mock.calls.at(-1)?.[0] as AutoForm;
    expect(next.automation.payload).toEqual({ runbook_id: 'phishing-triage', playbook_id: 'phishing-triage' });
  });

  it('carries no em dash and never the retired word in the actions copy', async () => {
    await renderActions(ruleWith({ runbook_id: 'brute-force-password-spray' }));
    await screen.findByText('Never closes a case');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/playbook/i);
  });
});
