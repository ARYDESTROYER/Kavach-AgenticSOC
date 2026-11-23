/**
 * CaseDetail: shared contracts, tone maps, action model, and small presentational
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
} from 'lucide-react';

import type { components } from '@/lib/api-types.gen';
import type { Case } from '@/lib/types';
import { cn } from '@/lib/cn';

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
  'Saved with the resolved case as durable context. The AI reads this note when it investigates similar cases later.';

/** One selectable notification channel in the Notify dialog. */
export interface NotifyChannelOption {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
}

/**
 * The lifecycle verbs the Console offers. Round 15 (D8.7) removed the unused `close` and
 * `confirm_fp` definitions: the one close flow is `close_disposition`. A stored
 * `confirm_fp` history entry (an older Console's verb) is still READ as a classification
 * by the outcome helpers and the facts rail.
 */
export type ActionKind =
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
 *  cases:write. The header gates the primary action and every Take action item with it. */
export const ACTION_PERMISSION: Record<ActionKind, { resource: 'cases'; action: 'close' | 'write' }> = {
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
  /** Button variant for the confirm dialog. */
  variant: 'default' | 'secondary' | 'outline' | 'destructive';
  /** Whether this is the primary action of the current state (filled). */
  fill?: boolean;
  /** The EXISTING backend action verb to POST. Defaults to `key` when unset; the
   *  UI-only `close_disposition` maps here to `'close'` so we never invent a verb. */
  wireAction?: 'close';
  confirmTitle: string;
  confirmBody: string;
  help: string;
  fields: ActionField[];
}

