/**
 * CaseDetail: the AI-decision grading module (Round-7 #10, DERIVED model; Round 15 D4.4).
 *
 * The close dialog asks ONE classification question, the disposition (D4.1). Whether
 * that disposition agrees with the AI verdict is DERIVED, shown as text and never asked,
 * from the fixed map:
 *   TRUE_POSITIVE  ↔ true_positive
 *   FALSE_POSITIVE ↔ { false_positive, benign }
 *   NEEDS_HUMAN    ↔ { suspicious, undetermined }
 *   NEEDS_HUMAN    → { true_positive, false_positive, benign } = RESOLVED (Round 12, D15):
 *                    the model handed the call to a person, so a concrete outcome settles
 *                    that hand-off. It is NOT an agreement signal either way: it is never
 *                    counted as the analyst overriding the AI, and never as agreeing with
 *                    it (the model made no call to agree with), so it carries no
 *                    assessment and the close posts no grade unless the analyst gave one
 *   duplicate      → no comparison (administrative outcome, not an agree/override signal)
 *
 * Today's grading rule stands (D4.4): on a close, resolve or set-disposition whose
 * disposition matches or overrides the AI verdict, the orchestrator posts ONE feedback
 * entry carrying the derived assessment, with or without stars. Stars and "What did the
 * AI miss?" sit in the collapsed "Rate the AI (optional)" disclosure ({@link RateTheAi}).
 *
 * GROUND TRUTH: the derived agree/override signal is not a label, and the Console never
 * sets `actual_outcome` (D4.4). The declared disposition already labels the case
 * (`explicit_analyst_disposition`); a feedback label would pin ground truth against a
 * later reclassification. The "What actually happened?" select left the dialog (D4.1),
 * so the draft no longer carries an outcome at all. {@link OUTCOME_OPTIONS} stays as the
 * vocabulary a STORED grade is read with (the grading history).
 *
 * SECURITY (#9): analyst-authored comments render as PLAIN TEXT, never markup.
 * #3: producing a `CaseFeedbackInput` never changes verdict/status/disposition: the
 * caller POSTs the grading as a SEPARATE call after the deterministic close.
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Star } from 'lucide-react';

import type { components } from '@/lib/api-types.gen';
import type { CaseFeedbackInput } from '@/lib/api';
import type { CaseFeedback, Disposition } from '@/lib/types';
import { DASH, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';

import { DURABLE_CONTEXT_NOTE, tsValue } from './shared';

/* --------------------------------------------------- ground-truth vocabulary --- */

/**
 * The analyst-outcome vocabulary, taken STRAIGHT off the generated OpenAPI schema
 * (`webui/openapi.json` -> `src/lib/api-types.gen.ts`, produced by `npm run gen:types`
 * and drift-gated by `npm run check:types`). Type-only import: erased at compile time.
 */
export type FeedbackOutcome = components['schemas']['FeedbackOutcome'];

/**
 * The words for each stored outcome. The Console no longer asks this question (D4.1);
 * the list is how a recorded grade's `actual_outcome` is read back. `as const satisfies`
 * rejects a value not in the generated union, and {@link FeedbackOutcomeCoverage} proves
 * nothing is missing.
 */
export const OUTCOME_OPTIONS = [
  { value: 'unknown', text: 'Not stated' },
  { value: 'true_positive', text: 'True positive: the alert was real' },
  { value: 'false_positive', text: 'False positive: the alert was wrong' },
  { value: 'true_negative', text: 'True negative: correctly quiet' },
  { value: 'false_negative', text: 'False negative: the detection missed it' },
] as const satisfies ReadonlyArray<{ value: FeedbackOutcome; text: string }>;

/** Fails to typecheck unless `T` is `never`. */
type MustBeNever<T extends never> = T;

/**
 * Compile-time drift guard: if `FeedbackOutcome` gains a member that
 * {@link OUTCOME_OPTIONS} does not word, `Exclude` stops being `never` and `tsc` fails.
 */
export type FeedbackOutcomeCoverage = MustBeNever<
  Exclude<FeedbackOutcome, (typeof OUTCOME_OPTIONS)[number]['value']>
>;

/** The short words for a stored outcome ("True positive"), or the token as written. */
export function outcomeWords(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) return '';
  const option = OUTCOME_OPTIONS.find((o) => o.value === token);
  return option ? option.text.split(':')[0] : humanizeToken(token);
}

/* ------------------------------------------------------------------ types --- */

/**
 * Draft grading state held by the close dialog. All fields optional so an untouched close
 * still produces a valid {@link CaseFeedbackInput}. Star fields carry a RAW 1-5 count
 * (0 = unset); {@link gradingToFeedbackInput} maps them to 0..1. There is deliberately no
 * outcome field (D4.4): the Console never sets `actual_outcome`.
 */
