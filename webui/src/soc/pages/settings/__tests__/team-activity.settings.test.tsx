/**
 * Round 15 (SPEC D3.4): the Team activity switch has one home, a "Team activity" group in
 * Settings, Single sign-on & policy, right after Posture. `team_activity` is a curated key
 * (the Advanced long tail never offers a second editor), owned by the `security` section,
 * and a Settings search for it lands on the group's anchor.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { schemaMock } = vi.hoisted(() => ({ schemaMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getSettingsSchema: schemaMock },
  ApiError: class ApiError extends Error {},
}));

import type { Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import { AdvancedSchemaSection } from '../advanced-schema';
import { SECTION_META_BY_ID, SETTING_ANCHORS, searchJumpTargets } from '../settings-sections-meta';
import { TeamActivitySettingsGroup } from '../team-activity';

describe('the Team activity switch', () => {
  it('reads on by default and writes team_activity.enabled through the page update', () => {
    const update = vi.fn();
    render(
      <TooltipProvider>
        <TeamActivitySettingsGroup prefs={{} as Preferences} update={update} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('group', { name: 'Team activity' })).toHaveAttribute('id', 'security-team-activity');
    const toggle = screen.getByRole('switch', { name: /Team activity page/ });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ team_activity: { enabled: false } });
  });

  it('shows a stored off value as off', () => {
    render(
      <TooltipProvider>
        <TeamActivitySettingsGroup prefs={{ team_activity: { enabled: false } } as Preferences} update={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('switch', { name: /Team activity page/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('sits right after Posture in Single sign-on & policy', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/soc/pages/settings/security.tsx'), 'utf8');
    const posture = source.indexOf('title="Posture"');
    const group = source.indexOf('<TeamActivitySettingsGroup');
    const sso = source.indexOf('<SecuritySsoInner');
    expect(posture).toBeGreaterThan(-1);
    expect(group).toBeGreaterThan(posture);
    expect(sso).toBeGreaterThan(group);
  });

  it('is owned by the security section and found by a Settings search', () => {
    expect(SECTION_META_BY_ID.security?.ownedKeys).toContain('team_activity');
    expect(SETTING_ANCHORS.find((a) => a.anchor === 'security-team-activity')?.section).toBe('security');
    const hits = searchJumpTargets('team activity', () => true);
    expect(hits.some((t) => t.anchor === 'security-team-activity')).toBe(true);
  });

  it('is hidden from the Advanced long tail (one editor per knob)', async () => {
    schemaMock.mockResolvedValueOnce({
      sections: [
        {
          key: 'general',
          title: 'General',
          kind: 'group' as const,
          model: null,
          fields: [
            { name: 'data_view_pattern', type: 'string' as const, default: 'all-logs-*', required: false, choices: null, description: null },
          ],
        },
        {
          key: 'team_activity',
          title: 'Team activity',
          kind: 'object' as const,
          model: 'TeamActivityConfig',
          fields: [
            { name: 'enabled', type: 'boolean' as const, default: true, required: false, choices: null, description: 'Show the Team activity page.' },
          ],
        },
      ],
    });
    render(
      <TooltipProvider>
        <AdvancedSchemaSection prefs={{} as Preferences} update={vi.fn()} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText('Data view pattern')).toBeInTheDocument());
    expect(screen.queryByText('Team activity')).not.toBeInTheDocument();
  });
});
