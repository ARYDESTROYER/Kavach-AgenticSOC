/**
 * The case activity timeline in plain words (Round 14, SPEC §4.9.4, ui-audit CM4).
 *
 * A row reads as a sentence: the automation and pipeline `key=value` summaries become one
 * plain sentence, internal actor tokens become names, and the recorded text stays under
 * Details exactly as the audit log holds it. The Human/AI/System switch is the console's
 * in-module view switch, and pipeline actors count as System, never as a person.
 */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CaseActivityFeed, activityActorKind } from '@/soc/components/CaseActivityFeed';
import { AUDIT_ACTOR_TOKENS } from '@/soc/components/audit/events';
import type { CaseActivityItem } from '@/soc/pages/CaseDetail.api';

const APPROVAL =
  'rule=demo-seed-approval action=request_approval proposal=prop-df443f39ce124222a3c8634fcffc25af kind=automation_ack';
const DECISION =
  'verdict=FALSE_POSITIVE status=closed decision_by=agent risk=7.41 cost=0.024474 confidence=0.97 auto_close_gate=cleared';

const ITEMS: CaseActivityItem[] = [
  { id: 'a1', ts: '2026-10-28T10:05:00Z', kind: 'automation', actor: 'automation', summary: APPROVAL },
  { id: 'a2', ts: '2026-10-28T10:04:00Z', kind: 'decision', actor: 'case_manager', summary: DECISION },
  {
    id: 'a3',
    ts: '2026-10-28T10:03:00Z',
    kind: 'verdict',
    actor: 'investigator',
    summary: 'verdict=FALSE_POSITIVE confidence=0.97 reasoning=Benign baseline.',
  },
  {
    id: 'a4',
    ts: '2026-10-28T10:02:00Z',
    kind: 'runbook',
    actor: 'dsingh',
    summary: 'Work started on runbook Phishing triage.',
  },
  {
    id: 'a5',
    ts: '2026-10-28T10:01:00Z',
    kind: 'decision',
    actor: 'runbook_selector',
    summary: 'runbook=web-application-attack v1 persona=web_application reason=matched: Matched rule WEB-EXPLOIT.',
  },
] as CaseActivityItem[];

