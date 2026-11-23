/**
 * CaseDetail: shared contracts, tone maps, action model, and small presentational
 * building blocks used by every panel (Coupling-D split).
 *
 * This module is behavior-preserving: it lifts the pieces that were previously
 * top-level in `CaseDetail.tsx` VERBATIM so the orchestrator + panels can import them
 * from one place. Nothing here fetches, decides, or mutates a case.
 *
 * SECURITY (#9): the small components below render case-derived text (labels, values,
 * tags) as PLAIN text nodes only: never markup, never an href/CSS value.
 * #3: the action model here is pure metadata; the close/escalate decision is still
 * made server-side by `decide()`. `close_disposition` maps to the EXISTING `close`
 * verb via `wireAction`: this module never invents a backend verb.
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
 * THE analyst-comment disclosure: shown wherever a note the analyst writes on a
 * close/confirm-FP or an AI grading is carried into `index_resolved_case`.
 *
 * Why this label exists: a comment written here is embedded into the resolved-case
 * precedent chunk and is read back by the investigator on every future retrieval that
 * matches. In production an ordinary operational aside ("Backfill: confirming agent
 * FALSE_POSITIVE disposition…") became durable evidence and quietly depressed
 * investigator confidence just under the auto-close bar, so nothing closed. The text
 * was well-formed (its MEANING was the problem) so sanitising could never have caught
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
  | 'assignee'
  | 'priority'
  | 'disposition'
  | 'reason'
  // Round 15 (SPEC D4.2): what the person did about the case, from the fixed vocabulary
  // (`ACTIONS_TAKEN_OPTIONS`). Optional; stored on the history entry and the audit row.
  | 'actions_taken'
  // Round-7 #10 (feedback-into-close): when present, the confirm dialog renders the
  // collapsed "Rate the AI (optional)" disclosure (Round 15, D4.4). It carries NO wire
  // payload: the grading is POSTed as a SEPARATE `caseFeedback` call in `runAction`, so
  // the deterministic close (`decide()`) is untouched (#3).
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
 * hand: `as const satisfies` rejects a value that is not in the union, and
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

/** The "actions taken" vocabulary, straight off the generated OpenAPI schema. */
export type WireActionTaken = NonNullable<components['schemas']['CaseAction']['actions_taken']>[number];

/**
 * What a person did about a case (Round 15, SPEC D4.2), in the order the close dialog
 * offers them. The words match the backend's `constants.CASE_ACTIONS_TAKEN_LABELS` (the
 * case Markdown export) so a person reads the same phrase everywhere. Pinned to the
 * generated schema like {@link DISPOSITION_OPTIONS}: `satisfies` refuses a value the
 * server does not accept, and {@link ActionsTakenCoverage} fails `tsc --noEmit` when the
 * server gains one this list does not offer.
 */
export const ACTIONS_TAKEN_OPTIONS = [
  { value: 'no_action_needed', text: 'No action needed' },
  { value: 'blocked_indicator', text: 'Blocked an indicator' },
  { value: 'isolated_host', text: 'Isolated a host' },
  { value: 'disabled_account', text: 'Disabled an account' },
  { value: 'reset_credentials', text: 'Reset credentials' },
  { value: 'removed_malware', text: 'Removed malware' },
  { value: 'patched_or_hardened', text: 'Patched or hardened' },
  { value: 'notified_owner', text: 'Notified the owner' },
  { value: 'escalated_externally', text: 'Escalated outside the SOC' },
  { value: 'tuned_detection', text: 'Tuned the detection' },
  { value: 'other', text: 'Other' },
] as const satisfies ReadonlyArray<{ value: WireActionTaken; text: string }>;

/** Compile-time drift guard for {@link ACTIONS_TAKEN_OPTIONS}. */
export type ActionsTakenCoverage = MustBeNever<
  Exclude<WireActionTaken, (typeof ACTIONS_TAKEN_OPTIONS)[number]['value']>
