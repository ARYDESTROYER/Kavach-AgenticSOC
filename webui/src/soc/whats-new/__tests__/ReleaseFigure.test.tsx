/**
 * A release-note screenshot and its lightbox (Round 16 WP07): the enlarged view opens
 * from the figure's button and, on close, hands focus back to that button, so a keyboard
 * user stays where they were on the page or in the welcome dialog.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../theme', () => ({ useTheme: () => ({ isDark: false }) }));

import { ReleaseFigure } from '../ReleaseFigure';

const SHOT = {
  light: { src: 'assets/releases/0.3.0/tabs-light.webp', width: 2880, height: 1800 },
  dark: { src: 'assets/releases/0.3.0/tabs-dark.webp', width: 2880, height: 1800 },
  alt: 'The case detail with the six tabs Brief, Evidence and Chat in their new order.',
  caption: 'The six case tabs',
};

describe('ReleaseFigure', () => {
  it('returns focus to the enlarge button when the lightbox closes', async () => {
    render(<ReleaseFigure screenshot={SHOT} version="0.3.0" />);
    const enlarge = screen.getByRole('button', { name: 'Enlarge screenshot: The six case tabs' });
    await userEvent.click(enlarge);
    expect(await screen.findByRole('dialog', { name: 'The six case tabs' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(enlarge).toHaveFocus());
  });

  it('opens the lightbox from the keyboard too', async () => {
    render(<ReleaseFigure screenshot={SHOT} version="0.3.0" />);
    const enlarge = screen.getByRole('button', { name: 'Enlarge screenshot: The six case tabs' });
    enlarge.focus();
    await userEvent.keyboard('{Enter}');
    const lightbox = await screen.findByRole('dialog', { name: 'The six case tabs' });
    expect(lightbox.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/tabs-light\.webp$/));
  });
});
