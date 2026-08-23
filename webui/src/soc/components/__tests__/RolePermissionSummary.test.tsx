/**
 * Round 11 — RolePermissionSummary: the read-only "what does this role grant?"
 * panel shown while creating a user. Covers the PURE summarisation logic
 * (wildcard explosion, ordering, unknown-resource honesty, full-access shape)
 * and the render contract (live update on role change; plain text only, #9).
 */
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  RolePermissionSummary,
  summarizeRoleGrants,
  isFullAccess,
} from '../RolePermissionSummary';
import { RESOURCE_ACTIONS, type GrantMap } from '@/soc/pages/Roles.api';

const MATRIX: Record<string, GrantMap> = {
  analyst_tier1: { cases: ['read', 'comment'], playbooks: ['read', 'run'] },
  wild: { cases: ['*'], mystery_resource: ['*'] },
  // A real wire shape: a custom role inheriting a wildcard base can resolve an
  // UNKNOWN resource to literals + '*' in one list.
  mixed_wild: { mystery_resource: ['read', '*'] },
  super_admin: Object.fromEntries(Object.keys(RESOURCE_ACTIONS).map((r) => [r, ['*']])),
};

describe('summarizeRoleGrants', () => {
  it('returns literal grants grouped by resource in canonical order', () => {
    const rows = summarizeRoleGrants(MATRIX, 'analyst_tier1');
    expect(rows.map((r) => r.resource)).toEqual(['cases', 'playbooks']);
    expect(rows[0].actions).toEqual(['read', 'comment']);
  });

  it('explodes "*" against the resource vocabulary and keeps unknown resources honest', () => {
    const rows = summarizeRoleGrants(MATRIX, 'wild');
    const cases = rows.find((r) => r.resource === 'cases');
    expect(cases?.actions).toEqual(RESOURCE_ACTIONS.cases);
    // A resource the client mirror does not know still shows up — with a literal
    // "all actions" chip instead of silently disappearing (the drift-proof path).
    const mystery = rows.find((r) => r.resource === 'mystery_resource');
    expect(mystery?.actions).toEqual(['all actions']);
  });

  it('keeps the wildcard disclosure when an UNKNOWN resource mixes literals with "*"', () => {
    // ['read','*'] on a resource the mirror does not know: dropping the '*' would
    // silently hide the wildcard grant — it must survive as the honest chip.
    const rows = summarizeRoleGrants(MATRIX, 'mixed_wild');
    const mystery = rows.find((r) => r.resource === 'mystery_resource');
    expect(mystery?.actions).toEqual(['read', 'all actions']);
  });

  it('returns [] for an unknown role or missing matrix', () => {
    expect(summarizeRoleGrants(MATRIX, 'nope')).toEqual([]);
    expect(summarizeRoleGrants(undefined, 'analyst_tier1')).toEqual([]);
  });
});

describe('isFullAccess', () => {
  it('recognises the all-wildcard super_admin shape and rejects partial rows', () => {
    expect(isFullAccess(summarizeRoleGrants(MATRIX, 'super_admin'))).toBe(true);
    expect(isFullAccess(summarizeRoleGrants(MATRIX, 'analyst_tier1'))).toBe(false);
    expect(isFullAccess([])).toBe(false);
  });
});

describe('RolePermissionSummary render', () => {
  it('renders per-resource action chips and updates when the role prop changes', () => {
    const { rerender } = render(<RolePermissionSummary roleName="analyst_tier1" matrix={MATRIX} />);
    const panel = screen.getByTestId('role-permission-summary');
    expect(within(panel).getByText('Analyst — Tier 1 grants')).toBeInTheDocument();
    expect(within(panel).getByText('comment')).toBeInTheDocument();
    expect(within(panel).getByText('2 resources · 4 actions')).toBeInTheDocument();

    rerender(<RolePermissionSummary roleName="super_admin" matrix={MATRIX} />);
    expect(
      within(screen.getByTestId('role-permission-summary')).getByText(
        /full administrative access — every action on every resource/i,
      ),
    ).toBeInTheDocument();
  });

  it('states plainly when a role grants nothing', () => {
    render(<RolePermissionSummary roleName="ghost" matrix={MATRIX} />);
    expect(screen.getByText('No permissions granted by this role.')).toBeInTheDocument();
  });

  it('makes the scrolling grant list keyboard-reachable and named', () => {
    // The bounded scroller must be focusable (Safari only keyboard-scrolls
    // focusable scrollers) and carry an accessible name.
    render(<RolePermissionSummary roleName="analyst_tier1" matrix={MATRIX} />);
    const list = screen.getByRole('list', { name: 'Permissions granted by Analyst — Tier 1' });
    expect(list).toHaveAttribute('tabindex', '0');
  });
});
