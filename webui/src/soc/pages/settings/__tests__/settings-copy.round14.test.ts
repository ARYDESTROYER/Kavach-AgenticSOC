/**
 * Settings copy rules (Round 14, SPEC §3.1 and §7.10): the Settings shell, every section
 * and the account and administration pages it embeds carry no em dashes and never say
 * "playbook" (the one word for the feature is Runbooks). Source-level, so a string that
 * only renders in a rare state is checked too. The missing-value placeholder comes from
 * the shared `DASH` constant, never a literal in these files.
 *
 * The Roles page and its API mirror keep the stored `playbooks` permission key readable
 * as its `runbooks` meaning (SPEC §3.7); only that compatibility code may name it.
 *
 * Rendered (Round 14, D26): the sections that host shared editors (SLA, priority &
 * suppression; Detection with Asset criticality) are rendered with rules in them, so the
 * editors' own copy is checked too: no em dash or en dash in any text or accessible name,
 * and no standing explanation box (the group captions carry it). A warning `Callout` for a
 * live consequence is allowed; a permanent `Alert` is not.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import * as React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import { CasePolicySection } from '../case-policy';
import { DetectionSection } from '../detection';

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

/** Every dash used as punctuation (U+2013, U+2014) in the rendered text or an accessible name. */
function dashesIn(root: HTMLElement): string[] {
  const found: string[] = [];
  const text = root.textContent ?? '';
  if (/[\u2013\u2014]/.test(text)) found.push(`text: ${text.match(/.{0,40}[\u2013\u2014].{0,40}/)?.[0]}`);
  for (const el of Array.from(root.querySelectorAll('[aria-label], [placeholder], [title]'))) {
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      const value = el.getAttribute(attr);
      if (value && /[\u2013\u2014]/.test(value)) found.push(`${attr}: ${value}`);
    }
  }
  return found;
}

/**
 * A standing box: the `Alert` primitive (a bordered, rounded live region) that is not a
 * `Callout`. A field's own validation message (a live `role="alert"` line under the
 * field) is a condition, not a box, and is allowed.
 */
function permanentAlerts(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll('[role="alert"], [role="status"]')).filter(
    (el) =>
      !el.closest('[data-callout]') &&
      el.tagName === 'DIV' &&
      el.classList.contains('rounded-lg') &&
      el.classList.contains('border'),
  );
}

function renderSection(Section: React.ComponentType<{ prefs: Preferences; update: (p: Partial<Preferences>) => void }>, prefs: Partial<Preferences>) {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(Section, { prefs: prefs as Preferences, update: vi.fn() }),
    ),
  );
}

describe('Settings copy, rendered (Round 14)', () => {
  it('SLA, priority & suppression has no dashes and no standing explanation box', () => {
    const { container } = renderSection(CasePolicySection, {
      sla: { enabled: true },
      priority_matrix: { enabled: true },
      suppression_rules: [
        { field: 'rule.name', value: 'scanner', reason: 'benign', enabled: true, created_by: 'agent' },
        { field: 'source.ip', value: '10.0.0.5', enabled: false, created_by: 'operator' },
      ],
      analyst_rule_policies: [{ id: 'arp-1', rule_id: 'web_shell_php', reason: 'CI runner', enabled: true }],
    });
    expect(dashesIn(container)).toEqual([]);
    expect(permanentAlerts(container)).toEqual([]);
    expect(container.textContent).not.toContain('Priority is advisory');
    expect(container.textContent).not.toContain('Suppression drops events before triage');
    // The group caption says what the matrix does; the switch's helper never repeats it.
    expect((container.textContent ?? '').split('Map every impact and urgency pair').length - 1).toBe(1);
    expect(container.textContent).toContain('Off by default. When off, cases have no priority.');
  });

  it('Detection, with Asset criticality filled in, has no dashes and no standing explanation box', () => {
    const { container } = renderSection(DetectionSection, {
      auto_close: {
        false_positive: { enabled: true, min_confidence: 0.85, max_risk_score: 30, objection_window_minutes: 1440 },
        true_positive: { enabled: false, min_confidence: 0.95, max_risk_score: 10, objection_window_minutes: 4320 },
      },
      asset_networks: [{ cidr: '10.0.0.0', criticality: 80 }],
      asset_criticality: { 'db-prod-01': 90 },
    } as unknown as Partial<Preferences>);
    expect(container.textContent).toContain('Include a prefix length, for example 10.0.0.0/8.');
    expect(container.textContent).toContain('(0 to 100)');
    expect(dashesIn(container)).toEqual([]);
    expect(permanentAlerts(container)).toEqual([]);
  });
});
