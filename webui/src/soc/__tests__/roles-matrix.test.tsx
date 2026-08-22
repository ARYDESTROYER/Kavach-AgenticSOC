/**
 * RBAC role matrix editor + preview-diff tests (Round 3 / Feature 6).
 *
 * Covers the PURE tri-state cell logic (cellState/cycleCell — the heart of the grants/
 * denies grid) and the PreviewDiff render that shows the resolved effective grants +
 * the per-resource added/removed action diff. No network: everything here is offline.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';
import {
  cellState,
  cycleCell,
  RoleMatrixEditor,
  type RoleDraft,
} from '../components/RoleMatrixEditor';
import { PreviewDiff } from '../pages/Roles';
import { RESOURCE_ACTIONS, type RolePreviewResponse } from '../pages/Roles.api';

function draft(): RoleDraft {
  return { name: 'tier1_plus', description: '', inherits: [], grants: {}, denies: {} };
}

describe('RoleMatrixEditor cell logic', () => {
  it('cycles a cell neutral → grant → deny → neutral', () => {
    let d = draft();
    expect(cellState(d, 'cases', 'read')).toBe('neutral');

    d = cycleCell(d, 'cases', 'read');
    expect(cellState(d, 'cases', 'read')).toBe('grant');
    expect(d.grants.cases).toEqual(['read']);

    d = cycleCell(d, 'cases', 'read');
    expect(cellState(d, 'cases', 'read')).toBe('deny');
    expect(d.denies.cases).toEqual(['read']);
    // The grant must have been removed when it became a deny.
    expect(d.grants.cases).toBeUndefined();

    d = cycleCell(d, 'cases', 'read');
    expect(cellState(d, 'cases', 'read')).toBe('neutral');
    expect(d.grants.cases).toBeUndefined();
    expect(d.denies.cases).toBeUndefined();
  });

  it('treats a wildcard grant as granting every action', () => {
    const d: RoleDraft = { ...draft(), grants: { cases: ['*'] } };
    expect(cellState(d, 'cases', 'read')).toBe('grant');
    expect(cellState(d, 'cases', 'close')).toBe('grant');
  });

  it('keeps other actions on the same resource intact when one toggles', () => {
    let d: RoleDraft = { ...draft(), grants: { cases: ['read', 'write'] } };
    d = cycleCell(d, 'cases', 'read'); // read: grant → deny
    expect(d.grants.cases).toEqual(['write']);
    expect(d.denies.cases).toEqual(['read']);
  });
});

describe('RoleMatrixEditor resource vocabulary', () => {
  it('exposes playbook management so custom roles can use the editor workflow', () => {
    expect(RESOURCE_ACTIONS.playbooks).toEqual(['read', 'run', 'manage']);
  });

  it('exposes portable data export for custom-role grant and deny workflows', () => {
    expect(RESOURCE_ACTIONS.data_export).toEqual(['export']);

    let d = draft();
    d = cycleCell(d, 'data_export', 'export');
    expect(d.grants.data_export).toEqual(['export']);

    d = cycleCell(d, 'data_export', 'export');
    expect(d.grants.data_export).toBeUndefined();
    expect(d.denies.data_export).toEqual(['export']);
  });

  it('renders the portable export permission in the custom-role matrix', () => {
    render(
      <TooltipProvider>
        <RoleMatrixEditor draft={draft()} onChange={vi.fn()} />
      </TooltipProvider>,
    );

    expect(screen.getByText('Data export')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /data_export:export/i }),
    ).toBeInTheDocument();
  });

  it('carries the Round-11 drift-fixed resources (runbooks / system_updates / rules)', () => {
    // These existed in backend rbac/policy.RESOURCES but were missing from the
    // client mirror, so the editor grid + permission summary never showed them.
    expect(RESOURCE_ACTIONS.runbooks).toEqual(['read', 'manage']);
    expect(RESOURCE_ACTIONS.system_updates).toEqual(['read', 'apply', 'rollback']);
    expect(RESOURCE_ACTIONS.rules).toEqual(['read', 'manage']);
  });
});

describe('PreviewDiff render', () => {
  const preview: RolePreviewResponse = {
    name: 'tier1_plus',
    resolved: { cases: ['read', 'write', 'close'], proposals: ['read'] },
    effective: { cases: ['read', 'write', 'close'], proposals: ['read'] },
    diff: {
      cases: { added: ['close'], removed: [] },
      proposals: { added: [], removed: ['approve'] },
    },
    is_new: true,
  };

  it('renders added (+) and removed (−) action chips per resource', () => {
    render(
      <TooltipProvider>
        <PreviewDiff preview={preview} />
      </TooltipProvider>,
    );
    expect(screen.getByText('New role')).toBeInTheDocument();
    // The diff badges.
    expect(screen.getByText('+close')).toBeInTheDocument();
    expect(screen.getByText('−approve')).toBeInTheDocument();
    // Effective grants rendered in a (fenced) code block as plain text.
    expect(screen.getByText(/cases: read, write, close/)).toBeInTheDocument();
  });

  it('shows a no-change message when the diff is empty', () => {
    render(
      <TooltipProvider>
        <PreviewDiff
          preview={{ ...preview, diff: {}, is_new: false }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText(/No change vs the current matrix/i)).toBeInTheDocument();
    expect(screen.getByText('Existing')).toBeInTheDocument();
  });
});
