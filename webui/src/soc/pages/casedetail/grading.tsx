/**
 * CaseDetail — AI-decision grading module (Round-7 #10, DERIVED model).
 *
 * Round-7 folds AI-decision feedback INTO the close flow (W1.E wires this into
 * `ConfirmActionDialog`); the standalone Feedback tab is retired. This module is the
 * pure + presentational library only — it does NOT wire into the dialog itself.
 *
 * DERIVED agree/override model (§A.10): instead of the analyst manually picking an
 * "agree / partial / disagree" assessment, we DERIVE it from the diff between the AI
 * verdict and the disposition the analyst is committing on close, using the fixed map:
 *   TRUE_POSITIVE  ↔ true_positive
 *   FALSE_POSITIVE ↔ { false_positive, benign }
 *   NEEDS_HUMAN    ↔ { suspicious, undetermined }
 *   duplicate      → no comparison (administrative outcome, not an agree/override signal)
 * A match reads "Matches AI verdict"; a mismatch reads "Overrides AI verdict (X → Y)"
 * and only THEN reveals an optional "What did the AI miss?" line. The 3 detailed quality
 * stars stay behind a "Rate in detail →" disclosure.
 *
 * GROUND TRUTH (G1): the derived agree/override signal above is NOT a label — an
 * analyst disagreeing with the model says nothing about what actually happened. The
 * only field here that becomes analyst-confirmed ground truth is `actual_outcome`, and
 * until G1 this module typed it, read it and forwarded it while offering no control
 * that could ever SET it, so `analyst_confirmed_outcome` could never fire through the
 * feedback channel. {@link OutcomeField} is that control; its options come from the
 * GENERATED OpenAPI schema so they cannot drift from the backend enum.
 *
 * SECURITY (#9): analyst-authored comments render as PLAIN TEXT, never markup.
 * #3: producing a `CaseFeedbackInput` never changes verdict/status/disposition — the
 * caller (W1.E) POSTs the grading as a SEPARATE call after the deterministic close.
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Star } from 'lucide-react';

import type { components } from '@/lib/api-types.gen';
import type { CaseFeedbackInput } from '@/lib/api';
import type { CaseFeedback, Disposition } from '@/lib/types';
import { DASH, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { Separator } from '@/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { DURABLE_CONTEXT_NOTE, tsValue } from './shared';

/* --------------------------------------------------- ground-truth vocabulary --- */

/**
 * The analyst-outcome vocabulary, taken STRAIGHT off the generated OpenAPI schema
 * (`webui/openapi.json` -> `src/lib/api-types.gen.ts`, produced by `npm run gen:types`
 * and drift-gated by `npm run check:types`). A hand-written literal list would fall
 * silently behind `backend/app/constants.py::FeedbackOutcome`; this one cannot.
 *
 * Type-only import: erased at compile time, so the generated module still contributes
 * zero runtime bytes.
 */
export type FeedbackOutcome = components['schemas']['FeedbackOutcome'];

/**
 * The operator-facing outcome choices, in the order they are offered.
 *
 * `unknown` is a real member of the wire enum and is the backend's default; it is the
 * "not stated" choice here and is deliberately NEVER written into the draft (see
 * {@link OutcomeField}), so an untouched grading still posts no `actual_outcome` at all.
 *
 * `as const satisfies` does the work in both directions: `satisfies` rejects a value
 * that is not in the generated union, and `as const` keeps the literals so
 * {@link FeedbackOutcomeCoverage} below can prove nothing is MISSING.
 */
export const OUTCOME_OPTIONS = [
  { value: 'unknown', text: 'Not stated' },
  { value: 'true_positive', text: 'True positive — the alert was real' },
  { value: 'false_positive', text: 'False positive — the alert was wrong' },
  { value: 'true_negative', text: 'True negative — correctly quiet' },
  { value: 'false_negative', text: 'False negative — the detection missed it' },
] as const satisfies ReadonlyArray<{ value: FeedbackOutcome; text: string }>;

/** Fails to typecheck unless `T` is `never`. */
type MustBeNever<T extends never> = T;

/**
 * Compile-time drift guard. If `FeedbackOutcome` ever gains a member that
 * {@link OUTCOME_OPTIONS} does not offer, `Exclude` stops being `never` and this alias
 * fails `tsc --noEmit` — so the picker cannot silently fall behind the backend enum.
 * Exported so it is a used declaration rather than dead code.
 */
export type FeedbackOutcomeCoverage = MustBeNever<
  Exclude<FeedbackOutcome, (typeof OUTCOME_OPTIONS)[number]['value']>
>;

/** The enum member that means "no outcome stated" — never persisted into the draft. */
export const OUTCOME_UNSET: FeedbackOutcome = 'unknown';

/* ------------------------------------------------------------------ types --- */

