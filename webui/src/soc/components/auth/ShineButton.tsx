/**
 * ShineButton — the identity canvas's primary call to action.
 *
 * A gradient-faced button that carries three layered effects, all of them plain
 * CSS in `theme.css` under the `.login-auth-canvas` scope:
 *
 *   1. a blurred cyan-to-orchid halo that sits rotated and invisible at rest and
 *      un-rotates into place on hover/focus (`.login-shine-button::before`);
 *   2. a soft gradient blob that sweeps across the face once per hover/focus and
 *      then fades (`.login-shine-button__sweep` + the `login-shine-sweep`
 *      keyframe, gated behind `prefers-reduced-motion: no-preference`);
 *   3. a gradient-clipped label that flattens to solid white while hovered.
 *
 * The construction is ours and depends on no animation library — the console
 * ships `motion` lazily, and the login deliberately stays off that path so the
 * first authenticated paint pulls nothing extra.
 *
 * Structure matters for three separate reasons, so do not flatten it:
 *
 *   - CONTRAST. The face is an opaque child at `z-index: 1`, which isolates the
 *     overlay-blended sheen to the face and keeps the halo from washing over the
 *     surface the label is measured against. The ramp is deepened from the
 *     reference until every stop clears 4.5:1 against both label stops in every
 *     state, including mid-sweep; `scripts/gate-login-accents.mjs` is the
 *     authority and re-measures it on every build.
 *   - FOCUS. The keyboard ring is drawn on the FACE, not on this button. An
 *     element's outer box-shadow paints before its descendants, so a ring here
 *     would sit underneath the halo — on precisely the state that shows the ring.
 *   - ACCESSIBLE NAME. `children` is the label and the only text in the button,
 *     so `getByRole('button', { name: 'Sign in' })` keeps working. The sweep is
 *     `aria-hidden` and the halo is a pseudo-element, so neither contributes a
 *     stray accessible name.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface ShineButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Rendered inside the face, before the label — in practice the busy spinner.
   * Icons are deliberately NOT gradient-clipped, so they keep a real colour.
   */
  icon?: React.ReactNode;
  /**
   * True while the action is in flight. The CTA is `disabled` both while nothing
   * is typed AND while submitting, but those states must not LOOK the same —
   * flattening the button the instant it is clicked reads as the form going
   * dead. This keeps the identity and lets the spinner carry the state.
   */
  busy?: boolean;
  /** The button's visible label, and its accessible name. */
  children: React.ReactNode;
}

export const ShineButton = React.forwardRef<HTMLButtonElement, ShineButtonProps>(
  function ShineButton({ className, icon, busy, children, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        data-busy={busy ? 'true' : undefined}
        className={cn('login-shine-button', focusRing, className)}
        {...rest}
      >
        <span className="login-shine-button__face h-full w-full">
          <span className="login-shine-button__sweep" aria-hidden="true" />
          {icon}
          <span className="login-shine-button__label">{children}</span>
        </span>
      </button>
    );
  },
);