export const ALL_ACTIONS: Record<ActionKind, ActionDef> = {
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
      'Choose the investigative outcome, then close this case. The close/escalate decision is still made by deterministic code. This records your disposition and closes the case.',
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
    confirmBody: 'Return this case to the open queue.',
    help: 'Return a closed or resolved case to the open queue.',
    fields: [],
  },
  acknowledge: {
    key: 'acknowledge',
    label: 'Acknowledge & investigate',
    icon: Eye,
    variant: 'default',
    confirmTitle: 'Acknowledge and start investigating?',
    confirmBody:
      'Take ownership of this case and move it to INVESTIGATING. It stays open and nothing is closed.',
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
    help: 'Pause while awaiting info, a maintenance window or a third party.',
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
    confirmBody:
      'Mark the case resolved: worked to completion and pending final close. Record the outcome you confirmed.',
    help: 'Resolved: worked to completion, pending final close.',
    // Round 12 (SPEC D15): resolving is a terminal move, so it captures the outcome like
    // a close does — required, opened empty, sent with `disposition_declared` (G1).
    fields: ['disposition', 'reason', 'tags', 'grading'],
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
 * The lifecycle action plan for a status (Round 15, SPEC D8.2): ONE primary contextual
 * action in the header and every other verb in the Take action menu, instead of a row of
 * equally weighted buttons.
 *
 *   | Status                              | Primary          | Take action                          |
 *   |-------------------------------------|------------------|--------------------------------------|
 *   | new                                 | Acknowledge      | Close case, Escalate, Mark resolved, Put on hold |
 *   | open, investigating, needs_human    | Close case       | Escalate, Acknowledge, Mark resolved, Put on hold |
 *   | on_hold                             | Resume           | Close case, Mark resolved, Escalate  |
 *   | escalated                           | Mark resolved    | Close case, De-escalate, Put on hold |
 *   | resolved                            | Close case       | Set disposition, Reopen              |
 *   | closed                              | Reopen           | Set disposition                      |
 *
 * The secondary "Close case" button is gone; C still opens the close dialog wherever the
 * plan offers it (it is in Take action). The auto-close review rows of the D8.2 table
 * (Start review as the primary on a pending review, "Review this auto-close" in place of
 * Set disposition) are added where the review is mounted (WP7); the lifecycle verbs here
 * are unchanged by them.
 *
 * Every entry is one of the existing `ALL_ACTIONS` records, so the confirm dialog and
 * `runAction` wire keys are unchanged. The plan mirrors the backend transition guard: a
 * closed case offers no close (only reopen), and a resolved case offers its final close
 * (resolved to closed through `close`, the one forward move out of a terminal status the
 * server allows). Both terminal states keep Set disposition, so an outcome that was never
 * recorded can be recorded without reopening the case.
 */
export interface ActionPlan {
  primary: ActionDef;
  /** Every other verb the status allows, in Take action order. */
  overflow: ActionDef[];
}

export function actionPlanForStatus(status?: string): ActionPlan {
  const s = (status || '').toLowerCase();
  const close = ALL_ACTIONS.close_disposition;

  // Closed: only reopen (and re-classify) is legal, no close.
  if (s === 'closed') {
    return { primary: { ...ALL_ACTIONS.reopen, fill: true }, overflow: [ALL_ACTIONS.set_disposition] };
  }
  if (s === 'resolved') {
    // Resolved is "worked to completion, pending final close": the final close is the
    // primary (the server allows resolved to closed through `close`). Set disposition
    // records or corrects the outcome without closing, e.g. a case resolved before resolve
    // captured one ("outcome not recorded").
    return { primary: { ...close, fill: true }, overflow: [ALL_ACTIONS.set_disposition, ALL_ACTIONS.reopen] };
  }
  if (s === 'on_hold') {
    return { primary: { ...ALL_ACTIONS.resume, fill: true }, overflow: [close, ALL_ACTIONS.resolve, ALL_ACTIONS.escalate] };
  }
  if (s === 'escalated') {
    return { primary: { ...ALL_ACTIONS.resolve, fill: true }, overflow: [close, ALL_ACTIONS.deescalate, ALL_ACTIONS.hold] };
  }
  // New: Acknowledge is the natural first move (it sets INVESTIGATING).
  if (s === 'new' || s === '') {
    return {
      primary: { ...ALL_ACTIONS.acknowledge, fill: true },
      overflow: [close, ALL_ACTIONS.escalate, ALL_ACTIONS.resolve, ALL_ACTIONS.hold],
    };
  }
  // Working states (open / investigating / needs_human): closing with a disposition is the
  // move that ends the work; escalation is one menu item away.
  return {
    primary: { ...close, fill: true },
    overflow: [ALL_ACTIONS.escalate, ALL_ACTIONS.acknowledge, ALL_ACTIONS.resolve, ALL_ACTIONS.hold],
  };
}

/** The close-with-disposition action this plan offers (primary or in Take action), or null. */
export function planCloseAction(plan: ActionPlan): ActionDef | null {
  return [plan.primary, ...plan.overflow].find((action) => action.key === 'close_disposition') ?? null;
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
 * The agent trace's two layouts (`TraceTimeline`, a shared component). Every case panel
 * renders the one Case Manager layout since Round 15 (D8.7); only the trace keeps a
 * second one.
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

/** A severity-ish tone for a verdict or an automation entry. */
export type ScoreTone = 'critical' | 'high' | 'medium' | 'low' | 'info';

/* ------------------------------------------------------------- meta item --- */

/**
 * One quiet label/value pair: a sentence-case muted caption over its value. `value` is
 * UNTRUSTED (plain text node). Names such as a source ("IBM QRadar SIEM") read in the
 * sans face; pass `mono` only for a true identifier.
 */
export const MetaItem: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono = false,
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <span className={cn('text-sm text-foreground', mono && 'font-mono')}>{value}</span>
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
      <h3 className="text-sm font-semibold text-foreground">
        {children}
      </h3>
    </div>
    {actions}
  </div>
);

/* --------------------------------------------------------------- PanelCard -- */

/**
 * The surface a CaseDetail panel section renders in: a top-level page Card at the
 * sanctioned 24px (`padding="md"`) rhythm. Round 15 (D8.5) retires it from the case files
 * as the tab bodies are rebuilt (no Card inside a Panel).
 */
export const PanelCard: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <Card elevation="none" className={cn('p-6', className)} {...props} />;
