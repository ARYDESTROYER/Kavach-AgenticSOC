/**
 * DecisionCard: the SINGLE, most-prominent, pinned deterministic-decision card
 * (Round-7 #9a / DESIGN_DIRECTION "3-lane separation").
 *
 * This is the DETERMINISTIC DECISION lane made visible: the authority for whether a
 * case closes / escalates is `case_manager.decide()` (#3), evaluated against the
 * operator-configured AutoClosePolicy, never raw model output. This card pins that
 * result at the end of the case story: the verdict / status / confidence inputs, WHO
 * the recorded decider was (a human analyst vs the Automated pipeline), the exact
 * matched policy clause (thresholds `decide()` compared against), the deterministic
 * rationale string, and the FP objection window when one is pending.
 *
 * Round 16 (research explainability D1, D8): the card shows the RECORDED decision: the
 * case's own status, decider and objection window, or the decision span's when it says
 * it reports the recorded decision (`source: "recorded"`). A span of an older build is a
 * read-time re-run of `decide()` with today's policy, so it never supplies the outcome,
 * the decider or a fresh objection window here. The thresholds come from the gate
 * recorded at decision time when the span carries one, otherwise from today's policy
 * clause, labelled "thresholds not recorded". Both auto-close conditions are stated with
 * their numbers, and a "policy changed since" note appears when today's policy differs.
 *
 * SECURITY (#9): the deterministic rationale + any status/verdict tokens are our own
 * or backend-derived controlled strings, rendered as PLAIN text nodes only, never
 * markup, never an href/CSS value. This card only READS; it never decides or mutates.
 */
