/**
 * Login building blocks: the credential fields, a client-side password-strength
 * meter, per-provider SSO brand icons, a segmented one-time-code input, and the
 * curated login white-label key sets.
 *
 * These are presentational pieces composed by `pages/Login.tsx`. They add NO new
 * dependencies and render all branding text as PLAIN text (#9). Nothing here animates:
 * the sign-in page's only motion is the CSS entrance in styles/theme.css.
 */
import * as React from 'react';
import {
  ShieldCheck,
  Eye,
  EyeOff,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input, type InputProps } from '@/ui/input';

// --------------------------------------------------------------------------- //
// Login controls: one local grammar for every credential field.
//
// These are login-specific rather than another global Input variant: the 44px
// target belongs to the sign-in page, while the Console's dense tables and filters
// keep the 36px base Input. The edge is the Console's `--input` (at least 3:1 on the
// canvas and the field fill), the ring the Console's focus ring, and the text 16px
// on phones (no browser focus zoom) and 14px from the small breakpoint up.
// --------------------------------------------------------------------------- //

const LOGIN_CONTROL_CLASS = cn(
  'h-11 rounded-md border border-input bg-background text-lg shadow-none sm:text-base',
  'transition-[border-color,background-color,box-shadow] duration-150',
  'placeholder:text-muted-foreground hover:border-border-strong',
  'focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring',
);

export interface LoginTextInputProps extends InputProps {
  /** Optional context glyph. Ordinary sign-in fields stay icon-free and editorial. */
  icon?: LucideIcon;
}

/**
 * A calm text field for the identity surface. Optional context glyphs are reserved
 * for setup/recovery states; ordinary sign-in stays icon-free and editorial. The
 * native input remains the only focusable control and retains base keyboard semantics.
 */
export const LoginTextInput = React.forwardRef<HTMLInputElement, LoginTextInputProps>(
  ({ icon: Icon, className, ...props }, ref) => (
    <div className="group relative">
      {Icon ? (
        <Icon
          className={cn(
            'pointer-events-none absolute left-3.5 top-1/2 z-10 h-4 w-4 -translate-y-1/2',
            'text-muted-foreground transition-colors group-focus-within:text-primary',
          )}
          aria-hidden
        />
      ) : null}
      <Input
        ref={ref}
        className={cn(LOGIN_CONTROL_CLASS, Icon ? 'pl-10' : 'px-3.5', className)}
        {...props}
      />
    </div>
  ),
);
LoginTextInput.displayName = 'LoginTextInput';

// --------------------------------------------------------------------------- //
// Password strength — a tiny, dependency-free zxcvbn-style heuristic.
// --------------------------------------------------------------------------- //
export interface PasswordStrength {
  /** 0 (empty) .. 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  /** Short human label for the current score. */
  label: string;
  /** A single, most-useful next-step hint (or "" when strong/empty). */
  hint: string;
}

const STRENGTH_LABELS = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/**
 * Score a password 0..4 from a handful of cheap signals (length + character
 * classes + a light repetition/sequence penalty). This is a UX nicety only — the
 * backend still enforces its own minimum — so it is intentionally approximate and
 * never blocks submission.
 */
export function scorePassword(pw: string): PasswordStrength {
  if (!pw) return { score: 0, label: '', hint: '' };

  const len = pw.length;
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^A-Za-z0-9]/.test(pw));

  let pts = 0;
  // Length is the dominant signal.
  if (len >= 8) pts += 1;
  if (len >= 12) pts += 1;
  if (len >= 16) pts += 1;
  // Character variety.
  if (classes >= 2) pts += 1;
  if (classes >= 3) pts += 1;
  // Penalise obvious low-entropy shapes.
  const repeated = /(.)\1\1/.test(pw); // 3+ of the same char in a row
  const sequential = /(?:abc|bcd|cde|def|123|234|345|456|567|678|789|qwer|asdf)/i.test(pw);
  if (repeated || sequential) pts -= 1;

  const score = Math.max(0, Math.min(4, pts)) as PasswordStrength['score'];

  let hint = '';
  if (len < 8) hint = 'Use at least 8 characters.';
  else if (classes < 3) hint = 'Mix upper, lower, numbers & symbols.';
  else if (len < 12) hint = 'Longer passwords are much stronger.';
  else if (repeated || sequential) hint = 'Avoid repeated or sequential characters.';

  return { score, label: STRENGTH_LABELS[score], hint };
}