export interface GradingDraft {
  assessment?: CaseFeedbackInput['assessment'];
  /** 1-5 stars (0/undefined = unset). */
  accuracy?: number;
  reasoning_quality?: number;
  action_appropriateness?: number;
  time_saved_minutes?: number;
  comment?: string;
}

/** Result of deriving agreement from the AI verdict ↔ analyst disposition diff. */
export type GradingAgreement =
  | { kind: 'match'; assessment: 'agree' }
  | { kind: 'override'; assessment: 'disagree'; fromLabel: string; toLabel: string }
  // NEEDS_HUMAN settled with a concrete outcome: the AI deferred to a person. No
  // assessment: neither a disagreement nor an "agree" the analyst never stated.
  | { kind: 'resolved'; toLabel: string }
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
 * True when the analyst entered ANY signal beyond a plain "agree" default: then a grade
 * is posted even when the disposition does not compare with the AI verdict.
 */
export function isGradingDirty(g: GradingDraft): boolean {
  return Boolean(
    (g.accuracy && g.accuracy > 0) ||
      (g.reasoning_quality && g.reasoning_quality > 0) ||
      (g.action_appropriateness && g.action_appropriateness > 0) ||
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

/** Concrete outcomes that RESOLVE a NEEDS_HUMAN hand-off rather than override it. */
const NEEDS_HUMAN_RESOLUTIONS: readonly string[] = ['true_positive', 'false_positive', 'benign'];

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
  if (v === 'NEEDS_HUMAN' && NEEDS_HUMAN_RESOLUTIONS.includes(d)) {
    return { kind: 'resolved', toLabel: humanizeToken(d) };
  }
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
  if (a.kind === 'resolved') return `Settles the AI's hand-off (Needs human → ${a.toLabel})`;
  return null;
}

/**
 * Round 15 (D4.3): the Console asks for a note when the disposition OVERRIDES the AI
 * verdict. A Needs human review resolution (`resolved`), a duplicate and a case with no
 * verdict (`none`) never require one. The backend is unchanged: the note stays optional
 * on the wire.
 */
export function requiresDisagreementNote(
  verdict?: string | null,
  disposition?: Disposition | string | null,
): boolean {
  return deriveAgreement(verdict, disposition).kind === 'override';
}

/**
 * Convert a {@link GradingDraft} into the EXISTING backend `CaseFeedbackInput` shape.
 * Stars → 0..1 via {@link starsToScore}; only present/non-empty fields are included;
 * the optional `analyst` is passed through when provided. `assessment` is sent ONLY when
 * the draft carries one (a derived match/override): it is never defaulted to `agree`,
 * so a grade on a settled Needs-human hand-off cannot inflate the Agreement metric. It
 * never carries `actual_outcome` (D4.4).
 */
export function gradingToFeedbackInput(g: GradingDraft, analyst?: string): CaseFeedbackInput {
  const body: CaseFeedbackInput = {};
  if (g.assessment) body.assessment = g.assessment;
  const a = starsToScore(g.accuracy);
  const r = starsToScore(g.reasoning_quality);
  const ap = starsToScore(g.action_appropriateness);
  if (a !== undefined) body.accuracy = a;
  if (r !== undefined) body.reasoning_quality = r;
  if (ap !== undefined) body.action_appropriateness = ap;
  if (typeof g.time_saved_minutes === 'number' && g.time_saved_minutes > 0) {
    body.time_saved_minutes = g.time_saved_minutes;
  }
  if (g.comment && g.comment.trim()) body.comment = g.comment.trim();
  if (analyst && analyst.trim()) body.analyst = analyst.trim();
  return body;
}

/* ------------------------------------------------------------- components --- */

/**
 * The derived agreement as one quiet line, shown under the disposition once one is
 * chosen (D4.4: shown, never asked). `aiLine` ("AI verdict: True positive (80%)") follows
 * it in muted text. Renders nothing when there is nothing to say.
 */
export const AgreementLine: React.FC<{
  verdict?: string | null;
  disposition?: Disposition | string | null;
  aiLine?: string | null;
  className?: string;
  'data-testid'?: string;
}> = ({ verdict, disposition, aiLine, className, 'data-testid': testId }) => {
  const agreement = deriveAgreement(verdict, disposition);
  const text = disposition ? agreementText(agreement) : null;
  if (!text && !aiLine) return null;
  const override = agreement.kind === 'override';
  const Icon = override ? AlertTriangle : CheckCircle2;
  return (
    <p data-testid={testId} className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs', className)}>
      {text ? (
        <span
          className={cn(
            'inline-flex items-center gap-1.5 font-medium',
            override ? 'text-warning-text' : agreement.kind === 'match' ? 'text-success-text' : 'text-foreground',
          )}
        >
          <Icon className="size-3.5 shrink-0 self-center" aria-hidden />
          <span>{text}</span>
        </span>
      ) : null}
      {aiLine ? <span className="text-muted-foreground">{aiLine}</span> : null}
    </p>
  );
};

const StarRow: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
}> = ({ label, value, onChange }) => (
  <div className="flex items-center gap-3">
    <span className="flex-1 text-sm text-foreground">{label}</span>
    <div className="flex items-center" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${label}: ${n} of 5`}
          aria-pressed={n <= value}
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
    <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{value ? `${value}/5` : DASH}</span>
  </div>
);

export interface GradingFieldsProps {
  /** The AI verdict on the case (read-only). */
  verdict?: string | null;
  /** The disposition the analyst is committing (read-only). */
  disposition?: Disposition | string | null;
  draft: GradingDraft;
  onChange: (next: GradingDraft) => void;
  className?: string;
}

/**
 * The grading body: the three quality stars and, on an override only, "What did the AI
 * miss?". The agreement itself is derived at submit by the orchestrator and shown by
 * {@link AgreementLine}; nothing here decides it.
 */
export const GradingFields: React.FC<GradingFieldsProps> = ({
  verdict,
  disposition,
  draft,
  onChange,
  className,
}) => {
  const isOverride = deriveAgreement(verdict, disposition).kind === 'override';
  const patch = React.useCallback(
    (next: Partial<GradingDraft>) => onChange({ ...draft, ...next }),
    [draft, onChange],
  );

  return (
    <div className={cn('space-y-3', className)}>
      <div className="space-y-1">
        <StarRow label="Accuracy" value={draft.accuracy ?? 0} onChange={(v) => patch({ accuracy: v })} />
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

      {isOverride ? (
        <div className="space-y-1.5">
          <Label htmlFor="grading-miss" className="text-xs">
            What did the AI miss? (optional)
          </Label>
          <Textarea
            id="grading-miss"
            rows={2}
            placeholder="What did you see that the agent did not?"
            value={draft.comment ?? ''}
            aria-describedby="grading-miss-help"
            onChange={(e) => patch({ comment: e.target.value })}
          />
          {/* The analyst-comment disclosure: this grading comment is posted to
              `/cases/{id}/feedback`, which re-indexes the resolved case, so the text
              becomes part of the precedent chunk the investigator reads later. */}
          <p id="grading-miss-help" className="text-xs leading-relaxed text-muted-foreground">
            {DURABLE_CONTEXT_NOTE}
          </p>
        </div>
      ) : null}
    </div>
  );
};

export interface RateTheAiProps extends GradingFieldsProps {
  /** Whether the disclosure starts open. Default closed (D4.4). */
  defaultOpen?: boolean;
}

/**
 * "Rate the AI (optional)": the collapsed disclosure around {@link GradingFields}. Closed
 * by default; the derived agreement is posted on submit whether or not it was opened.
 */
export const RateTheAi: React.FC<RateTheAiProps> = ({ defaultOpen = false, className, ...fields }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  const rated = isGradingDirty({ ...fields.draft, assessment: undefined });
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('space-y-3', className)}>
      <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        Rate the AI (optional)
        {rated && !open ? <span className="font-normal text-muted-foreground">· rated</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <GradingFields {...fields} />
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
 * Read-only list of prior gradings (most recent first), divided by hairlines. Analyst
 * comments render as PLAIN TEXT (#9). Renders nothing when there is no prior feedback.
 */
export const GradingHistory: React.FC<GradingHistoryProps> = ({ feedback, className }) => {
  const prior = React.useMemo(
    () => [...(feedback || [])].sort((x, y) => tsValue(y.ts) - tsValue(x.ts)),
    [feedback],
  );
  if (!prior.length) return null;

  return (
    <ol className={cn('divide-y divide-border/60', className)}>
      {prior.map((f, i) => (
        <li key={i} className="py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={assessmentVariant(f.assessment)}>
              {ASSESSMENT_LABEL[(f.assessment ?? '').trim().toLowerCase()] ||
                humanizeToken(f.assessment) ||
                'Graded'}
            </Badge>
            {f.actual_outcome && f.actual_outcome !== 'unknown' ? (
              <Badge variant="outline">{outcomeWords(f.actual_outcome)}</Badge>
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
            /* UNTRUSTED: plain text (#9). */
            <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">{f.comment}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
};
