/**
 * Custom-dashboard widget-registry tests (Round 5 / G7, CD1).
 *
 * Locks the reconcile-on-load anti-corruption step (§3.2) + per-role defaults:
 *   1. reconcile DROPS a widget whose `type` is no longer registered (and its geometry).
 *   2. reconcile RBAC-FILTERS instances the caller lacks the `requires` grant for.
 *   3. reconcile APPENDS new role-default widgets not already present (RBAC-filtered).
 *   4. per-role default widget sets resolve + RBAC-filter.
 *
 * Pure-function tests — no rendering, no network. The registry is the single source
 * of truth for what a widget IS; a layout is data referencing it by type.
 */
import { describe, it, expect } from 'vitest';

import {
  WIDGET_REGISTRY,
  WIDGET_TYPES,
  isKnownWidgetType,
  reconcileWidgets,
  defaultWidgetTypesForRole,
  buildDefaultWidgets,
  ROLE_DEFAULT_WIDGETS,
  ALLOW_ALL,
  PENDING_WIDGET_TYPES,
  type WidgetType,
  type PermissionCheck,
} from '@/soc/dashboard/registry';
import type { DashboardWidget } from '@/lib/types';

// A deterministic id factory so appended-widget ids are assertable.
let seq = 0;
const makeId = (type: WidgetType) => `id-${type}-${(seq += 1)}`;

function widget(type: string, extra: Partial<DashboardWidget> = {}): DashboardWidget {
  return { id: `inst-${type}`, type, x: 0, y: 0, w: 3, h: 3, options: {}, ...extra } as DashboardWidget;
}

describe('widget registry', () => {
  it('every registered type resolves + is known', () => {
    expect(WIDGET_TYPES.length).toBeGreaterThanOrEqual(6); // 6-8 seed widgets
    for (const t of WIDGET_TYPES) {
      expect(WIDGET_REGISTRY.has(t)).toBe(true);
      expect(isKnownWidgetType(t)).toBe(true);
    }
    expect(isKnownWidgetType('kpi.does_not_exist')).toBe(false);
  });

  it('every def carries a lazy Component, a default size, and its data sources', () => {
    for (const def of WIDGET_REGISTRY.values()) {
      expect(def.Component).toBeTruthy();
      expect(def.defaultSize.w).toBeGreaterThan(0);
      expect(def.defaultSize.h).toBeGreaterThan(0);
      expect(def.defaultSize.minW).toBeLessThanOrEqual(def.defaultSize.w);
      expect(def.defaultSize.minH).toBeLessThanOrEqual(def.defaultSize.h);
      // A real body names the shared sources it reads (they drive the fetch pre-warm).
      // A Round 14 stub (SPEC §4.4.1) reads nothing until WP-W4c lands its body, which
      // takes the type out of PENDING_WIDGET_TYPES and puts it under the first rule.
      const pending = PENDING_WIDGET_TYPES.has(def.type);
      expect(def.sources.length > 0, `${def.type} sources`).toBe(!pending);
    }
  });

  it('only Round 14 module types can be pending, never a shipped widget', () => {
    const shipped = [
      'kpi.needs_human',
      'kpi.cost_budget',
      'chart.verdict_mix',
      'chart.autonomous_vs_human',
      'kpi.lifecycle_timing',
      'table.connector_health',
      'table.recent_cases',
      'mitre.heatmap',
      'gauge.active_risk',
    ] as const;
    for (const t of shipped) {
      expect(PENDING_WIDGET_TYPES.has(t), t).toBe(false);
      expect(WIDGET_REGISTRY.get(t)!.sources.length, t).toBeGreaterThan(0);
    }
  });
});