/**
 * Draft grading state held by the close dialog (W1.E). All fields optional so an
 * un-touched close still produces a valid {@link CaseFeedbackInput}. Star fields carry
 * a RAW 1-5 count (0 = unset) — {@link gradingToFeedbackInput} maps them to 0..1.
 */
export interface GradingDraft {
  assessment?: CaseFeedbackInput['assessment'];
  /** 1-5 stars (0/undefined = unset). */
  accuracy?: number;
  reasoning_quality?: number;
  action_appropriateness?: number;
  /**
   * The CONFIRMED outcome — the only field in this draft that becomes analyst-confirmed
   * ground truth (`engine/analyst_outcomes`). Typed to the generated wire union, and
   * left `undefined` (never `'unknown'`) when the analyst states nothing.
   */
  actual_outcome?: FeedbackOutcome;
  time_saved_minutes?: number;
  comment?: string;
}

/** Result of deriving agreement from the AI verdict ↔ analyst disposition diff. */
export type GradingAgreement =
  | { kind: 'match'; assessment: 'agree' }
  | { kind: 'override'; assessment: 'disagree'; fromLabel: string; toLabel: string }
  | { kind: 'none' };

/* -------------------------------------------------------------- pure logic --- */

/** A fresh, empty draft (all fields unset). */
export function emptyGradingDraft(): GradingDraft {
  return {};
}

/** Map a 1-5 star count to the backend's 0..1 quality score (undefined when unset). */
export function starsToScore(n?: number): number | undefined {
  if (!n || n < 1) return undefined;
  return Math.max(0, Math.min(1, n / 5));
}

/**
 * True when the analyst has entered ANY signal beyond a plain "agree" default. Not
 * used to gate auto-submit (the derived model always submits alongside a
 * close-with-verdict) — a convenience predicate for optional UI affordances.
 */
export function isGradingDirty(g: GradingDraft): boolean {
  return Boolean(
    (g.accuracy && g.accuracy > 0) ||
      (g.reasoning_quality && g.reasoning_quality > 0) ||
      (g.action_appropriateness && g.action_appropriateness > 0) ||
      g.actual_outcome ||
      (typeof g.time_saved_minutes === 'number' && g.time_saved_minutes > 0) ||
      (g.comment && g.comment.trim()) ||
      (g.assessment && g.assessment !== 'agree'),
  );
}

/**
 * Which dispositions COUNT AS AGREEING with each AI verdict (§A.10). Keys are the
 * canonical uppercase `Verdict` enum values; values are the lowercase disposition set.
 */
const VERDICT_MATCH_DISPOSITIONS: Record<string, readonly string[]> = {
  TRUE_POSITIVE: ['true_positive'],
  FALSE_POSITIVE: ['false_positive', 'benign'],
  NEEDS_HUMAN: ['suspicious', 'undetermined'],
};

