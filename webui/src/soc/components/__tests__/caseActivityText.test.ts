/**
 * Plain words for case activity rows (Round 14, SPEC §4.9.4, ui-audit CM4 and X11).
 *
 * Each shape below is the exact text a backend writer records (the f-strings in
 * `threshold_automation.py`, `pipeline.py`, `investigator.py`, `router.py`,
 * `formatter.py` and the feedback route). The timeline shows a sentence and keeps the
 * recorded text for Details; anything unknown is shown unchanged.
 */
import { describe, expect, it } from 'vitest';

import { activityActorLabel, activityKindLabel, activityText, notifyDelivery } from '../caseActivityText';

const row = (summary: string, kind = 'decision', actor = 'case_manager') => ({ summary, kind, actor });

describe('activityText', () => {
  it('turns the automation approval payload into a sentence and keeps the record', () => {
    const summary =
      'rule=demo-seed-approval action=request_approval proposal=prop-df443f39ce124222a3c8634fcffc25af kind=automation_ack';
    const out = activityText(row(summary, 'automation', 'automation'));
    expect(out.text).toBe('Automation requested approval (rule demo-seed-approval).');
    expect(out.recorded).toBe(summary);
    expect(out.text).not.toMatch(/=|prop-/);
  });

  it.each([
    ['rule=r1 action=request_approval proposal=none', 'Automation could not request approval (rule r1).'],
    ['rule=r1 action=tag tag=phishing, vip', 'Automation tagged the case: phishing, vip (rule r1).'],
    ['rule=r1 action=tag tag=(empty)', 'Automation had no tags to add (rule r1).'],
    [
      'rule=r1 action=tag tag=a, b. Not added: "b", the case already has 50 tags.',
      'Automation tagged the case: a, b (rule r1). Not added: "b", the case already has 50 tags.',
    ],
    ['rule=r1 action=recommend recommend=Reset the password', 'Automation recommended: Reset the password (rule r1).'],
    ['rule=r1 action=recommend recommend=', 'Automation made a recommendation (rule r1).'],
    ['rule=r1 action=notify notify=automation', 'Automation sent a notification (rule r1).'],
    [
      'rule=r1 action=run_playbook attach_runbook=phishing attached=True',
      'Automation attached the runbook phishing (rule r1).',
    ],
    [
      'rule=r1 action=run_playbook attach_runbook=phishing attached=False',
      'Automation did not attach the runbook phishing (rule r1).',
    ],
    [
      'rule=r1 action=run_playbook attach_runbook=(none) attached=False',
      'Automation found no runbook to attach (rule r1).',
    ],
    ['rule=r1 action=escalate_now unknown_action=escalate_now', 'Automation ran the action escalate now (rule r1).'],
  ])('automation %s', (summary, text) => {
    const out = activityText(row(summary, 'automation', 'automation'));
    expect(out.text).toBe(text);
    expect(out.recorded).toBe(summary);
  });

  // The notify detail says whether the notification went out (`_maybe_notify` in
  // `threshold_automation.py`): no note when every channel took it, else "Not sent" or
  // "Partly sent" with the reason. Each reason below is one the backend writes, verbatim;
  // an empty result from the notification service ("no channel was due") and a dispatch
  // that failed as a whole are "Not sent" or "Partly sent" records, never note-less ones.
  describe('a notify action says whether the notification went out', () => {
    it('reads a notification that went out', () => {
      const summary = 'rule=r1 action=notify notify=automation';
      expect(activityText(row(summary, 'automation', 'automation'))).toEqual({
        text: 'Automation sent a notification (rule r1).',
        recorded: summary,
      });
      expect(notifyDelivery('notify=automation')).toEqual({ delivery: 'sent', reason: '' });
    });

    it.each([
      'no notification service is connected',
      'the notification service failed (SMTPException)',
      '1 of 1 channel failed',
      '2 of 3 channels were rate limited',
      '1 of 2 channels failed and 1 was rate limited',
      // The service sent nothing and nothing failed: notifications are off (the default),
      // no channel takes the trigger, the in-app copy is due for no one, or the send
      // repeats one inside the dedup window.
      'no channel was due (notifications are off, no channel takes this trigger, no one is addressed, or it repeated inside the dedup window)',
      // The service failed as a whole before any channel took it (its own result, `type`
      // "dispatch"); only the exception's type is recorded.
      'the notification service failed (RuntimeError)',
    ])('reads a notification that was not sent: %s', (reason) => {
      const summary = `rule=r1 action=notify notify=automation. Not sent: ${reason}.`;
      const out = activityText(row(summary, 'automation', 'automation'));
      expect(out.text).toBe(`Automation did not send a notification (rule r1). Not sent: ${reason}.`);
      expect(out.recorded).toBe(summary);
      expect(out.text).not.toMatch(/sent a notification/);
      expect(notifyDelivery(`notify=automation. Not sent: ${reason}.`)).toEqual({ delivery: 'not_sent', reason });
    });

    it.each([
      '1 of 2 channels failed',
      '1 of 3 channels was rate limited',
      '1 of 3 channels failed and 1 was rate limited',
      // The service failed as a whole after a channel took the notification.
      'the notification service failed (KeyError)',
    ])(
      'reads a notification that went to some channels: %s',
      (reason) => {
        const summary = `rule=r1 action=notify notify=case_closed. Partly sent: ${reason}.`;
        const out = activityText(row(summary, 'automation', 'automation'));
        expect(out.text).toBe(`Automation sent the notification to some channels (rule r1). Partly sent: ${reason}.`);
        expect(out.recorded).toBe(summary);
        expect(notifyDelivery(`notify=case_closed. Partly sent: ${reason}.`)).toEqual({
          delivery: 'partly_sent',
          reason,
        });
      },
    );

    it('reads the Demo record, which connects no notification service', () => {
      // Every Demo notify action carries this note (no notifier is wired on purpose).
      const out = activityText(
        row('rule=demo-notify action=notify notify=automation. Not sent: no notification service is connected.', 'automation', 'automation'),
      );
      expect(out.text).toBe(
        'Automation did not send a notification (rule demo-notify). Not sent: no notification service is connected.',
      );
    });

    it('keeps a trigger with dots and words a note with no reason', () => {
      expect(notifyDelivery('notify=team.soc. Not sent: 1 of 1 channel failed.')).toEqual({
        delivery: 'not_sent',
        reason: '1 of 1 channel failed',
      });
      expect(activityText(row('rule=r1 action=notify notify=automation. Not sent: .', 'automation', 'automation')).text).toBe(
        'Automation did not send a notification (rule r1).',
      );
      // A trigger that only contains the words, with no note after it, is a send.
      expect(notifyDelivery('notify=Not sent')).toEqual({ delivery: 'sent', reason: '' });
      expect(notifyDelivery(undefined)).toEqual({ delivery: 'sent', reason: '' });
    });
  });

  it('names a drafted proposal by what approving it does', () => {
    expect(
      activityText(row('automation drafted automation_ack proposal prop-9ac06f (rule=demo-seed-approval)', 'proposal', 'automation'))
        .text,
    ).toBe('Automation drafted a review proposal for approval (rule demo-seed-approval).');
    expect(activityText(row('automation drafted suppression proposal prop-1 (rule=r2)', 'proposal')).text).toBe(
      'Automation drafted a suppression proposal for approval (rule r2).',
    );
  });

  it('reads the deterministic decision row: who closed it, the verdict, the confidence, the risk and the gate', () => {
    expect(
      activityText(
        row(
          'verdict=FALSE_POSITIVE status=closed decision_by=agent risk=7.41 cost=0.024474 confidence=0.97 auto_close_gate=cleared',
        ),
      ).text,
    ).toBe('Closed by the AI agent: false positive at 97% confidence, risk 7.41. It met the auto-close bar.');
    expect(
      activityText(
        row(
          'verdict=TRUE_POSITIVE status=escalated decision_by=system risk=62.0 cost=0.026907 confidence=0.9 auto_close_gate=class_disabled',
        ),
      ).text,
    ).toBe('Escalated by the system: true positive at 90% confidence, risk 62.0. Auto-close is off for this verdict.');
    expect(
      activityText(
        row(
          'verdict=NEEDS_HUMAN status=needs_human decision_by=None risk=40 cost=0 confidence=0.5 auto_close_gate=unrecorded',
        ),
      ).text,
    ).toBe('Left for an analyst: needs human review at 50% confidence, risk 40.');
  });

  it('reads the investigator verdict and keeps its reasoning on its own line', () => {
    const out = activityText(
      row('verdict=FALSE_POSITIVE confidence=0.97 reasoning=Demo benign baseline: false positive.', 'verdict', 'investigator'),
    );
    expect(out.text).toBe('Verdict false positive at 97% confidence.\nDemo benign baseline: false positive.');
    expect(activityText(row('verdict=TRUE_POSITIVE confidence=0.9', 'verdict', 'investigator')).text).toBe(
      'Verdict true positive at 90% confidence.',
    );
  });

  it.each([
    ['formatted verdict FALSE_POSITIVE (confidence 0.97)', 'Formatted the verdict: false positive at 97% confidence.'],
    [
      'bucket=needs_strong_model confidence=0.0 reason=demo: investigate',
      'Triage sent the case to a full investigation. Reason: demo: investigate.',
    ],
    [
      'bucket=obviously_benign confidence=0.8 reason=health check',
      'Triage judged the case obviously benign (80% confidence). Reason: health check.',
    ],
    [
      'runbook=compromised-account v1 persona=generalist reason=matched: Matched rule 100190.',
      'Runbook compromised-account v1 selected for the generalist persona. Matched rule 100190.',
    ],
    [
      'persona selected=generalist consulted=True; runbook selected=compromised-account v1 consulted=True',
      'The generalist persona was consulted; the runbook compromised-account v1 was consulted.',
    ],
    [
      'persona selected=generalist consulted=True; runbook selected=none consulted=False',
      'The generalist persona was consulted; no runbook was selected.',
    ],
    [
      'persona=web_application runbook=web-application-attack v1',
      'Investigator prompt with the web_application persona and the runbook web-application-attack v1.',
    ],
    ['persona=generalist runbook=none', 'Investigator prompt with the generalist persona and no runbook.'],
    [
      "registered candidate risk=62.0 rules=['WEB-EXPLOIT', '100123']",
      'Registered as a candidate at risk 62.0 (rules WEB-EXPLOIT, 100123).',
    ],
    [
      "closed by analyst rule policy rules=['100190'] policies=pol-1 risk=12",
      'Closed by an analyst policy at risk 12 (rules 100190).',
    ],
    [
      'no material change; returning existing case unchanged (verdict=FALSE_POSITIVE)',
      'No material change, so the case stays as it was (false positive).',
    ],
    [
      'assessment=agree outcome=true_positive accuracy=correct',
      'Feedback recorded: agree, actual outcome true positive, accuracy correct.',
    ],
  ])('%s', (summary, text) => {
    const out = activityText(row(summary));
    expect(out.text).toBe(text);
    expect(out.recorded).toBe(summary);
  });

  it('keeps a long prompt excerpt under Details and names the step', () => {
    const excerpt = '## Investigation context (deterministic, computed in code)\n- entity: ip = <<<UNTRUSTED_LOG_DATA>>>';
    const out = activityText(row(excerpt, 'prompt', 'router'));
    expect(out.text).toBe('Prompt sent to the router.');
    expect(out.recorded).toBe(excerpt);
    expect(activityText(row('x'.repeat(300), 'prompt', '')).text).toBe('Prompt sent to the model.');
  });

  it('leaves anything it does not recognise exactly as recorded', () => {
    for (const summary of [
      // Runbook rows already written as sentences stay as they are.
      'Work started on runbook Phishing triage.',
      'Runbook Phishing triage v2 attached by an automation rule.',
      'rule=only-a-rule',
      'verdict=FALSE_POSITIVE',
      'a short prompt',
    ]) {
      expect(activityText(row(summary, 'prompt', 'router'))).toEqual({ text: summary, recorded: null });
    }
    expect(activityText(row(''))).toEqual({ text: '', recorded: null });
  });

  it('never writes an em dash or the word playbook', () => {
    const outputs = [
      'rule=r1 action=run_playbook attach_runbook=x attached=True',
      'rule=r1 action=run_playbook attach_runbook=(none) attached=False',
      'rule=r1 action=request_approval proposal=p kind=memory',
    ].map((summary) => activityText(row(summary, 'automation', 'automation')).text);
    for (const text of outputs) {
      expect(text).not.toMatch(/\u2014/);
      expect(text.toLowerCase()).not.toContain('playbook');
    }
  });
});

