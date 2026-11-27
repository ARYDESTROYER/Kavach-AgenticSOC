/**
 * ProvenanceTag — the ONE provenance primitive (Round-7 #9b).
 *
 * Answers "WHO produced this value?" for a case field, so the console can tell a SIEM
 * source-asserted number apart from an AI (LLM) judgement apart from a deterministic
 * code-derived score. This is a META axis, orthogonal to severity/status/verdict — it
 * never carries a semantic reading of its own, so its colors deliberately stay off the
 * severity red→orange→gold ramp and the verdict red/green.
 *
 * a11y (DESIGN_STANDARD §6.1): meaning is NEVER color-only. Each kind carries a
 * distinct ICON SHAPE + a text LABEL beside the color, so the reading survives
 * colorblindness / monochrome (WCAG 1.4.1). The label renders in high-contrast
 * `foreground` (AA in both themes); the tint + colored icon give the color channel.
 *
 * Two variants:
 *  - `default` — a small pill (icon + short label). Used inline beside a per-cell value
 *    (e.g. the Cases "Severity" cell whose provenance flips per row).
 *  - `icon` — icon-only, for constrained slots like a DataTable column HEADER (the
 *    provenance is constant for the whole column). The icon is exposed as an
 *    `role="img"` with the full description as its accessible name + hover `title`.
 *
 * All copy here is a fixed, controlled label — it never renders UNTRUSTED log/source
 * text (#9).
 */
import { Database, Bot, Binary, UserCheck, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Provenance } from '@/lib/types';

// Re-export the shared vocabulary so consumers can import the type alongside the tag.
export type { Provenance };

interface ProvenanceKindMeta {
  /** Beside-color redundancy shape (WCAG 1.4.1). */
  Icon: LucideIcon;
  /** Short visible label for the default pill variant. */
  label: string;
  /** Full description — the hover `title` + the icon-only accessible name. */
  description: string;
  /** Pill tint (border + wash) — token-only, proven AA in both themes. */
  wrap: string;
  /** Icon color — a colored graphic (non-text 3:1), token-only. */
  icon: string;
}

/**
 * The provenance kinds. Colors are token-only (no raw hex) and chosen to be
 * mutually distinct while staying clear of the severity/verdict hues: `source` = the
 * blue-grey `info` data color, `ai` = the brand `primary` blue, `code` = neutral grey.
 */
const PROVENANCE_META: Record<Provenance, ProvenanceKindMeta> = {
  source: {
    Icon: Database,
    label: 'SIEM',
    description: 'SIEM-asserted (from the source)',
    wrap: 'border-info/30 bg-info/10',
    icon: 'text-info-text',
  },
  ai: {
    Icon: Bot,
    label: 'AI',
    description: 'AI (LLM judgement)',
    wrap: 'border-primary/30 bg-primary/10',
    icon: 'text-primary',
  },
  code: {
    Icon: Binary,
    label: 'Code',
    description: 'Deterministic (code-derived)',
    wrap: 'border-border bg-muted/60',
    icon: 'text-muted-foreground',
  },
  // Round 12 (SPEC D15): a value a HUMAN recorded — the analyst's classification of
  // the case. Neutral strong outline + a person glyph, so it reads apart from the AI
  // blue and the SIEM grey-blue without borrowing a severity or verdict hue.
  analyst: {
    Icon: UserCheck,
    label: 'Analyst',
    description: 'Analyst (recorded by a person)',
    wrap: 'border-border-strong bg-secondary',
    icon: 'text-foreground',
  },
};

/**
 * Map a backend `severity_source` string to its provenance kind. The advisory pass
 * (`engine/priority.py`) tags a case's severity band as `"source_asserted"` when the
 * SIEM supplied a severity, else `"derived"` (fell back to the deterministic risk
 * total). Anything that is not an explicit source assertion reads as `code`.
 */
export function severityProvenance(source?: string): Provenance {
  return source === 'source_asserted' ? 'source' : 'code';
}

/**
 * The CONSTANT-per-column provenance for the advisory case fields, so list surfaces
 * declare a column-header provenance from ONE place (severity is intentionally absent:
 * its provenance flips per row → use {@link severityProvenance} per cell). Risk /
 * priority / impact / urgency are deterministic `code`; the LLM verdict + confidence
 * are `ai`.
 */
export const FIELD_PROVENANCE: Record<string, Provenance> = {
  risk_score: 'code',
  priority_level: 'code',
  impact_band: 'code',
  urgency_band: 'code',
  verdict: 'ai',
  confidence: 'ai',
};

export interface ProvenanceTagProps {
  /** Which provenance to show. */
  kind: Provenance;
  /** `default` = icon + label pill; `icon` = icon-only (for header cells). */
  variant?: 'default' | 'icon';
  /** Extra classes on the wrapper. */
  className?: string;
}

/**
 * A small provenance tag. Renders a fixed, controlled label — never UNTRUSTED text (#9).
 */
export function ProvenanceTag({
  kind,
  variant = 'default',
  className,
}: ProvenanceTagProps) {
  const meta = PROVENANCE_META[kind];
  const { Icon } = meta;

  if (variant === 'icon') {
    // Icon-only (header cells): the icon IS the message, so expose it as an image
    // with the full description as its accessible name (+ a hover title).
    return (
      <span
        role="img"
        aria-label={`Provenance: ${meta.description}`}
        title={meta.description}
        data-provenance={kind}
        className={cn('inline-flex items-center', meta.icon, className)}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
      </span>
    );
  }

  return (
    <span
      title={meta.description}
      data-provenance={kind}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5',
        'text-2xs font-medium leading-none text-foreground',
        meta.wrap,
        className,
      )}
    >
      <Icon className={cn('size-3 shrink-0', meta.icon)} aria-hidden />
      <span>{meta.label}</span>
    </span>
  );
}

export default ProvenanceTag;
