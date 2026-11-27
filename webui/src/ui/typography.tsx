/**
 * typography — the shared text primitives (DESIGN_STANDARD §2.4). Encodes the
 * heading hierarchy + weight discipline in ONE place so authors stop hand-rolling
 * `text-2xl font-bold`-style one-offs that drift off the scale.
 *
 * Weight cap (§2.4): body 400 · emphasis/labels 500 · headings/KPI values 600 ·
 * display 650 max. Never 700+ for UI text (smears at 12-14px). The named font
 * scale (tailwind.config `fontSize`) already bakes the correct line-height +
 * letter-spacing (+ weight for the display rungs) into each step, so these
 * components mostly select the right step + color.
 *
 * All components are token-only and forward `className` (merged last via `cn`) +
 * `...rest`, so a consumer can still nudge color/alignment without escaping the
 * scale. Untrusted values pass through as plain text children (#9) — these
 * components never `dangerouslySetInnerHTML`.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

/* ── Heading ───────────────────────────────────────────────────────────────
 * `level` maps to the semantic tag (h1..h4) AND the matching type-scale step.
 * Keep to <=4 visible heading levels per screen (§2.4); use `--muted-foreground`
 * (via <Text variant="muted">) for hierarchy where a level would be excessive.
 */
export type HeadingLevel = 1 | 2 | 3 | 4;

const HEADING_STYLES: Record<HeadingLevel, string> = {
  // font-weight rides in the scale step tuple for 3xl; the rest pin it explicitly.
  1: 'text-3xl text-foreground', // 24/30 — page H1 (weight 650 from scale)
  2: 'text-2xl text-foreground', // 20/26 — section/page heading (weight 600 from scale)
  3: 'text-xl text-foreground', // 18/24 — card title (weight 600 from scale)
  4: 'text-lg font-semibold text-foreground', // 16/24 — sub-card heading (§2.4)
};

const HEADING_TAG: Record<HeadingLevel, 'h1' | 'h2' | 'h3' | 'h4'> = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
};

export interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** Visual + semantic level (1=H1 … 4=H4). Default 2 (page heading). */
  level?: HeadingLevel;
  /** Render as a different tag while keeping the visual level (e.g. an H2-styled H1). */
  as?: 'h1' | 'h2' | 'h3' | 'h4';
}

export const Heading = React.forwardRef<HTMLHeadingElement, HeadingProps>(
  ({ level = 2, as, className, ...rest }, ref) => {
    const Tag = (as ?? HEADING_TAG[level]) as 'h1';
    return <Tag ref={ref} className={cn('font-display', HEADING_STYLES[level], className)} {...rest} />;
  },
);
Heading.displayName = 'Heading';

/* ── Text ──────────────────────────────────────────────────────────────────
 * Body copy + variants. `prose` is the WCAG 1.4.12 reading treatment (≥1.5
 * line-height) for narratives (chat / rationale / runbook bodies) — never the
 * tight table default. `muted` de-emphasizes; `emphasis` is the max UI weight
 * for inline stress (500).
 */
export type TextVariant = 'body' | 'muted' | 'emphasis' | 'prose' | 'small' | 'code';

const TEXT_STYLES: Record<TextVariant, string> = {
  body: 'text-sm text-foreground', // 14/20 — default UI body
  muted: 'text-sm text-muted-foreground', // secondary / hint
  emphasis: 'text-sm font-medium text-foreground', // inline stress (weight cap 500)
  prose: 'text-md leading-relaxed text-foreground', // 15/22, ≥1.5 lh — narratives (§2.6)
  small: 'text-xs text-muted-foreground', // 12/16 — meta / captions
  code: 'font-mono text-xs text-foreground', // inline IDs / IOCs / tokens
};

export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  /** Text treatment. Default `body`. */
  variant?: TextVariant;
  /** Element to render. Default `p` (`span` for inline). */
  as?: 'p' | 'span' | 'div';
}

export const Text = React.forwardRef<HTMLElement, TextProps>(
  ({ variant = 'body', as = 'p', className, ...rest }, ref) => {
    const Tag = as as 'p';
    return <Tag ref={ref as React.Ref<HTMLParagraphElement>} className={cn(TEXT_STYLES[variant], className)} {...rest} />;
  },
);
Text.displayName = 'Text';

/* ── Eyebrow ───────────────────────────────────────────────────────────────
 * The 12px UPPERCASE overline (§2.4): section kicker above a heading. Muted +
 * wide tracking + 600. Decorative-only by default (use a real Heading for the
 * accessible label); pass an id/role if it must be referenced.
 */
export interface EyebrowProps extends React.HTMLAttributes<HTMLParagraphElement> {}

export const Eyebrow = React.forwardRef<HTMLParagraphElement, EyebrowProps>(({ className, ...rest }, ref) => (
  <p
    ref={ref}
    className={cn('text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground', className)}
    {...rest}
  />
));
Eyebrow.displayName = 'Eyebrow';

/* ── Label ─────────────────────────────────────────────────────────────────
 * A plain form/field label (weight 500). NOT the Radix `<Label>` in ui/label —
 * that one is for control association (htmlFor). Use this for standalone
 * field-group captions / non-control labels; use `Field` (which wires the Radix
 * Label) for actual form controls.
 */
export interface LabelTextProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  as?: 'label' | 'span';
}

export const Label = React.forwardRef<HTMLLabelElement, LabelTextProps>(
  ({ as = 'label', className, ...rest }, ref) => {
    const Tag = as as 'label';
    return <Tag ref={ref} className={cn('text-sm font-medium leading-none text-foreground', className)} {...rest} />;
  },
);
Label.displayName = 'LabelText';

/* ── Metric ────────────────────────────────────────────────────────────────
 * A big numeric value (KPI headline, cost figure, p50/p90). ALWAYS
 * `tabular-nums` (§2.5) so streaming/changing digits don't jitter width. Weight
 * 600 (heading-class), never 700. Wrap a raw value; put the unit/period in a
 * sibling `<Text variant="small">`.
 */
export type MetricSize = 'sm' | 'md' | 'lg';

const METRIC_STYLES: Record<MetricSize, string> = {
  sm: 'text-lg', // 16/24
  md: 'text-2xl', // 20/26
  lg: 'text-3xl', // 24/30
};

export interface MetricProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Value size. Default `md`. */
  size?: MetricSize;
}

export const Metric = React.forwardRef<HTMLSpanElement, MetricProps>(({ size = 'md', className, ...rest }, ref) => (
  <span ref={ref} className={cn('font-semibold tabular-nums text-foreground', METRIC_STYLES[size], className)} {...rest} />
));
Metric.displayName = 'Metric';