import * as React from 'react';
import { AlertTriangle, GitBranch, Lock, ShieldCheck, User } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { DecisionPayload, TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';
import { DASH, formatTimestamp, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ExplainTrigger } from '@/design-system/explain';
import { displayScore, trimmed } from '@/lib/explain/rounding';
import type { Explanation } from '@/lib/explain/types';
import {
  FAILED_RUN_SENTENCE,
  compareWithPolicy,
  comparisonSentence,
  readDecision,
  type DecisionThresholds,
} from '@/lib/explain/decision';

import { Badge } from '@/ui/badge';
import {
  AutoClosedBadge,
  ConfidenceBadge,
  StatusBadge,
  VerdictBadge,
  isAutoClosedByAI,
} from '@/soc/components/badges';
import { decisionPayload } from '@/soc/components/TraceTimeline';
// motion.dev (lazy, part of the CaseDetail chunk, under its MotionProvider): the
// restrained "verdict lands" one-shot that reinforces the #3 "computed, not guessed"
// trust story. Reduced motion (MotionConfig reducedMotion="user") drops the scale,
// keeps the fade, never a loop.
import { motion, verdictLandVariants } from '@/soc/components/motion';

/* ------------------------------------------------------------------ helpers -- */

/** Find the terminal `decision` span in a timeline (the one `decide()` produced). */
function terminalDecisionSpan(timeline: TimelineResponse | null): TraceSpan | null {
  const spans = timeline?.spans ?? [];
  const decisions = spans.filter((s) => s.kind === 'decision');
  return decisions.length ? decisions[decisions.length - 1] : null;
}

/** The decision owner that means "an operator's rule-level declaration closed this". */
const ANALYST_POLICY = 'analyst_policy';

/** Who the recorded decider was: a human analyst vs the automated pipeline.
 *
 *  `analyst_policy` is checked FIRST and explicitly: it contains the substring
 *  "analyst", so the generic heuristic below would credit a person for a case no
 *  person ever worked. It is an operator's rule-level declaration applied
 *  deterministically, which is neither human case work nor agent judgement. */
function decidedBy(decisionBy?: string | null): { text: string; isHuman: boolean } {
  const d = (decisionBy || '').toLowerCase().trim();
  if (d === ANALYST_POLICY) return { text: 'Analyst policy', isHuman: false };
  const isHuman = d.includes('human') || d.includes('analyst') || d.includes('operator');
  return { text: decisionBy ? humanizeToken(decisionBy) : 'Automated pipeline', isHuman };
}

/** The rule-level declaration that closed this case, when one did. */
function analystPolicyRules(c: Case): string[] {
  const policy = (c as { analyst_policy?: { rule_ids?: unknown } }).analyst_policy;
  const rules = policy?.rule_ids;
  return Array.isArray(rules) ? rules.map((r) => String(r)) : [];
}

/** The qualifying analyst-precedent fact this investigation was given, if any. */
interface PrecedentSignalView {
  status?: string;
  reason?: string;
  qualifies?: boolean;
  confirmed_false_positive?: number;
  confirmed_true_positive?: number;
  min_confirmed?: number;
  top_score?: number | null;
  min_similarity?: number;
  truncated?: boolean;
  rule_ids?: unknown;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Why a precedent signal did not qualify, in words, by its status. A status the server
 * reads no counts for (`disabled`, `not_applicable`, an unreadable history) never shows
 * counts: its zeros were not read, so stating them would invent a history.
 */
const PRECEDENT_NOT_USED: Record<string, string> = {
  disabled: 'not used, because precedent promotion is off',
  not_applicable: 'not used, because this case has no detection rule to match',
  unavailable: 'not used, because the confirmed history could not be read',
};
const PRECEDENT_WHY: Record<string, string> = {
  conflicting: 'this rule has confirmed malicious outcomes',
  insufficient: 'fewer confirmed benign outcomes than needed',
  not_retrieved: 'no matching precedent was retrieved for this case',
  unavailable: 'the read was cut short, so the counts are lower bounds',
};

/** True when the server read this rule's confirmed counts for the signal. */
function precedentCounted(signal: PrecedentSignalView): boolean {
  const status = String(signal.status || '');
  if (signal.qualifies || ['qualified', 'conflicting', 'insufficient', 'not_retrieved'].includes(status)) return true;
  // An unavailable read carries counts only when it was cut short (lower bounds).
  return status === 'unavailable' && signal.truncated === true;
}

function outcomes(n: number, kind: string, atLeast: boolean): string {
  return `${atLeast ? 'at least ' : ''}${n.toLocaleString('en-US')} confirmed ${kind}`;
}

/**
 * The precedent line (research data-visibility R9): always shown, so a decision that did
 * not lean on precedent says why. Counts, the minimum and the reason are our own data,
 * stated only when the server read them; the reason is shown in words.
 */
export function precedentLine(signal: PrecedentSignalView | null): string {
  if (!signal) return 'Precedent: not recorded for this investigation.';
  const status = String(signal.status || '');
  if (!precedentCounted(signal)) {
    return `Precedent: ${PRECEDENT_NOT_USED[status] ?? 'not used for this investigation'}.`;
  }
  const atLeast = signal.truncated === true;
  const benign = count(signal.confirmed_false_positive);
  const malicious = count(signal.confirmed_true_positive);
  const counts = `${outcomes(benign, 'benign', atLeast)} and ${outcomes(malicious, 'malicious', atLeast)} outcome${
    malicious === 1 ? '' : 's'
  } for this rule`;
  const needed = count(signal.min_confirmed);
  const neededText = needed ? `; ${needed.toLocaleString('en-US')} needed` : '';
  if (signal.qualifies) return `Precedent: ${counts}${neededText}; it qualified as evidence.`;
  const why = PRECEDENT_WHY[status];
  return `Precedent: ${counts}${neededText}; it did not qualify${why ? ` (${why})` : ''}.`;
}

/** The precedent facts in full (research data-visibility R9): the click panel of the line. */
export function precedentExplanation(signal: PrecedentSignalView | null): Explanation | null {
  if (!signal) return null;
  const counted = precedentCounted(signal);
  const source = 'Recorded with the investigation';
  const inputs: Explanation['inputs'] = [
    { key: 'status', label: 'Status', value: humanizeToken(signal.status || 'unknown'), source },
  ];
  if (counted) {
    const atLeast = signal.truncated === true ? 'at least ' : '';
    inputs.push(
      { key: 'benign', label: 'Confirmed benign', value: `${atLeast}${count(signal.confirmed_false_positive).toLocaleString('en-US')}`, source },
      { key: 'malicious', label: 'Confirmed malicious', value: `${atLeast}${count(signal.confirmed_true_positive).toLocaleString('en-US')}`, source },
    );
  }
  if (count(signal.min_confirmed)) {
    inputs.push({ key: 'min_confirmed', label: 'Benign outcomes needed', value: count(signal.min_confirmed).toLocaleString('en-US'), source: 'Precedent settings' });
  }
  if (typeof signal.top_score === 'number' && Number.isFinite(signal.top_score)) {
    inputs.push({
      key: 'top_score',
      label: 'Best match',
      value: `${trimmed(signal.top_score, 4)} against a floor of ${trimmed(count(signal.min_similarity), 4)}`,
      source,
    });
  }
  if (signal.truncated) inputs.push({ key: 'truncated', label: 'History read', value: 'Cut short', source });
  return {
    metric: 'precedent',
    title: 'Precedent',
    value: signal.status ?? null,
    display: precedentLine(signal),
    summary: precedentLine(signal),
    formula: 'qualifies when no confirmed malicious outcome, at least the needed confirmed benign outcomes, and a match above the floor',
    inputs,
    steps: [],
    provenance: 'recorded',
    provenanceNote: 'Recorded when the investigation ran.',
    caveats: ['Precedent can add evidence for the AI. It never closes a case on its own.'],
  };
}
function precedentSignal(c: Case): PrecedentSignalView | null {
  const raw = (c as { precedent_signal?: PrecedentSignalView | null }).precedent_signal;
  return raw && typeof raw === 'object' ? raw : null;
}

/* --------------------------------------------------------------- clause row -- */

/** One label/value pair inside the decision-inputs grid. `value` is controlled text. */
const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md border border-border bg-card px-2.5 py-2">
    <div className="text-xs font-medium text-muted-foreground">
      {label}
    </div>
    <div className="mt-0.5 truncate font-mono text-sm text-foreground">{value}</div>
  </div>
);

/* --------------------------------------------------------------- component -- */

export interface DecisionCardProps {
  c: Case;
  rationale: CaseRationale | null;
  timeline: TimelineResponse | null;
}

/**
 * The pinned deterministic-decision authority card. Prefers the exact values recorded
 * on the terminal decision span, falling back to the rationale, then the case.
 */
/** True when two policy entries name different bars (the "policy changed since" test). */
function thresholdsDiffer(a: DecisionThresholds | null, b: DecisionThresholds | null): boolean {
  if (!a || !b) return false;
  return (
    (a.enabled !== null && b.enabled !== null && a.enabled !== b.enabled) ||
    (a.min_confidence !== null && b.min_confidence !== null && a.min_confidence !== b.min_confidence) ||
    (a.max_risk_score !== null && b.max_risk_score !== null && a.max_risk_score !== b.max_risk_score)
  );
}

export const DecisionCard: React.FC<DecisionCardProps> = ({ c, rationale, timeline }) => {
  const span = terminalDecisionSpan(timeline);
  const d: DecisionPayload = span ? decisionPayload(span) : {};
  const reading = readDecision(d);
  // A span that reports the recorded decision may supply the outcome; an older span is a
  // read-time re-run with today's policy and never does (D1).
  const recordedSpan = reading?.source === 'recorded';
  // The newest run failed (WP10 `run_failed`): code routed the case without comparing
  // anything with the auto-close policy, so no clause is shown as if it decided.
  const runFailed = reading?.runFailed === true;
  const gate = reading?.gate ?? null;

  const verdict = gate?.verdict ?? c.verdict ?? rationale?.verdict ?? d.verdict;
  const confidence =
    typeof gate?.confidence === 'number'
      ? gate.confidence
      : typeof c.confidence === 'number'
        ? c.confidence
        : typeof rationale?.confidence === 'number'
          ? rationale.confidence
          : d.confidence;
  const riskScore = typeof gate?.risk_score === 'number' ? gate.risk_score : c.risk_score;
  const status = (recordedSpan ? reading?.status : null) ?? c.status ?? rationale?.status;
  const decisionByRaw = (recordedSpan ? reading?.decisionBy : null) ?? c.decision_by ?? rationale?.decision_by;
  const decider = decidedBy(decisionByRaw);
  const escalate = recordedSpan ? d.escalate === true : String(status || '').toLowerCase() === 'escalated';

  // The DETERMINISTIC rationale string (our own / backend copy): plain text (#9). The
  // recorded rationale first; a read-time re-run's summary never stands in for it.
  const rationaleText = rationale?.decision_rationale || (recordedSpan ? span?.summary : '') || '';

  // The FP objection deadline: the recorded one only (a re-run computes "now + window").
  const objectionWindow =
    (recordedSpan ? reading?.objectionWindowExpiresAt : null) ?? c.objection_window_expires_at ?? null;
  const autoClosed = isAutoClosedByAI(status, decisionByRaw);
  const policyRules = analystPolicyRules(c);
  const precedent = precedentSignal(c);

  // The thresholds: recorded at decision time when the span carries the gate, else
  // today's policy clause, labelled so.
  const recordedThresholds: DecisionThresholds | null = gate
    ? {
        enabled: gate.class_enabled,
        min_confidence: gate.min_confidence,
        max_risk_score: gate.max_risk_score,
        objection_window_minutes: gate.objection_window_minutes,
        note: null,
      }
    : null;
  const currentThresholds = runFailed ? null : reading?.current ?? null;
  const thresholds = runFailed ? null : recordedThresholds ?? currentThresholds;
  const clause = d.policy_clause;
  const verdictText = typeof verdict === 'string' ? verdict : null;
  const comparison = thresholds
    ? compareWithPolicy(
        verdictText,
        typeof confidence === 'number' ? confidence : null,
        typeof riskScore === 'number' ? riskScore : null,
        thresholds,
      )
    : null;
  const policyChanged =
    reading?.policyChanged === true || (recordedThresholds !== null && thresholdsDiffer(recordedThresholds, currentThresholds));
  const todayComparison =
    policyChanged && currentThresholds
      ? compareWithPolicy(
          verdictText,
          typeof confidence === 'number' ? confidence : null,
          typeof riskScore === 'number' ? riskScore : null,
          currentThresholds,
        )
      : null;
  const autoClosable = thresholds?.enabled ?? clause?.auto_closable;
  const codeNote = thresholds?.note ?? clause?.note ?? null;

  return (
    <section
      aria-label="Deterministic decision"
      data-testid="decision-card"
      className="relative overflow-hidden rounded-xl border-2 border-low/40 bg-low/5 p-5"
    >
      {/* Left authority accent so the pinned card reads as the decision lane. */}
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-low" />

      {/* ----------------------------------------------------------- header */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-low/50 bg-low/15"
          aria-hidden
        >
          <ShieldCheck className="h-4 w-4 text-low" />
        </span>
        <div className="mr-auto">
          <h3 className="text-sm font-semibold text-foreground">Deterministic decision</h3>
          <p className="text-xs text-muted-foreground">The close or escalate authority</p>
        </div>
        {/* Routing authority, not the closer: a person may still have closed the case
            (shown under "Decided by"), so the badge never reads as a contradiction. */}
        <Badge variant="success" className="gap-1" title="The deterministic case policy routed this case">
          <Lock className="h-3 w-3" />
          Routed by <span className="font-mono">case_manager</span>
        </Badge>
        {escalate ? (
          <Badge variant="high" className="gap-1">
            <AlertTriangle className="h-3 w-3" />
            Escalate
          </Badge>
        ) : null}
        <AutoClosedBadge
          status={status}
          decisionBy={decisionByRaw}
          objectionWindowExpiresAt={objectionWindow}
          showObjection
        />
        {policyRules.length ? (
          <Badge variant="info" className="gap-1">
            <Lock className="h-3 w-3" />
            Closed by analyst policy
          </Badge>
        ) : null}
      </div>

      {/* An operator's rule-level declaration closed this with NO model call, so the
          usual verdict/confidence story below does not apply. Say so plainly rather
          than showing an empty verdict the reader has to interpret. */}
      {policyRules.length ? (
        <p className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          {`Closed by an operator declaration that ${policyRules.join(', ')} is benign in this
            environment. No investigation ran and no model was called, so there is no verdict
            or confidence to report. Revoke the declaration in Detection & Rules to resume
            investigating this detection.`}
        </p>
      ) : null}

      {/* Why a close leaned on institutional history: auditable and reversible. */}
      {precedent?.qualifies ? (
        <p className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          {`Analyst-confirmed precedent was promoted for this investigation:
            ${precedent.confirmed_false_positive ?? 0} prior confirmed-benign outcome(s) for
            this exact detection rule were supplied to the investigator as evidence. The
            verdict remained the model's and the close/escalate decision remained the
            deterministic policy's.`}
        </p>
      ) : null}

      {/* The precedent facts behind the decision, always (data-visibility R9). */}
      <p className="mt-3 text-xs text-muted-foreground" data-testid="decision-precedent">
        <ExplainTrigger explanation={precedentExplanation(precedent)}>{precedentLine(precedent)}</ExplainTrigger>
      </p>

      {/* ------------------------------------------------ outcome badge row */}
      {/* "Verdict lands": a one-shot scale-settle on mount (never a loop). */}
      <motion.div
        className="mt-3 flex flex-wrap items-center gap-2"
        variants={verdictLandVariants}
        initial="hidden"
        animate="show"
      >
        <VerdictBadge verdict={verdict} />
        <StatusBadge status={status} />
        {typeof confidence === 'number' ? <ConfidenceBadge confidence={confidence} /> : null}
        <Badge variant={decider.isHuman ? 'success' : 'info'} className="gap-1">
          <User className="h-3 w-3" />
          Decided by {decider.isHuman ? decider.text : 'Automated'}
        </Badge>
      </motion.div>

      <p className="mt-3 text-xs text-muted-foreground">
        The close / escalate decision is made by deterministic code against the operator-
        configured auto-close policy, never by raw model output.
      </p>

      {/* --------------------------------------- the exact decide() inputs */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Fact label="Verdict" value={verdict ? humanizeToken(verdict) : DASH} />
        <Fact
          label="Confidence"
          value={typeof confidence === 'number' ? `${Math.round((confidence <= 1 ? confidence * 100 : confidence))}%` : DASH}
        />
        <Fact
          label="Risk score"
          value={typeof riskScore === 'number' ? `${displayScore(riskScore)}/100` : DASH}
        />
        <Fact label="Result" value={status ? humanizeToken(status) : DASH} />
      </div>

      {/* ---------------------------------- the matched AutoClosePolicy clause */}
      {runFailed ? (
        <p
          className="mt-3 rounded-lg border border-border bg-card p-3 text-xs text-foreground/90"
          data-testid="decision-run-failed"
        >
          {FAILED_RUN_SENTENCE} No auto-close policy was evaluated for this run.
        </p>
      ) : thresholds || clause ? (
        <div className="mt-3 rounded-lg border border-border bg-card p-3" data-testid="decision-clause">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            Policy clause evaluated
            <span className="font-normal" data-testid="decision-clause-basis">
              {recordedThresholds
                ? '· as recorded at decision time'
                : "· today's policy: the thresholds were not recorded for this decision"}
            </span>
          </div>
          {codeNote ? (
            /* TRUSTED policy note (our own copy): plain text node. */
            <p className="text-xs text-foreground/90">{codeNote}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                class{' '}
                <span className="font-mono text-foreground">
                  {verdictText ? humanizeToken(verdictText) : clause?.verdict_class ? humanizeToken(clause.verdict_class) : DASH}
                </span>
              </span>
              <span className="text-muted-foreground">
                auto-close{' '}
                <span className={cn('font-medium', autoClosable ? 'text-success' : 'text-high')}>
                  {autoClosable ? 'eligible' : 'off'}
                </span>
              </span>
              {typeof thresholds?.min_confidence === 'number' ? (
                <span className="text-muted-foreground">
                  min-conf <span className="font-mono text-foreground">{thresholds.min_confidence}</span>
                </span>
              ) : null}
              {typeof thresholds?.max_risk_score === 'number' ? (
                <span className="text-muted-foreground">
                  max-risk <span className="font-mono text-foreground">{thresholds.max_risk_score}</span>
                </span>
              ) : null}
            </div>
          )}
          {/* Both auto-close conditions with their numbers (D8), never half of the predicate. */}
          {comparison ? (
            <p className="mt-2 text-xs text-foreground/90" data-testid="decision-conditions">
              {comparisonSentence(comparison)}
            </p>
          ) : null}
          {policyChanged ? (
            <p className="mt-2 text-xs text-warning-text" role="note" data-testid="decision-policy-changed">
              {todayComparison
                ? `The auto-close policy changed since this decision. ${comparisonSentence(todayComparison, 'current')}`
                : 'The auto-close policy changed since this decision. The values above are the ones in force at the time.'}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------ deterministic rationale */}
      {rationaleText ? (
        /* Controlled deterministic prose: plain text (#9). */
        <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/90">{rationaleText}</p>
      ) : null}

      {/* ------------------------------------------------- objection window */}
      {objectionWindow && !autoClosed ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Objection window open until {formatTimestamp(objectionWindow)}.
        </p>
      ) : null}
    </section>
  );
};

export default DecisionCard;
