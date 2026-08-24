/**
 * The two login identity accents — the shine CTA and the appearance pill.
 *
 * These tests pin the contracts that are easy to break while "just" restyling:
 * the accessible name of the CTA (a decorative sweep span inside a button will
 * silently poison `getByRole('button', { name })` if it is ever un-hidden), the
 * pill's state semantics, and the structural rules that the measured contrast
 * depends on — the opaque track sitting above the flair, and the glyphs living
 * in fixed side cells the label cannot enter.
 *
 * The colour maths itself is enforced separately, from theme.css, in
 * `design-gates.test.ts`.
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShineButton } from '@/soc/components/auth/ShineButton';
import { ThemeModePill } from '@/soc/components/auth/ThemeModePill';

describe('ShineButton', () => {
  it('takes its accessible name from the label alone, with the decoration hidden', () => {
    render(<ShineButton>Sign in</ShineButton>);
    // The exact-string lookup the login suite uses everywhere.
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toBeInTheDocument();
    const sweep = button.querySelector('.login-shine-button__sweep');
    expect(sweep).not.toBeNull();
    expect(sweep).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the sweep hidden and the name intact when an icon is present', () => {
    render(
      <ShineButton icon={<svg data-testid="spinner" aria-hidden />}>Signing in…</ShineButton>,
    );
    // The icon must not leak into the name — the busy label is the whole name.
    const button = screen.getByRole('button', { name: 'Signing in…' });
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    // And the decoration stays hidden in this arrangement too, not just the bare one.
    expect(button.querySelector('.login-shine-button__sweep')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('renders the icon inside the face but OUTSIDE the gradient-clipped label', () => {
    // The label is `-webkit-text-fill-color: transparent`; an icon nested inside it
    // would inherit that and vanish, so the split is load-bearing, not cosmetic.
    render(<ShineButton icon={<svg data-testid="spinner" aria-hidden />}>Sign in</ShineButton>);
    const label = document.querySelector('.login-shine-button__label');
    const face = document.querySelector('.login-shine-button__face');
    const icon = screen.getByTestId('spinner');
    expect(face?.contains(icon)).toBe(true);
    expect(label?.contains(icon)).toBe(false);
    expect(label).toHaveTextContent('Sign in');
  });

  it('merges caller classes onto the button and defaults to type="button"', () => {
    const { rerender } = render(<ShineButton className="ml-auto flex h-10">Continue</ShineButton>);
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toHaveClass('login-shine-button', 'ml-auto', 'flex', 'h-10');
    expect(button).toHaveAttribute('type', 'button');
    rerender(<ShineButton type="submit">Continue</ShineButton>);
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveAttribute('type', 'submit');
  });

  it('marks the busy state distinctly from the inert one', () => {
    // The CTA is `disabled` both while nothing is typed AND while submitting.
    // Those must not look the same: flattening the button the instant it is
    // clicked reads as the form going dead, so the CSS excludes `[data-busy]`
    // from the disabled treatment and this is the hook it keys off.
    const { rerender } = render(
      <ShineButton disabled>Sign in</ShineButton>,
    );
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toHaveAttribute('data-busy');
    rerender(
      <ShineButton disabled busy icon={<svg data-testid="spinner" aria-hidden />}>
        Signing in…
      </ShineButton>,
    );
    const busyButton = screen.getByRole('button', { name: 'Signing in…' });
    expect(busyButton).toHaveAttribute('data-busy', 'true');
    expect(busyButton).toBeDisabled();
  });

  it('forwards disabled and does not fire onClick while disabled', () => {
    const onClick = vi.fn();
    render(
      <ShineButton disabled onClick={onClick}>
        Sign in
      </ShineButton>,
    );
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('ThemeModePill', () => {
  it('names the mode it is currently in and switches to the other one', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ThemeModePill dark={false} onToggle={onToggle} />);

    const light = screen.getByRole('button', { name: 'Light mode — switch to dark mode' });
    expect(light).toHaveAttribute('data-appearance', 'light');
    expect(light).toHaveTextContent('Light mode');
    fireEvent.click(light);
    expect(onToggle).toHaveBeenCalledWith('dark');

    rerender(<ThemeModePill dark onToggle={onToggle} />);
    const dark = screen.getByRole('button', { name: 'Dark mode — switch to light mode' });
    expect(dark).toHaveAttribute('data-appearance', 'dark');
    expect(dark).toHaveTextContent('Dark mode');
    fireEvent.click(dark);
    expect(onToggle).toHaveBeenLastCalledWith('light');
  });

  it('opens its accessible name with the visible label (WCAG 2.5.3 Label in Name)', () => {
    render(<ThemeModePill dark={false} onToggle={() => {}} />);
    const pill = screen.getByRole('button', { name: /^Light mode/ });
    const visible = pill.querySelector('.login-theme-pill__label')?.textContent ?? '';
    expect(visible).toBe('Light mode');
    // A voice-control user saying the visible label must match the name.
    expect(pill.getAttribute('aria-label')?.startsWith(visible)).toBe(true);
  });

  it('hides every decorative layer from assistive technology', () => {
    render(<ThemeModePill dark onToggle={() => {}} />);
    const pill = screen.getByRole('button', { name: /^Dark mode/ });
    for (const selector of [
      '.login-theme-pill__flair',
      '.login-theme-pill__track',
      '.login-theme-pill__icon--moon',
      '.login-theme-pill__icon--sun',
    ]) {
      expect(pill.querySelector(selector), selector).toHaveAttribute('aria-hidden', 'true');
    }
    // The label is the only text, so the name never picks up glyph alt text.
    expect(pill).toHaveTextContent('Dark mode');
  });

  it('orders the flair, the track and the three cells as the CSS layering expects', () => {
    // DOM order is only a PROXY for the paint order here — an explicit z-index beats
    // it in both directions, so the real guarantee (flair below an opaque track) is
    // asserted from theme.css by the `login accents` gate, in design-gates.test.ts.
    // What this pins is the structure that CSS is written against: the flair and
    // track exist and are out of flow, and the glyphs own the two fixed side cells
    // so the label can never drift over the bright end of either ramp.
    render(<ThemeModePill dark={false} onToggle={() => {}} />);
    const pill = screen.getByRole('button', { name: /^Light mode/ });
    const children = Array.from(pill.children);
    const flairIndex = children.findIndex((c) => c.classList.contains('login-theme-pill__flair'));
    const trackIndex = children.findIndex((c) => c.classList.contains('login-theme-pill__track'));
    expect(flairIndex).toBeGreaterThanOrEqual(0);
    expect(trackIndex).toBeGreaterThan(flairIndex);

    // Grid order: moon, label, sun — the glyphs own the two fixed side cells.
    const flow = children
      .filter((c) => !c.classList.contains('login-theme-pill__flair'))
      .filter((c) => !c.classList.contains('login-theme-pill__track'))
      .map((c) => c.className);
    expect(flow).toHaveLength(3);
    expect(flow[0]).toContain('login-theme-pill__icon--moon');
    expect(flow[1]).toContain('login-theme-pill__label');
    expect(flow[2]).toContain('login-theme-pill__icon--sun');
  });
});
