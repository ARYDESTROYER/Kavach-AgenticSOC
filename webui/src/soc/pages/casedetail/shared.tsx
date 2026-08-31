/**
 * CaseDetail — shared contracts, tone maps, action model, and small presentational
 * building blocks used by every panel (Coupling-D split).
 *
 * This module is behavior-preserving: it lifts the pieces that were previously
 * top-level in `CaseDetail.tsx` VERBATIM so the orchestrator + panels can import them
 * from one place. Nothing here fetches, decides, or mutates a case.
 *
 * SECURITY (#9): the small components below render case-derived text (labels, values,
 * tags) as PLAIN text nodes only — never markup, never an href/CSS value.
 * #3: the action model here is pure metadata; the close/escalate decision is still
 * made server-side by `decide()`. `close_disposition` maps to the EXISTING `close`
 * verb via `wireAction` — this module never invents a backend verb.
 */
import * as React from 'react';
import {
  ArrowDownCircle,
  Bell,
  Check,
  CheckCircle2,
  Eye,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Tag,
  X,
} from 'lucide-react';

import type { components } from '@/lib/api-types.gen';
import type { Case } from '@/lib/types';
import { DASH, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Input } from '@/ui/input';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import { isAutoClosedByAI } from '@/soc/components/badges';

/** The disposition vocabulary, straight off the generated OpenAPI schema. */
type WireDisposition = components['schemas']['Disposition'];

/* --------------------------------------------------------------- contracts -- */

/**
 * One content rail for every panel embedded in Case Manager. Keeping this in the
 * shared case-detail vocabulary prevents tabs from drifting back to independent
 * 32px gutters and gives the resizable workspace a stable alignment axis.
 */
export const CASE_MANAGER_PANEL_PADDING =
  'px-4 py-4 sm:px-5 sm:py-5 lg:px-6';

/**
 * THE analyst-comment disclosure — shown wherever a note the analyst writes on a
 * close/confirm-FP or an AI grading is carried into `index_resolved_case`.
 *
 * Why this label exists: a comment written here is embedded into the resolved-case
 * precedent chunk and is read back by the investigator on every future retrieval that
 * matches. In production an ordinary operational aside ("Backfill: confirming agent
 * FALSE_POSITIVE disposition…") became durable evidence and quietly depressed
 * investigator confidence just under the auto-close bar, so nothing closed. The text
 * was well-formed — its MEANING was the problem — so sanitising could never have caught
 * it. The only real fix is telling the analyst, where they type, what the note becomes.
 *
 * Deliberately a calm one-line LABEL, not a warning banner: notes are wanted, and the
 * point is informed authorship rather than discouragement.
 */
export const DURABLE_CONTEXT_NOTE =
  'Saved with the resolved case as durable context — the AI reads this note when it investigates similar cases later.';

/** One selectable notification channel in the Notify dialog. */
export interface NotifyChannelOption {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
}

export type ActionKind =
  | 'close'
  | 'confirm_fp'
  | 'escalate'
  | 'deescalate'
  | 'reopen'
  | 'acknowledge'
  | 'hold'
  | 'resume'
  | 'resolve'
  | 'set_disposition'
  // UI-only unified verb. Merges the old close / confirm-FP / set-disposition
  // controls into ONE "Close with disposition" flow. It maps to the EXISTING
  // backend `close` verb via `ActionDef.wireAction` (never a new verb) and always
  // carries a disposition, so `decide()`/`apply()` still run server-side (#3).
  | 'close_disposition';
export type ActionField =
  | 'resolution'
  | 'tags'
  | 'assignee'
  | 'priority'
  | 'disposition'
  | 'reason'
  // Round-7 #10 (feedback-into-close): when present, the confirm dialog renders the
  // in-line AI-decision grading section (`GradingSection`). It carries NO wire payload
  // — the grading is POSTed as a SEPARATE `caseFeedback` call in `runAction`, so the
  // deterministic close (`decide()`) is untouched (#3).
  | 'grading';

/** The RBAC grant an action needs: close-class moves need cases:close, the rest
 *  cases:write. The footer gates each button with <Can> using this. */
