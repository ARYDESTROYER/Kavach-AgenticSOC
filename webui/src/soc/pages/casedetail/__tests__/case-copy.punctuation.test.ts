/**
 * Case Manager / case detail copy uses plain punctuation (Round 12 polish, tour finding
 * 5). The close dialog read "deterministic code — this records …", the note disclosure
 * "durable context — the AI reads …", the grading help "ground truth — the stars …",
 * the outcome rail "Needs human review — on hold", and the role names "Analyst — Tier
 * 2/1". The display labels change; the stored role ids and wire values do not.
 */
import { describe, expect, it } from 'vitest';

import { aiHeadline } from '@/soc/components/outcome';
import { BUILTIN_ROLES, ROLE_LABELS, roleLabel } from '@/soc/pages/Roles.api';
import { ALL_ACTIONS, DURABLE_CONTEXT_NOTE } from '../shared';
import { OUTCOME_OPTIONS } from '../grading';

const EM_DASH = '—';

describe('case copy punctuation', () => {
  it('has no em dash in any lifecycle action copy', () => {
    for (const action of Object.values(ALL_ACTIONS)) {
      for (const text of [action.label, action.confirmTitle, action.confirmBody, action.help]) {
        expect(text, `${action.key}: ${text}`).not.toContain(EM_DASH);
      }
    }
    expect(ALL_ACTIONS.close_disposition.confirmBody).toBe(
      'Choose the investigative outcome, then close this case. The close/escalate decision is still made by deterministic code. This records your disposition and closes the case.',
    );
    expect(DURABLE_CONTEXT_NOTE).toBe(
      'Saved with the resolved case as durable context. The AI reads this note when it investigates similar cases later.',
    );
  });

  it('has no em dash in the confirmed-outcome options', () => {
    for (const option of OUTCOME_OPTIONS) expect(option.text).not.toContain(EM_DASH);
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