describe('runbook lookups and steps (runbook_runs.py)', () => {
  /**
   * Each status in the server's words (`runbook_runs.lookup_evidence_summary`, the labels
   * of `runbook_lookup.TOOL_RULES`): a row written before the server worded its summary
   * (`Lookup <tool> collected evidence (<status>).`) reads exactly as a row written today.
   */
  const LOOKUPS: Array<[tool: string, status: string, today: string]> = [
    ['log_stats', 'ok', 'Log statistics lookup collected evidence.'],
    ['log_search', 'partial', 'Log search lookup collected partial evidence.'],
    ['enrich', 'not_applicable', 'Enrichment lookup was not applicable.'],
    ['related_cases', 'empty', 'Related cases lookup found no matching records.'],
    ['campaign', 'error', 'Campaign lookup could not run.'],
    ['mitre', 'ok', 'ATT&CK technique lookup collected evidence.'],
  ];

  it.each(LOOKUPS)('reads an older %s row (%s) in the words the server writes today', (tool, status, today) => {
    const summary = `Lookup ${tool} collected evidence (${status}).`;
    const out = activityText(row(summary, 'tool_call', 'dsingh'));
    expect(out.text).toBe(today);
    // The stored text stays under Details, exactly as recorded.
    expect(out.recorded).toBe(summary);
    expect(out.text).not.toMatch(/_|\(ok\)/);
  });

  it.each(LOOKUPS)("shows today's %s row (%s) as written, with nothing under Details", (_tool, _status, today) => {
    expect(activityText(row(today, 'tool_call', 'dsingh'))).toEqual({ text: today, recorded: null });
  });

  it("keeps the reason today's server adds after the status", () => {
    for (const summary of [
      'Enrichment lookup found no matching records. No enrichment provider is set up for this kind of value.',
      'ATT&CK technique lookup found no matching records. This case has no ATT&CK technique yet.',
      'Enrichment lookup was not applicable. Enrichment is turned off in Settings.',
      'Campaign lookup could not run. Campaigns could not be read.',
    ]) {
      expect(activityText(row(summary, 'tool_call', 'system'))).toEqual({ text: summary, recorded: null });
    }
  });

  it('never claims a lookup that could not run collected evidence', () => {
    expect(activityText(row('Lookup enrich collected evidence (error).')).text).not.toMatch(/collected/);
  });

  it('leaves a lookup status it does not know as recorded', () => {
    const summary = 'Lookup enrich collected evidence (throttled).';
    expect(activityText(row(summary))).toEqual({ text: summary, recorded: null });
  });

  it('names a runbook step in words', () => {
    const out = activityText(row('Runbook step user-confirms updated.', 'runbook', 'dsingh'));
    expect(out.text).toBe('Runbook step "User confirms" updated.');
    expect(out.recorded).toBe('Runbook step user-confirms updated.');
    // An operator runbook's generated id, as rows stored before the server named titles hold it.
    expect(activityText(row('Runbook step check-2 updated.', 'runbook', 'mira')).text).toBe('Runbook step "Check 2" updated.');
  });

  /**
   * The server names the step by its title in the run's pinned version now
   * (`runbook_runs._step_update_summary`, second acceptance pass, wrb-11): the row is
   * already plain words and is shown exactly as written, a one-word title too.
   */
  it.each([
    'Runbook step "Isolate the host" marked done (note updated).',
    'Runbook step "Contain" updated.',
    'Runbook step "Check" marked not applicable.',
    'Decision recorded on runbook step "Is this lateral movement?": Benign (2 later steps marked not applicable).',
    'Action recorded on runbook step "Isolate the host" (it waits for approval).',
    'Action on runbook step "Isolate the host" waits for approval from a SOC manager.',
    'Action on runbook step "Isolate the host" approved.',
    'Log statistics lookup on runbook step "Accounts tried" collected evidence.',
    'The AI drafted a note for runbook step "Check the sign-in".',
  ])('shows the step-titled row %s as written', (summary) => {
    expect(activityText(row(summary, 'runbook', 'mira'))).toEqual({ text: summary, recorded: null });
  });

  it('reads only an id as an id: a title-like word is never rewritten', () => {
    for (const summary of ['Runbook step Contain updated.', 'Runbook step check_two! updated.']) {
      expect(activityText(row(summary, 'runbook', 'mira'))).toEqual({ text: summary, recorded: null });
    }
  });
});