export const ACTION_PERMISSION: Record<ActionKind, { resource: 'cases'; action: 'close' | 'write' }> = {
  close: { resource: 'cases', action: 'close' },
  confirm_fp: { resource: 'cases', action: 'close' },
  close_disposition: { resource: 'cases', action: 'close' },
  resolve: { resource: 'cases', action: 'close' },
  reopen: { resource: 'cases', action: 'close' },
  escalate: { resource: 'cases', action: 'write' },
  deescalate: { resource: 'cases', action: 'write' },
  acknowledge: { resource: 'cases', action: 'write' },
  hold: { resource: 'cases', action: 'write' },
  resume: { resource: 'cases', action: 'write' },
  set_disposition: { resource: 'cases', action: 'write' },
};

/**
 * Disposition options for the disposition picker.
 *
 * This list is LOAD-BEARING for ground truth: the Console's primary close posts the
 * chosen disposition alongside `disposition_declared`, and the backend records a
 * DECLARED binary disposition as analyst-confirmed evidence (`engine/analyst_outcomes`).
 * A value the analyst never picked is not offered here and never declared. So it is
 * pinned to the GENERATED OpenAPI schema rather than "mirroring the backend enum" by
 * hand — `as const satisfies` rejects a value that is not in the union, and
 * {@link DispositionCoverage} fails `tsc --noEmit` if the union gains a member this
 * list does not offer. Type-only import: zero runtime bytes from the generated module.
 */
export const DISPOSITION_OPTIONS = [
  { value: 'true_positive', text: 'True positive' },
  { value: 'false_positive', text: 'False positive' },
  { value: 'benign', text: 'Benign' },
  { value: 'suspicious', text: 'Suspicious' },
  { value: 'duplicate', text: 'Duplicate' },
  { value: 'undetermined', text: 'Undetermined' },
] as const satisfies ReadonlyArray<{ value: WireDisposition; text: string }>;

/** Fails to typecheck unless `T` is `never`. */
type MustBeNever<T extends never> = T;

/** Compile-time drift guard for {@link DISPOSITION_OPTIONS}. */
export type DispositionCoverage = MustBeNever<
  Exclude<WireDisposition, (typeof DISPOSITION_OPTIONS)[number]['value']>
>;

export interface ActionDef {
  key: ActionKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Button variant for the footer + confirm dialog. */
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
  /** Whether this is the primary action of the current state (filled). */
  fill?: boolean;
  /** The EXISTING backend action verb to POST. Defaults to `key` when unset; the
   *  UI-only `close_disposition` maps here to `'close'` so we never invent a verb. */
  wireAction?: ActionKind;
  confirmTitle: string;
  confirmBody: string;
  help: string;
  fields: ActionField[];
}

