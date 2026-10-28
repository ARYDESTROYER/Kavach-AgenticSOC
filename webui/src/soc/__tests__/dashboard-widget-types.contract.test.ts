/**
 * Widget-type ALLOWLIST contract test (Round 5 audit C1/H1).
 *
 * C1 was a shipping regression: the server allowlist
 * (`backend/app/api/routes_dashboards.py` `WIDGET_TYPES`) and the client widget
 * registry (`webui/src/soc/dashboard/registry.ts` `WIDGET_TYPES`) were authored
 * independently and drifted — sharing only 3 of ~9/14 values — so EVERY Edit→Save 400'd
 * in `_clean_widget`. No test crossed the two allowlists, so it passed CI green (H1).
 *
 * This is that missing cross-check. Both sides now pin to ONE committed source of truth
 * (`widget-types.contract.json`). This test asserts the CLIENT registry equals that
 * canonical set; the backend companion
 * (`test_round5_dashboards_widget_type_contract.py`) asserts the SERVER frozenset equals
 * the SAME file. A one-sided widget addition therefore fails CI on whichever side
 * forgot to update — the two allowlists can never silently diverge again.
 */
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  PENDING_WIDGET_TYPES,
  WIDGET_TYPES,
  getWidgetDef,
  isKnownWidgetType,
} from '@/soc/dashboard/registry';
import contract from '@/soc/dashboard/widget-types.contract.json';

const canonical: string[] = (contract as { widget_types: string[] }).widget_types;

describe('dashboard widget-type allowlist contract (C1/H1)', () => {
  it('the client registry WIDGET_TYPES === the canonical contract set (order-independent)', () => {
    const client = new Set<string>(WIDGET_TYPES);
    const canon = new Set<string>(canonical);
    // Symmetric-difference must be empty: no client-only type, no canonical-only type.
    const clientOnly = [...client].filter((t) => !canon.has(t));
    const canonOnly = [...canon].filter((t) => !client.has(t));
    expect(clientOnly, 'widget types in registry.ts but NOT in the contract').toEqual([]);
    expect(canonOnly, 'widget types in the contract but NOT in registry.ts').toEqual([]);
    // Same cardinality (guards against a duplicate hiding a real divergence).
    expect(client.size).toBe(canon.size);
  });

  it('every canonical widget type is a currently-registered client widget', () => {
    for (const t of canonical) {
      expect(isKnownWidgetType(t), `${t} must resolve in the client registry`).toBe(true);
    }
  });

  it('the contract set is exactly the 25 shipped widgets (a change here is deliberate)', () => {
    // A tripwire so ADDING/REMOVING a widget forces a conscious update of BOTH the
    // registry and the server frozenset (and this expected list). Round 14 (SPEC
    // §4.4.3) added the sixteen modules of the built-in boards.
    expect([...canonical].sort()).toEqual(
      [
        'chart.autonomous_vs_human',
        'chart.verdict_mix',
        'gauge.active_risk',
        'kpi.cost_budget',
        'kpi.lifecycle_timing',
        'kpi.needs_human',
        'mitre.heatmap',
        'table.connector_health',
        'table.recent_cases',
        // Round 14
        'kpi.strip',
        'kpi.auto_close_health',
        'kpi.agent_quality',
        'chart.case_trend',
        'chart.case_breakdown',
        'chart.severity_trend',
        'chart.backlog_aging',
        'chart.noise_funnel',
        'table.attention_queue',
        'table.workload',
        'table.sla_breaches',
        'table.top_rules',
        'table.noisy_rules',
        'table.top_techniques',
        'table.campaigns',
        'table.telemetry_gaps',
      ].sort(),
    );
  });

  it('the contract lists every type once (no duplicate can hide a divergence)', () => {
    expect(new Set(canonical).size).toBe(canonical.length);
  });

  it('every type keeps the dotted family grammar the server allowlist expects', () => {
    for (const t of canonical) {
      expect(t, `${t} must read <family>.<name>`).toMatch(/^(kpi|chart|table|mitre|gauge)\.[a-z_]+$/);
    }
  });

  it('every registered type has a title, a description and a lazy body to render', () => {
    for (const t of WIDGET_TYPES) {
      const def = getWidgetDef(t)!;
      expect(def.title.trim().length, `${t} title`).toBeGreaterThan(0);
      expect(def.description.trim().length, `${t} description`).toBeGreaterThan(0);
      expect(def.Component, `${t} body`).toBeTruthy();
      // Console-authored copy: no em or en dash, no retired vocabulary (SPEC §3.1).
      for (const text of [def.title, def.description]) {
        expect(text).not.toMatch(/[\u2013\u2014]/);
        expect(text.toLowerCase()).not.toContain('playbook');
      }
    }
  });
});