describe('reconcileWidgets — anti-corruption on load', () => {
  it('(1) DROPS a widget whose type is no longer registered', () => {
    const known = WIDGET_TYPES[0];
    const input = [
      widget(known, { id: 'keep-me' }),
      widget('chart.LEGACY_REMOVED', { id: 'drop-me' }),
      widget('totally.bogus', { id: 'drop-me-too' }),
    ];
    const out = reconcileWidgets(input, { can: ALLOW_ALL });
    expect(out.map((w) => w.id)).toEqual(['keep-me']);
    // The dropped widget's geometry goes with it — no hole left behind.
    expect(out.every((w) => isKnownWidgetType(w.type))).toBe(true);
  });

  it('(2) RBAC-FILTERS instances the caller lacks the required grant for', () => {
    // Deny only `cost:view` (the canonical cost grant the widget requires) → the cost
    // widget is filtered, others survive.
    const denyCost: PermissionCheck = (resource, action) =>
      !(resource === 'cost' && action === 'view');

    const input = [
      widget('kpi.cost_budget', { id: 'cost' }), // requires cost:view → dropped
      widget('kpi.needs_human', { id: 'needs' }), // requires cases:read → kept
    ];
    const out = reconcileWidgets(input, { can: denyCost });
    expect(out.map((w) => w.id)).toEqual(['needs']);
  });

  it('(3) APPENDS new role-default widgets not already present (RBAC-filtered)', () => {
    const existing = [widget('kpi.needs_human', { id: 'existing' })];
    const out = reconcileWidgets(existing, {
      can: ALLOW_ALL,
      appendDefaults: ['kpi.needs_human', 'gauge.active_risk'], // first already present
      makeId,
    });
    // needs_human kept once (not duplicated); active_risk appended.
    const types = out.map((w) => w.type);
    expect(types.filter((t) => t === 'kpi.needs_human')).toHaveLength(1);
    expect(types).toContain('gauge.active_risk');
    const appended = out.find((w) => w.type === 'gauge.active_risk')!;
    expect(appended.id).toMatch(/^id-gauge\.active_risk-/);
    // Appended widget gets the registry default size.
    const def = WIDGET_REGISTRY.get('gauge.active_risk')!;
    expect(appended.w).toBe(def.defaultSize.w);
    expect(appended.h).toBe(def.defaultSize.h);
  });

  it('(3b) does NOT append an unknown or RBAC-denied default', () => {
    const denyMetricsView: PermissionCheck = (resource, action) =>
      !(resource === 'metrics' && action === 'view');
    const out = reconcileWidgets([], {
      can: denyMetricsView,
      // mitre.heatmap requires metrics:view (denied); the bogus id is ignored.
      appendDefaults: ['mitre.heatmap', 'not.a.widget' as WidgetType, 'kpi.needs_human'],
      makeId,
    });
    const types = out.map((w) => w.type);
    expect(types).not.toContain('mitre.heatmap');
    expect(types).not.toContain('not.a.widget');
    expect(types).toContain('kpi.needs_human');
  });

  it('handles null/empty input without throwing', () => {
    expect(reconcileWidgets(null)).toEqual([]);
    expect(reconcileWidgets(undefined)).toEqual([]);
    expect(reconcileWidgets([])).toEqual([]);
  });
});

describe('per-role default dashboards', () => {
  it('every role default references only registered widget types', () => {
    for (const [role, types] of Object.entries(ROLE_DEFAULT_WIDGETS)) {
      for (const t of types) {
        expect(isKnownWidgetType(t)).toBe(true);
      }
      // sanity: at least one widget per role
      expect(types.length).toBeGreaterThan(0);
      void role;
    }
  });

  it('resolves a role default set, falling back to `default` for an unknown role', () => {
    expect(defaultWidgetTypesForRole('soc_manager')).toEqual(ROLE_DEFAULT_WIDGETS.soc_manager);
    expect(defaultWidgetTypesForRole('nonexistent_role')).toEqual(ROLE_DEFAULT_WIDGETS.default);
    expect(defaultWidgetTypesForRole(null)).toEqual(ROLE_DEFAULT_WIDGETS.default);
  });

  it('RBAC-filters a role default set', () => {
    // super_admin default leads with cost_budget (needs cost:view); deny it.
    const denyCost: PermissionCheck = (resource, action) =>
      !(resource === 'cost' && action === 'view');
    const filtered = defaultWidgetTypesForRole('super_admin', denyCost);
    expect(filtered).not.toContain('kpi.cost_budget');
    expect(filtered.length).toBeLessThan(ROLE_DEFAULT_WIDGETS.super_admin.length);
  });

  it('buildDefaultWidgets emits sized, uniquely-id\'d instances for a role', () => {
    const widgets = buildDefaultWidgets('analyst_tier1', { can: ALLOW_ALL, makeId });
    expect(widgets.length).toBe(ROLE_DEFAULT_WIDGETS.analyst_tier1.length);
    const ids = widgets.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length); // unique ids
    for (const w of widgets) {
      const def = WIDGET_REGISTRY.get(w.type as WidgetType)!;
      expect(w.w).toBe(def.defaultSize.w);
      expect(w.h).toBe(def.defaultSize.h);
      expect(w.options).toEqual({});
    }
  });
});