export const ALL_ACTIONS: Record<ActionKind, ActionDef> = {
  close: {
    key: 'close',
    label: 'Close case',
    icon: Check,
    variant: 'default',
    confirmTitle: 'Close this case?',
    confirmBody: 'Mark this case as CLOSED — triaged and handled.',
    help: 'Mark this case as CLOSED — triaged / handled.',
    fields: ['resolution', 'tags'],
  },
  confirm_fp: {
    key: 'confirm_fp',
    label: 'Confirm false positive',
    icon: CheckCircle2,
    variant: 'secondary',
    confirmTitle: 'Confirm false positive?',
    confirmBody:
      'Close the case as a FALSE POSITIVE. The resolved case is fed into the RAG baseline memory so future triage learns from it.',
    help: 'Close as FALSE_POSITIVE; also feeds the resolved case into RAG baseline memory.',
    fields: ['resolution', 'tags', 'grading'],
  },
  // ONE unified close flow: pick the investigative disposition (true/false
  // positive, benign, …) + an optional note, then close. Posts the EXISTING
  // `close` verb with a `disposition` — the backend still runs decide()/apply()
  // (#3). Replaces the separate close / confirm-FP / set-disposition buttons.
  close_disposition: {
    key: 'close_disposition',
    wireAction: 'close',
    label: 'Close case',
    icon: Check,
    variant: 'default',
    confirmTitle: 'Close with a disposition',
    confirmBody:
      'Choose the investigative outcome, then close this case. The close/escalate decision is still made by deterministic code — this records your disposition and closes the case.',
    help: 'Pick a disposition and close the case.',
    fields: ['disposition', 'resolution', 'tags', 'grading'],
  },
  escalate: {
    key: 'escalate',
    label: 'Escalate',
    icon: Bell,
    variant: 'default',
    confirmTitle: 'Escalate this case?',
    // The backend `escalate` verb sets CaseStatus.ESCALATED (a distinct status from
    // NEEDS_HUMAN, which is only reached via the deterministic decide()/verdict path).
    // The paired `deescalate` action clears it.
    confirmBody:
      'Escalate this case. The status becomes ESCALATED and the case remains open for analyst action.',
    help: 'Escalate this case; the status becomes ESCALATED.',
    fields: ['assignee', 'priority'],
  },
  reopen: {
    key: 'reopen',
    label: 'Reopen',
    icon: RefreshCw,
    variant: 'default',
    confirmTitle: 'Reopen this case?',
    confirmBody: 'Reopen a closed case and return it to the open queue.',
    help: 'Reopen a closed case.',
    fields: [],
  },
  acknowledge: {
    key: 'acknowledge',
    label: 'Acknowledge & investigate',
    icon: Eye,
    variant: 'default',
    confirmTitle: 'Acknowledge and start investigating?',
    confirmBody:
      'Take ownership of this case and move it to INVESTIGATING. It stays open — nothing is closed.',
    help: 'Take the case and move it to INVESTIGATING.',
    fields: [],
  },
  hold: {
    key: 'hold',
    label: 'Put on hold',
    icon: PauseCircle,
    variant: 'outline',
    confirmTitle: 'Put this case on hold?',
    confirmBody: 'Pause the case (awaiting info / a maintenance window / a third party).',
    help: 'Pause — awaiting info / maintenance / third party.',
    fields: ['reason'],
  },
  resume: {
    key: 'resume',
    label: 'Resume',
    icon: PlayCircle,
    variant: 'outline',
    confirmTitle: 'Resume this case?',
    confirmBody: 'Return a held case to the open queue.',
    help: 'Return a held case to the open queue.',
    fields: [],
  },
  resolve: {
    key: 'resolve',
    label: 'Mark resolved',
    icon: CheckCircle2,
    variant: 'default',
    confirmTitle: 'Mark this case resolved?',
    confirmBody: 'Mark the case RESOLVED — worked to completion, pending final close / audit.',
    help: 'RESOLVED — worked to completion, pending final close.',
    fields: ['reason', 'tags', 'grading'],
  },
  deescalate: {
    key: 'deescalate',
    label: 'De-escalate',
    icon: ArrowDownCircle,
    variant: 'outline',
    confirmTitle: 'De-escalate this case?',
    confirmBody: 'Clear the escalation and return the case to the open queue.',
    help: 'Clear the escalation; return to the open queue.',
    fields: ['reason'],
  },
  set_disposition: {
    key: 'set_disposition',
    label: 'Set disposition',
    icon: Tag,
    variant: 'outline',
    confirmTitle: 'Set the investigative disposition',
    confirmBody:
      'Record the investigative OUTCOME (true/false positive, benign, suspicious, …). This does not change the lifecycle status.',
    help: 'Record the investigative outcome (true/false positive, benign, …).',
    fields: ['disposition', 'reason', 'grading'],
  },
};

export const RESOLUTION_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'handled', text: 'Handled' },
  { value: 'benign', text: 'Benign' },
  { value: 'duplicate', text: 'Duplicate' },
  { value: 'no_action', text: 'No action needed' },
  { value: 'other', text: 'Other' },
];

export const PRIORITY_OPTIONS: Array<{ value: string; text: string }> = [
  { value: 'low', text: 'Low' },
  { value: 'medium', text: 'Medium' },
  { value: 'high', text: 'High' },
  { value: 'critical', text: 'Critical' },
];

/**
 * The lifecycle action plan for a status: ONE clear primary CTA, ONE always-visible
 * "Close with disposition" (except where close is itself the primary), and the rest
 * folded into an overflow menu — instead of a row of equally-weighted buttons.
 *
 *   - `primary`  — the single filled CTA for the current state (context-dependent:
 *                  Acknowledge when new, Escalate/Resolve when working, Resume when
 *                  held, Reopen when terminal). Never null for a loaded case.
 *   - `close`    — the unified Close-with-disposition action, shown as a secondary
 *                  button, UNLESS it is already the primary (resolved cases).
 *   - `overflow` — the remaining contextual actions, in a "More" menu.
 *
 * Every entry is one of the existing `ALL_ACTIONS` records, so the confirm dialog +
 * `runAction` wire keys are unchanged. Terminal states expose no close (only reopen).
 */