describe('Round 14 stub widgets (SPEC §4.4.1)', () => {
  const ROUND14 = [
    'kpi.strip',
    'kpi.auto_close_health',
    'kpi.agent_quality',
    'chart.case_trend',
    'chart.case_breakdown',
    'chart.severity_trend',
    'chart.backlog_aging',
    'chart.noise_funnel',
    'table.attention_queue',
    'table.workload',
    'table.sla_breaches',
    'table.top_rules',
    'table.noisy_rules',
    'table.top_techniques',
    'table.campaigns',
    'table.telemetry_gaps',
  ] as const;

  it('carries the grant the widget table names (per cell for the KPI strip)', () => {
    const grant = (t: (typeof ROUND14)[number]) => {
      const req = getWidgetDef(t)!.requires;
      return req ? `${req.resource}:${req.action}` : null;
    };
    expect(Object.fromEntries(ROUND14.map((t) => [t, grant(t)]))).toEqual({
      'kpi.strip': null,
      'kpi.auto_close_health': 'metrics:view',
      'kpi.agent_quality': 'metrics:view',
      'chart.case_trend': 'metrics:view',
      'chart.case_breakdown': 'metrics:view',
      'chart.severity_trend': 'metrics:view',
      'chart.backlog_aging': 'cases:read',
      'chart.noise_funnel': 'metrics:view',
      'table.attention_queue': 'cases:read',
      'table.workload': 'cases:read',
      'table.sla_breaches': 'cases:read',
      'table.top_rules': 'metrics:view',
      'table.noisy_rules': 'automation:read',
      'table.top_techniques': 'metrics:view',
      'table.campaigns': 'cases:read',
      'table.telemetry_gaps': 'cases:read',
    });
  });

  it('offers the options the widget table names', () => {
    const choices = (t: (typeof ROUND14)[number], key: string) =>
      getWidgetDef(t)!
        .configFields?.find((f) => f.key === key)
        ?.choices?.map((c) => c.value);
    expect(choices('kpi.strip', 'preset')).toEqual(['operations', 'detection', 'executive']);
    expect(choices('chart.case_trend', 'series')).toEqual(['flow', 'alerts', 'outcomes']);
    expect(choices('chart.severity_trend', 'bucket')).toEqual(['day', 'week']);
    expect(choices('table.attention_queue', 'limit')).toEqual(['5', '8', '10']);
    expect(choices('table.top_rules', 'top')).toEqual(['5', '10']);
    expect(choices('table.top_techniques', 'top')).toEqual(['5', '10']);
    expect(choices('chart.case_breakdown', 'by')).toEqual([
      'status',
      'verdict',
      'severity',
      'source',
      'rule',
      'closed_by',
      'assignee',
      'mitre_tactic',
      'mitre_technique',
    ]);
  });

  it('states the default row count the sheet leaves unset', () => {
    const placeholder = (t: (typeof ROUND14)[number], key: string) =>
      getWidgetDef(t)!.configFields?.find((f) => f.key === key)?.placeholder;
    expect(placeholder('table.attention_queue', 'limit')).toBe('Default 8');
    expect(placeholder('table.top_rules', 'top')).toBe('Default 10');
    expect(placeholder('table.top_techniques', 'top')).toBe('Default 10');
    expect(placeholder('chart.case_breakdown', 'top')).toBe('Default 10');
  });

  it('every Round 14 type is pending until its body lands, and only those', () => {
    expect([...PENDING_WIDGET_TYPES].sort()).toEqual([...ROUND14].sort());
  });

  it('a stub reads no data source and renders the shared "Not available yet" state', async () => {
    for (const t of PENDING_WIDGET_TYPES) {
      expect(getWidgetDef(t)!.sources, `${t} must not fetch before its body lands`).toEqual([]);
    }
    const Stub = getWidgetDef('table.top_rules')!.Component;
    render(
      React.createElement(
        React.Suspense,
        { fallback: null },
        React.createElement(Stub, { id: 'w1', title: 'Top detection rules', options: {} }),
      ),
    );
    expect(await screen.findByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('Top detection rules')).toBeInTheDocument();
  });
});
