/**
 * Runbooks settings section (Round 14, SPEC §4.9.6 and §4.10.19).
 *
 * Proves that the section
 *   - mirrors the backend `RunbookConfig` (every key and its default is read back from
 *     `backend/app/config.py`, so a backend change without an editor change fails here),
 *   - repairs a stored block the way `RunbookConfig._repair` does (a non-boolean switch
 *     takes its default; the review cadence is clamped into 30 to 730 days),
 *   - edits through the shared `{prefs, update}` buffer with one `runbooks` patch that
 *     keeps keys it does not know and the migration marker,
 *   - dims and disables everything under the feature switch when Runbooks are off, and
 *     the fallback when nothing is attached automatically, and
 *   - links to the Runbook library and never says "playbook".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import {
  RUNBOOK_REVIEW_DAYS_BOUNDS,
  RUNBOOK_SETTINGS_DEFAULTS,
  RunbooksSection,
  runbooksConfig,
} from '../runbooks';

expect.extend(toHaveNoViolations);

const CONFIG_PY = readFileSync(path.resolve(__dirname, '../../../../../../backend/app/config.py'), 'utf8');

/** The body of `class RunbookConfig(BaseModel):` up to the next top-level class. */
function runbookConfigSource(): string {
  const start = CONFIG_PY.indexOf('class RunbookConfig(');
  expect(start).toBeGreaterThan(-1);
  const rest = CONFIG_PY.slice(start + 1);
  const end = rest.search(/\nclass \w+/);
  return end === -1 ? rest : rest.slice(0, end);
}

function renderSection(runbooks?: Record<string, unknown>) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const prefs = (runbooks ? { runbooks } : {}) as unknown as Preferences;
  const utils = render(
    <TooltipProvider>
      <RunbooksSection prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  const lastPatch = () => (update.mock.calls.at(-1)?.[0] as { runbooks: Record<string, unknown> }).runbooks;
  return { update, lastPatch, ...utils };
}

describe('runbooksConfig mirrors the backend RunbookConfig', () => {
  it('uses the backend default for every switch and the review cadence', () => {
    const src = runbookConfigSource();
    for (const [key, value] of Object.entries(RUNBOOK_SETTINGS_DEFAULTS)) {
      if (typeof value === 'boolean') {
        expect(src, key).toMatch(new RegExp(`\\n\\s+${key}: bool = ${value ? 'True' : 'False'}\\b`));
      }
    }
    expect(src).toMatch(/review_every_days_default: int = Field\(\s*default=RUNBOOK_REVIEW_DAYS_DEFAULT,/);
    expect(CONFIG_PY).toMatch(/\nRUNBOOK_REVIEW_DAYS_DEFAULT = 180\n/);
    expect(CONFIG_PY).toMatch(/\nRUNBOOK_REVIEW_DAYS_MIN = 30\n/);
    expect(CONFIG_PY).toMatch(/\nRUNBOOK_REVIEW_DAYS_MAX = 730\n/);
    expect(RUNBOOK_SETTINGS_DEFAULTS.review_every_days_default).toBe(180);
    // Every boolean field of the model has a row in the editor's defaults.
    const fields = [...src.matchAll(/\n\s{4}(\w+): bool = /g)].map((m) => m[1]).sort();
    expect(Object.keys(RUNBOOK_SETTINGS_DEFAULTS).filter((k) => k !== 'review_every_days_default').sort()).toEqual(fields);
  });

  it('fills a missing block with the defaults', () => {
    expect(runbooksConfig({} as Preferences)).toEqual(RUNBOOK_SETTINGS_DEFAULTS);
  });

  it('gives a non-boolean switch its default and clamps the cadence into 30 to 730 days', () => {
    const [lo, hi] = RUNBOOK_REVIEW_DAYS_BOUNDS;
    expect(lo).toBe(30);
    expect(hi).toBe(730);
    const low = runbooksConfig({ runbooks: { auto_attach: 'yes', step_approvals: true, review_every_days_default: 5 } } as never);
    expect(low.auto_attach).toBe(true);
    expect(low.step_approvals).toBe(true);
    expect(low.review_every_days_default).toBe(30);
    expect(runbooksConfig({ runbooks: { review_every_days_default: 9999 } } as never).review_every_days_default).toBe(730);
    expect(runbooksConfig({ runbooks: { review_every_days_default: 'soon' } } as never).review_every_days_default).toBe(180);
  });

  it('carries the migration marker through untouched', () => {
    expect(runbooksConfig({ runbooks: { runbooks_config_version: 3 } } as never).runbooks_config_version).toBe(3);
  });
});

describe('RunbooksSection', () => {
  it('shows the four groups and the library link, with every switch at its default', () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Runbooks', level: 2 })).toBeInTheDocument();
    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(['Library', 'Runbooks on cases', 'Agent and AI help', 'Publishing and review']);
    expect(screen.getByRole('switch', { name: 'Runbooks enabled' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Attach the matching runbook' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Offer Draft note on Check steps' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'The publisher must differ from the author' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Honour step approvals' })).not.toBeChecked();
    expect(screen.getByRole('link', { name: /Runbook library/ })).toHaveAttribute('href', '#/runbooks');
    expect((screen.getByLabelText('Review new runbooks every') as HTMLInputElement).value).toBe('180');
  });

  it('writes one runbooks patch that keeps unknown keys and the migration marker', () => {
    const { update, lastPatch } = renderSection({ runbooks_config_version: 2, future_key: 'kept' });
    fireEvent.click(screen.getByRole('switch', { name: 'Attach the matching runbook' }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = lastPatch();
    expect(patch.auto_attach).toBe(false);
    expect(patch.future_key).toBe('kept');
    expect(patch.runbooks_config_version).toBe(2);
    // The rest of the block is written as shown (the repaired values).
    expect(patch.enabled).toBe(true);
    expect(patch.rag_corpus).toBe(true);
  });

  it('clamps a typed review cadence into the backend range', () => {
    const { lastPatch } = renderSection();
    const days = screen.getByLabelText('Review new runbooks every') as HTMLInputElement;
    fireEvent.focus(days);
    fireEvent.change(days, { target: { value: '5' } });
    fireEvent.blur(days);
    expect(lastPatch().review_every_days_default).toBe(30);
    fireEvent.focus(days);
    fireEvent.change(days, { target: { value: '400' } });
    fireEvent.blur(days);
    expect(lastPatch().review_every_days_default).toBe(400);
  });

  it('disables everything under the switch when Runbooks are off, and the fallback without auto-attach', () => {
    const { unmount } = renderSection({ enabled: false });
    for (const name of ['Attach the matching runbook', 'Use Published runbooks in retrieval', 'Honour step approvals']) {
      expect(screen.getByRole('switch', { name })).toBeDisabled();
    }
    expect(screen.getByLabelText('Review new runbooks every')).toBeDisabled();
    unmount();
    renderSection({ auto_attach: false });
    expect(screen.getByRole('switch', { name: 'Attach Generic incident when nothing matches' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Guide the agent with the matching runbook' })).toBeEnabled();
  });

  it('never says playbook and has no em dashes or accessibility violations', async () => {
    const { container } = renderSection();
    expect(container.textContent?.toLowerCase()).not.toContain('playbook');
    expect(container.textContent).not.toMatch(/—/);
    expect(await axe(container)).toHaveNoViolations();
  });
});
