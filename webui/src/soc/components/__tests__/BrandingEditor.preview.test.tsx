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
    const slab = container.querySelector('[data-login-preview-slab]');
    expect(shell).toHaveAttribute('data-login-preview-layout', 'split');
    expect(shell).toHaveClass('login-auth-canvas', 'overflow-hidden');
    expect(slab?.parentElement).toHaveClass('w-[480px]');
    expect(slab).toHaveClass(
      'login-auth-slab',
      'min-h-[492px]',
      'w-[480px]',
      'px-12',
      'pb-24',
      'pt-12',
    );
    expect(slab).not.toHaveClass('h-[492px]');
    expect(slab).not.toHaveClass('border-x', 'shadow-elev2');
    expect(container.querySelector('[data-login-preview-content]')).toHaveClass('w-[384px]');

    // Runtime and preview deliberately share the live-Mistral background system:
    // a flat theme canvas, the pure identity slab, four viewport guides, four
    // neutral 240px carriers, and horizontal-edge-only warm trails. The preview is
    // a representative frozen frame; it must never start ambient timers.
    const ambient = shell?.querySelector('[data-login-ambient-grid]');
    expect(ambient).toHaveAttribute('aria-hidden', 'true');
    expect(ambient).toHaveAttribute('data-login-ambient-cadence', 'mistral');
    expect(ambient).not.toHaveAttribute('data-login-accent-cycle');
    expect(ambient).toHaveClass('pointer-events-none', 'hidden', 'sm:block');
    expect(
      Array.from(ambient?.querySelectorAll<HTMLElement>('[data-login-guide]') ?? []).map(
        (guide) => guide.dataset.loginGuide,
      ).sort(),
    ).toEqual(['bottom', 'left', 'right', 'top']);
    const ambientTiles = Array.from(
      ambient?.querySelectorAll<HTMLElement>('[data-login-ambient-tile]') ?? [],
    );
    expect(ambientTiles).toHaveLength(4);
    expect(ambientTiles.map((tile) => tile.dataset.loginAmbientTile).sort()).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    expect(ambientTiles.map((tile) => tile.dataset.loginAmbientSide).sort()).toEqual([
      'bottom',
      'left',
      'right',
      'top',
    ]);
    const trails = Array.from(
      ambient?.querySelectorAll<HTMLElement>('[data-login-ambient-trail]') ?? [],
    );
    expect(trails).toHaveLength(2);
    expect(
      ambient?.querySelector(
        '[data-login-ambient-side="top"] [data-login-ambient-trail]',
      ),
    ).toHaveAttribute('data-login-ambient-trail-active', 'true');
    expect(
      ambient?.querySelector(
        '[data-login-ambient-side="bottom"] [data-login-ambient-trail]',
      ),
    ).toHaveAttribute('data-login-ambient-trail-active', 'true');
    expect(
      ambient?.querySelector(
        '[data-login-ambient-side="left"] [data-login-ambient-trail]',
      ),
    ).toBeNull();
    expect(
      ambient?.querySelector(
        '[data-login-ambient-side="right"] [data-login-ambient-trail]',
      ),
    ).toBeNull();
    expect(ambient?.querySelector('[data-login-ambient-anchor]')).toBeNull();
    expect(ambient?.querySelectorAll('.login-auth-trail')).toHaveLength(2);
    expect(ambient?.querySelector('.login-auth-accent')).toBeNull();
    expect(
      ambientTiles.every((tile) => (
        tile.classList.contains('h-[240px]') &&
        tile.classList.contains('w-[240px]') &&
        tile.style.width === '' &&
        tile.style.height === '' &&
        tile.style.transform === '' &&
        (
          tile.style.backgroundColor.includes('var(--login-tile-default)') ||
          tile.style.backgroundColor.includes('var(--login-tile-muted)')
        )
      )),
    ).toBe(true);
    expect(
      Array.from(ambient?.querySelectorAll<HTMLElement>('*') ?? [])
        .filter((node) => node.style.backgroundColor.includes('var(--login-trail-'))
        .every((node) => node.hasAttribute('data-login-ambient-trail')),
    ).toBe(true);

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
