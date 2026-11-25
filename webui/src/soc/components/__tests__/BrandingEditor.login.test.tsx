/**
 * BrandingEditor — Round-4 login white-label section test.
 *
 * Covers the minimal "Login screen" controls: bounded plain-text welcome copy,
 * description, and footer notes. Legacy layout/illustration values remain part of the
 * wire contract but are intentionally no longer editable; Save must preserve them.
 * Operator copy is stored verbatim (plain data) and rendered as plain text (#6/#9).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---- Mock the typed api client BEFORE importing the component ------------- //
const getMock = vi.fn();
const putMock = vi.fn();
// Named so we can assert ThemeProvider's mount fetch + save()'s refresh resync (Ask #6).
const getBrandingMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => getMock(path),
    put: (path: string, body: unknown) => putMock(path, body),
    getBranding: () => getBrandingMock(),
  },
}));

// sonner toasts are irrelevant here; stub to no-ops.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { ThemeProvider } from '../../theme';
import { BrandingEditor } from '../BrandingEditor';
import { useHasUnsavedChanges } from '@/soc/hooks/useDirtyDraft';

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
  login_headline: '',
  login_body: '',
  login_chips: [],
  login_layout: 'split',
  login_illustration: '',
};

function renderEditor() {
  return render(
    <ThemeProvider>
      <BrandingEditor />
      <DirtyProbe />
    </ThemeProvider>,
  );
}

function DirtyProbe() {
  return <output data-testid="branding-dirty-probe">{useHasUnsavedChanges() ? 'dirty' : 'clean'}</output>;
}

describe('BrandingEditor — login white-label section', () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
    getBrandingMock.mockReset();
    getMock.mockResolvedValue({ ...SAVED_BRANDING });
    getBrandingMock.mockResolvedValue({ ...SAVED_BRANDING });
    putMock.mockImplementation((_path: string, body: unknown) => Promise.resolve(body));
  });

  it('renders the minimal Login screen controls without legacy layout or illustration selects', async () => {
    renderEditor();
    expect(await screen.findByText('Login screen')).toBeInTheDocument();
    expect(screen.getByLabelText('Short welcome line')).toBeInTheDocument();
    expect(screen.getByLabelText('Sign-in description')).toBeInTheDocument();
    expect(screen.getByText('Footer notes')).toBeInTheDocument();
    expect(screen.queryByLabelText('Login layout')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Login illustration')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Saved legacy layout and illustration values remain preserved/i),
    ).toBeInTheDocument();
  });

  it('bounds the headline + body inputs to the server caps (120 / 600)', async () => {
    renderEditor();
    const headline = (await screen.findByLabelText('Short welcome line')) as HTMLInputElement;
    const body = screen.getByLabelText('Sign-in description') as HTMLTextAreaElement;
    expect(headline.maxLength).toBe(120);
    expect(body.maxLength).toBe(600);
  });

  it('adds and removes footer notes (bounded to 6)', async () => {
    renderEditor();
    await screen.findByText('Login screen');
    const addChip = screen.getByRole('button', { name: 'Add note' });
    fireEvent.click(addChip);
    const chip1 = (await screen.findByLabelText('Login chip 1')) as HTMLInputElement;
    fireEvent.change(chip1, { target: { value: 'Audited' } });
    expect((screen.getByLabelText('Login chip 1') as HTMLInputElement).value).toBe('Audited');
    // Remove it again.
    fireEvent.click(screen.getByRole('button', { name: 'Remove login chip 1' }));
    await waitFor(() => expect(screen.queryByLabelText('Login chip 1')).toBeNull());
  });

  it('round-trips the login_* fields through PUT /api/branding on Save', async () => {
    renderEditor();
    const headline = (await screen.findByLabelText('Short welcome line')) as HTMLInputElement;
    fireEvent.change(headline, { target: { value: 'Welcome to Contoso' } });
    fireEvent.change(screen.getByLabelText('Sign-in description'), {
      target: { value: 'Investigate faster.' },
    });

    const saveBtn = screen.getByRole('button', { name: /Save branding/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);

    await waitFor(() => expect(putMock).toHaveBeenCalled());
    const [path, body] = putMock.mock.calls[0];
    expect(path).toBe('branding');
    expect(body).toMatchObject({
      login_headline: 'Welcome to Contoso',
      login_body: 'Investigate faster.',
      login_layout: 'split',
      login_illustration: '',
    });
  });

  it('blocks shell activation while branding has an unsaved draft', async () => {
    renderEditor();
    const headline = await screen.findByLabelText('Short welcome line');
    expect(screen.getByTestId('branding-dirty-probe')).toHaveTextContent('clean');

    fireEvent.change(headline, { target: { value: 'Unsaved identity' } });
    await waitFor(() =>
      expect(screen.getByTestId('branding-dirty-probe')).toHaveTextContent('dirty'),
    );
    fireEvent.click(screen.getByRole('button', { name: /Discard/i }));
    await waitFor(() =>
      expect(screen.getByTestId('branding-dirty-probe')).toHaveTextContent('clean'),
    );
  });

  it('preserves hidden legacy layout and illustration values on Save', async () => {
    const legacyBranding = {
      ...SAVED_BRANDING,
      login_layout: 'full',
      login_illustration: 'radar',
    };
    getMock.mockResolvedValue(legacyBranding);
    getBrandingMock.mockResolvedValue(legacyBranding);

    renderEditor();
    const headline = await screen.findByLabelText('Short welcome line');
    expect(screen.queryByLabelText('Login layout')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Login illustration')).not.toBeInTheDocument();
    fireEvent.change(headline, { target: { value: 'Welcome back' } });

    const saveBtn = screen.getByRole('button', { name: /Save branding/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await waitFor(() => expect(putMock).toHaveBeenCalled());
    const [, body] = putMock.mock.calls[0];
    expect(body).toMatchObject({
      login_headline: 'Welcome back',
      login_layout: 'full',
      login_illustration: 'radar',
    });
  });

  it('re-fetches GET /api/branding (shared-context resync) after a successful Save', async () => {
    renderEditor();
    const headline = await screen.findByLabelText('Short welcome line');
    fireEvent.change(headline, { target: { value: 'X' } });
    const saveBtn = screen.getByRole('button', { name: /Save branding/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await waitFor(() => expect(putMock).toHaveBeenCalled());
    // Once for ThemeProvider's own mount fetch, once triggered by save()'s
    // refreshBranding() — the resync that makes the saved branding reach Login/AppShell
    // in the same session (Ask #6).
    await waitFor(() => expect(getBrandingMock).toHaveBeenCalledTimes(2));
  });
});

// A tiny guard: the exported layout/illustration key sets stay in lockstep with the
// backend curated set (so a drift here surfaces as a failing test, not a silent
// mismatch with routes/config validators).
describe('loginParts — curated key sets', () => {
  it('exposes exactly the backend layouts + illustrations', async () => {
    const parts = await import('../auth/loginParts');
    expect([...parts.LOGIN_LAYOUTS].sort()).toEqual(['centered', 'full', 'split']);
    expect([...parts.LOGIN_ILLUSTRATIONS].sort()).toEqual(
      ['', 'aurora', 'constellation', 'grid', 'mesh', 'radar', 'shield', 'waves'].sort(),
    );
    // Defensive coercion clamps unknowns to safe defaults.
    expect(parts.asLoginLayout('bogus')).toBe('split');
    expect(parts.asLoginIllustration('bogus')).toBe('');
    expect(parts.asLoginIllustration('radar')).toBe('radar');
  });

  it('keeps the keys as data only: no illustration or hero component is exported', async () => {
    // Round 16 WP04 deleted the drawn illustrations and the hero; the keys still
    // round-trip through Branding (see "preserves hidden legacy layout ..." above).
    const parts = (await import('../auth/loginParts')) as Record<string, unknown>;
    expect(parts.LoginIllustration).toBeUndefined();
    expect(parts.BrandHero).toBeUndefined();
    expect(parts.LOGIN_ILLUSTRATION_LABELS).toBeUndefined();
  });
});
