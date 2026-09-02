/**
 * Item A — the per-case caps carry the backend's floor as UI guidance.
 *
 * `CapsConfig` declares `ge=1` on `max_tool_calls` / `max_tokens` / `timeout_seconds`
 * (0 and negatives are a broken configuration, not a stricter limit), so the fields that
 * edit them advertise `min={1}`.
 *
 * There is deliberately NO `max`: an upper bound here would encode one vendor's hosted-API
 * latency/context envelope as product policy and would fight the configuration of any
 * deployer already above it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AdvancedSection } from '../advanced';
import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

const PREFS = {
  caps: { max_tool_calls: 8, max_tokens: 20000, timeout_seconds: 120, kill_switch: false },
  rag: {},
  auto_forward_allowlist: [],
} as unknown as Preferences;

function renderSection() {
  return render(
    <TooltipProvider>
      <AdvancedSection prefs={PREFS} update={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Advanced → per-case caps bounds', () => {
  it.each([
    ['Max tool calls / case', '8'],
    ['Max tokens / case', '20000'],
    ['Timeout (seconds)', '120'],
  ])('%s advertises the backend floor and no ceiling', (label, value) => {
    renderSection();
    const input = screen.getByLabelText(label) as HTMLInputElement;
    expect(input.value).toBe(value);
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBeNull();
  });
});
