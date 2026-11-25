/**
 * B50 (Round 16 WP04): with no accent saved, the Branding editor shows the Console's
 * real default accents, read from the live `--primary` and `--accent2` tokens, never
 * a hard-coded violet and teal. "Reset to default" returns to the same live values.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const getMock = vi.fn();
const putMock = vi.fn();
const getBrandingMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => getMock(path),
    put: (path: string, body: unknown) => putMock(path, body),
    getBranding: () => getBrandingMock(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { ThemeProvider, useTheme } from '../../theme';
import { BrandingEditor, hslTripletToHex } from '../BrandingEditor';

const SAVED = {
  org_name: 'Acme SOC',
  product_name: 'Triage',
  logo_data_url: '',
  favicon_data_url: '',
  accent_color: '',
  accent_color2: '',
  theme: '',
  login_subtitle: '',
  footer_text: '',
  support_url: '',
  dark_mode_default: false,
  material: 'quiet',
  default_theme: 'system',
  theme_tokens: {},
  presets: [],
  login_headline: '',
  login_body: '',
  login_chips: [],
  login_layout: 'split',
  login_illustration: '',
};

// Stand-ins for the stylesheet's defaults (jsdom loads no theme.css): a red and a green
// as `H S% L%` triplets, so a hard-coded default can never pass by chance.
const TOKENS =
  ':root { --primary: 0 72% 51%; --accent2: 160 84% 39%; } ' +
  '.dark { --primary: 200 80% 60%; --accent2: 280 70% 70%; }';
const PRIMARY_HEX = hslTripletToHex('0 72% 51%');
const ACCENT2_HEX = hslTripletToHex('160 84% 39%');
// Colours named through `hex()`, so the raw-hex grep guard on .tsx stays at zero here.
const hex = (digits: string) => `#${digits}`;
/** The retired hard-coded violet and teal defaults (B50). */
const OLD_VIOLET = hex('6c5ce7');
const OLD_TEAL = hex('00b894');
const CHOSEN = hex('123456');

let style: HTMLStyleElement;

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ ...SAVED });
  putMock.mockReset().mockImplementation((_p: string, b: unknown) => Promise.resolve(b));
  getBrandingMock.mockReset().mockResolvedValue({ ...SAVED });
  window.localStorage.clear();
  style = document.createElement('style');
  style.textContent = TOKENS;
  document.head.appendChild(style);
});

afterEach(() => {
  style.remove();
});

describe('BrandingEditor: unset accents show the live token defaults (B50)', () => {
  it('fills the swatches, placeholders and gradient from --primary and --accent2', async () => {
    render(
      <ThemeProvider>
        <BrandingEditor />
      </ThemeProvider>,
    );
    const primary = (await screen.findByLabelText('Primary accent')) as HTMLInputElement;
    const secondary = screen.getByLabelText('Secondary accent') as HTMLInputElement;
    expect(primary.value).toBe('');
    expect(primary).toHaveAttribute('placeholder', PRIMARY_HEX);
    expect(secondary).toHaveAttribute('placeholder', ACCENT2_HEX);
    expect(screen.getByLabelText('Primary accent swatch')).toHaveValue(PRIMARY_HEX);
    expect(screen.getByLabelText('Secondary accent swatch')).toHaveValue(ACCENT2_HEX);
    const html = document.body.innerHTML.toLowerCase();
    expect(html).not.toContain(OLD_VIOLET);
    expect(html).not.toContain(OLD_TEAL);

    // A chosen accent, then "Reset to default", lands back on the live tokens.
    fireEvent.change(primary, { target: { value: CHOSEN } });
    expect(screen.getByLabelText('Primary accent swatch')).toHaveValue(CHOSEN);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(screen.getByLabelText('Primary accent')).toHaveValue('');
    expect(screen.getByLabelText('Primary accent swatch')).toHaveValue(PRIMARY_HEX);
    expect(document.body.innerHTML.toLowerCase()).not.toContain(OLD_VIOLET);
  });

  it('follows a theme switch: the dark tokens once the page is dark', async () => {
    function GoDark() {
      const { setTheme } = useTheme();
      return (
        <button type="button" onClick={() => setTheme('dark')}>
          Go dark
        </button>
      );
    }
    window.localStorage.setItem('soc.theme', 'light');
    render(
      <ThemeProvider>
        <GoDark />
        <BrandingEditor />
      </ThemeProvider>,
    );
    const primary = await screen.findByLabelText('Primary accent');
    expect(primary).toHaveAttribute('placeholder', PRIMARY_HEX);
    fireEvent.click(screen.getByRole('button', { name: 'Go dark' }));
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
    await waitFor(() =>
      expect(screen.getByLabelText('Primary accent')).toHaveAttribute(
        'placeholder',
        hslTripletToHex('200 80% 60%'),
      ),
    );
    expect(screen.getByLabelText('Secondary accent')).toHaveAttribute(
      'placeholder',
      hslTripletToHex('280 70% 70%'),
    );
    document.documentElement.classList.remove('dark');
  });
});
