/**
 * Design gate — the login identity accents stay WCAG-AA.
 *
 * The shine CTA and the appearance pill are the only two console surfaces that
 * paint text on a raw gradient instead of a semantic token pair, so the normal
 * token-based contrast gate cannot see them. Their palettes were derived by
 * measurement rather than by eye, and this gate is what keeps that true: it
 * re-derives the worst case straight from `theme.css` on every run, so nobody
 * can lighten a stop back toward the reference values without the build saying so.
 *
 * What it measures, and why each layer is in the model:
 *
 *   SHINE CTA. The label sits above three stacked paints — the face gradient,
 *   the sweep blob, and the overlay-blended tint. All three are inside the
 *   face's own stacking context, so the composite under the glyphs is
 *   `tint over (sweep over face)`. The gate walks every face stop, applies the
 *   sweep at the peak opacity taken from the keyframe, then the tint at the
 *   opacity declared for each theme, and measures the result against BOTH label
 *   stops (resting gradient and the flattened hover white). The halo is excluded
 *   deliberately: it renders outside the opaque face and never reaches the label.
 *
 *   APPEARANCE PILL. The moon and sun occupy fixed grid cells, so the label can
 *   only ever sit over the middle of the track. The gate resolves the gradient
 *   position of that cell from the declared geometry — angle, pill width, cell
 *   width, inline padding — samples across it, and measures every sample against
 *   the ink colour for that state. The flair orbs are excluded deliberately: they
 *   paint behind an opaque track.
 *
 * Dependency-free node ESM, same as its sibling gates, so it runs under both
 * `npm run gates` and Vitest. It reads source text only — never app code.
 */
import fs from 'node:fs';
import { THEME_CSS_PATH, hexToRgb, contrastRatio } from './lib/theme-css.mjs';

/** WCAG AA for normal-size text. */
export const TEXT_BAR = 4.5;

/**
 * Geometry of the pill, mirrored from the `.login-theme-pill` declarations.
 *
 * `labelSlideRem` is load-bearing, not decorative: the label translates by that
 * much toward whichever glyph is showing, so a glyph-free cell boundary is NOT
 * the edge of the measured zone — the slid label overhangs it. Measuring only the
 * cell would report the light state ~0.5 points higher than it really is.
 */
const PILL = {
  angleDeg: 95,
  widthRem: 13.375,
  heightRem: 2.875,
  sideCellRem: 2.75,
  paddingInlineRem: 0.4375,
  /** `.login-theme-pill__label` transform, applied in BOTH directions. */
  labelSlideRem: 0.375,
  /** Safety margin on top of the slid cell, as a fraction of the pill width. */
  marginFraction: 0.01,
};

function readCss() {
  return fs.readFileSync(THEME_CSS_PATH, 'utf8');
}

/**
 * Bodies of EVERY top-level rule whose selector matches, concatenated in source
 * order. A selector may legitimately be declared more than once — the identity
 * palette and these accents both open `.login-auth-canvas` — and a gate that
 * only read the first block would silently measure the wrong rule.
 */
function ruleBodies(css, selector) {
  const re = new RegExp(
    `(^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`,
    'gm',
  );
  const bodies = [];
  let m;
  while ((m = re.exec(css)) !== null) {
    const open = css.indexOf('{', m.index);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(css.slice(open + 1, i));
          re.lastIndex = i;
          break;
        }
      }
    }
  }
  return bodies;
}

/** All matching rule bodies as one string. */
function ruleBody(css, selector) {
  return ruleBodies(css, selector).join('\n');
}

