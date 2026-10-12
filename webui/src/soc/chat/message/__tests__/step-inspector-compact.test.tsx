/**
 * The step inspector's "What the model saw" (Round 12 final polish, screenshot tour 13):
 * it opened on thirty lines of `null` for a not-measured alert series before the cases
 * data. The compact view counts a not-measured run once and keeps short lists on one
 * line; the exact JSON is one click away and is always what Copy takes.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  getStepObservation: vi.fn(),
  copyText: vi.fn(async () => true),
}));

vi.mock('@/lib/clipboard', () => ({ copyText: mocks.copyText, default: mocks.copyText }));
vi.mock('../../chat-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../chat-api')>();
  return { ...actual, getStepObservation: mocks.getStepObservation };
});

import { StepInspector, compactJson, visibleJson } from '../StepInspector';
import type { RunLogStep } from '../RunLog';
import { step } from './fixtures';

const TRENDS = {
  alerts: [...Array<null>(29).fill(null), 186],
  buckets: [
    { label: '13 Sep', in_progress: false },
    { label: '12 Oct', in_progress: true },
  ],
  new_cases: [0, 0, 1, 2],
  window: 'last 30 days (since 13 Sep 2026)',
  fp_rate_percent: [null, 50, null],
};

describe('compactJson', () => {
  it('counts a not-measured run once and keeps every value', () => {
    const text = compactJson(TRENDS);
    expect(text).toContain('"alerts": [null × 29 (not measured), 186]');
    expect(text).toContain('{ "label": "13 Sep", "in_progress": false }');
    expect(text).toContain('"new_cases": [0, 0, 1, 2]');
    // Short runs stay as they are: a single not-measured point is not a run.
    expect(text).toContain('"fp_rate_percent": [null, 50, null]');
    expect(text.split('\n').length).toBeLessThan(visibleJson(TRENDS).split('\n').length / 4);
  });

  it('writes invisible characters as escapes, as the exact view does', () => {
    expect(compactJson({ user: 'admin\u200b', rows: [1, 2, 3] })).toBe('{\n  "user": "admin\\u200b",\n  "rows": [1, 2, 3]\n}');
    expect(compactJson({ user: 'admin\u200b', n: 1 })).toBe('{ "user": "admin\\u200b", "n": 1 }');
  });
});

describe('StepInspector observation view', () => {
  function renderInspector() {
    const base = step(2, { tool: 'soc_metrics', label: 'Read SOC metrics', observation_ref: 'obs-1' });
    const runStep: RunLogStep = {
      index: 2,
      kind: 'tool',
      tool: 'soc_metrics',
      label: 'Read SOC metrics',
      params: base.params,
      group: null,
      status: 'ok',
      result: base,
    };
    return render(
      <StepInspector step={runStep} open conversationId="conv-1" messageId="m-1" onOpenChange={() => undefined} />,
    );
  }

  it('opens on the compact view, toggles to the exact JSON, and copies the exact JSON', async () => {
    mocks.getStepObservation.mockResolvedValue({
      conversation_id: 'conv-1',
      message_id: 'm-1',
      index: 2,
      tool: 'soc_metrics',
      status: 'ok',
      label: 'Read SOC metrics',
      summary: 'Trends by day',
      observation: TRENDS,
      params: {},
      truncated: false,
      stored_at: null,
      suggestions: [],
    });
    const user = userEvent.setup();
    renderInspector();
    const sheet = await screen.findByTestId('step-inspector');
    const block = await within(sheet).findByTestId('step-inspector-observation');
    expect(block).toHaveAttribute('data-view', 'compact');
    expect(block).toHaveTextContent('null × 29 (not measured)');
    expect(within(sheet).getByTestId('step-inspector-view-note')).toHaveTextContent('Copy takes the exact result.');

    await user.click(within(block).getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith(visibleJson(TRENDS)));

    // The button names the view it switches to (its label changes; no pressed state too).
    const toggle = within(sheet).getByRole('button', { name: 'Show exact result' });
    expect(toggle).toHaveAttribute('aria-controls', block.id);
    await user.click(toggle);
    expect(block).toHaveAttribute('data-view', 'exact');
    expect(block.textContent).toContain('null,\n');
    await user.click(within(sheet).getByRole('button', { name: 'Show compact view' }));
    expect(block).toHaveAttribute('data-view', 'compact');
  });

  it('offers no toggle when the compact view would read the same', async () => {
    mocks.getStepObservation.mockResolvedValue({
      conversation_id: 'conv-1',
      message_id: 'm-1',
      index: 2,
      tool: 'soc_metrics',
      status: 'ok',
      label: 'Read SOC metrics',
      summary: 'One figure',
      observation: { total: 4 },
      params: {},
      truncated: false,
      stored_at: null,
      suggestions: [],
    });
    renderInspector();
    const sheet = await screen.findByTestId('step-inspector');
    const block = await within(sheet).findByTestId('step-inspector-observation');
    expect(block).toHaveAttribute('data-view', 'exact');
    expect(within(sheet).queryByRole('button', { name: 'Show exact result' })).toBeNull();
  });
});