export interface ActionPlan {
  primary: ActionDef;
  close: ActionDef | null;
  overflow: ActionDef[];
}

export function actionPlanForStatus(status?: string): ActionPlan {
  const s = (status || '').toLowerCase();
  const close = ALL_ACTIONS.close_disposition;

  // Terminal states: only reopen (and re-classify) is legal — no close.
  if (s === 'closed') {
    return {
      primary: { ...ALL_ACTIONS.reopen, fill: true },
      close: null,
      overflow: [ALL_ACTIONS.set_disposition],
    };
  }
  if (s === 'resolved') {
    // Close IS the primary here; don't duplicate it as a secondary button.
    return {
      primary: { ...close, fill: true },
      close: null,
      overflow: [ALL_ACTIONS.reopen],
    };
  }
  if (s === 'on_hold') {
    return {
      primary: { ...ALL_ACTIONS.resume, fill: true },
      close,
      overflow: [ALL_ACTIONS.resolve, ALL_ACTIONS.escalate],
    };
  }
  if (s === 'escalated') {
    return {
      primary: { ...ALL_ACTIONS.resolve, fill: true },
      close,
      overflow: [ALL_ACTIONS.deescalate, ALL_ACTIONS.hold],
    };
  }
  // New — Acknowledge is the natural first move (now sets INVESTIGATING).
  if (s === 'new' || s === '') {
    return {
      primary: { ...ALL_ACTIONS.acknowledge, fill: true },
      close,
      overflow: [ALL_ACTIONS.escalate, ALL_ACTIONS.resolve, ALL_ACTIONS.hold],
    };
  }
  // Working states (open / investigating / needs_human) — Escalate is the primary
  // path to a human; the rest fold into the overflow.
  return {
    primary: { ...ALL_ACTIONS.escalate, fill: true },
    close,
    overflow: [ALL_ACTIONS.acknowledge, ALL_ACTIONS.resolve, ALL_ACTIONS.hold],
  };
}

/**
 * Adapter: was this case auto-closed by the AI? A thin `Case`-shaped wrapper over the
 * shared {@link isAutoClosedByAI} predicate (terminal status + `decision_by === 'agent'`).
 * There is no `auto_closed` STATUS in the backend — this is a read-only presentation of
 * WHO the recorded decider was. Presentation-only (#3): the close was still made by the
 * deterministic `decide()` policy, never by this helper.
 */
export const isAutoClosed = (c: Case): boolean =>
  isAutoClosedByAI(c.status, c.decision_by);

/* ------------------------------------------------------------------ helpers -- */

/** Best-effort epoch for sorting mixed history entries (ts is ISO). */
export function tsValue(ts?: string): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

export type FpPolicy = {
  enabled?: boolean;
  min_confidence?: number;
  max_risk_score?: number;
} | null;

/**
 * Additive visual treatment used by the split Case Manager workspace. The default
 * keeps the legacy Cases sheet byte-for-byte familiar; `case-manager` only changes
 * layout/chrome and never the panel's data or mutation contracts.
 */
export type CasePanelPresentation = 'default' | 'case-manager';

/** Derive the ConfidenceBadge threshold/note from the FP auto-close policy. */
export function confidenceCalibration(
  policy: FpPolicy,
  verdict?: string,
): { threshold?: number; note?: string } {
  if (!policy || typeof policy.min_confidence !== 'number') return {};
  const v = (verdict || '').toLowerCase();
  const isFp = v.includes('false') || v === 'fp' || v.includes('benign');
  const note = policy.enabled
    ? isFp
      ? 'FP auto-close enabled at this bar'
      : 'bar governs FP only'
    : 'auto-close off';
  return { threshold: policy.min_confidence, note };
}

/** Map a severity-ish value to a token text-color class for the headline panels. */
export type ScoreTone = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const TONE_TEXT: Record<ScoreTone, string> = {
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
  info: 'text-info',
};
export const TONE_BORDER: Record<ScoreTone, string> = {
  critical: 'border-critical/30 bg-critical/5',
  high: 'border-high/30 bg-high/5',
  medium: 'border-medium/30 bg-medium/5',
  low: 'border-low/30 bg-low/5',
  info: 'border-info/30 bg-info/5',
};

/** A quiet top-accent bar tone for the calmer headline panels. */
export const TONE_ACCENT: Record<ScoreTone, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
};

