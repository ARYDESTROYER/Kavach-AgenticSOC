/**
 * BrandingEditor — the org white-label + theme panel for the Tailwind/token console.
 *
 * Round-3 extends the legacy white-label editor (wordmark / logo / favicon / accent /
 * default theme / login copy) with the BOUNDED design-token surface:
 *   - a one-click named accent PRESET picker (AA-vetted hues from theme-tokens);
 *   - a bounded ThemeTokens editor (radius + display font) applied as a LIVE PREVIEW
 *     via `applyTokens` (allow-listed + sanitised — #9/#10); measured semantic axes
 *     remain system-owned so branding cannot split their fill/text contrast pairs;
 *   - a light / dark / system default theme choice (drives `default_theme`);
 *   - a 'command' MATERIAL pack toggle (denser chrome; colours/contrast unchanged);
 *   - a live WCAG-AA contrast advisory — from the PUT response when the backend
 *     computes one (`contrast_warnings` / `auto_corrected`), else a defensive local
 *     check on the chosen accent.
 *
 * Persistence: edits are buffered locally and written on Save via `putBrandingDoc`.
 * Discard reverts the live preview to the saved branding. A successful Save reseeds
 * the baseline (dirty-tracking resets) and re-applies the resolved appearance.
 *
 * Security: the live preview renders the operator-supplied logo/favicon data URLs in
 * <img>; ALL wordmark/tagline/footer copy renders as PLAIN text (never markup). Every
 * theme-token value is allow-listed + sanitised by `theme-tokens.ts` before it ever
 * touches the DOM; appearance inputs are hex/enum/length-bounded.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Brush,
  Check,
  Image as ImageIcon,
  Monitor,
  Moon,
  RotateCcw,
  Save,
  Shield,
  ShieldCheck,
  Sun,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/cn';
import { useTheme } from '@/soc/theme';
import {
  ACCENT_PRESETS,
  ALLOWED_TOKENS,
  applyMaterial,
  applyTokens,
  resolveAccentPair,
  clearTokens,
  hexToHslTriplet,
  type Material,
  type ThemeMode,
} from '@/soc/theme-tokens';
import {
  getBrandingDoc,
  putBrandingDoc,
  accentContrastAdvisory,
  type BrandingDoc,
} from './branding.api';
import {
  asLoginLayout,
  type BrandHeroProps,
  type LoginLayout,
} from './auth/loginParts';
import { LOGIN_BRANDING_DEFAULTS } from './auth/login.api';
import { LoginAuthBackdrop } from './auth/LoginAuthBackdrop';
import { LoadError } from './LoadError';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Textarea } from '@/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import { Heading as TypographyHeading, Text } from '@/ui/typography';
import { LoadingState } from '@/design-system';
import { useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';
import { SectionTitle } from '@/soc/pages/settings/primitives';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

/* ----------------------------------------------------------------- limits --- */

const MAX_LOGO_BYTES = 200 * 1024; // ~200 KB
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const LOGO_ACCEPT = LOGO_TYPES.join(',');

const MAX_FAVICON_BYTES = 64 * 1024; // ~64 KB
const FAVICON_TYPES = [
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
];
const FAVICON_ACCEPT = '.ico,.png,.svg,image/png,image/svg+xml,image/x-icon';

// Free-text caps — mirror the backend BrandingConfig validators.
const MAX_TEXT_LEN = 400;
const MAX_URL_LEN = 2000;

// Login white-label caps — mirror the backend BrandingConfig login-copy validators
// (`login_headline` ≤120, `login_body` ≤600, `login_chips` ≤6 × ≤60). Plain text only.
const MAX_LOGIN_HEADLINE_LEN = 120;
const MAX_LOGIN_BODY_LEN = 600;
const MAX_LOGIN_CHIPS = 6;
const MAX_LOGIN_CHIP_LEN = 60;

const DEFAULT_ACCENT = '#6c5ce7';
const DEFAULT_ACCENT2 = '#00b894';

/** Built-in defaults — reproduce the no-branding experience (Round-3/4 superset). */
const DEFAULT_BRANDING: BrandingDoc = {
  org_name: '',
  product_name: '',
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
  ...LOGIN_BRANDING_DEFAULTS,
};

const THEME_OPTIONS: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

/**
 * The BOUNDED design tokens exposed in the editor. Only allow-listed token names
 * appear; font is an enum and radius uses a small rem range. Everything still passes
 * `sanitizeTokenValue` before it is written, and only `applyTokens` touches the DOM.
 * Severity/status/verdict fills are deliberately absent: each belongs to a measured
 * fill + foreground + standalone-text + CVD pairing that must change as one system.
 */
type TokenKind = 'color' | 'radius' | 'font';
interface TokenSpec {
  name: string; // the --css-var
  label: string;
  kind: TokenKind;
}
const TOKEN_SPECS: TokenSpec[] = [
  { name: '--radius', label: 'Corner radius', kind: 'radius' },
  { name: '--font-display', label: 'Display font', kind: 'font' },
];
// Defence-in-depth: every spec must reference an allow-listed token.
const SAFE_TOKEN_SPECS = TOKEN_SPECS.filter((s) => ALLOWED_TOKENS.has(s.name));

