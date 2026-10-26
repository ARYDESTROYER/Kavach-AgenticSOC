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
import { fireEvent, render, screen } from '@testing-library/react';

import { AdvancedSection } from '../advanced';
import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

const PREFS = {
  caps: { max_tool_calls: 8, max_tokens: 20000, timeout_seconds: 120, kill_switch: false },
  rag: {},
  auto_forward_allowlist: [],
} as unknown as Preferences;

function renderSection() {
  const update = vi.fn();
  render(
    <TooltipProvider>
      <AdvancedSection prefs={PREFS} update={update} />
    </TooltipProvider>,
  );
  return update;
}

/** Type a value into a field and leave it, as an operator would. */
function commit(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

/** The cap the last preference patch carried for `key`. */
function lastCap(update: ReturnType<typeof vi.fn>, key: string): unknown {
  const patch = update.mock.calls.at(-1)?.[0] as { caps?: Record<string, unknown> } | undefined;
  return patch?.caps?.[key];
}

describe('Advanced → per-case caps bounds', () => {
  // Round 14: the caps are the shared NumberField (no raw number input, so no `min`
  // attribute to read); the floor is pinned by what a typed value commits.
  it.each([
    ['Max tool calls / case', '8', 'max_tool_calls'],
    ['Max tokens / case', '20000', 'max_tokens'],
    ['Timeout (seconds)', '120', 'timeout_seconds'],
  ])('%s enforces the backend floor and has no ceiling', (label, value, key) => {
    const update = renderSection();
    const input = screen.getByLabelText(label) as HTMLInputElement;
    expect(input.value).toBe(value);
    // The floor: 0 is a broken configuration, so it commits the minimum, 1.
    commit(input, '0');
    expect(lastCap(update, key)).toBe(1);
    // No ceiling: a deployer above any vendor envelope keeps the value they typed.
    commit(input, '987654321');
    expect(lastCap(update, key)).toBe(987654321);
  });
});
