/**
 * Design-system layer regression coverage (Round 3, Stage 1):
 *   - `applyTokens` writes ONLY allow-listed, sanitised CSS custom properties —
 *     unknown keys + unsafe values (url()/braces/semicolons/expression/long) are
 *     dropped, so an operator/branding payload can never inject arbitrary CSS (#10/#9).
 *   - `applyBranding` resolves accent + material + bounded token overrides, with
 *     theme_tokens winning over the accent/material defaults.
 *   - `resolveDark` honours the explicit-user > org-default > OS precedence.
 *   - `GlassSurface` carries the `glass-surface` reduced-transparency marker class
 *     so the media rule can neutralise its blur, and renders a translucent token fill.
 *
 * NOTE (Round-5 W0-Z Z3): this spec asserts the SECURITY behaviour of the theming
 * layer (allow-list enforced, sanitizer strips injection, AA advisory fires) and
 * round-trips of OPERATOR-SUPPLIED values only — it must NEVER pin a `theme.css`
 * default token VALUE literal, so the W0-A token retune (new severity hues, aliased
 * Radix ramps) does not break it. Keep it that way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import {
  applyTokens,
  applyMaterial,
  sanitizeTokenValue,
  applyBranding,
  resolveDark,
  effectiveBrandingTheme,
  resolveMaterial,
  ALLOWED_TOKENS,
  ACCENT_PRESETS,
  MATERIAL_PACKS,
  hexToHslTriplet,
  resolveAccentPair,
} from '../../theme-tokens';
import { GlassSurface } from '../GlassSurface';

function freshRoot(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('applyTokens — allow-listing + sanitisation (#10/#9)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = freshRoot();
  });

  it('writes an allow-listed token (with and without the -- prefix)', () => {
    const written = applyTokens({ '--primary': '210 90% 50%', radius: '0.5rem' }, root);
    expect(written).toContain('--primary');
    expect(written).toContain('--radius');
    expect(root.style.getPropertyValue('--primary')).toBe('210 90% 50%');
    expect(root.style.getPropertyValue('--radius')).toBe('0.5rem');
  });

  it('DROPS unknown / non-allow-listed properties', () => {
    const written = applyTokens(
      { '--evil': 'red', '--background': '0 0% 0%', position: 'fixed' },
      root,
    );
    expect(written).toEqual([]);
    expect(root.style.getPropertyValue('--evil')).toBe('');
    // --background is intentionally NOT in the allow-list (only tints are).
    expect(root.style.getPropertyValue('--background')).toBe('');
  });

  it('drops every semantic fill override so the measured axis stays intact', () => {
    const semantic = ['critical', 'high', 'medium', 'low', 'info', 'success', 'warning'];
    const written = applyTokens(
      Object.fromEntries(semantic.map((axis) => [`--${axis}`, '0 0% 100%'])),
      root,
    );
    expect(written).toEqual([]);
    for (const axis of semantic) {
      expect(ALLOWED_TOKENS.has(`--${axis}`)).toBe(false);
      expect(root.style.getPropertyValue(`--${axis}`)).toBe('');
    }
  });

  it('rejects values that could break out of a declaration', () => {
    const dangerous = [
      'red; position: fixed',
      'url(javascript:alert(1))',
      'expression(alert(1))',
      'blue } body {',
      'red /* x */',
      '<script>',
      'a\\b',
      'x'.repeat(300),
    ];
    for (const v of dangerous) {
      expect(sanitizeTokenValue('--primary', v)).toBeNull();
    }
    const written = applyTokens({ '--primary': 'url(x)' }, root);
    expect(written).toEqual([]);
    expect(root.style.getPropertyValue('--primary')).toBe('');
  });

  it('restricts --font-display to the vetted font enum', () => {
    expect(sanitizeTokenValue('--font-display', 'inter')).toContain('Inter');
    expect(sanitizeTokenValue('--font-display', 'grotesk')).toContain('Space Grotesk');
    // An arbitrary family is rejected (no injection of foreign @font-face refs).
    expect(sanitizeTokenValue('--font-display', 'Comic Sans')).toBeNull();
  });

  it('normalises legacy hex brand tokens to the HSL triplets consumed by CSS', () => {
    const midGrey = '#76' + '7676';
    const shortHex = '#a' + 'bc';
    expect(sanitizeTokenValue('--primary', midGrey)).toBe(hexToHslTriplet(midGrey));
    expect(sanitizeTokenValue('--ring', shortHex)).toBe(hexToHslTriplet(shortHex));
    expect(sanitizeTokenValue('--radius', shortHex)).toBe(shortHex);
  });

  it('font stacks LEAD with the actually-bundled Inter Variable (round-6 no-downgrade fix)', () => {
    // The only self-hosted sans is 'Inter Variable' (@fontsource-variable/inter). The
    // 'inter'/'grotesk' stacks previously led with the UNREGISTERED 'Inter'/'Space Grotesk',
    // so selecting them silently fell through to the OS font. Both must now include the
    // bundled family (and 'inter' must lead with it) so the choice actually renders Inter.
    const inter = sanitizeTokenValue('--font-display', 'inter')!;
    expect(inter.startsWith("'Inter Variable'")).toBe(true);
    expect(sanitizeTokenValue('--font-display', 'grotesk')).toContain('Inter Variable');
  });

  it('every ALLOWED_TOKENS entry is a -- custom property', () => {
    for (const t of ALLOWED_TOKENS) expect(t.startsWith('--')).toBe(true);
  });
});

