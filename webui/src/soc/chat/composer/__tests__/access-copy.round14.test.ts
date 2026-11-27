/**
 * Access copy, Round 14 (SPEC §3.7, §4.10.1): runbooks are the one name for procedures,
 * so a retired `playbooks:*` grant reads as the runbook ability the server maps it to,
 * the new runbook and audit grants have plain phrases, and `case_stats` reads as an
 * ability in the present tense.
 */
import { describe, expect, it } from 'vitest';

import { CAPABILITY_LABELS, PERMISSION_PHRASES, capabilityLabel, permissionNeedText, permissionPhrase } from '../access-copy';

describe('access copy (Round 14)', () => {
  it('reads the retired playbook grants as runbook abilities', () => {
    expect(permissionPhrase('playbooks:read')).toBe('read runbooks');
    expect(permissionPhrase('playbooks:run')).toBe('run runbooks');
    expect(permissionPhrase('playbooks:manage')).toBe('manage runbooks');
    expect(permissionNeedText('playbooks:read')).toBe('Needs permission to read runbooks (playbooks:read)');
  });

  it('names the new runbook and audit grants', () => {
    expect(permissionPhrase('runbooks:run')).toBe('run runbooks');
    expect(permissionPhrase('runbooks:manage')).toBe('manage runbooks');
    expect(permissionPhrase('runbooks:publish')).toBe('publish runbooks');
    expect(permissionPhrase('audit:export')).toBe('export the audit log');
  });

  it('never says "playbook" in its own words', () => {
    for (const phrase of [...Object.values(PERMISSION_PHRASES), ...Object.values(CAPABILITY_LABELS)]) {
      expect(phrase).not.toMatch(/playbook/i);
      expect(phrase).not.toMatch(/\u2014/);
    }
  });

  it('reads case_stats as an ability', () => {
    expect(capabilityLabel({ name: 'case_stats', label: 'Counted cases' })).toBe('Count cases');
  });
});
