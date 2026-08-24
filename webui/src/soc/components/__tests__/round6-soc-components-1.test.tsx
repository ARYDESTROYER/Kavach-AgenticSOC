/**
 * Round-6 sweep (soc/components batch 1) — regression coverage for the audited
 * a11y / glitch fixes:
 *  - DashboardGroup: the group title is a REAL heading, not swallowed inside the
 *    trigger <button> (valid content model + heading-jump navigation).
 *  - DemoBadge / DemoIndicator: the amber affordances use the AA-tuned `-text` token
 *    instead of the failing plain `text-warning` tint.
 *  - HelpTip: the (?) trigger has a ≥24px hit target (WCAG 2.5.8).
 *  - LabeledSlider: the role="slider" thumb is named via `aria-labelledby` even
 *    when the label is a ReactNode.
 *  - TagInput: symmetric chip radius, ONE control-wide focus ring, and no spurious
 *    chip on blur-to-remove.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { DashboardGroup } from '../DashboardGroup';
import { DemoBadge } from '../DemoBadge';
import { HelpTip } from '../HelpTip';
import { LabeledSlider } from '../LabeledSlider';
import { TagInput } from '../TagInput';

vi.mock('../Can', () => ({ useCan: () => true }));

describe('DashboardGroup — heading is not nested inside the button', () => {
  it('exposes the title as a real heading at the requested level', () => {
    render(
      <DashboardGroup title="Attention queue" headingLevel={2}>
        <div>body</div>
      </DashboardGroup>,
    );
    const heading = screen.getByRole('heading', { name: /Attention queue/i, level: 2 });
    expect(heading).toBeInTheDocument();
    // The heading must WRAP the button, never live inside it (invalid nesting +
    // swallowed outline).
    const button = screen.getByRole('button', { name: /Attention queue/i });
    expect(button.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
    expect(heading.contains(button)).toBe(true);
  });

  it('respects a custom heading level', () => {
    render(
      <DashboardGroup title="Cost & budget" headingLevel={3}>
        <div>body</div>
      </DashboardGroup>,
    );
    expect(screen.getByRole('heading', { name: /Cost & budget/i, level: 3 })).toBeInTheDocument();
  });
});

describe('DemoBadge — AA warning token', () => {
  it('uses the -text token, not the failing text-warning tint', () => {
    render(<DemoBadge show iconless />);
    const badge = screen.getByText('SAMPLE');
    expect(badge.className).toContain('text-warning-text');
    // no standalone `text-warning ` foreground (word-boundary, allowing `-text`)
    expect(/text-warning(?![-])/.test(badge.className)).toBe(false);
  });
});

describe('HelpTip — hit target', () => {
  it('gives the (?) trigger a >=24px target while keeping a 14px glyph', () => {
    render(<HelpTip text="short help" label="Field help" />);
    const btn = screen.getByRole('button', { name: 'Field help' });
    expect(btn.className).toContain('min-h-6');
    expect(btn.className).toContain('min-w-6');
    // the old 16px sizing is gone
    expect(btn.className).not.toContain('h-4 w-4');
  });
});

describe('LabeledSlider — thumb accessible name', () => {
  it('names the slider thumb via aria-labelledby even for a ReactNode label', () => {
    render(
      <LabeledSlider label={<span>Threshold</span>} value={50} min={0} max={100} onChange={() => {}} />,
    );
    const slider = screen.getByRole('slider');
    const labelledBy = slider.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    // the referenced element carries the visible label text
    expect(document.getElementById(labelledBy!)?.textContent).toContain('Threshold');
    // the formatted value is announced too
    expect(slider.getAttribute('aria-valuetext')).toBe('50');
  });
});

describe('TagInput — chip glitches + blur logic', () => {
  it('renders chips with a symmetric radius (not rounded-r-sm)', () => {
    render(<TagInput label="Tags" value={['alpha']} onChange={() => {}} />);
    const chip = screen.getByText('alpha').closest('li')!;
    expect(chip.className).toContain('rounded-sm');
    expect(chip.className).not.toContain('rounded-r-sm');
  });

  it('draws ONE control-wide focus ring on the container, not the inner input', () => {
    render(<TagInput label="Tags" value={[]} onChange={() => {}} />);
    const input = screen.getByRole('textbox');
    expect(input.className).not.toContain('focus-visible:ring-2');
    const container = input.parentElement!;
    expect(container.className).toContain('focus-within:ring-2');
  });

  it('does NOT commit pending text when focus moves to a chip remove button', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={['existing']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'partial' } });
    const removeBtn = screen.getByRole('button', { name: /Remove existing/i });
    fireEvent.blur(input, { relatedTarget: removeBtn });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('DOES commit pending text when focus leaves the widget entirely', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={['existing']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'partial' } });
    fireEvent.blur(input, { relatedTarget: null });
    expect(onChange).toHaveBeenCalledWith(['existing', 'partial']);
  });
});

// DemoIndicator needs the demo context; mock it to an active tenant so the amber
// chip + its popover controls render, then assert they use the AA `-text` token.
vi.mock('@/soc/demo', () => ({
  useDemo: () => ({
    status: { mode: 'seeded', active: true, run_id: 'r1' },
    active: true,
    loading: false,
    refresh: async () => ({ mode: 'seeded', active: true, run_id: 'r1' }),
  }),
}));

describe('DemoIndicator — AA warning token', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* jsdom always provides localStorage */
    }
  });

  it('top-bar chip uses text-warning-text', async () => {
    const { DemoIndicator } = await import('../DemoIndicator');
    render(<DemoIndicator />);
    const chip = screen.getByRole('button', { name: /Demo mode active/i });
    expect(chip.className).toContain('text-warning-text');
  });

  it('popover Reset / Exit controls use text-warning-text', async () => {
    const { DemoIndicator } = await import('../DemoIndicator');
    render(<DemoIndicator />);
    fireEvent.click(screen.getByRole('button', { name: /Demo mode active/i }));
    expect(screen.getByRole('button', { name: /^Reset$/i }).className).toContain('text-warning-text');
    expect(screen.getByRole('button', { name: /Exit & clear/i }).className).toContain('text-warning-text');
  });
});
