/**
 * Settings copy rules (Round 14, SPEC §3.1 and §7.10): the Settings shell, every section
 * and the account and administration pages it embeds carry no em dashes and never say
 * "playbook" (the one word for the feature is Runbooks). Source-level, so a string that
 * only renders in a rare state is checked too. The missing-value placeholder comes from
 * the shared `DASH` constant, never a literal in these files.
 *
 * The Roles page and its API mirror keep the stored `playbooks` permission key readable
 * as its `runbooks` meaning (SPEC §3.7); only that compatibility code may name it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SOC = path.resolve(__dirname, '../../..');

const FILES = [
  'pages/Settings.tsx',
  ...readdirSync(path.join(SOC, 'pages/settings'))
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => `pages/settings/${name}`),
  'pages/Account.tsx',
  'pages/Sessions.tsx',
  'pages/Users.tsx',
  'pages/Roles.tsx',
  'pages/Roles.api.ts',
  'pages/AdminSessions.tsx',
  'pages/Security.tsx',
  'components/SessionPolicyEditor.tsx',
];

/** The compatibility code that maps the retired permission key onto runbooks. */
const PLAYBOOK_ALLOWED = new Set(['pages/Roles.tsx', 'pages/Roles.api.ts']);

describe('Settings copy (Round 14)', () => {
  it('covers the shell, every section file and the embedded pages', () => {
    expect(FILES).toContain('pages/settings/runbooks.tsx');
    expect(FILES).toContain('pages/settings/discounted-inference.tsx');
    expect(FILES.length).toBeGreaterThan(30);
  });

  it.each(FILES)('%s has no em dash', (file) => {
    const source = readFileSync(path.join(SOC, file), 'utf8');
    const lines = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes('—'));
    expect(lines).toEqual([]);
  });

  it.each(FILES.filter((file) => !PLAYBOOK_ALLOWED.has(file)))('%s never says playbook', (file) => {
    const source = readFileSync(path.join(SOC, file), 'utf8');
    expect(source.toLowerCase()).not.toContain('playbook');
  });
});