/** Headline label for a verdict (Suspicious / Malicious / Benign / …). */
export function verdictHeadline(verdict?: string): { label: string; tone: ScoreTone } {
  const t = (verdict || '').trim().toLowerCase();
  if (!t || t === 'none') return { label: 'Unverdicted', tone: 'info' };
  if (t === 'true_positive') return { label: 'Malicious', tone: 'critical' };
  if (t === 'false_positive' || t === 'benign') return { label: 'Benign', tone: 'low' };
  if (t === 'needs_human') return { label: 'Needs human', tone: 'high' };
  if (t === 'suspicious') return { label: 'Suspicious', tone: 'high' };
  return { label: humanizeToken(verdict), tone: 'medium' };
}

/** Confidence headline (Low / Medium / High) from a 0..1 (or 0..100) score. */
export function confidenceHeadline(conf?: number): { label: string; tone: ScoreTone } {
  if (typeof conf !== 'number' || Number.isNaN(conf)) {
    return { label: DASH, tone: 'info' };
  }
  const pct = conf <= 1 ? conf * 100 : conf;
  if (pct >= 75) return { label: 'High', tone: 'low' };
  if (pct >= 50) return { label: 'Medium', tone: 'medium' };
  return { label: 'Low', tone: 'high' };
}

/* ----------------------------------------------------------- headline panel -- */

export const HeadlinePanel: React.FC<{
  label: string;
  value: string;
  tone: ScoreTone;
}> = ({ label, value, tone }) => (
  <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-lg border border-border bg-card px-4 py-3 text-center">
    <span
      aria-hidden="true"
      className={cn('absolute inset-x-0 top-0 h-0.5', TONE_ACCENT[tone])}
    />
    <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </span>
    <span
      className={cn(
        'mt-1.5 text-base font-semibold tracking-tight tabular-nums',
        TONE_TEXT[tone],
      )}
    >
      {value}
    </span>
  </div>
);

/* ------------------------------------------------------------- meta item --- */

/** One quiet label/value pair for the run-meta strip. `value` is UNTRUSTED. */
export const MetaItem: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </span>
    <span className="font-mono text-xs text-foreground">{value}</span>
  </div>
);

/* --------------------------------------------------------- section heading -- */

export const SectionHeading: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ icon: Icon, children, actions }) => (
  <div className="mb-4 flex items-center justify-between gap-3">
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h3 className="text-sm font-semibold tracking-tight text-foreground">
        {children}
      </h3>
    </div>
    {actions}
  </div>
);

/* --------------------------------------------------------------- PanelCard -- */

/**
 * The ONE surface a CaseDetail panel section renders in — a top-level page Card at
 * the sanctioned 24px (`padding="md"`) rhythm. Replaces the hand-rolled
 * `rounded-lg border border-border bg-card p-6` divs that were repeated ~30× across
 * the panels (DESIGN_STANDARD §3.2 / §5.2 — adopt the Card primitive).
 */
export const PanelCard: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <Card elevation="none" className={cn('p-6', className)} {...props} />;

/* --------------------------------------------------------------- TagInput == */

/** A dependency-free chips input (enter/comma adds, ✕ removes). UNTRUSTED text. */
export const TagInput: React.FC<{
  tags: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onTagsChange: (tags: string[]) => void;
}> = ({ tags, draft, onDraftChange, onTagsChange }) => {
  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (!tags.includes(v)) onTagsChange([...tags, v]);
    onDraftChange('');
  };
  return (
    <div
      className={cn(
        // The inner Input has no border/ring of its own, so the WRAPPER carries the
        // visible focus indicator (#3 — WCAG 2.4.7) via focus-within. The ring shows
        // whenever the input (or a tag-remove button) holds focus.
        'rounded-md border border-border bg-background p-1.5',
        'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background',
      )}
    >
      {tags.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1 pr-0.5">
              {/* UNTRUSTED tag — plain text node. */}
              <span className="max-w-[10rem] truncate">{t}</span>
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                // min 24x24 hit area (#4 — WCAG 2.5.8); the glyph stays 12px but the
                // padded box is ≥24px so it's an easy keyboard/pointer target.
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onTagsChange(tags.filter((x) => x !== t))}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      <Input
        className="h-7 border-0 px-1 shadow-none focus-visible:ring-0"
        placeholder="Add a tag…"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && tags.length) {
            onTagsChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
      />
    </div>
  );
};