/** Token colour per score bucket (semantic SOC scale, light/dark aware). */
const STRENGTH_BAR: Record<number, string> = {
  0: 'bg-critical',
  1: 'bg-critical',
  2: 'bg-warning',
  3: 'bg-info',
  4: 'bg-success',
};
// Standalone-text tints use the AA-tuned `-text` triad member (theme.css §1.3): the
// solid `--{axis}` FILL fails 4.5:1 as small text on the light card, so the label
// colour must come from `--{axis}-text` (measured AA in both themes).
const STRENGTH_TEXT: Record<number, string> = {
  0: 'text-critical-text',
  1: 'text-critical-text',
  2: 'text-warning-text',
  3: 'text-info-text',
  4: 'text-success-text',
};

/**
 * A 4-segment strength meter + label + a single next-step hint. Renders nothing
 * until the user has typed (so empty forms stay clean).
 */
export const PasswordStrengthMeter: React.FC<{ password: string; className?: string }> = ({
  password,
  className,
}) => {
  const { score, label, hint } = React.useMemo(() => scorePassword(password), [password]);
  if (!password) return null;
  // Map 0..4 onto 4 visible segments. A non-empty password is always ≥1 filled
  // segment so a score-0 "Too weak" shows a single red bar (distinct from the empty
  // / untyped all-`bg-border` state) instead of reading as no reaction.
  const filled = Math.max(1, Math.min(4, score));
  return (
    <div className={cn('space-y-1.5', className)} aria-live="polite">
      <div className="flex gap-1.5" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-300',
              i < filled ? STRENGTH_BAR[score] : 'bg-border',
            )}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className={cn('font-medium', STRENGTH_TEXT[score])}>{label}</span>
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------- //
// PasswordInput — a masked credential field with a functional reveal (eye) toggle.
// The toggle only ever reveals what the user is CURRENTLY typing;
// there is no persisted secret to echo. Used by every password field on the login
// surface (sign-in / create-admin / change-password). The reveal state is local so
// each field toggles independently. `autoComplete` is caller-set (never defaulted)
// so a manager fills the right credential (`current-password`/`new-password`).
// --------------------------------------------------------------------------- //
export interface PasswordInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** REQUIRED — never defaulted (current-password vs new-password matters for autofill). */
  autoComplete: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  /** Forwarded to the input for a11y wiring (e.g. a policy-hint paragraph). */
  ariaDescribedBy?: string;
  /** Forwarded when a credential failure belongs to this field. */
  ariaInvalid?: React.AriaAttributes['aria-invalid'];
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(({
  id,
  value,
  onChange,
  autoComplete,
  name,
  placeholder,
  disabled,
  required,
  autoFocus,
  ariaDescribedBy,
  ariaInvalid,
}, ref) => {
  const [reveal, setReveal] = React.useState(false);
  return (
    <div className="group relative">
      <Input
        ref={ref}
        id={id}
        type={reveal ? 'text' : 'password'}
        className={cn(LOGIN_CONTROL_CLASS, 'pl-3.5 pr-11')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        name={name}
        placeholder={placeholder}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        required={required}
        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused login flow; behavior-preserving */
        autoFocus={autoFocus}
      />
      <button
        type="button"
        onClick={() => setReveal((r) => !r)}
        disabled={disabled}
        aria-label={reveal ? 'Hide password' : 'Show password'}
        aria-pressed={reveal}
        className={cn(
          'absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground',
          'transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {reveal ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
});
PasswordInput.displayName = 'PasswordInput';

// --------------------------------------------------------------------------- //
// SSO brand icons — small inline SVGs so we don't pull in an icon-brand pack.
// --------------------------------------------------------------------------- //
const GoogleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
    />
  </svg>
);

const MicrosoftIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
    <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
    <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
    <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
    <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
  </svg>
);

/** Brand icon for an SSO provider type; falls back to a neutral shield glyph. */
export const SsoBrandIcon: React.FC<{ type?: string; className?: string }> = ({
  type,
  className,
}) => {
  const cls = cn('h-4 w-4', className);
  if (type === 'google') return <GoogleIcon className={cls} />;
  if (type === 'microsoft') return <MicrosoftIcon className={cls} />;
  return <ShieldCheck className={cls} aria-hidden />;
};

// --------------------------------------------------------------------------- //
// Segmented one-time-code input (6 cells) for the MFA step.
// --------------------------------------------------------------------------- //
export interface OtpInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Fired when all `length` cells are filled (e.g. auto-submit). */
  onComplete?: (code: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  'aria-label'?: string;
}

/**
 * A 6-cell segmented OTP input backed by a single string value. Handles
 * type-to-advance, backspace-to-retreat, arrow navigation, and paste of a full
 * code. Only digits are accepted; the underlying value stays a plain string so
 * the existing `submitMfa` handler is unchanged.
 */
export const OtpInput: React.FC<OtpInputProps> = ({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  autoFocus,
  'aria-label': ariaLabel = 'One-time code',
}) => {
  const refs = React.useRef<Array<HTMLInputElement | null>>([]);
  const digits = React.useMemo(() => {
    const arr = value.replace(/\D/g, '').slice(0, length).split('');
    while (arr.length < length) arr.push('');
    return arr;
  }, [value, length]);

  const focusCell = (i: number) => {
    const el = refs.current[Math.max(0, Math.min(length - 1, i))];
    el?.focus();
    el?.select?.();
  };

  // Returns the new collapsed value so callers can move focus to the cell that
  // ACTUALLY holds the next empty slot. `digits` is always front-packed (gaps are
  // stripped by `onChange`), so focusing `index + 1` blindly overshoots when a gap
  // cell was clicked; callers clamp against `joined.length` instead.
  const setAt = (index: number, char: string): string => {
    const next = digits.slice();
    next[index] = char;
    const joined = next.join('').replace(/\D/g, '').slice(0, length);
    onChange(joined);
    if (joined.length === length) onComplete?.(joined);
    return joined;
  };

  const handleChange = (index: number, raw: string) => {
    const only = raw.replace(/\D/g, '');
    if (!only) {
      setAt(index, '');
      return;
    }
    // If the user typed/pasted multiple digits into one cell, spread them.
    if (only.length > 1) {
      const next = digits.slice();
      let cursor = index;
      for (const ch of only) {
        if (cursor >= length) break;
        next[cursor] = ch;
        cursor += 1;
      }
      const joined = next.join('').replace(/\D/g, '').slice(0, length);
      onChange(joined);
      if (joined.length === length) onComplete?.(joined);
      else focusCell(joined.length);
      return;
    }
    const joined = setAt(index, only);
    // Never move past the last filled cell: a digit typed into a gap re-packs to the
    // front, so the caret follows it instead of overshooting to the clicked index+1.
    focusCell(Math.min(index + 1, joined.length));
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[index]) {
        setAt(index, '');
      } else if (index > 0) {
        e.preventDefault();
        setAt(index - 1, '');
        focusCell(index - 1);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusCell(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusCell(index + 1);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!text) return;
    e.preventDefault();
    onChange(text);
    if (text.length === length) onComplete?.(text);
    else focusCell(text.length);
  };

  return (
    // gap-1.5 keeps every cell about 40px wide on a 320px phone.
    <div className="flex items-center justify-between gap-1.5" role="group" aria-label={ariaLabel}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.currentTarget.select()}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          disabled={disabled}
          /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
          autoFocus={autoFocus && i === 0}
          aria-label={`${ariaLabel} digit ${i + 1}`}
          className={cn(
            LOGIN_CONTROL_CLASS,
            'h-12 w-full min-w-0 px-0 text-center font-mono text-lg font-semibold',
            'focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            d ? 'border-ring/60' : '',
          )}
        />
      ))}
    </div>
  );
};

