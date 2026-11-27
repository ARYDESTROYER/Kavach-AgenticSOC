/**
 * variants.ts — the ONE source of truth for the motion.dev animation layer's timing,
 * built FROM the existing `soc/motion.ts` `MOTION` tokens so the JS-driven (motion.dev)
 * system and the CSS-keyframe system read the SAME numbers. `MOTION` durations are in
 * milliseconds (mirroring the `--motion-*` CSS tokens); motion.dev transitions want
 * SECONDS, so everything here is converted once via `s()`.
 *
 * Distances stay tiny (4–16px) and we only ever animate `transform` + `opacity`
 * (GPU-composited, 60fps) — per the SOC motion house-style (restraint reads as premium).
 * `MotionConfig reducedMotion="user"` (see provider.tsx) auto-neutralises the transform
 * side of these under OS "Reduce Motion", keeping only the opacity cross-fade.
 *
 * ONE SPRING VOCABULARY (Round 12, ui-standard "Motion"). Apple's two spring knobs map
 * straight onto motion.dev's: damping 1.0 ⇔ `bounce: 0` (critically damped — settles
 * with no overshoot) and response ⇔ `visualDuration` (the time to visually reach the
 * target). Three springs, and nothing else springs:
 *   - SPRING_UI       — the default: tabs, disclosure, row reflow, the bulk bar, a verdict
 *                       landing. Critically damped, 0.3s.
 *   - SPRING_PANE     — large surfaces: sheets, side panes, the report panel. 0.35s.
 *   - SPRING_MOMENTUM — the ONLY one that bounces, and only after a pointer release that
 *                       carried velocity (a flick or a thrown drag). A click carries no
 *                       momentum, so nothing click-driven may use it.
 * Exits stay short tweens: a leaving surface should get out of the way, not settle.
 * The CSS overlays (Radix menus, popovers, dialogs, sheets) use the same curve via the
 * `ease-spring` / `duration-ui` / `duration-pane` tokens in theme.css.
 */
import type { Transition, Variants } from 'motion/react';
import { MOTION } from '@/soc/motion';

/** ms → s (motion.dev transitions are in seconds; MOTION tokens are in ms). */
const s = (ms: number): number => ms / 1000;

/** cubic-bezier arrays mirroring the CSS `--motion-ease-*` tokens (see soc/motion.ts). */
export const EASE_STANDARD: [number, number, number, number] = [0.2, 0, 0, 1];
export const EASE_PREMIUM: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** The default UI spring: critically damped (no overshoot), 0.3s to visually land. */
export const SPRING_UI: Transition = { type: 'spring', bounce: 0, visualDuration: 0.3 };

/** Large surfaces (sheets, side panes, the report panel): critically damped, 0.35s. */
export const SPRING_PANE: Transition = { type: 'spring', bounce: 0, visualDuration: 0.35 };

/**
 * The only spring with bounce — ONLY after a pointer release that carried velocity.
 * Pass the release velocity too (`{ ...SPRING_MOMENTUM, velocity }`) so the animation
 * continues at the finger's speed instead of starting from rest.
 */
export const SPRING_MOMENTUM: Transition = { type: 'spring', bounce: 0.2, visualDuration: 0.35 };

/**
 * The app-wide default applied by `<MotionConfig>`: anything that animates without
 * naming a transition gets the critically damped UI spring (it was a 200ms tween).
 */
export const HOUSE_TRANSITION: Transition = SPRING_UI;

/**
 * @deprecated Use `SPRING_UI`. The old house spring (stiffness 320, damping 30, mass 1:
 * ζ = 30 / (2·√320) ≈ 0.84) overshot slightly on click-driven motion such as the Cases
 * bulk bar. Kept as an alias so existing imports land on the critically damped spring.
 */
export const HOUSE_SPRING: Transition = SPRING_UI;

/** A short tween for EXITS (and only exits): a leaving surface gets out of the way. */
const EXIT_TWEEN: Transition = { duration: s(MOTION.fast), ease: EASE_STANDARD };

/**
 * Route/page transition: content rises 8px + fades in; lifts 8px + fades on exit.
 * Paired with `<AnimatePresence mode="wait">` so the outgoing page finishes before the
 * incoming one enters (the classic route-swap sequence CSS `animate-fade-in` can't do —
 * it is enter-only, no exit).
 */
export const pageVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: SPRING_UI },
  exit: { opacity: 0, y: -8, transition: EXIT_TWEEN },
};

/** CaseDetail tab body: a smaller (6px), faster fade+rise on each tab switch. */
export const tabVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: SPRING_UI },
  exit: { opacity: 0, y: -6, transition: EXIT_TWEEN },
};

/**
 * Cases bulk-action bar: rises from below on select (critically damped — a checkbox
 * click carries no momentum, so it must not overshoot); slides back down + fades on
 * exit along the same path it came in by.
 */
export const bulkBarVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: SPRING_UI },
  exit: { opacity: 0, y: 16, transition: { duration: s(MOTION.base), ease: EASE_STANDARD } },
};

/**
 * The DecisionCard "verdict lands" one-shot: a restrained scale-settle that reinforces
 * the #3 trust story — the deterministic decision is COMPUTED, not guessed. One-shot on
 * mount only (never a loop); reduced motion drops the scale, keeps the fade.
 */
export const verdictLandVariants: Variants = {
  hidden: { opacity: 0, scale: 0.94 },
  show: { opacity: 1, scale: 1, transition: SPRING_UI },
};
