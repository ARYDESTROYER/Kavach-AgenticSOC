/**
 * Round 15 (SPEC D6.2): the Settings, Detection "Auto-close review" group.
 *
 *   - it sits beside the auto-close bars and edits `prefs.auto_close_review` only;
 *   - the share is edited as a percent (5% is 0.05) within 0 to 50%;
 *   - the fields disable with the switch;
 *   - `auto_close_review` has one editor: it is in `CURATED_SECTIONS` (hidden from All
 *     settings) and in the Detection section's `ownedKeys`.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';

import { AUTO_CLOSE_REVIEW_DEFAULTS, DetectionSection } from '../detection';
import { SECTION_META_BY_ID } from '../settings-sections-meta';

function renderSection(prefs: Partial<Preferences> = {}) {
  const update = vi.fn<[Partial<Preferences>], void>();
  render(
    <TooltipProvider>
      <DetectionSection prefs={prefs as Preferences} update={update} />
    </TooltipProvider>,
  );
  return update;
}

describe('the Auto-close review group', () => {
  it('renders after the auto-close bars with the shipped defaults', () => {
    renderSection();
    const group = document.getElementById('detection-autoclose-review');
    expect(group).toBeTruthy();
    expect(screen.getByRole('switch', { name: /send automatic closes for review/i })).toHaveAttribute('aria-checked', 'true');
    expect((screen.getByLabelText('Share of automatic closes picked') as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText('Most picked in a day') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('Most of one rule in a day') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Days before a review expires') as HTMLInputElement).value).toBe('7');
    const autoclose = document.getElementById('detection-autoclose')!;
    const order = autoclose.compareDocumentPosition(group!);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('writes prefs.auto_close_review, the share as a fraction', () => {
    const update = renderSection({ auto_close_review: { ...AUTO_CLOSE_REVIEW_DEFAULTS } });
    const share = screen.getByLabelText('Share of automatic closes picked') as HTMLInputElement;
    fireEvent.change(share, { target: { value: '12' } });
    fireEvent.blur(share);
    const patch = update.mock.calls.at(-1)![0] as { auto_close_review?: Record<string, unknown> };
    expect(Object.keys(update.mock.calls.at(-1)![0])).toEqual(['auto_close_review']);
    expect(patch.auto_close_review).toEqual({ ...AUTO_CLOSE_REVIEW_DEFAULTS, sample_rate: 0.12 });
    fireEvent.click(screen.getByRole('switch', { name: /send automatic closes for review/i }));
    expect((update.mock.calls.at(-1)![0] as { auto_close_review: { enabled: boolean } }).auto_close_review.enabled).toBe(false);
  });

  it('disables the fields with the switch', () => {
    renderSection({ auto_close_review: { ...AUTO_CLOSE_REVIEW_DEFAULTS, enabled: false } });
    expect(screen.getByLabelText('Most picked in a day')).toBeDisabled();
    expect(screen.getByLabelText('Days before a review expires')).toBeDisabled();
  });
});

describe('one editor for auto_close_review', () => {
  it('is owned by Detection and curated out of All settings', () => {
    expect(SECTION_META_BY_ID.detection.ownedKeys).toContain('auto_close_review');
    const schema = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'advanced-schema.tsx'), 'utf8');
    const curated = schema.slice(schema.indexOf('const CURATED_SECTIONS'), schema.indexOf(']);'));
    expect(curated).toContain("'auto_close_review'");
  });
});