describe('hexToHslTriplet', () => {
  it('converts hex to an "H S% L%" triple and rejects junk', () => {
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%');
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%');
    expect(hexToHslTriplet('#fff')).toBe('0 0% 100%');
    expect(hexToHslTriplet('not-a-hex')).toBeNull();
    expect(hexToHslTriplet('rgb(0,0,0)')).toBeNull();
  });
});

describe('applyBranding — accent + material + token overrides', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = freshRoot();
  });

  it('quiet branding leaves the chrome at the quiet pack (identity)', () => {
    const mat = applyBranding({ material: 'quiet' }, root);
    expect(mat).toBe('quiet');
    expect(root.style.getPropertyValue('--grid-opacity')).toBe('0');
    expect(root.style.getPropertyValue('--glow-strength')).toBe('0');
  });

  it('quiet branding does NOT pin --glass-opacity (lets the per-theme stylesheet value win)', () => {
    // Regression for the a11y/branding re-audit: 'quiet' must be byte-identical to
    // the pre-wave look in BOTH themes. Each theme's stylesheet owns its --glass-opacity
    // (0.97 in both today), so force-writing one inline would override a theme's own.
    // 'quiet' therefore leaves --glass-opacity UNSET inline so the stylesheet decides.
    const mat = applyBranding({ material: 'quiet' }, root);
    expect(mat).toBe('quiet');
    expect(root.style.getPropertyValue('--glass-opacity')).toBe('');
    expect(MATERIAL_PACKS.quiet['--glass-opacity']).toBeUndefined();
  });

  it('command material raises the chrome vars (incl. an explicit --glass-opacity)', () => {
    const mat = applyBranding({ material: 'command' }, root);
    expect(mat).toBe('command');
    expect(root.style.getPropertyValue('--grid-opacity')).toBe(MATERIAL_PACKS.command['--grid-opacity']);
    expect(Number(root.style.getPropertyValue('--glow-strength'))).toBeGreaterThan(0);
    // Command DOES set an explicit, more-translucent glass opacity.
    expect(root.style.getPropertyValue('--glass-opacity')).toBe(MATERIAL_PACKS.command['--glass-opacity']);
  });

  it('switching command → quiet clears the inline --glass-opacity (no stale override)', () => {
    applyMaterial('command', root);
    expect(root.style.getPropertyValue('--glass-opacity')).toBe(MATERIAL_PACKS.command['--glass-opacity']);
    applyMaterial('quiet', root);
    // The quiet applier actively removes the stale inline value so the stylesheet's
    // per-theme default (0.97 in both themes) governs again.
    expect(root.style.getPropertyValue('--glass-opacity')).toBe('');
  });

  it('accent_color drives --primary/--ring; accent_color2 drives --accent2', () => {
    applyBranding({ accent_color: '#1f6feb', accent_color2: '#6366f1' }, root);
    expect(root.style.getPropertyValue('--primary')).toBe(hexToHslTriplet('#1f6feb'));
    expect(root.style.getPropertyValue('--ring')).toBe(hexToHslTriplet('#1f6feb'));
    expect(root.style.getPropertyValue('--accent2')).toBe(hexToHslTriplet('#6366f1'));
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('0 0% 100%');
  });

  it('derives a trusted primary foreground from the custom fill in either theme', () => {
    const lightAccent = '#fde' + '047';
    applyBranding({ accent_color: lightAccent }, root);
    expect(root.style.getPropertyValue('--primary')).toBe(hexToHslTriplet(lightAccent));
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('0 0% 0%');
    expect(resolveAccentPair(root.style.getPropertyValue('--primary'))?.ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('theme_tokens override the accent default (applied last) and stay allow-listed', () => {
    applyBranding(
      { accent_color: '#1f6feb', theme_tokens: { '--primary': '120 50% 40%', '--evil': 'x' } },
      root,
    );
    expect(root.style.getPropertyValue('--primary')).toBe('120 50% 40%');
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('0 0% 0%');
    expect(root.style.getPropertyValue('--evil')).toBe('');
  });

  it('pairs a legacy hex primary override with its derived foreground', () => {
    const midGrey = '#76' + '7676';
    applyBranding({ theme_tokens: { '--primary': midGrey } }, root);

    expect(root.style.getPropertyValue('--primary')).toBe(hexToHslTriplet(midGrey));
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('0 0% 0%');
  });

  it('clearing accent restores the stylesheet default (no stale inline override)', () => {
    applyBranding({ accent_color: '#1f6feb' }, root);
    expect(root.style.getPropertyValue('--primary')).not.toBe('');
    applyBranding({}, root); // empty branding
    expect(root.style.getPropertyValue('--primary')).toBe('');
    expect(root.style.getPropertyValue('--primary-foreground')).toBe('');
  });

  it('clears every former branding override before applying a smaller token bag', () => {
    applyBranding({
      theme_tokens: {
        '--canvas-tint': '220 10% 90%',
        '--radius': '1rem',
        '--density-unit': '0.5rem',
        '--font-display': 'mono',
        '--glass-tint': '220 10% 20%',
      },
    }, root);
    expect(root.style.getPropertyValue('--canvas-tint')).not.toBe('');
    expect(root.style.getPropertyValue('--font-display')).not.toBe('');

    applyBranding({ theme_tokens: { '--radius': '0.25rem' } }, root);
    expect(root.style.getPropertyValue('--radius')).toBe('0.25rem');
    expect(root.style.getPropertyValue('--canvas-tint')).toBe('');
    expect(root.style.getPropertyValue('--density-unit')).toBe('');
    expect(root.style.getPropertyValue('--font-display')).toBe('');
    expect(root.style.getPropertyValue('--glass-tint')).toBe('');
  });

  it('exports accent presets with a derived AA black/white foreground', () => {
    expect(ACCENT_PRESETS.length).toBeGreaterThanOrEqual(4);
    for (const p of ACCENT_PRESETS) {
      const triplet = hexToHslTriplet(p.hex);
      expect(triplet).not.toBeNull();
      expect(resolveAccentPair(triplet)?.ratio).toBeGreaterThanOrEqual(4.5);
      if (p.hex2) expect(hexToHslTriplet(p.hex2)).not.toBeNull();
    }
  });
});

describe('resolveDark — explicit > org-default > OS precedence', () => {
  it('explicit user choice always wins over branding', () => {
    expect(resolveDark('dark', { default_theme: 'light' })).toBe(true);
    expect(resolveDark('light', { default_theme: 'dark' })).toBe(false);
  });

  it('on system, the org default decides', () => {
    expect(resolveDark('system', { default_theme: 'dark' })).toBe(true);
    expect(resolveDark('system', { default_theme: 'light' })).toBe(false);
    // legacy dark_mode_default still forces dark.
    expect(resolveDark('system', { dark_mode_default: true })).toBe(true);
  });

  it('falls back to OS (false in jsdom) when nothing chooses', () => {
    expect(resolveDark('system', {})).toBe(false);
    expect(resolveDark(undefined, null)).toBe(false);
  });
});

describe('effectiveBrandingTheme + resolveMaterial', () => {
  it('reconciles new + legacy theme fields', () => {
    expect(effectiveBrandingTheme({ dark_mode_default: true })).toBe('dark');
    expect(effectiveBrandingTheme({ default_theme: 'light' })).toBe('light');
    expect(effectiveBrandingTheme({ theme: 'dark' })).toBe('dark');
    expect(effectiveBrandingTheme({})).toBe('');
  });

  it('resolveMaterial defaults to quiet', () => {
    expect(resolveMaterial('command')).toBe('command');
    expect(resolveMaterial('quiet')).toBe('quiet');
    expect(resolveMaterial(undefined)).toBe('quiet');
    expect(resolveMaterial('bogus')).toBe('quiet');
  });
});

describe('GlassSurface — reduced-transparency marker + token fill', () => {
  it('carries the glass-surface marker class (media rule neutralises blur)', () => {
    const { container } = render(<GlassSurface>hi</GlassSurface>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('glass-surface');
  });

  it('renders a translucent token fill + an inline backdrop blur', () => {
    const { container } = render(<GlassSurface blur="lg">x</GlassSurface>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.backgroundColor).toContain('var(--glass-tint)');
    expect(el.style.backdropFilter).toContain('blur(22px)');
  });

  it('renders a hairline rim by default and can drop it', () => {
    const rim = render(<GlassSurface>a</GlassSurface>).container.firstElementChild as HTMLElement;
    expect(rim.className).toContain('border');
    const noRim = render(<GlassSurface rim={false}>a</GlassSurface>).container.firstElementChild as HTMLElement;
    expect(noRim.className).not.toContain('border-border/70');
  });

  it('renders as a semantic element when `as` is set', () => {
    const { container } = render(<GlassSurface as="header">h</GlassSurface>);
    expect(container.querySelector('header')).not.toBeNull();
  });
});
