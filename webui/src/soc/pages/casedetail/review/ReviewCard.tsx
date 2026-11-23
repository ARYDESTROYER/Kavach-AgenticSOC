/**
 * The auto-close review card (Round 15 SPEC D6.6, D6.9, D6.11). A kit: WP7 mounts it in
 * the case workspace (the pending band's Start review, and Review this auto-close on an
 * agent-closed case). Lazy with its host, never in the entry chunk.
 *
 * Not a full blind review, but the reviewer answers first: "What was it?" has no
 * preselected answer, and the AI verdict is shown only after "Compare with the AI". Once
 * compared, the answer is locked, so the comparison cannot steer it. The time from
 * opening the card to submitting is sent as `elapsed_ms`.
 *
 * The review is always recorded and never changes the case (#3). On a disagreement, a
 * reviewer who can close cases is offered Reopen case and Reopen and escalate (two
 * calls; when the second fails the case stays reopened and the card says so). Anyone
 * else reads that someone who can close cases has been asked to look. Every string is
 * fixed copy; the note is plain text the person typed (#9).
 */
import * as React from 'react';
import { Star } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { recordReview } from '@/lib/api-reviews';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errorMessage';
import type { Case, CaseActionInput } from '@/lib/types';
import type { ReviewBody, ReviewClassification, ReviewResult } from '@/lib/types-reviews';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { aiVerdictLine, canonicalVerdict } from '@/soc/components/outcome';

/** The answers, in the order the card offers them. */
export const REVIEW_CHOICES: ReadonlyArray<{ value: ReviewClassification; label: string }> = [
  { value: 'true_positive', label: 'True positive' },
  { value: 'false_positive', label: 'False positive' },
  { value: 'benign', label: 'Benign' },
  { value: 'unsure', label: 'Unsure' },
];

/** The note's limit (the server's `ReviewBody.note`). */
export const REVIEW_NOTE_MAX = 1000;

/** The band copy for a pending sample (D6.12). */
export const REVIEW_BAND_TEXT =
  'Picked at random for auto-close review. Classify it yourself, then compare with the AI.';

/** The AI verdicts each answer agrees with (the server's `classification_agrees`). */
const AGREES_WITH: Record<string, string> = {
  true_positive: 'TRUE_POSITIVE',
  false_positive: 'FALSE_POSITIVE',
  benign: 'FALSE_POSITIVE',
};

/** Whether `answer` matches the AI verdict; null for Unsure or an unknown verdict. */
export function reviewAgrees(answer: ReviewClassification, verdict: unknown): boolean | null {
  const v = canonicalVerdict(verdict);
  const wanted = AGREES_WITH[answer];
  if (!wanted || !v) return null;
  return v === wanted;
}

/** The comparison sentence shown after "Compare with the AI". */
export function comparisonText(agrees: boolean | null): string {
  if (agrees === true) return 'Your classification agrees with the AI.';
  if (agrees === false) return 'Your classification disagrees with the AI.';
  return 'Unsure is recorded without a label.';
}

/** A 1 to 5 star rating as the server's 0.2 to 1.0 (undefined when unrated). */
function starsToScore(n: number): number | undefined {
  return n >= 1 ? Math.min(1, n / 5) : undefined;
}

type Stage = 'answer' | 'compared' | 'saving' | 'recorded';

export interface ReviewCardProps {
  caseData: Case;
  /** The case is in the review sample (the band is shown above the card). */
  pending?: boolean;
  /** The viewer holds `cases:close` (offers Reopen after a disagreement). */
  canReopen?: boolean;
  /** Called once the review is recorded. */
  onRecorded?: (result: ReviewResult) => void;
  /** Called after Reopen (and escalate), with the case the last call returned. */
  onReopened?: (updated: Case | null, escalated: boolean) => void;
  /** Close the card without recording (hidden once recorded). */
  onCancel?: () => void;
  /** Test seams. */
  record?: typeof recordReview;
  caseAction?: (caseId: string, input: CaseActionInput) => Promise<Case>;
  now?: () => number;
}

