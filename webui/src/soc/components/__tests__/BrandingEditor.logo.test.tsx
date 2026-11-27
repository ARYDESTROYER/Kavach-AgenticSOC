/**
 * The Branding editor's login preview draws a wide logo the way the sign-in page does
 * (Round 16 FXF): 40px tall and as wide as it needs, up to 12rem, aligned left, never
 * squeezed into a 40px square.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

const BRANDING = {
  org_name: 'Acme SOC',
  product_name: 'Triage',
  logo_data_url: 'data:image/png;base64,iVBORw0KGgo=',
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

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ ...BRANDING });
  putMock.mockReset().mockImplementation((_p: string, b: unknown) => Promise.resolve(b));
  getBrandingMock.mockReset().mockResolvedValue({ ...BRANDING });
  window.localStorage.clear();
});

describe('BrandingEditor login preview logo', () => {
  it('uses the sign-in page classes for the logo', async () => {
    const { container } = render(
      <ThemeProvider>
        <BrandingEditor />
      </ThemeProvider>,
    );
    await screen.findByText('Login preview');
    const logo = container.querySelector('[data-login-preview-content] img') as HTMLImageElement;
    expect(logo).not.toBeNull();
    // Login.tsx draws the organization logo with exactly these classes.
    expect(logo).toHaveClass('h-10', 'w-auto', 'max-w-48', 'object-contain', 'object-left');
    expect(logo).not.toHaveClass('w-10');
  });
});