const FONT_CHOICES: Array<{ key: string; label: string }> = [
  { key: '', label: 'Default' },
  { key: 'inter', label: 'Inter' },
  { key: 'system', label: 'System UI' },
  { key: 'grotesk', label: 'Space Grotesk' },
  { key: 'mono', label: 'Monospace' },
];

const RADIUS_CHOICES: Array<{ key: string; label: string }> = [
  { key: '', label: 'Default' },
  { key: '0rem', label: 'Square' },
  { key: '0.375rem', label: 'Subtle' },
  { key: '0.5rem', label: 'Rounded' },
  { key: '0.75rem', label: 'Soft' },
  { key: '1rem', label: 'Pill-ish' },
];

/* -------------------------------------------------------------- utilities --- */

function isValidHex(v: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

/**
 * Convert an `H S% L%` CSS triplet (the form our severity colour tokens store, e.g.
 * `0 72% 51%`) to `#rrggbb`. Returns null on a malformed triplet. Pure + exported so
 * an unset token's swatch/placeholder can show the theme's REAL current colour instead
 * of a misleading black `#000000`. Tested in isolation.
 */
export function hslTripletToHex(triplet: string): string | null {
  const m = triplet.trim().match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)%\s+(-?\d*\.?\d+)%$/);
  if (!m) return null;
  const h = (((Number(m[1]) % 360) + 360) % 360) / 60;
  const s = Math.min(100, Math.max(0, Number(m[2]))) / 100;
  const l = Math.min(100, Math.max(0, Number(m[3]))) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const mm = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) [r, g, b] = [c, x, 0];
  else if (h < 2) [r, g, b] = [x, c, 0];
  else if (h < 3) [r, g, b] = [0, c, x];
  else if (h < 4) [r, g, b] = [0, x, c];
  else if (h < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + mm) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * The current computed colour of a `--token` (as `#rrggbb`), for an unset-token swatch
 * so it doesn't render black. Reads the live CSS custom property (an `H S% L%` triplet
 * for our tokens, occasionally a hex) and converts it. No-ops (null) in non-DOM/test envs.
 */
function resolvedTokenHex(name: string): string | null {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return null;
  if (isValidHex(raw)) return raw;
  return hslTripletToHex(raw);
}

/** Live-preview the accent by rewriting (or clearing) the primary/ring CSS vars. */
function applyAccentPreview(accentHex: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const pair = resolveAccentPair(accentHex || null);
  if (pair) {
    applyTokens({ '--primary': pair.fill, '--ring': pair.fill }, root);
    root.style.setProperty('--primary-foreground', pair.foreground);
  } else {
    root.style.removeProperty('--primary');
    root.style.removeProperty('--primary-foreground');
    root.style.removeProperty('--ring');
  }
}

/** Live-preview the secondary accent → `--accent2` (cleared when blank). */
function applyAccent2Preview(accentHex: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const triplet = accentHex ? hexToHslTriplet(accentHex) : null;
  if (triplet) applyTokens({ '--accent2': triplet }, root);
  else root.style.removeProperty('--accent2');
}

/**
 * Live-preview the bounded theme-token bag. Hex colour values are converted to the
 * `H S% L%` triplet the tokens expect; all values route through `applyTokens` (which
 * re-validates against the allow-list + `sanitizeTokenValue`). Tokens absent from the
 * draft are CLEARED so toggling one off restores the stylesheet default.
 */
function applyThemeTokensPreview(tokens: Record<string, string>): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  // Clear every editable token first, then re-apply the present ones.
  clearTokens(
    SAFE_TOKEN_SPECS.map((s) => s.name),
    root,
  );
  const toApply: Record<string, string> = {};
  for (const spec of SAFE_TOKEN_SPECS) {
    const raw = tokens[spec.name];
    if (!raw) continue;
    if (spec.kind === 'color') {
      const triplet = isValidHex(raw) ? hexToHslTriplet(raw) : null;
      if (triplet) toApply[spec.name] = triplet;
    } else {
      toApply[spec.name] = raw;
    }
  }
  applyTokens(toApply, root);
}

/** Live-preview the material chrome class (decorative grid overlay). */
function applyMaterialPreview(material: Material): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  // Delegate to the ONE allow-listed material applier so the preview matches the
  // saved appearance exactly — notably, 'quiet' CLEARS `--glass-opacity` (it has
  // per-theme stylesheet defaults, 0.97 in both today) instead of force-writing a value,
  // so a theme's own default is never overridden. Only 'command' changes the glass.
  applyMaterial(material, root);
  root.classList.toggle('command-grid', material === 'command');
  root.dataset.material = material;
}