/**
 * Rows a case investigated before Round 14 still carries (writers at base 1cf20a7:
 * pipeline.py actor `playbook_selector` and the procedure record, investigator.py's
 * prompt row, threshold_automation.py's `run_playbook` action). SPEC §3.1: the list shows
 * Console-authored friendly names, never the retired noun; the stored text is unchanged
 * under Details.
 */
describe('rows from before Round 14', () => {
  const visible = (out: { text: string }, actor: string, kind: string) =>
    `${activityKindLabel(kind)} ${activityActorLabel(actor)} ${out.text}`;

  it('reads the selector row and names its actor and kind', () => {
    const summary = 'playbook=brute_force_login v3 persona=identity reason=matched rule_ids∩{auth.failed}; priority=5';
    const out = activityText(row(summary, 'playbook', 'playbook_selector'));
    expect(out.text).toBe(
      'Runbook brute_force_login v3 selected for the identity persona. Its match rules matched this case.',
    );
    expect(out.recorded).toBe(summary);
    expect(activityActorLabel('playbook_selector')).toBe('Runbook selector (before Round 14)');
    expect(activityKindLabel('playbook')).toBe('Runbook (before Round 14)');
    expect(visible(out, 'playbook_selector', 'playbook').toLowerCase()).not.toContain('playbook');
  });

  it.each([
    ['playbook=none persona=generalist reason=no_playbook_matched', 'No runbook selected (persona generalist). No runbook matched this case.'],
    ['playbook=phish v1 persona=email reason=forced:phish', 'Runbook phish v1 selected for the email persona. An analyst chose it for this investigation.'],
    ['playbook=none persona=email reason=forced_missing:gone', 'No runbook selected (persona email). The runbook an analyst chose was not found.'],
    ['playbook=phish v1 persona=email reason=something new', 'Runbook phish v1 selected for the email persona.'],
  ])('reads the selector reason in words: %s', (summary, text) => {
    const out = activityText(row(summary, 'decision', 'playbook_selector'));
    expect(out.text).toBe(text);
    expect(out.recorded).toBe(summary);
    expect(out.text.toLowerCase()).not.toContain('playbook');
  });

  it('reads the investigator prompt row', () => {
    const summary = 'persona=identity playbook=brute_force_login v3';
    const out = activityText(row(summary, 'prompt', 'investigator'));
    expect(out.text).toBe('Investigator prompt with the identity persona and the runbook brute_force_login v3.');
    expect(out.recorded).toBe(summary);
    expect(activityText(row('persona=generalist playbook=none', 'prompt', 'investigator')).text).toBe(
      'Investigator prompt with the generalist persona and no runbook.',
    );
  });

  it('reads the procedure record', () => {
    const summary = 'persona selected=identity consulted=True; playbook selected=brute_force_login consulted=False';
    const out = activityText(row(summary, 'context', 'procedure_provenance'));
    expect(out.text).toBe(
      'The identity persona was consulted; the runbook brute_force_login was selected but not consulted.',
    );
    expect(out.recorded).toBe(summary);
  });

  it.each([
    ['rule=r1 action=run_playbook run_playbook=phish queued=True', 'Automation queued a new investigation with the runbook phish (rule r1).'],
    ['rule=r1 action=run_playbook run_playbook=phish queued=False', 'Automation did not queue a new investigation with the runbook phish (rule r1).'],
    ['rule=r1 action=run_playbook run_playbook=(none) queued=False', 'Automation found no runbook to use (rule r1).'],
  ])('reads the automation action that queued an investigation: %s', (summary, text) => {
    const out = activityText(row(summary, 'automation', 'run_playbook'));
    expect(out.text).toBe(text);
    expect(out.recorded).toBe(summary);
    expect(visible(out, 'run_playbook', 'automation').toLowerCase()).not.toContain('playbook');
    expect(activityActorLabel('run_playbook')).toBe('Runbook automation (before Round 14)');
  });
});

describe('activityKindLabel', () => {
  it('words the kind badge, with the friendly name of the legacy kind', () => {
    expect(activityKindLabel('decision')).toBe('Decision');
    expect(activityKindLabel('tool_call')).toBe('Tool call');
    expect(activityKindLabel('PLAYBOOK')).toBe('Runbook (before Round 14)');
    expect(activityKindLabel('')).toBe('Event');
    expect(activityKindLabel(null)).toBe('Event');
  });
});

describe('activityActorLabel', () => {
  it('names the pipeline actors and keeps a person as recorded', () => {
    expect(activityActorLabel('case_manager')).toBe('Case manager');
    expect(activityActorLabel('runbook_selector')).toBe('Runbook selector');
    expect(activityActorLabel('procedure_provenance')).toBe('Procedure record');
    expect(activityActorLabel('automation')).toBe('Automation');
    expect(activityActorLabel('')).toBe('System');
    expect(activityActorLabel(null)).toBe('System');
    expect(activityActorLabel('dsingh')).toBe('dsingh');
    expect(activityActorLabel('Case_Manager')).toBe('Case manager');
  });
});