// --------------------------------------------------------------------------- //
// Login white-label (#6/#9): the CURATED layout + illustration key sets.
//
// The branding doc only ever carries bounded PLAIN-TEXT copy (headline/body/chips)
// plus an enum LAYOUT key and an enum ILLUSTRATION key. It never carries HTML, SVG
// markup, or a URL, so nothing operator-supplied is ever interpolated as markup.
// Both keys stay accepted and round-trip for compatibility; the sign-in page renders
// one shell for every layout and draws no illustration (Round 16 WP04).
// --------------------------------------------------------------------------- //

/** The three curated login arrangements (mirror `login_layout` on the backend). */
export type LoginLayout = 'split' | 'centered' | 'full';
export const LOGIN_LAYOUTS: readonly LoginLayout[] = ['split', 'centered', 'full'] as const;

/**
 * The curated login-illustration keys (mirror `login_illustration` +
 * `_LOGIN_ILLUSTRATIONS` on the backend). Accepted and preserved, never drawn.
 */
export const LOGIN_ILLUSTRATIONS = [
  '',
  'shield',
  'radar',
  'grid',
  'waves',
  'aurora',
  'constellation',
  'mesh',
] as const;
export type LoginIllustration = (typeof LOGIN_ILLUSTRATIONS)[number];

/** Coerce an arbitrary string to a known layout (defensive; unknown → 'split'). */
export function asLoginLayout(v: string | undefined | null): LoginLayout {
  return v === 'centered' || v === 'full' ? v : 'split';
}

/** Coerce an arbitrary string to a known illustration key (unknown → ''). */
export function asLoginIllustration(v: string | undefined | null): LoginIllustration {
  return (LOGIN_ILLUSTRATIONS as readonly string[]).includes(v ?? '')
    ? ((v ?? '') as LoginIllustration)
    : '';
}