/** Live-preview the favicon from a trusted data: URL (empty/blank → no change). */
// The site's ORIGINAL favicon (from index.html), captured once so removing a custom one
// can RESTORE it rather than leaving the tab icon stale until a full page reload.
let _originalFaviconHref: string | null = null;
function applyFaviconPreview(href: string): void {
  if (typeof document === 'undefined') return;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (_originalFaviconHref === null) _originalFaviconHref = link?.getAttribute('href') ?? '';
  // A valid custom data-URL wins; a blank/invalid href falls back to the original favicon.
  const next = href && href.startsWith('data:image/') ? href : _originalFaviconHref;
  if (!next) {
    // No custom AND no original → drop the <link rel=icon> so the tab icon isn't stale.
    if (link) link.parentNode?.removeChild(link);
    return;
  }
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = next;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Normalise to the Round-3 default colour mode (default_theme wins over legacy). */
function effectiveDefaultTheme(b: BrandingDoc): ThemeMode {
  if (b.dark_mode_default) return 'dark';
  const dt = (b.default_theme || '') as string;
  if (dt === 'light' || dt === 'dark' || dt === 'system') return dt;
  const legacy = (b.theme || '') as string;
  if (legacy === 'light' || legacy === 'dark' || legacy === 'system') return legacy;
  return 'system';
}

/* ----------------------------------------------------------- small heading -- */

function Heading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="space-y-0.5">
      {/* Shared typography primitives (§2.4) instead of a hand-rolled h3/p pair. The
          text-sm override keeps the compact 13px section-heading size while the level-4
          weight (600) + tracking come from the scale. Title/sub render as plain text (#9). */}
      <TypographyHeading level={4} as="h3" className="text-sm">
        {title}
      </TypographyHeading>
      {sub ? (
        <Text variant="small" className="leading-relaxed">
          {sub}
        </Text>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- color field ---- */

function ColorField({
  label,
  value,
  placeholder,
  invalid,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  invalid: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const swatch = value && isValidHex(value) ? value : placeholder;
  // Associate the visible Label with the hex Input so the field has an accessible
  // name (#6 — WCAG 1.3.1/4.1.2). A stable per-instance id keeps multiple ColorFields
  // distinct on the page.
  const hexId = React.useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={hexId}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={isValidHex(value) ? value : placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-background p-0.5 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ backgroundColor: swatch }}
        />
        <Input
          id={hexId}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
          className={cn('font-mono', invalid && 'border-critical focus-visible:ring-critical')}
        />
      </div>
      {invalid ? (
        <p className="text-xs text-critical">Enter a valid #rrggbb hex (or leave blank).</p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- image upload --- */

function ImageUpload({
  id,
  value,
  accept,
  promptText,
  disabled,
  onPick,
  onRemove,
  square,
}: {
  id: string;
  value: string;
  accept: string;
  promptText: string;
  disabled?: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
  square: number;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span
        className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted text-muted-foreground"
        style={{ width: square, height: square }}
      >
        {value ? (
          <img src={value} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <ImageIcon className="h-5 w-5" aria-hidden />
        )}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          disabled={disabled}
          aria-label={promptText}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            // reset so re-picking the same file re-fires change
            e.currentTarget.value = '';
          }}
        />
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <ImageIcon className="h-4 w-4" aria-hidden />
          {promptText}
        </Button>
        {value ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={disabled}
            className="text-critical hover:text-critical"
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------- login preview (8b) --- */

// Design canvas for the scaled login miniature (a browser-ish ~16:10). The stage is
// rendered at THIS size then uniformly scaled down to the box width, so the whole hero
// fits without the old clipping (the previous preview stuffed the full p-12/text-3xl
// hero into a fixed 224px box → the headline/chips/footer were cut off).
const PREVIEW_DESIGN_W = 1160;
const PREVIEW_DESIGN_H = 700;

type PreviewHero = Omit<BrandHeroProps, 'variant'>;

/**
 * A small, faithful identity-slab preview. It mirrors the real login's standalone
 * mark, single title hierarchy, and 48px credential rhythm—there is
 * intentionally no marketing hero, illustration, floating card, or elevation.
 */
function LoginPreviewCard({ hero }: { hero: PreviewHero }) {
  const title = hero.headline?.trim() || 'Welcome back';
  const description = hero.body?.trim() || hero.subtitle?.trim() || `Sign in to continue to ${hero.wordmark}.`;
  return (
    <div data-login-preview-content className="w-[384px]">
      <div className="mb-5 flex h-14 min-w-0 items-center">
        <div className="flex h-14 w-14 shrink-0 items-center justify-start">
          {hero.logoUrl ? (
            <img src={hero.logoUrl} alt="" className="h-14 w-14 object-contain" />
          ) : (
            <Shield className="h-12 w-12 stroke-[1.35] text-primary" aria-hidden />
          )}
        </div>
      </div>
      <div>
        <div className="text-left">
          <p className="break-words text-display font-medium text-foreground">
            {title}
          </p>
          <p className="mt-3 break-words text-base leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="mt-9 space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Username</p>
            <div className="h-12 rounded-md border border-input bg-background" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The full-screen login arrangement at DESIGN size. Legacy layout values remain
 * visible in Settings for wire compatibility, but all three intentionally preview the
 * same minimal centered shell used by the real login.
 */
function LoginPreviewStage({ layout, hero }: { layout: LoginLayout; hero: PreviewHero }) {
  return (
    <div
      data-login-preview-shell="minimal"
      data-login-preview-layout={layout}
      className="login-auth-canvas absolute inset-0 overflow-hidden"
    >
      <div className="absolute right-8 top-8 flex gap-0.5">
        <span className="h-6 w-6 bg-muted" />
        <span className="h-6 w-6" />
        <span className="h-6 w-6" />
      </div>
      <div className="flex min-h-full items-center justify-center px-12 py-12">
        <div className="relative isolate w-[480px]">
          <LoginAuthBackdrop staticFrame />
          <div
            data-login-preview-slab
            className="login-auth-slab relative z-30 min-h-[492px] w-[480px] px-12 pb-24 pt-12"
          >
            <LoginPreviewCard hero={hero} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A faithful, non-clipping miniature of the login screen: the DESIGN-size stage is
 * uniformly `scale()`d down to the box width (transform-origin top-left) inside a box
 * that holds the matching aspect ratio, so the full identity column fits without
 * clipping. A ResizeObserver keeps
 * the scale correct as the settings column resizes; jsdom (no RO / zero width) simply
 * keeps the default scale, which is harmless for the non-visual test env.
 */
function LoginPreview({ layout, hero }: { layout: LoginLayout; hero: PreviewHero }) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.5);

  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(w / PREVIEW_DESIGN_W);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={boxRef}
      className="relative w-full overflow-hidden rounded-lg border border-border bg-canvas shadow-elev1"
      style={{ aspectRatio: `${PREVIEW_DESIGN_W} / ${PREVIEW_DESIGN_H}` }}
    >
      {/* The stage is a visual mock — hide its skeleton + branding text from assistive tech;
          the editable, labelled controls below are the real interface. */}
      <div
        aria-hidden
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: PREVIEW_DESIGN_W,
          height: PREVIEW_DESIGN_H,
          transform: `scale(${scale})`,
        }}
      >
        <LoginPreviewStage layout={layout} hero={hero} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- main -- */

export interface BrandingEditorProps {
  /** Read-only mode from the parent Settings page (disables every control). */
  readOnly?: boolean;
}

export function BrandingEditor({ readOnly = false }: BrandingEditorProps) {
  const { branding: ctxBranding, isDark, refreshBranding } = useTheme();

  // The server-confirmed baseline (for dirty-tracking) and the working draft.
  const seed = React.useMemo<BrandingDoc>(
    () => ({ ...DEFAULT_BRANDING, ...(ctxBranding as Partial<BrandingDoc>) }),
    [ctxBranding],
  );
  const [saved, setSaved] = React.useState<BrandingDoc>(seed);
  const [draft, setDraft] = React.useState<BrandingDoc>(seed);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);
  const [logoError, setLogoError] = React.useState<string | null>(null);
  const [faviconError, setFaviconError] = React.useState<string | null>(null);
  // WCAG advisories from the LAST save (server-computed), if any.
  const [serverWarnings, setServerWarnings] = React.useState<string[]>([]);
  const [autoCorrected, setAutoCorrected] = React.useState<Record<string, string>>({});

  // Fetch the authoritative branding (callable so a load failure can be retried).
  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const b = await getBrandingDoc();
      const merged = { ...DEFAULT_BRANDING, ...b };
      setSaved(merged);
      setDraft(merged);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const set = (patch: Partial<BrandingDoc>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  // On unmount, restore the live preview to the saved/applied branding so unsaved
  // appearance edits never leak globally (switching sections / navigating away).
  const savedRef = React.useRef(saved);
  savedRef.current = saved;
  // The organization default is configuration, not the current operator's personal
  // theme. Never call ThemeProvider.setTheme() from this editor: that setter persists
  // `soc.theme`, and React StrictMode runs effect cleanup during the initial mount.
  // Using it here meant merely opening Branding could replace an explicit Light choice
  // with the organization's Dark default. System-mode operators adopt a newly SAVED org
  // default through refreshBranding(); explicit Light/Dark operators always keep theirs.
  React.useEffect(() => {
    return () => {
      const s = savedRef.current;
      applyAccentPreview(s.accent_color || '');
      applyAccent2Preview(s.accent_color2 || '');
      applyThemeTokensPreview(s.theme_tokens || {});
      applyMaterialPreview((s.material as Material) || 'quiet');
      applyFaviconPreview(s.favicon_data_url || '');
    };
  }, []);

  /* --------------------------------------------------------------- accents -- */

  const accent = draft.accent_color || '';
  const accent2 = draft.accent_color2 || '';
  const accentValid = !accent || isValidHex(accent);
  const accent2Valid = !accent2 || isValidHex(accent2);

  const onAccent = (value: string) => {
    set({ accent_color: value });
    if (!value || isValidHex(value)) applyAccentPreview(value || '');
  };
  const onAccent2 = (value: string) => {
    set({ accent_color2: value });
    if (!value || isValidHex(value)) applyAccent2Preview(value || '');
  };
  const resetAccents = () => {
    set({ accent_color: '', accent_color2: '' });
    applyAccentPreview('');
    applyAccent2Preview('');
  };

  /** Apply a one-click named preset (accent + accent2). */
  const applyPreset = (hex: string, hex2?: string) => {
    set({ accent_color: hex, accent_color2: hex2 || '' });
    applyAccentPreview(hex);
    applyAccent2Preview(hex2 || '');
  };

  /* ------------------------------------------------------------ theme tokens - */

  const themeTokens = draft.theme_tokens || {};
  const setToken = (name: string, value: string) => {
    const next = { ...themeTokens };
    if (!value) delete next[name];
    else next[name] = value;
    set({ theme_tokens: next });
    applyThemeTokensPreview(next);
  };
  const resetTokens = () => {
    set({ theme_tokens: {} });
    applyThemeTokensPreview({});
  };

  /* ----------------------------------------------------------------- theme -- */

  const currentDefaultTheme = effectiveDefaultTheme(draft);
  const onDefaultTheme = (id: ThemeMode) => {
    // Keep BOTH the Round-3 `default_theme` and the legacy `theme` aligned, and clear
    // the legacy `dark_mode_default` override so the explicit choice wins cleanly.
    set({ default_theme: id, theme: id, dark_mode_default: false });
  };

  /* ----------------------------------------------------------- material pack - */

  const material: Material = draft.material === 'command' ? 'command' : 'quiet';
  const onMaterial = (commandOn: boolean) => {
    const next: Material = commandOn ? 'command' : 'quiet';
    set({ material: next });
    applyMaterialPreview(next);
  };

  /* ------------------------------------------------------------------ logo -- */

  const onLogo = async (file: File) => {
    setLogoError(null);
    if (!LOGO_TYPES.includes(file.type)) {
      setLogoError('Unsupported format. Use a PNG, JPEG, SVG, or WebP image.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`Logo is too large (${Math.round(file.size / 1024)} KB). The limit is 200 KB.`);
      return;
    }
    try {
      set({ logo_data_url: await readAsDataUrl(file) });
    } catch {
      setLogoError('Could not read the file. Please try again.');
    }
  };

  const onFavicon = async (file: File) => {
    setFaviconError(null);
    const okType = !file.type || FAVICON_TYPES.includes(file.type) || /\.ico$/i.test(file.name);
    if (!okType) {
      setFaviconError('Unsupported format. Use an ICO, PNG, or SVG image.');
      return;
    }
    if (file.size > MAX_FAVICON_BYTES) {
      setFaviconError(`Favicon is too large (${Math.round(file.size / 1024)} KB). The limit is 64 KB.`);
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      if (!dataUrl.startsWith('data:image/')) {
        setFaviconError('That file did not read as an image.');
        return;
      }
      set({ favicon_data_url: dataUrl });
      applyFaviconPreview(dataUrl); // live preview, mirroring accent/token/material edits
    } catch {
      setFaviconError('Could not read the file. Please try again.');
    }
  };

  /* ---------------------------------------------------- login white-label -- */

  // Round-4 login copy + curated layout/illustration keys. All are bounded PLAIN TEXT
  // (headline/body/chips) or a curated ENUM key (layout/illustration) — never markup
  // or a URL (#6/#9). The BrandHero live preview renders every string as plain text.
  const loginLayout = asLoginLayout(draft.login_layout);
  const loginChips: string[] = Array.isArray(draft.login_chips)
    ? draft.login_chips.map((c) => String(c))
    : [];

  const setChip = (index: number, value: string) => {
    const next = loginChips.slice();
    next[index] = value.slice(0, MAX_LOGIN_CHIP_LEN);
    set({ login_chips: next });
  };
  const addChip = () => {
    if (loginChips.length >= MAX_LOGIN_CHIPS) return;
    set({ login_chips: [...loginChips, ''] });
  };
  const removeChip = (index: number) => {
    set({ login_chips: loginChips.filter((_, i) => i !== index) });
  };
  // The chips actually shown on the login screen (blank chips are dropped there).
  const previewChips = loginChips.map((c) => c.trim()).filter((c) => c.length > 0);

  /* --------------------------------------------------------------- persist -- */

  const dirty = React.useMemo(() => {
    try {
      return JSON.stringify(draft) !== JSON.stringify(saved);
    } catch {
      return true;
    }
  }, [draft, saved]);
  // Branding owns an independent save lifecycle and is intentionally excluded from
  // the parent Settings dirty map. Surface its draft to the shell update guard here.
  useUnsavedChanges(dirty, !readOnly);

  const supportUrlValid =
    !draft.support_url ||
    (/^https?:\/\//i.test(draft.support_url) && draft.support_url.length <= MAX_URL_LEN);

  // A local WCAG-AA advisory for the chosen accent (used when the backend does not
  // return one). Recomputed on every accent edit.
  const localContrast = React.useMemo(
    () => (accentValid ? accentContrastAdvisory(accent) : null),
    [accent, accentValid],
  );

  const canSave =
    dirty && accentValid && accent2Valid && supportUrlValid && !readOnly && !saving;

  const save = async () => {
    setSaving(true);
    try {
      const next = await putBrandingDoc({
        ...draft,
        accent_color: accent,
        accent_color2: accent2,
      });
      const { contrast_warnings, auto_corrected, ...brand } = next;
      const merged = { ...DEFAULT_BRANDING, ...brand };
      setSaved(merged);
      setDraft(merged);
      setServerWarnings(Array.isArray(contrast_warnings) ? contrast_warnings : []);
      setAutoCorrected(
        auto_corrected && typeof auto_corrected === 'object' ? auto_corrected : {},
      );
      // Re-apply the resolved appearance (the backend may have auto-corrected values).
      applyAccentPreview(merged.accent_color || '');
      applyAccent2Preview(merged.accent_color2 || '');
      applyThemeTokensPreview(merged.theme_tokens || {});
      applyMaterialPreview((merged.material as Material) || 'quiet');
      applyFaviconPreview(merged.favicon_data_url || '');
      // Resync the SHARED ThemeProvider context (Login, AppShell, the browser tab
      // title/favicon, …) so the just-saved branding is visible everywhere in THIS SPA
      // session without a hard reload — the actual fix for "saved branding doesn't show
      // on the login screen": ThemeProvider is mounted once at the app root and
      // otherwise never refetches. The backend persists synchronously before the PUT
      // responds, so this fresh GET is guaranteed to observe the just-saved doc.
      void refreshBranding();
      toast.success('Branding saved.');
    } catch (e) {
      toast.error(errMsg(e, 'Could not save branding.'));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(saved);
    setLogoError(null);
    setFaviconError(null);
    setServerWarnings([]);
    setAutoCorrected({});
    applyAccentPreview(saved.accent_color || '');
    applyAccent2Preview(saved.accent_color2 || '');
    applyThemeTokensPreview(saved.theme_tokens || {});
    applyMaterialPreview((saved.material as Material) || 'quiet');
    applyFaviconPreview(saved.favicon_data_url || '');
  };

  /* ---------------------------------------------------------------- render -- */

  const wordmark = draft.org_name.trim() || 'Agentic SOC';
  const tagline = draft.product_name.trim() || 'Security operations console';
  const a1 = accentValid && accent ? accent : DEFAULT_ACCENT;
  const a2 = accent2Valid && accent2 ? accent2 : DEFAULT_ACCENT2;
  const gradient = `linear-gradient(135deg, ${a1} 0%, ${a2} 100%)`;

  if (loading) {
    return (
      <LoadingState
        label="Loading branding"
        description="Preparing your organization’s appearance controls."
        layout="panel"
        shape="panel"
      />
    );
  }
  if (error) {
    return <LoadError error={error} title="Couldn't load branding" onRetry={() => void load()} />;
  }

  const hasServerWarnings = serverWarnings.length > 0;
  const correctedNames = Object.keys(autoCorrected);

  return (
    <div className="space-y-6" data-testid="branding-settings-surface">
      <SectionTitle
        title="Branding"
        sub="Set the organization wordmark, logo, accents, bounded design tokens, default theme, and sign-in experience."
      />

      {/* Live preview of the shell header */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Live preview
        </p>
        <div className="overflow-hidden border-y border-border" data-testid="branding-live-preview">
          <div className="h-1" style={{ background: gradient }} />
          <div
            className="flex items-center gap-3 bg-primary px-5 py-4 text-primary-foreground"
          >
            <span
              className="inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-md"
              style={{ background: 'hsl(var(--primary-foreground) / 0.14)' }}
            >
              {draft.logo_data_url ? (
                <img src={draft.logo_data_url} alt="" className="h-11 w-11 object-contain" />
              ) : (
                <ShieldCheck className="h-6 w-6" aria-hidden />
              )}
            </span>
            <div className="leading-tight">
              <div className="text-lg font-bold">{wordmark}</div>
              <div className="text-xs opacity-90">{tagline}</div>
            </div>
          </div>
        </div>
      </div>

      {/* WCAG-AA contrast advisory: server-reported (authoritative) OR the local check. */}
      {hasServerWarnings ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Contrast check (from the last save)</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {/* server warning strings are controlled UI copy — render plain text */}
              {serverWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            {correctedNames.length ? (
              <p className="mt-2 text-xs">
                Auto-corrected to stay AA: {correctedNames.join(', ')}.
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : localContrast ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>{localContrast.severe ? 'Accent fails WCAG-AA' : 'Low accent contrast'}</AlertTitle>
          <AlertDescription>{localContrast.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* Wordmark */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="brand-org">Organisation name</Label>
          <Input
            id="brand-org"
            value={draft.org_name}
            placeholder="Agentic SOC"
            disabled={readOnly}
            maxLength={MAX_TEXT_LEN}
            onChange={(e) => set({ org_name: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Shown as the wordmark. Blank uses “Agentic SOC”.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-product">Product name</Label>
          <Input
            id="brand-product"
            value={draft.product_name}
            placeholder="Triage console"
            disabled={readOnly}
            maxLength={MAX_TEXT_LEN}
            onChange={(e) => set({ product_name: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Tagline beneath the wordmark. Blank uses “Triage console”.</p>
        </div>
      </div>

      <Separator />

      {/* Logo + favicon */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <Heading title="Logo" sub="PNG, JPEG, SVG, or WebP up to 200 KB. Stored inline." />
          <ImageUpload
            id="brand-logo-file"
            value={draft.logo_data_url}
            accept={LOGO_ACCEPT}
            promptText="Select or drag a logo"
            disabled={readOnly}
            square={64}
            onPick={(f) => void onLogo(f)}
            onRemove={() => {
              set({ logo_data_url: '' });
              setLogoError(null);
            }}
          />
          {logoError ? <p className="text-xs text-critical">{logoError}</p> : null}
        </div>
        <div className="space-y-2">
          <Heading title="Browser tab icon (favicon)" sub="ICO, PNG, or SVG up to 64 KB. Stored inline." />
          <ImageUpload
            id="brand-favicon-file"
            value={draft.favicon_data_url}
            accept={FAVICON_ACCEPT}
            promptText="Select or drag a favicon"
            disabled={readOnly}
            square={40}
            onPick={(f) => void onFavicon(f)}
            onRemove={() => {
              set({ favicon_data_url: '' });
              applyFaviconPreview(''); // reflect removal immediately (restore the original)
              setFaviconError(null);
            }}
          />
          {faviconError ? <p className="text-xs text-critical">{faviconError}</p> : null}
        </div>
      </div>

      <Separator />

      {/* Accent presets */}
      <div className="space-y-3">
        <Heading
          title="Accent presets"
          sub="One-click brand hues — each vetted to keep white text at WCAG-AA on the accent fill."
        />
        <div className="flex flex-wrap gap-2">
          {ACCENT_PRESETS.map((p) => {
            const active =
              accent.toLowerCase() === p.hex.toLowerCase() &&
              (accent2.toLowerCase() === (p.hex2 || '').toLowerCase() || !p.hex2);
            return (
              <button
                key={p.key}
                type="button"
                disabled={readOnly}
                onClick={() => applyPreset(p.hex, p.hex2)}
                aria-pressed={active}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  active
                    ? 'border-primary bg-accent text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <span
                  className="h-4 w-4 rounded-full ring-1 ring-black/10"
                  style={{
                    background: p.hex2
                      ? `linear-gradient(135deg, ${p.hex} 0%, ${p.hex2} 100%)`
                      : p.hex,
                  }}
                  aria-hidden
                />
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Accent colours */}
      <div className="space-y-3">
        <Heading title="Accent colours" sub="The primary accent previews instantly across the console." />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ColorField
            label="Primary accent"
            value={accent}
            placeholder={DEFAULT_ACCENT}
            invalid={!accentValid}
            disabled={readOnly}
            onChange={onAccent}
          />
          <ColorField
            label="Secondary accent"
            value={accent2}
            placeholder={DEFAULT_ACCENT2}
            invalid={!accent2Valid}
            disabled={readOnly}
            onChange={onAccent2}
          />
          <div className="space-y-1.5">
            <Label>Gradient</Label>
            <div
              className="h-9 rounded-md border border-border"
              style={{ background: gradient }}
              aria-hidden
            />
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={resetAccents} disabled={readOnly}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Reset to default
        </Button>
      </div>

      <Separator />

      {/* Design tokens (bounded) */}
      <div className="space-y-3">
        <Heading
          title="Design tokens"
          sub="Bounded layout tokens — corner radius and display font. Semantic severity, status, and verdict colours stay system-owned so their measured text contrast and colour-blind-safe pairings cannot drift."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SAFE_TOKEN_SPECS.map((spec) => {
            const value = themeTokens[spec.name] || '';
            if (spec.kind === 'color') {
              const invalid = Boolean(value) && !isValidHex(value);
              // Show the token's REAL current colour as the unset swatch/placeholder
              // rather than a misleading black (unset severity tokens all looked black).
              const placeholder = resolvedTokenHex(spec.name) || '#000000';
              return (
                <ColorField
                  key={spec.name}
                  label={spec.label}
                  value={value}
                  placeholder={placeholder}
                  invalid={invalid}
                  disabled={readOnly}
                  onChange={(v) => setToken(spec.name, v)}
                />
              );
            }
            const choices = spec.kind === 'font' ? FONT_CHOICES : RADIUS_CHOICES;
            return (
              <div key={spec.name} className="space-y-1.5">
                <Label>{spec.label}</Label>
                <Select
                  value={value || '__default__'}
                  disabled={readOnly}
                  onValueChange={(v) => setToken(spec.name, v === '__default__' ? '' : v)}
                >
                  <SelectTrigger aria-label={spec.label}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((c) => (
                      <SelectItem key={c.key || '__default__'} value={c.key || '__default__'}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
        <Button variant="ghost" size="sm" onClick={resetTokens} disabled={readOnly}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Reset tokens
        </Button>
      </div>

      <Separator />

      {/* Material pack */}
      <div className="space-y-3">
        <Heading
          title="Material pack"
          sub="The shell surface treatment. “Command” adds a faint glow + grid overlay for a denser command-center feel — colours and text contrast are unchanged."
        />
        {/* Not a <label>: a native <label> does not forward clicks to a Radix
            Switch (a <button role="switch">), so it provided no association —
            the Switch is self-labeled via aria-label. A <div> keeps the styling
            and behavior identical while dropping the misleading label semantics. */}
        <div className="flex max-w-xl items-center gap-3 border-y border-border py-3 text-sm text-foreground">
          <Switch
            checked={material === 'command'}
            disabled={readOnly}
            onCheckedChange={onMaterial}
            aria-label="Use the command material pack"
          />
          <span className="inline-flex items-center gap-1.5">
            <Zap className="h-4 w-4 text-primary" aria-hidden />
            Command material pack
          </span>
        </div>
      </div>

      <Separator />

      {/* Theme */}
      <div className="space-y-3">
        <Heading title="Default theme" sub="The org default colour mode; “System” follows the OS. Your personal appearance stays active while you edit." />
        <div className="inline-flex border border-border bg-muted p-0.5">
          {THEME_OPTIONS.map((o) => {
            const active = currentDefaultTheme === o.id;
            const Icon = o.icon;
            return (
              <button
                key={o.id}
                type="button"
                disabled={readOnly}
                onClick={() => onDefaultTheme(o.id)}
                aria-pressed={active}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  active
                    ? 'bg-card text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {o.label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Your Console remains in your personal <strong className="font-semibold text-foreground">{isDark ? 'dark' : 'light'}</strong> theme. System users adopt this default after Save.
        </p>
      </div>

      <Separator />

      {/* Login & messaging */}
      <div className="space-y-4">
        <Heading
          title="Login &amp; messaging"
          sub="Operator-set copy shown on the login screen and console chrome."
        />
        <div className="space-y-1.5">
          <Label htmlFor="brand-subtitle">Login subtitle</Label>
          <Input
            id="brand-subtitle"
            value={draft.login_subtitle}
            placeholder="Welcome back"
            disabled={readOnly}
            maxLength={MAX_TEXT_LEN}
            onChange={(e) => set({ login_subtitle: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Used as the short sentence beneath the sign-in heading when no custom
            description is set below.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-footer">Footer text</Label>
          <Input
            id="brand-footer"
            value={draft.footer_text}
            placeholder="UNCLASSIFIED"
            disabled={readOnly}
            maxLength={MAX_TEXT_LEN}
            onChange={(e) => set({ footer_text: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            A footer / classification banner line (e.g. “UNCLASSIFIED // FOUO”).
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-support">Support / docs URL</Label>
          <Input
            id="brand-support"
            value={draft.support_url}
            placeholder="https://help.example.com"
            disabled={readOnly}
            maxLength={MAX_URL_LEN}
            aria-invalid={!supportUrlValid}
            className={cn(!supportUrlValid && 'border-critical focus-visible:ring-critical')}
            onChange={(e) => set({ support_url: e.target.value })}
          />
          {!supportUrlValid ? (
            <p className="text-xs text-critical">Enter an http(s):// URL or leave blank.</p>
          ) : null}
        </div>
      </div>

      <Separator />

      {/* Login screen — bounded optional copy inside one minimal sign-in shell. */}
      <div className="space-y-4">
        <Heading
          title="Login screen"
          sub="Keep sign-in quiet and concise. Optional copy is plain text and appears inside the centered identity slab."
        />

        {/* Faithful miniature of the same minimal shell used by Login. */}
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Login preview
          </p>
          <LoginPreview
            layout={loginLayout}
            hero={{
              wordmark,
              tagline,
              logoUrl: draft.logo_data_url || '',
              headline: draft.login_headline || '',
              body: draft.login_body || '',
              chips: previewChips,
              subtitle: draft.login_subtitle || '',
              footerText: draft.footer_text || '',
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="brand-login-headline">Short welcome line</Label>
          <Input
            id="brand-login-headline"
            value={draft.login_headline || ''}
            placeholder="Welcome to your security workspace"
            disabled={readOnly}
            maxLength={MAX_LOGIN_HEADLINE_LEN}
            onChange={(e) => set({ login_headline: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Optional. Replaces the default “Welcome back” heading.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="brand-login-body">Sign-in description</Label>
          <Textarea
            id="brand-login-body"
            value={draft.login_body || ''}
            placeholder="Use your organization account to continue."
            disabled={readOnly}
            maxLength={MAX_LOGIN_BODY_LEN}
            rows={3}
            onChange={(e) => set({ login_body: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Optional. Replaces the default sentence beneath the heading.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Footer notes</Label>
          <p className="text-xs text-muted-foreground">
            Up to {MAX_LOGIN_CHIPS} short notes shown as quiet dot-separated text.
          </p>
          <div className="space-y-2">
            {loginChips.map((chip, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  aria-label={`Login chip ${i + 1}`}
                  value={chip}
                  placeholder="e.g. Audited"
                  disabled={readOnly}
                  maxLength={MAX_LOGIN_CHIP_LEN}
                  onChange={(e) => setChip(i, e.target.value)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={readOnly}
                  className="shrink-0 text-critical hover:text-critical"
                  onClick={() => removeChip(i)}
                  aria-label={`Remove login chip ${i + 1}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            ))}
          </div>
          {loginChips.length < MAX_LOGIN_CHIPS ? (
            <Button variant="outline" size="sm" type="button" disabled={readOnly} onClick={addChip}>
              Add note
            </Button>
          ) : null}
        </div>

        <p className="text-xs leading-5 text-muted-foreground">
          Saved legacy layout and illustration values remain preserved for compatibility;
          the current Console intentionally uses one minimal sign-in layout.
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button onClick={() => void save()} disabled={!canSave}>
          <Save className="h-4 w-4" aria-hidden />
          {saving ? 'Saving…' : 'Save branding'}
        </Button>
        <Button variant="ghost" onClick={discard} disabled={!dirty || saving}>
          <X className="h-4 w-4" aria-hidden />
          Discard
        </Button>
        {!dirty && !saving ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-success" aria-hidden />
            Saved
          </span>
        ) : null}
        {readOnly ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Brush className="h-3.5 w-3.5" aria-hidden />
            Read-only mode
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default BrandingEditor;
