/**
 * Discounted inference settings section (Round 14, D30: moved here from the Jobs page).
 *
 * Proves that the section mirrors the backend `BatchConfig` defaults (read back from
 * `backend/app/config.py`), edits `Preferences.batch` through the page buffer while
 * keeping stored keys it does not show (the legacy `flex` field), names the severity
 * floor in words, and stores providers lower-cased with duplicates dropped.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { BatchConfig, Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import { DEFAULT_BATCH_CONFIG, DiscountedInferenceSection, SEVERITY_FLOOR_OPTIONS } from '../discounted-inference';

expect.extend(toHaveNoViolations);

const CONFIG_PY = readFileSync(path.resolve(__dirname, '../../../../../../backend/app/config.py'), 'utf8');

function batchConfigSource(): string {
  const start = CONFIG_PY.indexOf('class BatchConfig(');
  expect(start).toBeGreaterThan(-1);
  const rest = CONFIG_PY.slice(start + 1);
  const end = rest.search(/\nclass \w+/);
  return end === -1 ? rest : rest.slice(0, end);
}

function renderSection(batch?: BatchConfig, readOnly = false) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const prefs = (batch ? { batch } : {}) as Preferences;
  const utils = render(
    <TooltipProvider>
      <DiscountedInferenceSection prefs={prefs} update={update} readOnly={readOnly} />
    </TooltipProvider>,
  );
  const lastPatch = () => (update.mock.calls.at(-1)?.[0] as { batch: BatchConfig }).batch;
  return { update, lastPatch, ...utils };
}

describe('DiscountedInferenceSection', () => {
  it('mirrors the backend BatchConfig defaults', () => {
    const src = batchConfigSource();
    expect(src).toMatch(/\n\s+enabled: bool = False\b/);
    expect(src).toMatch(/severity_floor: int = Field\(default=3, ge=1, le=6\)/);
    expect(src).toMatch(/default_factory=lambda: \["anthropic", "openai"\]/);
    expect(src).toMatch(/\n\s+prefer_discounted_alerts: bool = True\b/);
    expect(src).toMatch(/\n\s+fallback_to_standard: bool = True\b/);
    expect(DEFAULT_BATCH_CONFIG).toEqual({
      enabled: false,
      severity_floor: 3,
      providers: ['anthropic', 'openai'],
      prefer_discounted_alerts: true,
      fallback_to_standard: true,
    });
    expect(SEVERITY_FLOOR_OPTIONS.map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('shows the live preference on and the Batch queue off by default', () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Discounted inference', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Live alert investigations', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Asynchronous Batch queue', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Prefer discounted alert inference' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Standard fallback' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Batch routing' })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Severity floor' })).toHaveTextContent('Medium');
  });

  it('writes the batch block and keeps stored keys it does not show', () => {
    const { lastPatch } = renderSection({ flex: true, severity_floor: 2 });
    fireEvent.click(screen.getByRole('switch', { name: 'Prefer discounted alert inference' }));
    expect(lastPatch()).toEqual({ flex: true, severity_floor: 2, prefer_discounted_alerts: false });
    fireEvent.click(screen.getByRole('switch', { name: 'Batch routing' }));
    expect(lastPatch()).toEqual({ flex: true, severity_floor: 2, enabled: true });
  });

  it('stores providers lower-cased with duplicates dropped', () => {
    const { update, lastPatch } = renderSection({ providers: ['openai'] });
    const field = screen.getByLabelText('Batch providers');
    // A duplicate typed in another case never adds a second entry.
    fireEvent.change(field, { target: { value: 'OpenAI' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    if (update.mock.calls.length > 0) expect(lastPatch().providers).toEqual(['openai']);
    fireEvent.change(field, { target: { value: ' Anthropic ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(lastPatch().providers).toEqual(['openai', 'anthropic']);
  });

  it('clamps a stored severity floor into the named range', () => {
    renderSection({ severity_floor: 42 });
    const floor = screen.getByRole('combobox', { name: 'Severity floor' });
    expect(within(floor).getByText('Fatal')).toBeInTheDocument();
  });

  it('has no em dashes and no accessibility violations', async () => {
    const { container } = renderSection();
    expect(container.textContent).not.toMatch(/—/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('DiscountedInferenceSection without settings management', () => {
  it('shows the policy with every control disabled, as it was on Jobs', () => {
    const { update } = renderSection(undefined, true);
    for (const name of ['Prefer discounted alert inference', 'Standard fallback', 'Batch routing']) {
      const sw = screen.getByRole('switch', { name });
      expect(sw).toBeDisabled();
      fireEvent.click(sw);
    }
    expect(screen.getByRole('combobox', { name: 'Severity floor' })).toBeDisabled();
    expect(screen.getByLabelText('Batch providers')).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps every control live for a viewer who can save', () => {
    renderSection();
    expect(screen.getByRole('switch', { name: 'Batch routing' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Severity floor' })).toBeEnabled();
  });
});