describe('CaseActivityFeed in plain words', () => {
  it('shows the automation payload as a sentence, with the record under Details', async () => {
    const user = userEvent.setup();
    render(<CaseActivityFeed items={ITEMS} />);

    const sentence = screen.getByText('Automation requested approval (rule demo-seed-approval).');
    const item = sentence.closest('li') as HTMLElement;
    // The recorded payload is not on the row until Details is opened.
    const recorded = within(item).getByTestId('activity-recorded');
    expect(recorded).toHaveTextContent(APPROVAL);
    expect(recorded).not.toBeVisible();
    await user.click(within(item).getByText('Details'));
    expect(recorded).toBeVisible();

    expect(
      screen.getByText('Closed by the AI agent: false positive at 97% confidence, risk 7.41. It met the auto-close bar.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Runbook web-application-attack v1 selected for the web_application persona. Matched rule WEB-EXPLOIT.'),
    ).toBeInTheDocument();
    // A summary that is already a sentence is shown as recorded, with no Details.
    const plainRow = screen.getByText('Work started on runbook Phishing triage.').closest('li') as HTMLElement;
    expect(within(plainRow).queryByText('Details')).not.toBeInTheDocument();
  });

  it('names a case\'s rows from before Round 14 in Console words, and keeps the stored text under Details', async () => {
    const legacy =
      'playbook=brute_force_login v3 persona=identity reason=matched rule_ids∩{auth.failed}; priority=5';
    const lookup = 'Lookup enrich collected evidence (not_applicable).';
    const user = userEvent.setup();
    render(
      <CaseActivityFeed
        items={[
          { id: 'l1', ts: '2026-10-28T10:05:00Z', kind: 'playbook', actor: 'playbook_selector', summary: legacy },
          { id: 'l2', ts: '2026-10-28T10:04:00Z', kind: 'tool_call', actor: 'dsingh', summary: lookup },
        ] as CaseActivityItem[]}
      />,
    );
    const row = screen
      .getByText('Runbook brute_force_login v3 selected for the identity persona. Its match rules matched this case.')
      .closest('li') as HTMLElement;
    expect(within(row).getByText('Runbook (before Round 14)')).toBeInTheDocument();
    expect(within(row).getByText('Runbook selector (before Round 14)')).toBeInTheDocument();
    // Nothing outside Details says the retired noun.
    const details = row.querySelector('details') as HTMLElement;
    const outside = (row.textContent ?? '').replace(details.textContent ?? '', '');
    expect(outside.toLowerCase()).not.toContain('playbook');
    // The stored value is shown unchanged in the record (AU-7).
    await user.click(within(row).getByText('Details'));
    expect(within(row).getByTestId('activity-recorded')).toHaveTextContent(legacy);

    expect(screen.getByText('Enrichment lookup did not apply to this case.')).toBeInTheDocument();
  });

  it('never prints a key=value payload as the row text', () => {
    render(<CaseActivityFeed items={ITEMS} />);
    const rows = screen.getAllByRole('listitem');
    for (const row of rows) {
      const visible = Array.from(row.querySelectorAll('p'))
        .filter((p) => !p.closest('details'))
        .map((p) => p.textContent ?? '')
        .join(' ');
      expect(visible).not.toMatch(/\b(rule|action|verdict|decision_by|proposal|persona|runbook)=/);
      expect(visible).not.toMatch(/\u2014/);
      expect(visible.toLowerCase()).not.toContain('playbook');
    }
  });

  it('names pipeline actors and keeps a person as recorded', () => {
    render(<CaseActivityFeed items={ITEMS} />);
    expect(screen.getByText('Automation', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Case manager')).toBeInTheDocument();
    expect(screen.getByText('Runbook selector')).toBeInTheDocument();
    expect(screen.getByText('Investigator')).toBeInTheDocument();
    expect(screen.getByText('dsingh')).toBeInTheDocument();
    expect(screen.queryByText('case_manager')).not.toBeInTheDocument();
  });

  it('splits actor tokens the way the Audit log does, and never counts a pipeline actor as a person', () => {
    for (const actor of AUDIT_ACTOR_TOKENS.agent) {
      expect(activityActorKind({ actor, kind: 'decision' }), actor).toBe('ai');
    }
    for (const actor of AUDIT_ACTOR_TOKENS.system) {
      expect(activityActorKind({ actor, kind: 'decision' }), actor).toBe('system');
    }
    expect(activityActorKind({ actor: '', kind: 'note' })).toBe('system');
    expect(activityActorKind({ actor: 'dsingh', kind: 'runbook' })).toBe('human');
  });

  it('filters by who acted with the view switch; pipeline actors are never people', async () => {
    const user = userEvent.setup();
    render(<CaseActivityFeed items={ITEMS} />);
    const group = screen.getByRole('radiogroup', { name: 'Show activity by' });
    expect(within(group).getByRole('radio', { name: 'All' })).toBeChecked();

    await user.click(within(group).getByRole('radio', { name: 'Human' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('dsingh')).toBeInTheDocument();

    await user.click(within(group).getByRole('radio', { name: 'System' }));
    const system = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(system).toHaveLength(2);
    expect(system.join(' ')).toContain('Case manager');
    expect(system.join(' ')).toContain('Automation');

    // Keyboard (the radio-group pattern): the arrow keys move focus, Space selects.
    within(group).getByRole('radio', { name: 'System' }).focus();
    await user.keyboard('{ArrowLeft}');
    const ai = within(group).getByRole('radio', { name: 'AI' });
    expect(ai).toHaveFocus();
    await user.keyboard(' ');
    expect(ai).toBeChecked();
    const agent = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(agent).toHaveLength(2);
    expect(agent.join(' ')).toContain('Investigator');
    expect(agent.join(' ')).toContain('Runbook selector');
  });

  it('says so when a filter has nothing to show', async () => {
    const user = userEvent.setup();
    render(<CaseActivityFeed items={ITEMS.filter((item) => item.actor !== 'dsingh')} />);
    await user.click(screen.getByRole('radio', { name: 'Human' }));
    expect(screen.getByText('No activity of this kind yet.')).toBeInTheDocument();
  });

  it('keeps its loading and empty states', () => {
    const { rerender } = render(<CaseActivityFeed items={[]} loading />);
    expect(screen.getByRole('status', { name: 'Loading case activity' })).toBeInTheDocument();
    rerender(<CaseActivityFeed items={[]} />);
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });
});
