/**
 * The sticky save bar (Round 14 closing fixes qa1-01 and qa1-10): on a narrow pane the
 * message takes a full line of its own above Discard and Save under a 40rem bar (it was
 * squeezed beside them into an 80 px column, five lines tall on a phone); the bar's ref
 * reaches the bar while it shows; and while the bar sits where the bottom toasts are it
 * lifts them clear of Discard and Save itself, so every page that pins it (Settings,
 * Baseline, Campaigns, Tuning, the dashboard editor) keeps a failed Save's error toast
 * off the Save button.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StickySaveBar } from '@/soc/components/SettingsGrid';
import { bottomBarClearance, TOAST_CLEARANCE_VAR } from '@/soc/hooks/useToastClearance';

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(TOAST_CLEARANCE_VAR);
});

/** Place every save bar at `top`, `height` px tall (jsdom has no layout). */
function placeBar(top: number, height: number) {
  const base = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('[role="region"][aria-label="Unsaved changes"]')) {
      return DOMRect.fromRect({ x: 0, y: top, width: 1000, height });
    }
    return base.call(this);
  });
}

describe('StickySaveBar on a narrow pane', () => {
  it('is a size container whose message takes its own line under 40rem', () => {
    render(<StickySaveBar visible onSave={() => {}} onDiscard={() => {}} message="You have unsaved changes." />);
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.className).toContain('@container/savebar');
    expect(bar.className).toContain('flex-wrap');
    const message = screen.getByText('You have unsaved changes.', { selector: '[data-save-bar-message]' });
    // A full-width line by default, sharing the row with the buttons from 40rem.
    expect(message.className).toContain('basis-full');
    expect(message.className).toContain('grow');
    expect(message.className).toContain('@[40rem]/savebar:basis-0');
    // The buttons keep their size and sit at the end of their line.
    const buttons = screen.getByRole('button', { name: 'Discard' }).parentElement as HTMLElement;
    expect(buttons.className).toContain('ml-auto');
    expect(buttons.className).toContain('shrink-0');
  });

  it('forwards its ref to the bar while it shows, and to nothing while hidden', () => {
    const ref = React.createRef<HTMLDivElement>();
    const { rerender } = render(<StickySaveBar ref={ref} visible onSave={() => {}} onDiscard={() => {}} />);
    expect(ref.current).toBe(screen.getByRole('region', { name: 'Unsaved changes' }));
    rerender(<StickySaveBar ref={ref} visible={false} onSave={() => {}} onDiscard={() => {}} />);
    expect(ref.current).toBeNull();
  });

  it('still saves and discards', () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render(<StickySaveBar visible onSave={onSave} onDiscard={onDiscard} saveLabel="Save dashboard" />);
    screen.getByRole('button', { name: 'Save dashboard' }).click();
    screen.getByRole('button', { name: 'Discard' }).click();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});

describe('StickySaveBar and the bottom toasts', () => {
  it('lifts the toasts by its height while it is pinned where they are, and drops the lift when it hides', () => {
    // Settings at 1440 x 768: the bar pinned to the bottom edge, 58 px tall.
    placeBar(window.innerHeight - 58, 58);
    const { rerender } = render(<StickySaveBar visible onSave={() => {}} onDiscard={() => {}} />);
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('58px');
    expect(bottomBarClearance()).toBe(58);

    rerender(<StickySaveBar visible={false} onSave={() => {}} onDiscard={() => {}} />);
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
    expect(bottomBarClearance()).toBe(0);
  });

  it('adds no lift while it sits above the toasts, and none while it is hidden', () => {
    placeBar(200, 58);
    const { unmount } = render(<StickySaveBar visible onSave={() => {}} onDiscard={() => {}} />);
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
    unmount();

    placeBar(window.innerHeight - 58, 58);
    render(<StickySaveBar visible={false} onSave={() => {}} onDiscard={() => {}} />);
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
  });

  it('still hands its host a ref while it lifts the toasts', () => {
    placeBar(window.innerHeight - 58, 58);
    const ref = React.createRef<HTMLDivElement>();
    const callback = vi.fn();
    const { unmount } = render(<StickySaveBar ref={ref} visible onSave={() => {}} onDiscard={() => {}} />);
    expect(ref.current).toBe(screen.getByRole('region', { name: 'Unsaved changes' }));
    unmount();
    render(<StickySaveBar ref={callback} visible onSave={() => {}} onDiscard={() => {}} />);
    expect(callback).toHaveBeenCalledWith(screen.getByRole('region', { name: 'Unsaved changes' }));
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('58px');
  });
});
