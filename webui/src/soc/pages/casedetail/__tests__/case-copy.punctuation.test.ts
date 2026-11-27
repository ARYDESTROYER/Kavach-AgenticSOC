/**
 * Case Manager / case detail copy uses plain punctuation (Round 12 polish, tour finding
 * 5). The close dialog ("deterministic code, this records …"), the note disclosure
 * ("durable context, the AI reads …"), the grading help ("ground truth, the stars …"),
 * the outcome rail ("Needs human review, on hold") and the role names ("Analyst, Tier
 * 2/1") each joined their clauses with an em dash. The display labels change; the
 * stored role ids and wire values do not.
 */
import { describe, expect, it } from 'vitest';

import { aiHeadline } from '@/soc/components/outcome';
import { BUILTIN_ROLES, ROLE_LABELS, roleLabel } from '@/soc/pages/Roles.api';
import { ACTIONS_TAKEN_OPTIONS, ALL_ACTIONS, DURABLE_CONTEXT_NOTE } from '../shared';
import { OUTCOME_OPTIONS } from '../grading';

const EM_DASH = '\u2014';

describe('case copy punctuation', () => {
  it('has no em dash in any lifecycle action copy', () => {
    for (const action of Object.values(ALL_ACTIONS)) {
      for (const text of [action.label, action.confirmTitle, action.confirmBody, action.help]) {
        expect(text, `${action.key}: ${text}`).not.toContain(EM_DASH);
      }
    }
    // Round 15 (D4.1): the close asks one classification question, then what was done.
    expect(ALL_ACTIONS.close_disposition.confirmBody).toBe(
      'Say what this case was and what you did about it, then close it.',
    );
    expect(DURABLE_CONTEXT_NOTE).toBe(
      'Saved with the resolved case as durable context. The AI reads this note when it investigates similar cases later.',
    );
  });

  it('has no em dash in the confirmed-outcome words or the actions-taken vocabulary', () => {
    for (const option of OUTCOME_OPTIONS) expect(option.text).not.toContain(EM_DASH);
    for (const option of ACTIONS_TAKEN_OPTIONS) expect(option.text).not.toContain(EM_DASH);
  });

  it('joins the AI headline with a comma', () => {
    expect(aiHeadline('needs_human', 'on_hold')).toBe('Needs human review, on hold');
    expect(aiHeadline('true_positive', 'escalated')).toBe('Likely a true positive, escalated');
    expect(aiHeadline('needs_human', 'needs_human')).toBe('Needs human review');
  });

  it('names the analyst tiers without a dash and keeps the stored role ids', () => {
    expect(roleLabel('analyst_tier1')).toBe('Analyst Tier 1');
    expect(roleLabel('analyst_tier2')).toBe('Analyst Tier 2');
    expect([...BUILTIN_ROLES].sort()).toEqual(
      ['analyst_tier1', 'analyst_tier2', 'auditor', 'responder', 'soc_manager', 'super_admin'],
    );
    for (const label of Object.values(ROLE_LABELS)) expect(label).not.toContain(EM_DASH);
  });
});