/** The raw value of a custom property declared in `body`. */
function customProperty(body, name) {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`, 'm');
  const m = re.exec(body);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

/**
 * Colour stops of a gradient, as `{ rgb, pos }` where `pos` is the declared
 * percentage as a 0..1 fraction (null when the stop declared no position).
 */
export function gradientStops(value) {
  const stops = [];
  const re = /(#[0-9a-fA-F]{6}|rgb\([^)]*\))\s*(-?[\d.]+)?%?/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    // Skip the geometry prelude of a radial gradient (`at 14% 86%` etc.) — it has
    // no colour, so the regex above never matches it, but a bare percentage after
    // a colour is a real stop position.
    const rgb = m[1].startsWith('#') ? hexToRgb(m[1]) : rgbFunc(m[1]);
    if (!rgb) continue;
    stops.push({ rgb, pos: m[2] === undefined ? null : Number(m[2]) / 100, raw: m[1] });
  }
  return stops;
}

/** `rgb(r g b / a%)` → [r,g,b] in 0..1, matching `hexToRgb`'s scale. */
function rgbFunc(text) {
  const nums = text.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return null;
  return [Number(nums[0]) / 255, Number(nums[1]) / 255, Number(nums[2]) / 255];
}

/** Alpha of an `rgb(r g b / a%)` value, defaulting to 1. */
function rgbAlpha(text) {
  const m = /\/\s*([\d.]+)%/.exec(text);
  return m ? Number(m[1]) / 100 : 1;
}

/** Source-over composite of `top` at `alpha` onto `bottom`. */
export function over(bottom, top, alpha) {
  return bottom.map((b, i) => b * (1 - alpha) + top[i] * alpha);
}

/** CSS `mix-blend-mode: overlay`, per channel, on 0..1 sRGB values. */
export function overlayBlend(bottom, top) {
  return bottom.map((b, i) => (b < 0.5 ? 2 * b * top[i] : 1 - 2 * (1 - b) * (1 - top[i])));
}

/** Linear interpolation across positioned gradient stops. */
export function sampleGradient(stops, t) {
  const positioned = stops.map((s, i) => ({
    ...s,
    pos: s.pos === null ? i / Math.max(1, stops.length - 1) : s.pos,
  }));
  if (t <= positioned[0].pos) return positioned[0].rgb;
  const last = positioned[positioned.length - 1];
  if (t >= last.pos) return last.rgb;
  for (let i = 0; i < positioned.length - 1; i += 1) {
    const a = positioned[i];
    const b = positioned[i + 1];
    if (t >= a.pos && t <= b.pos) {
      const f = b.pos === a.pos ? 0 : (t - a.pos) / (b.pos - a.pos);
      return a.rgb.map((c, k) => c + (b.rgb[k] - c) * f);
    }
  }
  return last.rgb;
}

/**
 * Where a point at horizontal fraction `f` (vertically centred) falls along a
 * `linear-gradient(<angle>)` line. CSS measures the angle clockwise from "to
 * top", so the direction is (sin a, -cos a) and the line length is
 * |W·sin a| + |H·cos a|.
 */
export function gradientPositionAt(f, { angleDeg, widthRem, heightRem }) {
  const a = (angleDeg * Math.PI) / 180;
  const length = Math.abs(widthRem * Math.sin(a)) + Math.abs(heightRem * Math.cos(a));
  return 0.5 + ((f - 0.5) * widthRem * Math.sin(a)) / length;
}

export function checkLoginAccents() {
  const css = readCss();
  const canvas = ruleBody(css, '.login-auth-canvas');
  const results = [];

  // ---- Shine CTA -------------------------------------------------------- //
  const faceValue = customProperty(canvas, 'login-shine-face');
  const labelValue = customProperty(canvas, 'login-shine-label');
  const sweepValue = customProperty(canvas, 'login-shine-sweep');
  const tintValue = customProperty(canvas, 'login-shine-tint');

  if (!faceValue || !labelValue || !sweepValue || !tintValue) {
    return {
      ok: false,
      results: [
        {
          name: 'shine tokens present',
          pass: false,
          detail: 'a --login-shine-* custom property is missing from .login-auth-canvas',
        },
      ],
    };
  }

  const faceStops = gradientStops(faceValue);
  const labelStops = gradientStops(labelValue);
  const tintStops = gradientStops(tintValue);
  const sweepCore = gradientStops(sweepValue)[0];
  const sweepCoreAlpha = rgbAlpha(/rgb\([^)]*\)/.exec(sweepValue)?.[0] ?? '');

  // Peak sweep opacity, straight from the keyframe.
  const keyframes = ruleBody(css, '@keyframes login-shine-sweep');
  const sweepPeak = Math.max(
    ...[...keyframes.matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1])),
    0,
  );

  // Tint opacity per theme, straight from the declarations.
  const tintLight = Number(
    /opacity:\s*([\d.]+)/.exec(ruleBody(css, '.login-shine-button__face::after'))?.[1] ?? '0',
  );
  const tintDark = Number(
    /opacity:\s*([\d.]+)/.exec(ruleBody(css, '.dark .login-shine-button__face::after'))?.[1] ??
      '0',
  );

  // The hover label flattens to solid white, which every state must also clear.
  const labelColours = [...labelStops.map((s) => s.rgb), [1, 1, 1]];

  for (const [theme, tintAlpha] of [
    ['light', tintLight],
    ['dark', tintDark],
  ]) {
    for (const face of faceStops) {
      // Every paint layer that can sit between the face and the glyphs.
      const layerings = [
        { label: 'bare', rgb: face.rgb },
        { label: 'sweep', rgb: over(face.rgb, sweepCore.rgb, sweepPeak * sweepCoreAlpha) },
      ];
      const composites = [];
      for (const layer of layerings) {
        composites.push({ ...layer });
        for (const tint of tintStops) {
          composites.push({
            label: `${layer.label}+tint`,
            rgb: over(layer.rgb, overlayBlend(layer.rgb, tint.rgb), tintAlpha),
          });
        }
      }
      for (const composite of composites) {
        for (const ink of labelColours) {
          const ratio = contrastRatio(composite.rgb, ink);
          results.push({
            name: `shine face ${face.raw} [${theme}/${composite.label}] vs label`,
            theme,
            bar: TEXT_BAR,
            ratio: Number(ratio.toFixed(2)),
            pass: ratio >= TEXT_BAR,
          });
        }
      }
    }
  }

  // ---- Appearance pill -------------------------------------------------- //
  const contentRem = PILL.widthRem - 2 * PILL.paddingInlineRem;
  // Widen the cell by the label slide in both directions — the label moves left in
  // one state and right in the other, so the union of both is what must hold.
  const cellStartRem = PILL.paddingInlineRem + PILL.sideCellRem - PILL.labelSlideRem;
  const cellEndRem = PILL.paddingInlineRem + contentRem - PILL.sideCellRem + PILL.labelSlideRem;
  const from = gradientPositionAt(cellStartRem / PILL.widthRem, PILL) - PILL.marginFraction;
  const to = gradientPositionAt(cellEndRem / PILL.widthRem, PILL) + PILL.marginFraction;

  for (const [state, gradientToken, inkToken] of [
    ['light', 'login-pill-light', 'login-pill-ink-light'],
    ['dark', 'login-pill-dark', 'login-pill-ink-dark'],
  ]) {
    const gradient = customProperty(canvas, gradientToken);
    const inkRaw = customProperty(canvas, inkToken);
    if (!gradient || !inkRaw) {
      results.push({
        name: `pill ${state} tokens present`,
        pass: false,
        bar: TEXT_BAR,
        ratio: null,
      });
      continue;
    }
    const stops = gradientStops(gradient);
    const ink = hexToRgb(inkRaw);
    let worst = { ratio: Infinity, at: null };
    for (let i = 0; i <= 100; i += 1) {
      const t = from + ((to - from) * i) / 100;
      const ratio = contrastRatio(sampleGradient(stops, t), ink);
      if (ratio < worst.ratio) worst = { ratio, at: t };
    }
    results.push({
      name: `pill ${state} label zone (${(from * 100).toFixed(0)}%-${(to * 100).toFixed(
        0,
      )}%) vs ink ${inkRaw}`,
      theme: state,
      bar: TEXT_BAR,
      ratio: Number(worst.ratio.toFixed(2)),
      pass: worst.ratio >= TEXT_BAR,
    });
  }

  return { ok: results.every((r) => r.pass), results };
}
