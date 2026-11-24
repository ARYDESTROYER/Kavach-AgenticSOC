/**
 * Settings, General, Detection: Cross-source correlation (Round 15 final screenshot pass).
 *
 * The server turns it on by default (`CrossSourceCorrelationConfig.enabled = True` in
 * `backend/app/config.py`, since the Autopilot overhaul). The row says so, and a stored
 * preference without the value reads on, as the server does; an explicit off stays off.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

import { DetectionSection } from '../detection';

function renderGroup(prefs: Partial<Preferences>) {
  render(
    <TooltipProvider>
      <DetectionSection prefs={prefs as Preferences} update={vi.fn()} />
    </TooltipProvider>,
  );
  const group = document.getElementById('detection-crosssource');
  expect(group).not.toBeNull();
  return group as HTMLElement;
}

describe('Detection: Cross-source correlation', () => {
  it('says it is on by default, and an absent value reads on', () => {
    const group = renderGroup({});
    const toggle = within(group).getByRole('switch', { name: 'Cross-source correlation' });
    expect(toggle).toHaveAccessibleDescription('On by default.');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(group).not.toHaveTextContent('Off by default');
    expect(within(group).getByRole('spinbutton', { name: /Time window/ })).toBeEnabled();
  });

  it('keeps an explicit off', () => {
    const group = renderGroup({ cross_source_correlation: { enabled: false } } as unknown as Partial<Preferences>);
    expect(within(group).getByRole('switch', { name: 'Cross-source correlation' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByRole('spinbutton', { name: /Time window/ })[0]).toBeDisabled();
  });
});
