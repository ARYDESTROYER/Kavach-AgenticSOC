/**
 * BrandingEditor "Login preview" — faithful, minimal, and NON-CLIPPING.
 *
 * The preview renders the design-size minimal identity shell uniformly scaled inside an
 * aspect-ratio box. Legacy layout values are retained only as compatibility metadata;
 * they must not bring back the removed hero/layout controls or alter the minimal shell.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import { ThemeProvider } from '../../theme';
import { BrandingEditor } from '../BrandingEditor';

const SAVED_BRANDING = {
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
  login_headline: 'Triage at machine speed.',
  login_body: 'A body line.',
  login_chips: ['Audited', 'Cost-metered'],
  login_layout: 'split',
  login_illustration: '',
};

function renderEditor() {
  return render(
    <ThemeProvider>
      <BrandingEditor />
    </ThemeProvider>,
  );
}

describe('BrandingEditor — faithful minimal login preview', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ ...SAVED_BRANDING });
    putMock.mockReset().mockImplementation((_p: string, b: unknown) => Promise.resolve(b));
    getBrandingMock.mockReset().mockResolvedValue({ ...SAVED_BRANDING });
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('does not replace an explicit Light preference with the organization default on mount', async () => {
    const darkOrgBranding = {
      ...SAVED_BRANDING,
      theme: 'dark',
      default_theme: 'dark',
    };
    getMock.mockResolvedValue(darkOrgBranding);
    getBrandingMock.mockResolvedValue(darkOrgBranding);
    window.localStorage.setItem('soc.theme', 'light');

    const view = render(
      <React.StrictMode>
        <ThemeProvider>
          <BrandingEditor />
        </ThemeProvider>
      </React.StrictMode>,
    );

    await screen.findByText('Login preview');
    await waitFor(() => expect(document.documentElement).not.toHaveClass('dark'));
    expect(window.localStorage.getItem('soc.theme')).toBe('light');

    // The org-default control edits the branding draft only. Even choosing Dark must
    // not mutate the signed-in operator's personal Light preference.
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem('soc.theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem('soc.theme')).toBe('light');

    await act(async () => view.unmount());
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem('soc.theme')).toBe('light');
  });

  it('uses the centered shared panel loader before branding resolves', async () => {
    getMock.mockReturnValue(new Promise(() => {}));
    const view = renderEditor();

    const loading = screen.getByRole('status', { name: 'Loading branding' });
    expect(loading).toHaveAttribute('data-loading-layout', 'panel');
    expect(loading).toHaveClass('items-center', 'justify-center');
    expect(screen.getByText('Preparing your organization’s appearance controls.')).toBeInTheDocument();
    expect(screen.getByTestId('console-loading-glyph')).toBeInTheDocument();
    await act(async () => view.unmount());
  });

  it('renders the preview as an aspect-ratio scaled stage, NOT a fixed 224px clip', async () => {
    const { container } = renderEditor();
    await screen.findByText('Login preview');

    expect(screen.getByRole('heading', { name: 'Branding', level: 2 })).toBeInTheDocument();
    const livePreview = screen.getByTestId('branding-live-preview');
    expect(livePreview).toHaveClass('border-y');
    expect(livePreview.className).not.toMatch(/rounded|shadow/);

    // The preview box holds a fixed aspect ratio (fluid width) rather than the old
    // fixed 224px height that clipped the hero.
    const boxes = Array.from(container.querySelectorAll<HTMLElement>('div')).filter(
      (el) => el.style.aspectRatio,
    );
    expect(boxes.length).toBeGreaterThan(0);

    // The design-size stage is uniformly scaled down (transform: scale(...)), which is
    // what lets the whole hero fit without clipping.
    const scaled = Array.from(container.querySelectorAll<HTMLElement>('div')).filter((el) =>
      /scale\(/.test(el.style.transform || ''),
    );
    expect(scaled.length).toBeGreaterThan(0);

    const shell = container.querySelector('[data-login-preview-shell="minimal"]');
    expect(shell).toHaveAttribute('data-login-preview-layout', 'split');
    // The preview mirrors the real page: one column on the Console canvas with the
    // static brand wash, a 400px measure, the mark, one heading, a 44px field and
    // the primary Continue. No slab, ambient tiles, hero or gradient controls.
    expect(shell).toHaveClass('login-canvas', 'bg-canvas', 'overflow-hidden');
    expect(shell?.querySelector('[data-login-preview-slab]')).toBeNull();
    expect(shell?.querySelector('[data-login-ambient-grid]')).toBeNull();
    expect(shell?.querySelector('.login-auth-slab, .login-shine-button, .login-theme-pill')).toBeNull();
    const content = container.querySelector('[data-login-preview-content]');
    expect(content).toHaveClass('w-[400px]');
    expect(content).toHaveTextContent('Triage at machine speed.');
    expect(content).toHaveTextContent('A body line.');
    expect(content).toHaveTextContent('Username');
    expect(content).toHaveTextContent('Continue');
    expect(content?.querySelector('.h-11.border-input')).not.toBeNull();
    expect(content?.querySelector('.bg-primary.text-primary-foreground')).not.toBeNull();

    // The old clipping fixed-height box is gone.
    expect(container.querySelector('.h-56')).toBeNull();
  });

  it.each(['split', 'centered', 'full'] as const)(
    'uses the same minimal preview shell for preserved legacy layout %s',
    async (layout) => {
      const legacyBranding = { ...SAVED_BRANDING, login_layout: layout };
      getMock.mockResolvedValue(legacyBranding);
      getBrandingMock.mockResolvedValue(legacyBranding);

      const { container } = renderEditor();
      await screen.findByText('Login preview');

      const shell = container.querySelector('[data-login-preview-shell="minimal"]');
      expect(shell).toHaveAttribute('data-login-preview-layout', layout);
      expect(screen.queryByLabelText('Login layout')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Login illustration')).not.toBeInTheDocument();
    },
  );
});

describe('BrandingEditor copy (Round 14)', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ ...SAVED_BRANDING });
    putMock.mockReset().mockImplementation((_p: string, b: unknown) => Promise.resolve(b));
    getBrandingMock.mockReset().mockResolvedValue({ ...SAVED_BRANDING });
    window.localStorage.clear();
  });

  it('explains accent presets, design tokens and the material pack without em dashes', async () => {
    renderEditor();
    expect(
      await screen.findByText('One-click brand hues, each checked to keep white text at WCAG AA on the accent fill.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Bounded layout tokens: corner radius and display font\./)).toBeInTheDocument();
    expect(screen.getByText(/denser command-center feel; colours and text contrast are unchanged\.$/)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/[–—]/);
  });
});
