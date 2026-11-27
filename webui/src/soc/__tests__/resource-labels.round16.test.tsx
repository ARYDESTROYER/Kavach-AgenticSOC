/**
 * B57 (Round 16 SPEC §4.5 WP15E): one `RESOURCE_LABELS` map with a `resourceLabel()`
 * fallback names every permission resource, wherever the Roles and Users pages list them.
 * `rag` and `inapp` read "Knowledge corpus" and "In-app notifications", never the raw
 * tokens "Rag" and "Inapp".
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import { RoleMatrixEditor, type RoleDraft } from '../components/RoleMatrixEditor';
import { RolePermissionSummary } from '../components/RolePermissionSummary';
import { PreviewDiff } from '../pages/Roles';
import { RESOURCE_LABELS, resourceLabel, type RolePreviewResponse } from '../pages/Roles.api';

const RAW = /^(Rag|Inapp)$/;

describe('B57: resource names', () => {
  it('names the four tokens and falls back to a readable token for the rest', () => {
    expect(resourceLabel('rag')).toBe('Knowledge corpus');
    expect(resourceLabel('inapp')).toBe('In-app notifications');
    expect(resourceLabel('data_export')).toBe('Data export');
    expect(resourceLabel('system_updates')).toBe('System updates');
    expect(resourceLabel('cases')).toBe('Cases');
    expect(Object.keys(RESOURCE_LABELS).sort()).toEqual(['data_export', 'inapp', 'rag', 'system_updates']);
  });

  it('the Add user grants list reads the names, never the tokens', () => {
    render(
      <RolePermissionSummary
        roleName="analyst_tier1"
        matrix={{ analyst_tier1: { rag: ['read'], inapp: ['read'], cases: ['read'] } }}
      />,
    );
    expect(screen.getByText('Knowledge corpus')).toBeInTheDocument();
    expect(screen.getByText('In-app notifications')).toBeInTheDocument();
    expect(screen.queryByText('Rag')).toBeNull();
    expect(screen.queryByText('Inapp')).toBeNull();
  });

  it('the custom role matrix rows read the names', () => {
    const draft: RoleDraft = { name: 'r', description: '', inherits: [], grants: {}, denies: {} };
    render(
      <TooltipProvider>
        <RoleMatrixEditor draft={draft} onChange={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Knowledge corpus')).toBeInTheDocument();
    expect(screen.getByText('In-app notifications')).toBeInTheDocument();
    expect(screen.queryByText('Rag')).toBeNull();
    expect(screen.queryByText('Inapp')).toBeNull();
  });

  it('the role preview diff reads the names', () => {
    const preview = {
      role: 'r',
      effective: { rag: ['read'] },
      diff: { rag: { added: ['read'], removed: [] }, inapp: { added: [], removed: ['manage'] } },
      is_new: true,
    } as unknown as RolePreviewResponse;
    render(
      <TooltipProvider>
        <PreviewDiff preview={preview} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Knowledge corpus')).toBeInTheDocument();
    expect(screen.getByText('In-app notifications')).toBeInTheDocument();
    expect(screen.queryByText(RAW)).toBeNull();
  });
});