>;

/** At most this many actions on one lifecycle action (`constants.CASE_ACTIONS_TAKEN_MAX`). */
export const ACTIONS_TAKEN_MAX = 8;

/** The words for one recorded action (an unknown stored value is shown as written). */
export function actionTakenWords(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) return '';
  return ACTIONS_TAKEN_OPTIONS.find((option) => option.value === token)?.text ?? token;
}

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
  // `close` verb with a `disposition`: the backend still runs decide()/apply()
  // (#3). Replaces the separate close / confirm-FP / set-disposition buttons.
  close_disposition: {
    key: 'close_disposition',
    wireAction: 'close',
    label: 'Close case',
    icon: Check,
    variant: 'default',
    confirmTitle: 'Close with a disposition',
    // Round 15 (D4.1): one classification question, then what was done about it.
    confirmBody: 'Say what this case was and what you did about it, then close it.',
    help: 'Pick a disposition and close the case.',
    fields: ['disposition', 'actions_taken', 'grading'],
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
      'Worked to completion and pending final close. Say what this case was and what you did about it.',
    help: 'Resolved: worked to completion, pending final close.',
    // Round 12 (SPEC D15): resolving is a terminal move, so it captures the outcome like
    // a close does: required, opened empty, sent with `disposition_declared` (G1). Round
    // 15 (D4.1, D4.6): the same one question as the close, with no tags; the note is the
    // status reason (the server stores `reason or note`).
    fields: ['disposition', 'actions_taken', 'grading'],
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
      'Record what this case was (true positive, false positive, benign and so on). This does not change its status.',
    help: 'Record the investigative outcome (true/false positive, benign, …).',
    // The server keeps no separate reason for a classification (no status moves), so the
    // note is the one place for why.
    fields: ['disposition', 'grading'],
  },
};

/**
 * The resolution choices of the BULK close (`BulkCloseDialog`, which keeps its shape,
 * Round 15 D4.6). The single-case close dialog no longer asks it: its options overlapped
 * the disposition (D4.1).
 */
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
 * There is no `auto_closed` STATUS in the backend: this is a read-only presentation of
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

/* ------------------------------------------------------------ PanelSection -- */

/**
 * One section of a case tab body (Round 15, SPEC D8.3, D8.5): a 16px heading over its
 * content, divided from the section before it by a hairline. No card, no icon heading,
 * no padding of its own (the tab body owns the one 16 to 24px content rail).
 *
 * `section` names a section a link can scroll to (`data-section`, the retired Timeline and
 * Threat context tabs and the facts rail's Related cases); its heading is then focusable
 * (`data-section-title`, tabIndex -1) so an in-page jump can move focus to it.
 */
export interface PanelSectionProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  /** A scroll target name (`data-section`). */
  section?: string;
  /** Beside the heading: a provenance tag, a count. */
  adornment?: React.ReactNode;
  /** At the end of the heading row: a quiet control. */
  actions?: React.ReactNode;
  /** One muted line under the heading. */
  description?: React.ReactNode;
  testId?: string;
  /** The heading's id (generated when omitted). */
  headingId?: string;
}

export const PanelSection: React.FC<PanelSectionProps> = ({
  title,
  section,
  adornment,
  actions,
  description,
  testId,
  headingId: headingIdProp,
  className,
  children,
  ...rest
}) => {
  const generatedId = React.useId();
  const headingId = headingIdProp ?? generatedId;
  return (
    <section
      {...rest}
      data-section={section}
      data-testid={testId}
      aria-labelledby={headingId}
      className={cn('space-y-3 border-t border-border/60 pt-6 first:border-t-0 first:pt-0', className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2
            id={headingId}
            data-section-title={section ? '' : undefined}
            tabIndex={section ? -1 : undefined}
            className="rounded-sm text-base font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </h2>
          {adornment}
        </div>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {description ? <p className="-mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  );
};
