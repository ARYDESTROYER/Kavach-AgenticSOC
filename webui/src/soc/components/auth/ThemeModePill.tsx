/**
 * ThemeModePill — the identity canvas's Light mode / Dark mode switch.
 *
 * A gradient pill that names the mode you are currently IN, with a crescent on
 * the left and a plain disc on the right that scale-swap as the mode changes,
 * a label that slides toward whichever glyph is showing, and two blurred orbs
 * behind the pill that trade sides on every toggle. Every effect is a CSS
 * transition in `theme.css` keyed off `data-appearance` — no animation library,
 * and the global reduced-motion rule neutralises all of it for free.
 *
 * Two structural rules keep the measured contrast honest:
 *
 *   - The glyphs live in FIXED side cells of a three-column grid, so the label
 *     can never drift over the bright end of either gradient. Contrast was
 *     measured across the label's cell only (>= 5.1:1 in both states).
 *   - The orbs sit at `z-index: 0` BEHIND an opaque `__track` at `z-index: 1`,
 *     so a glow can never tint the surface the label is measured against.
 *
 * Accessibility: the pill is a plain button, not a `switch` — "Light mode,
 * switch, off" is a worse announcement than a button that says what it does.
 * The accessible name opens with the visible label, so WCAG 2.5.3 (Label in
 * Name) holds for voice control, then states the action.
 */
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface ThemeModePillProps {
  /** The RESOLVED appearance — `system` must be resolved by the caller. */
  dark: boolean;
  /** Called with the mode the operator is asking for. */
  onToggle: (next: 'light' | 'dark') => void;
  className?: string;
}

/**
 * A filled crescent: an inner arc bites into an outer arc of the same radius.
 * The reference glyph is solid, not stroked, so lucide's outline Moon is wrong
 * here — and its Sun is rayed where the reference is a plain disc.
 */
function MoonGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function SunGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="currentColor" />
    </svg>
  );
}

export function ThemeModePill({ dark, onToggle, className }: ThemeModePillProps) {
  const label = dark ? 'Dark mode' : 'Light mode';
  const action = dark ? 'switch to light mode' : 'switch to dark mode';

  return (
    <button
      type="button"
      data-login-theme-pill
      data-appearance={dark ? 'dark' : 'light'}
      // Opens with the visible label so voice control can target it (WCAG 2.5.3),
      // then names the action, because the label alone reads as a statement.
      aria-label={`${label} — ${action}`}
      title={`${label} — ${action}`}
      onClick={() => onToggle(dark ? 'light' : 'dark')}
      className={cn('login-theme-pill', focusRing, className)}
    >
      <span className="login-theme-pill__flair" aria-hidden="true">
        <span className="login-theme-pill__orb login-theme-pill__orb--light" />
        <span className="login-theme-pill__orb login-theme-pill__orb--dark" />
      </span>
      <span className="login-theme-pill__track" aria-hidden="true" />
      <span className="login-theme-pill__icon login-theme-pill__icon--moon" aria-hidden="true">
        <MoonGlyph />
      </span>
      <span className="login-theme-pill__label">{label}</span>
      <span className="login-theme-pill__icon login-theme-pill__icon--sun" aria-hidden="true">
        <SunGlyph />
      </span>
    </button>
  );
}