function normVerdict(v?: string | null): string {
  return String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function normDisposition(d?: string | null): string {
  return String(d ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * Derive whether the analyst's disposition AGREES with the AI verdict. Returns `none`
 * (no comparable signal) when the verdict is missing/unknown, the disposition is
 * missing, or the disposition is the administrative `duplicate` outcome.
 */
export function deriveAgreement(
  verdict?: string | null,
  disposition?: Disposition | string | null,
): GradingAgreement {
  const v = normVerdict(verdict);
  const d = normDisposition(disposition);
  if (!v || !d) return { kind: 'none' };
  // `duplicate` is an administrative close, not an agree/override signal.
  if (d === 'duplicate') return { kind: 'none' };
  const allowed = VERDICT_MATCH_DISPOSITIONS[v];
  if (!allowed) return { kind: 'none' };
  if (allowed.includes(d)) return { kind: 'match', assessment: 'agree' };
  return {
    kind: 'override',
    assessment: 'disagree',
    fromLabel: humanizeToken(v),
    toLabel: humanizeToken(d),
  };
}

/** Human-facing text for the derived agreement (null when not comparable). */
export function agreementText(a: GradingAgreement): string | null {
  if (a.kind === 'match') return 'Matches AI verdict';
  if (a.kind === 'override') return `Overrides AI verdict (${a.fromLabel} → ${a.toLabel})`;
  return null;
}

/**
 * Convert a {@link GradingDraft} into the EXISTING backend `CaseFeedbackInput` shape.
 * Stars → 0..1 via {@link starsToScore}; only present/non-empty fields are included;
 * `assessment` defaults to `'agree'` (the field is required by the contract); the
 * optional `analyst` is passed through when provided.
 */
export function gradingToFeedbackInput(g: GradingDraft, analyst?: string): CaseFeedbackInput {
  const body: CaseFeedbackInput = { assessment: g.assessment ?? 'agree' };
  const a = starsToScore(g.accuracy);
  const r = starsToScore(g.reasoning_quality);
  const ap = starsToScore(g.action_appropriateness);
  if (a !== undefined) body.accuracy = a;
  if (r !== undefined) body.reasoning_quality = r;
  if (ap !== undefined) body.action_appropriateness = ap;
  if (g.actual_outcome) body.actual_outcome = g.actual_outcome;
  if (typeof g.time_saved_minutes === 'number' && g.time_saved_minutes > 0) {
    body.time_saved_minutes = g.time_saved_minutes;
  }
  if (g.comment && g.comment.trim()) body.comment = g.comment.trim();
  if (analyst && analyst.trim()) body.analyst = analyst.trim();
  return body;
}

/* ------------------------------------------------------------- components --- */

const StarRow: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
}> = ({ label, value, onChange }) => (
  <div className="flex items-center gap-3">
    <span className="flex-1 text-sm text-foreground">{label}</span>
    <div className="flex items-center">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${label}: ${n} of 5`}
          // ≥24px hit area (WCAG 2.5.8); the glyph stays 16px inside a 24px box.
          className="inline-flex h-6 w-6 items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onChange(n === value ? 0 : n)}
        >
          <Star
            className={cn('h-4 w-4', n <= value ? 'fill-warning text-warning' : 'text-muted-foreground')}
            aria-hidden
          />
        </button>
      ))}
    </div>
    <span className="w-8 text-right text-xs text-muted-foreground">{value ? `${value}/5` : DASH}</span>
  </div>
);

/**
 * The confirmed-outcome picker — the ONE control in this dialog that supplies
 * analyst-confirmed ground truth.
 *
 * Options come from {@link OUTCOME_OPTIONS}, which is derived from the generated
 * OpenAPI schema. Choosing "Not stated" clears the field rather than persisting the
 * `unknown` member, so an untouched grading posts no `actual_outcome` and the backend
 * default applies unchanged.
 */
export const OutcomeField: React.FC<{
  value?: FeedbackOutcome;
  onChange: (next: FeedbackOutcome | undefined) => void;
  id?: string;
}> = ({ value, onChange, id = 'grading-actual-outcome' }) => {
  const helpId = `${id}-help`;
  const selected = value ?? OUTCOME_UNSET;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        What actually happened? (optional)
      </Label>
      <Select
        value={selected}
        onValueChange={(next) =>
          onChange(next === OUTCOME_UNSET ? undefined : (next as FeedbackOutcome))
        }
      >
        <SelectTrigger
          id={id}
          className="h-9"
          aria-label="What actually happened? (optional)"
          aria-describedby={helpId}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OUTCOME_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={helpId} className="text-xs leading-relaxed text-muted-foreground">
        The confirmed outcome. This is the only part of a grade that becomes
        analyst-confirmed ground truth — the stars and the agree/override signal do not
        label the case.
      </p>
    </div>
  );
};

export interface GradingFieldsProps {
  /** The AI verdict on the case (read-only). */
  verdict?: string | null;
  /** The disposition the analyst is committing on close (read-only). */
  disposition?: Disposition | string | null;
  draft: GradingDraft;
  onChange: (next: GradingDraft) => void;
  className?: string;
}

/**
 * The in-dialog grading body: a DERIVED agree/override badge (from the read-only
 * verdict + disposition), an optional "What did the AI miss?" line on a mismatch, and
 * the 3 detailed quality stars behind a "Rate in detail →" disclosure.
 */
export const GradingFields: React.FC<GradingFieldsProps> = ({
  verdict,
  disposition,
  draft,
  onChange,
  className,
}) => {
  const agreement = React.useMemo(() => deriveAgreement(verdict, disposition), [verdict, disposition]);
  const badgeText = agreementText(agreement);
  const isOverride = agreement.kind === 'override';
  const [detailOpen, setDetailOpen] = React.useState(false);

  // Keep the parent draft's derived `assessment` in sync with the current
  // verdict↔disposition diff so the close-time submit carries the right value. Guarded
  // to only fire on an actual change (terminates — never loops).
  const derivedAssessment = agreement.kind === 'none' ? undefined : agreement.assessment;
  React.useEffect(() => {
    if (draft.assessment !== derivedAssessment) {
      onChange({ ...draft, assessment: derivedAssessment });
    }
  }, [derivedAssessment, draft, onChange]);

  const patch = React.useCallback(
    (next: Partial<GradingDraft>) => onChange({ ...draft, ...next }),
    [draft, onChange],
  );

  return (
    <div className={cn('space-y-3', className)}>
      {badgeText ? (
        <Badge variant={isOverride ? 'warning' : 'success'} className="gap-1.5">
          {isOverride ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
          {badgeText}
        </Badge>
      ) : null}

      {/* G1: the ground-truth intake. Always offered (not gated on an override) — an
          agreed close is exactly as much of a confirmed outcome as a contested one. */}
      <OutcomeField
        value={draft.actual_outcome}
        onChange={(actual_outcome) => patch({ actual_outcome })}
      />

      {isOverride ? (
        <div className="space-y-1.5">
          <Label htmlFor="grading-miss" className="text-xs">
            What did the AI miss? (optional)
          </Label>
          <Textarea
            id="grading-miss"
            rows={2}
            placeholder="What did the analyst see that the agent didn't?"
            value={draft.comment ?? ''}
            aria-describedby="grading-miss-help"
            onChange={(e) => patch({ comment: e.target.value })}
          />
          {/* The analyst-comment disclosure: this grading comment is posted to
              `/cases/{id}/feedback`, which re-indexes the resolved case — so the text
              becomes part of the precedent chunk the investigator reads later. */}
          <p id="grading-miss-help" className="text-xs leading-relaxed text-muted-foreground">
            {DURABLE_CONTEXT_NOTE}
          </p>
        </div>
      ) : null}

      <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', detailOpen && 'rotate-90')} aria-hidden />
            Rate in detail
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 space-y-2 rounded-md border border-border bg-muted/30 p-4">
            <div className="mb-1 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
              Quality (optional)
            </div>
            <StarRow
              label="Accuracy"
              value={draft.accuracy ?? 0}
              onChange={(v) => patch({ accuracy: v })}
            />
            <StarRow
              label="Reasoning quality"
              value={draft.reasoning_quality ?? 0}
              onChange={(v) => patch({ reasoning_quality: v })}
            />
            <StarRow
              label="Action appropriateness"
              value={draft.action_appropriateness ?? 0}
              onChange={(v) => patch({ action_appropriateness: v })}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

export interface GradingSectionProps extends GradingFieldsProps {
  /** Section heading. */
  title?: string;
  /** Whether the section starts expanded. Defaults open (keeps GradingFields mounted). */
  defaultOpen?: boolean;
}

/**
 * A titled, collapsible wrapper around {@link GradingFields} for the close dialog.
 * Defaults OPEN so the derived badge (the primary signal) is visible and the
 * derived-assessment sync runs.
 */
export const GradingSection: React.FC<GradingSectionProps> = ({
  title = 'Grade the AI decision',
  defaultOpen = true,
  className,
  ...fields
}) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('rounded-md border border-border p-4', className)}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="text-sm font-medium text-foreground">{title}</span>
          <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3">
          <GradingFields {...fields} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

const ASSESSMENT_LABEL: Record<string, string> = {
  agree: 'Matched AI',
  partial: 'Partially agreed',
  disagree: 'Overrode AI',
};

function assessmentVariant(assessment?: string): React.ComponentProps<typeof Badge>['variant'] {
  const a = (assessment ?? '').trim().toLowerCase();
  if (a === 'agree') return 'success';
  if (a === 'disagree') return 'warning';
  if (a === 'partial') return 'medium';
  return 'outline';
}

export interface GradingHistoryProps {
  feedback?: CaseFeedback[] | null;
  className?: string;
}

/**
 * Read-only list of prior gradings (most recent first). Analyst comments render as
 * PLAIN TEXT (#9). Renders nothing when there is no prior feedback.
 */
export const GradingHistory: React.FC<GradingHistoryProps> = ({ feedback, className }) => {
  const prior = React.useMemo(
    () => [...(feedback || [])].sort((x, y) => tsValue(y.ts) - tsValue(x.ts)),
    [feedback],
  );
  if (!prior.length) return null;

  return (
    <div className={className}>
      <div className="mb-3 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
        Previous gradings
      </div>
      <div className="space-y-2">
        {prior.map((f, i) => (
          <div key={i} className="rounded-md border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={assessmentVariant(f.assessment)}>
                {ASSESSMENT_LABEL[(f.assessment ?? '').trim().toLowerCase()] ||
                  humanizeToken(f.assessment) ||
                  'Graded'}
              </Badge>
              {f.actual_outcome ? (
                <Badge variant="outline">{humanizeToken(f.actual_outcome)}</Badge>
              ) : null}
              {typeof f.time_saved_minutes === 'number' && f.time_saved_minutes > 0 ? (
                <Badge variant="outline" className="gap-1">
                  <Clock className="h-3 w-3" aria-hidden />
                  {f.time_saved_minutes} min saved
                </Badge>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {f.analyst ? `${f.analyst} · ` : ''}
                {f.ts ? humanizeAge(f.ts) : DASH}
              </span>
            </div>
            {f.comment ? (
              /* UNTRUSTED — plain text (#9). */
              <p className="mt-2 whitespace-pre-wrap text-xs text-foreground/90">{f.comment}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

/** Re-export the `Separator` grammar so the close dialog can divide sections (W1.E). */
export { Separator as GradingDivider };