function StarRating({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex-1 text-sm text-foreground">{label}</span>
      <div className="flex items-center" role="group" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${label}: ${n} of 5`}
            aria-pressed={n <= value}
            className="inline-flex h-6 w-6 items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onChange(n === value ? 0 : n)}
          >
            <Star className={cn('h-4 w-4', n <= value ? 'fill-warning text-warning' : 'text-muted-foreground')} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReviewCard({
  caseData,
  pending = false,
  canReopen = false,
  onRecorded,
  onReopened,
  onCancel,
  record = recordReview,
  caseAction = (caseId, input) => api.caseActionExec(caseId, input),
  now = () => Date.now(),
}: ReviewCardProps) {
  const openedAt = React.useRef(now());
  const [answer, setAnswer] = React.useState<ReviewClassification | ''>('');
  const [note, setNote] = React.useState('');
  const [rateOpen, setRateOpen] = React.useState(false);
  const [stars, setStars] = React.useState({ accuracy: 0, reasoning_quality: 0, action_appropriateness: 0 });
  const [stage, setStage] = React.useState<Stage>('answer');
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ReviewResult | null>(null);
  const [reopen, setReopen] = React.useState<'idle' | 'busy' | 'reopened' | 'escalated' | 'partial' | 'failed'>('idle');
  const [reopenError, setReopenError] = React.useState<string | null>(null);
  const noteId = React.useId();
  const rateId = React.useId();
  const answerHelpId = React.useId();

  const agrees = answer ? reviewAgrees(answer, caseData.verdict) : null;
  const aiLine = aiVerdictLine(caseData.verdict, caseData.confidence) ?? 'AI verdict: Not yet assessed';

  const submit = async () => {
    if (!answer) return;
    setStage('saving');
    setError(null);
    const body: ReviewBody = {
      classification: answer,
      note: note.trim() || undefined,
      accuracy: starsToScore(stars.accuracy),
      reasoning_quality: starsToScore(stars.reasoning_quality),
      action_appropriateness: starsToScore(stars.action_appropriateness),
      elapsed_ms: Math.max(0, Math.min(86_400_000, Math.round(now() - openedAt.current))),
    };
    try {
      const saved = await record(caseData.case_id, body);
      setResult(saved);
      setStage('recorded');
      onRecorded?.(saved);
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { detail?: { code?: string } } | undefined)?.detail?.code : undefined;
      setError(
        code === 'review_already_recorded'
          ? 'This review is already recorded.'
          : errorMessage(e, 'The review could not be recorded. Try again.'),
      );
      setStage('compared');
    }
  };

  const doReopen = async (escalate: boolean) => {
    setReopen('busy');
    setReopenError(null);
    let updated: Case | null = null;
    try {
      updated = await caseAction(caseData.case_id, { action: 'reopen', review_via: 'auto_close_review' });
    } catch (e) {
      setReopen('failed');
      setReopenError(errorMessage(e, 'The case could not be reopened.'));
      return;
    }
    if (!escalate) {
      setReopen('reopened');
      onReopened?.(updated, false);
      return;
    }
    try {
      updated = await caseAction(caseData.case_id, { action: 'escalate', review_via: 'auto_close_review' });
      setReopen('escalated');
      onReopened?.(updated, true);
    } catch (e) {
      setReopen('partial');
      setReopenError(errorMessage(e, 'The case could not be escalated.'));
      onReopened?.(updated, false);
    }
  };

  if (stage === 'recorded' && result) {
    const disagreed = result.agrees === false;
    return (
      <section aria-label="Auto-close review" className="space-y-3" data-testid="review-card">
        <p className="text-sm font-medium text-foreground" role="status">
          {result.agrees === true
            ? 'Review recorded. Your classification agrees with the AI.'
            : disagreed
              ? 'Review recorded. Your classification disagrees with the AI.'
              : 'Review recorded without a label.'}
        </p>
        {disagreed && !(result.can_reopen ?? canReopen) ? (
          <p className="text-sm text-muted-foreground" data-testid="review-asked">
            Someone who can close cases has been asked to look at this.
          </p>
        ) : null}
        {disagreed && (result.can_reopen ?? canReopen) ? (
          reopen === 'reopened' ? (
            <p className="text-sm text-foreground" role="status">The case is reopened.</p>
          ) : reopen === 'escalated' ? (
            <p className="text-sm text-foreground" role="status">The case is reopened and escalated.</p>
          ) : reopen === 'partial' ? (
            <p className="text-sm text-warning-text" role="alert">
              The case is reopened, but it could not be escalated: {reopenError} Escalate it from Take action.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void doReopen(false)} disabled={reopen === 'busy'}>
                Reopen case
              </Button>
              <Button size="sm" variant="outline" onClick={() => void doReopen(true)} disabled={reopen === 'busy'}>
                Reopen and escalate
              </Button>
              {reopen === 'failed' && reopenError ? (
                <p className="text-sm text-critical-text" role="alert">
                  {reopenError}
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </section>
    );
  }

  const compared = stage === 'compared' || stage === 'saving';
  return (
    <section aria-label="Auto-close review" className="space-y-4" data-testid="review-card">
      {pending ? <p className="text-sm text-muted-foreground">{REVIEW_BAND_TEXT}</p> : null}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground" id={answerHelpId}>
          What was it?
        </p>
        <SegmentedControl<ReviewClassification | ''>
          options={REVIEW_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
          value={answer}
          onValueChange={(v) => setAnswer(v)}
          aria-label="Your classification"
          aria-describedby={answerHelpId}
          orientation="both"
          className="flex-wrap"
          disabled={compared}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={noteId}>Note (optional)</Label>
        <Textarea
          id={noteId}
          value={note}
          maxLength={REVIEW_NOTE_MAX}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          disabled={stage === 'saving'}
        />
        <p className="text-xs text-muted-foreground">Your note is kept as precedent for future investigations.</p>
      </div>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={rateOpen}
          aria-controls={rateId}
          onClick={() => setRateOpen((open) => !open)}
        >
          {rateOpen ? 'Hide the AI rating' : 'Rate the AI (optional)'}
        </Button>
        <div id={rateId} hidden={!rateOpen} className={rateOpen ? 'mt-2 space-y-1' : undefined}>
          <StarRating label="Accuracy" value={stars.accuracy} onChange={(v) => setStars((s) => ({ ...s, accuracy: v }))} />
          <StarRating
            label="Reasoning"
            value={stars.reasoning_quality}
            onChange={(v) => setStars((s) => ({ ...s, reasoning_quality: v }))}
          />
          <StarRating
            label="Recommended action"
            value={stars.action_appropriateness}
            onChange={(v) => setStars((s) => ({ ...s, action_appropriateness: v }))}
          />
        </div>
      </div>
      {compared ? (
        <div className="space-y-1" data-testid="review-comparison">
          <p className="text-sm text-foreground">{aiLine}</p>
          <p className={cn('text-sm', agrees === false ? 'font-medium text-warning-text' : 'text-muted-foreground')}>
            {comparisonText(agrees)}
          </p>
        </div>
      ) : null}
      {error ? (
        <p className="text-sm text-critical-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {compared ? (
          <Button onClick={() => void submit()} disabled={stage === 'saving'}>
            {stage === 'saving' ? 'Recording' : 'Record review'}
          </Button>
        ) : (
          <Button onClick={() => setStage('compared')} disabled={!answer}>
            Compare with the AI
          </Button>
        )}
        {onCancel ? (
          <Button variant="outline" onClick={onCancel} disabled={stage === 'saving'}>
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export default ReviewCard;
