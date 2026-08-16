/**
 * DecisionCard — the SINGLE, most-prominent, pinned deterministic-decision card
 * (Round-7 #9a / DESIGN_DIRECTION "3-lane separation").
 *
 * This is the DETERMINISTIC DECISION lane made visible: the authority for whether a
 * case closes / escalates is `case_manager.decide()` (#3), evaluated against the
 * operator-configured AutoClosePolicy — never raw model output. This card pins that
 * result at the end of the case story: the verdict / status / confidence inputs, WHO
 * the recorded decider was (a human analyst vs the Automated pipeline), the exact
 * matched policy clause (thresholds `decide()` compared against), the deterministic
 * rationale string, and the FP objection window when one is pending.
 *
 * The exact `policy_clause` is read off the terminal `decision` TraceSpan in the
 * `timeline` prop (its payload_ref) via the shared `decisionPayload()` helper — the
 * clause does not live on the `Case` or the rationale. When the timeline is absent
 * the card degrades to the case / rationale fields and hides the clause block.
 *
 * SECURITY (#9): the deterministic rationale + any status/verdict tokens are our own
 * or backend-derived controlled strings, rendered as PLAIN text nodes only — never
 * markup, never an href/CSS value. This card only READS; it never decides or mutates.
 */
import * as React from 'react';
import { AlertTriangle, GitBranch, Lock, ShieldCheck, User } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { DecisionPayload, TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';
import { DASH, formatTimestamp, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import {
  AutoClosedBadge,
  ConfidenceBadge,
  StatusBadge,
  VerdictBadge,
  isAutoClosedByAI,
} from '@/soc/components/badges';
import { decisionPayload } from '@/soc/components/TraceTimeline';
// motion.dev (lazy — part of the CaseDetail chunk, under its MotionProvider): the
// restrained "verdict lands" one-shot that reinforces the #3 "computed, not guessed"
// trust story. Reduced motion (MotionConfig reducedMotion="user") drops the scale,
// keeps the fade — never a loop.
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

/** Who the recorded decider was — a human analyst vs the automated pipeline.
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
  qualifies?: boolean;
  confirmed_false_positive?: number;
  rule_ids?: unknown;
}
function precedentSignal(c: Case): PrecedentSignalView | null {
  const raw = (c as { precedent_signal?: PrecedentSignalView | null }).precedent_signal;
  return raw && typeof raw === 'object' ? raw : null;
}

/* --------------------------------------------------------------- clause row -- */

/** One label/value pair inside the decision-inputs grid. `value` is controlled text. */
const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md border border-border bg-card px-2.5 py-2">
    <div className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
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
export const DecisionCard: React.FC<DecisionCardProps> = ({ c, rationale, timeline }) => {
  const span = terminalDecisionSpan(timeline);
  const d: DecisionPayload = span ? decisionPayload(span) : {};
  const clause = d.policy_clause;

  const verdict = d.verdict ?? rationale?.verdict ?? c.verdict;
  const confidence =
    typeof d.confidence === 'number'
      ? d.confidence
      : typeof rationale?.confidence === 'number'
        ? rationale.confidence
        : c.confidence;
  const riskScore = typeof d.risk_score === 'number' ? d.risk_score : c.risk_score;
  const status = d.decision_status ?? rationale?.status ?? c.status;
  const decisionByRaw = d.decision_by ?? rationale?.decision_by ?? c.decision_by;
  const decider = decidedBy(decisionByRaw);
  const escalate = d.escalate === true;

  // The DETERMINISTIC rationale string (our own / backend copy) — plain text (#9).
  const rationaleText = rationale?.decision_rationale || span?.summary || '';

  // The FP objection deadline: prefer the span payload, else the flat case field.
  const objectionWindow = d.objection_window_expires_at ?? c.objection_window_expires_at ?? null;
  const autoClosed = isAutoClosedByAI(status, decisionByRaw);
  const policyRules = analystPolicyRules(c);
  const precedent = precedentSignal(c);
  const autoClosable = clause?.auto_closable;

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
          <h3 className="text-sm font-semibold tracking-tight text-foreground">Deterministic decision</h3>
          <p className="text-xs text-muted-foreground">The close / escalate authority (#3)</p>
        </div>
        <Badge variant="success" className="gap-1">
          <Lock className="h-3 w-3" />
          case_manager
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

      {/* Why a close leaned on institutional history — auditable and reversible. */}
      {precedent?.qualifies ? (
        <p className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          {`Analyst-confirmed precedent was promoted for this investigation:
            ${precedent.confirmed_false_positive ?? 0} prior confirmed-benign outcome(s) for
            this exact detection rule were supplied to the investigator as evidence. The
            verdict remained the model's and the close/escalate decision remained the
            deterministic policy's.`}
        </p>
      ) : null}

      {/* ------------------------------------------------ outcome badge row */}
      {/* "Verdict lands" — a one-shot scale-settle on mount (never a loop). */}
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
        configured auto-close policy — never by raw model output.
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
          value={typeof riskScore === 'number' ? `${Math.round(riskScore)}/100` : DASH}
        />
        <Fact label="Result" value={status ? humanizeToken(status) : DASH} />
      </div>

      {/* ---------------------------------- the matched AutoClosePolicy clause */}
      {clause ? (
        <div className="mt-3 rounded-lg border border-border bg-card p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            Policy clause evaluated
          </div>
          {clause.note ? (
            /* TRUSTED policy note (our own copy) — plain text node. */
            <p className="text-xs text-foreground/90">{clause.note}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                class{' '}
                <span className="font-mono text-foreground">
                  {clause.verdict_class ? humanizeToken(clause.verdict_class) : DASH}
                </span>
              </span>
              <span className="text-muted-foreground">
                auto-close{' '}
                <span className={cn('font-medium', autoClosable ? 'text-success' : 'text-high')}>
                  {autoClosable ? 'eligible' : 'off'}
                </span>
              </span>
              {typeof clause.min_confidence === 'number' ? (
                <span className="text-muted-foreground">
                  min-conf <span className="font-mono text-foreground">{clause.min_confidence}</span>
                </span>
              ) : null}
              {typeof clause.max_risk_score === 'number' ? (
                <span className="text-muted-foreground">
                  max-risk <span className="font-mono text-foreground">{clause.max_risk_score}</span>
                </span>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {/* ------------------------------------------ deterministic rationale */}
      {rationaleText ? (
        /* Controlled deterministic prose — plain text (#9). */
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
