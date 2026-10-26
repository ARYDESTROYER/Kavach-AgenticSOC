/**
 * RefreshButton `display="icon"` (Round 14, SPEC §4.9.2, C8): the page header's refresh,
 * a quiet 32px icon button whose name stays in the DOM and shows in the shared tooltip on
 * hover and keyboard focus (never a native title); it spins only while a load is in
 * flight.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { RefreshButton } from '../RefreshButton';

describe('RefreshButton display="icon"', () => {
  it('is an icon button named by its label, with the label in the shared tooltip, not a native title', () => {
    const onClick = vi.fn();
    const { container } = render(<RefreshButton display="icon" label="Refresh cases" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Refresh cases' });
    expect(button).not.toHaveAttribute('title');
    expect(button).toHaveAttribute('data-refresh-display', 'icon');
    expect(button).toHaveClass('h-8', 'w-8', 'rounded-md', 'text-muted-foreground');
    expect(screen.getByText('Refresh cases')).toHaveClass('sr-only');
    expect(container.querySelector('svg')).not.toHaveClass('animate-spin');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows its tooltip on keyboard focus, outside any app provider', async () => {
    render(<RefreshButton display="icon" label="Refresh dashboard" />);
    const button = screen.getByRole('button', { name: 'Refresh dashboard' });
    act(() => {
      button.focus();
    });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Refresh dashboard');
    expect(button).toHaveAttribute('aria-describedby');
  });

  it('spins and is busy only while a load is in flight', () => {
    const { container } = render(<RefreshButton display="icon" refreshing />);
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('svg')).toHaveClass('animate-spin', 'motion-reduce:animate-none');
  });

  it('keeps the visible word by default', () => {
    render(<RefreshButton />);
    const button = screen.getByRole('button', { name: 'Refresh' });
    expect(button).not.toHaveAttribute('title');
    expect(screen.getByText('Refresh')).not.toHaveClass('sr-only');
  });
});
