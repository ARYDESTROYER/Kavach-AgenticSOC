/**
 * Approvals: the human-in-the-loop queue for agent-drafted proposals.
 *
 * The agent parks governed suppression, durable-memory, threshold-tuning and
 * acknowledgement-only automation reviews here for an operator decision. The
 * deterministic, operator-controlled case-decision spine stays intact: Approvals can
 * never change decide() or make model output authoritative.
 *
 * Round 14 (SPEC §4.9.4, ui-audit AP1 to AP4): the Overview's grammar. The page header
 * is the title, a help tip (which now holds the always-on explanation callout and the
 * old footer) and the pending count with an icon Refresh. The queue is one panel whose
 * rows are the proposals (no card per proposal, no coloured accent bar), with sentence
 * case labels. A source case is named by its case number, and the automation's default
 * rationale ("... (verdict=NEEDS_HUMAN, risk=62.0) ...") reads as plain words.
 *
 * UNTRUSTED-safe: a proposal's `payload` (field, value, text) and `rationale` derive
 * from log events, so they render as plain text or <InlineCode>, never as markup.
 */
import * as React from 'react';
import {
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Flag,
  FolderClosed,
  Gauge,
  MemoryStick,
  ShieldOff,
  SlidersHorizontal,
  X,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import type {
  AutomationAcknowledgementPayload,
  MemoryPayload,
  Proposal,
  SuppressionPayload,
  TuningProposalPayload,
} from '@/lib/types';
import {
  caseLabel,
  fmtNumber,
  fmtPercent,
  formatTimestamp,
  humanizeAge,
  humanizeUntil,
  humanizeToken,
} from '@/lib/format';
import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { toast } from 'sonner';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Checkbox } from '@/ui/checkbox';
import { Switch } from '@/ui/switch';
import { Callout, LoadingState, Panel, PANEL_PADDING_X } from '@/design-system';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { InlineCode } from '@/soc/components/CodeBlock';
import { useCan } from '@/soc/components/Can';
import { verdictLabel } from '@/soc/components/semantic-labels';
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { useAuth } from '@/soc/auth';
import { useDemo } from '@/soc/demo';
import type { LucideIcon } from 'lucide-react';

/* ----------------------------------------------------------------- helpers -- */

/** Render any source-controlled scalar as a readable, plain string. */
function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

type KindBand = 'suppression' | 'memory' | 'tuning' | 'automation_ack' | 'other';

interface KindMeta {
  label: string;
  icon: LucideIcon;
  /** Badge variant for the kind chip. */
  variant: 'warning' | 'info' | 'secondary';
}

function kindBand(kind?: string): KindBand {
  const t = (kind || '').toLowerCase();
  if (t === 'suppression') return 'suppression';
  if (t === 'memory') return 'memory';
  if (t === 'tuning') return 'tuning';
  if (t === 'automation_ack') return 'automation_ack';
  return 'other';
}

function kindMeta(kind?: string): KindMeta {
  switch (kindBand(kind)) {
    case 'suppression':
      return { label: 'Suppression', icon: ShieldOff, variant: 'warning' };
    case 'memory':
      return { label: 'Memory', icon: MemoryStick, variant: 'info' };
    case 'tuning':
      return { label: 'Tuning change', icon: SlidersHorizontal, variant: 'warning' };
    case 'automation_ack':
      return { label: 'Automation review', icon: ClipboardCheck, variant: 'info' };
    default:
      return { label: kind ? humanizeToken(kind) : 'Proposal', icon: Flag, variant: 'secondary' };
  }
}

/** A stable "source or rule" group label for a proposal (UNTRUSTED-safe plain text). */
function groupKeyOf(p: Proposal): string {
  if (kindBand(p.kind) === 'suppression') {
    const sup = (p.payload || {}) as SuppressionPayload;
    if (sup.field) return `${asText(sup.field)} == ${asText(sup.value) || '∗'}`;
  }
  if (kindBand(p.kind) === 'memory') {
    const mem = (p.payload || {}) as MemoryPayload;
    if (mem.category) return humanizeToken(asText(mem.category));
  }
  if (kindBand(p.kind) === 'tuning') {
    const tuning = (p.payload || {}) as TuningProposalPayload;
    if (tuning.rule_id) return asText(tuning.rule_id);
  }
  if (kindBand(p.kind) === 'automation_ack') {
    const ack = (p.payload || {}) as AutomationAcknowledgementPayload;
    if (ack.rule_id) return `Automation · ${asText(ack.rule_id)}`;
  }
  return kindMeta(p.kind).label;
}

function tuningActionLabel(payload: TuningProposalPayload): string {
  if (payload.action === 'apply_change') return 'Apply bounded change';
  if (payload.action === 'collect_evidence') return 'Acknowledge evidence requirement';
  if (payload.action === 'review_history') return 'Acknowledge historical review';
  return 'Approve recommendation';
}

function approvedToast(proposal: Proposal): string {
  const band = kindBand(proposal.kind);
  if (band === 'suppression') return 'Suppression approved. It is now live.';
  if (band === 'memory') return 'Memory approved. It is now trusted and active.';
  if (band === 'tuning') {
    const payload = (proposal.payload || {}) as TuningProposalPayload;
    return payload.action === 'apply_change'
      ? 'Tuning change approved and applied.'
      : 'Tuning review acknowledged; no threshold was changed.';
  }
  if (band === 'automation_ack') {
    return 'Automation review acknowledged; no setting, Memory, suppression, or case state changed.';
  }
  return 'Proposal approved.';
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'You do not have permission to decide proposals.';
    if (e.status === 404) return 'This proposal no longer exists. It may have been decided already.';
    if (e.status === 409) {
      return e.message.toLowerCase().includes('applying')
        ? 'This approval is already in progress. Wait briefly, refresh, then resume if needed.'
        : 'This proposal was already decided. Refresh to see its current state.';
    }
    return e.message;
  }
  return e instanceof Error ? e.message : 'Action failed.';
}

/**
 * The automation's default rationale (`threshold_automation.py`): "Threshold automation
 * rule '<rule>' requested approval for case <id> (verdict=<VERDICT>, risk=<n>). Review
 * before approving." Matched whole, so an operator-written rationale is never rewritten.
 */
const AUTOMATION_RATIONALE =
  /^Threshold automation rule '([^']*)' requested approval for case (\S+) \(verdict=([^,()]*), risk=([0-9]+(?:\.[0-9]+)?|n\/a)\)\. Review before approving\.$/;

/** A risk score in plain digits: "62.0" reads "62", "61.5" stays "61.5". */
function plainRisk(raw: string): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** A string matched literally inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A proposal's rationale in plain words (SPEC §4.9.4, X11): the automation's default
 * template becomes a sentence naming the case by its number and the verdict and risk in
 * words; any other rationale keeps its text, with each source case id replaced by its
 * case number once that number is known. `labelFor` answers null while a case's number
 * is still being looked up: the template then says "this case", and an operator-written
 * rationale keeps the internal id, so its wording is never changed to a guess. Pure and
 * plain text: the result is rendered as text, never markup.
 */
export function plainRationale(
  text: string,
  labelFor: (caseId: string) => string | null,
  sourceCaseIds: readonly string[] = [],
): string {
  const trimmed = text.trim();
  const match = AUTOMATION_RATIONALE.exec(trimmed);
  if (match) {
    const [, rule, caseId, verdict, risk] = match;
    const verdictText = verdict.trim().toLowerCase() === 'n/a' ? null : verdictLabel(verdict.trim());
    const riskText = plainRisk(risk);
    const facts = [
      verdictText ? `the agent's verdict is ${verdictText}` : 'the case has no verdict yet',
      riskText ? `the risk score is ${riskText}` : null,
    ].filter(Boolean);
    const ruleText = rule.trim() ? `Automation rule ${rule.trim()}` : 'An automation rule';
    return `${ruleText} asked for a review of ${labelFor(caseId) ?? 'this case'}: ${facts.join(' and ')}. Review it before approving.`;
  }
  // Only the ids whose number is known are replaced. One pass, longest id first, so an id
  // that is a prefix of another ("case-1", "case-12") never splits it, and a number just
  // written in is never read again as an id.
  const labels = new Map<string, string>();
  for (const id of sourceCaseIds) {
    if (!id || labels.has(id)) continue;
    const label = labelFor(id);
    if (label && label !== id) labels.set(id, label);
  }
  if (!labels.size) return text;
  const pattern = new RegExp(
    Array.from(labels.keys())
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|'),
    'g',
  );
  return text.replace(pattern, (id) => labels.get(id) ?? id);
}

/* ------------------------------------------------------ case number lookup -- */

/** At most this many distinct source cases are looked up per page load. */
const MAX_CASE_LOOKUPS = 60;
/** Lookups in flight at once. */
const CASE_LOOKUP_BATCH = 4;
/** At most this many identities keep resolved case numbers (a sign-out, a Demo run). */
const MAX_LABEL_SCOPES = 8;

/**
 * The case numbers one identity resolved this session. `labels` holds each answered
 * lookup (`''` when the case has no number of its own, or no longer exists, so the
 * internal id is its name); `failed` holds the ids whose last read failed for another
 * reason (a 5xx, a network loss). A failed id shows its internal id meanwhile and is read
 * again on the page's next load, never cached for the life of the tab.
 */
interface CaseLabelScope {
  labels: Map<string, string>;
  failed: Set<string>;
}

/**
 * Resolved case numbers, kept per identity: the signed-in user and the confirmed Demo run
 * (`caseLabelScopeKey`). A number one identity read under its grant is never shown to
 * another, and a Demo reset, which re-seeds the same case ids with new numbers, starts
 * empty.
 */
const CASE_LABEL_SCOPES = new Map<string, CaseLabelScope>();

function caseLabelScope(key: string): CaseLabelScope {
  let scope = CASE_LABEL_SCOPES.get(key);
  if (!scope) {
    // Bounded: the oldest identity goes first (a Map iterates in insertion order).
    while (CASE_LABEL_SCOPES.size >= MAX_LABEL_SCOPES) {
      const oldest = CASE_LABEL_SCOPES.keys().next().value;
      if (oldest === undefined) break;
      CASE_LABEL_SCOPES.delete(oldest);
    }
    scope = { labels: new Map(), failed: new Set() };
    CASE_LABEL_SCOPES.set(key, scope);
  }
  return scope;
}

/** Forget every resolved case number (tests). */
export function resetCaseLabelsForTests(): void {
  CASE_LABEL_SCOPES.clear();
}

/**
 * The identity resolved case numbers belong to: the signed-in user and the Demo run.
 * Only a confirmed Demo status changes it: the provider's OFF stand-in while a status
 * read is failing is no answer, so the last confirmed run holds (the chat caches' rule).
 */
function useCaseLabelScopeKey(): string {
  const { username } = useAuth();
  const demo = useDemo();
  const confirmed =
    demo.confirmed === false ? null : demo.active ? `demo:${demo.status.run_id ?? ''}` : 'live';
  const [demoKey, setDemoKey] = React.useState(confirmed ?? 'live');
  // Derived from the last confirmed read (React's "state from previous renders" pattern).
  if (confirmed !== null && confirmed !== demoKey) setDemoKey(confirmed);
  return `${username ?? ''}\u0000${demoKey}`;
}

/**
 * The case number for each source case the visible proposals cite. A proposal stores
 * only internal case ids, so each distinct id is read once per identity (bounded and
 * cached); until it answers, the link reads "Case". Without `cases:read` nothing is
 * fetched or read from the cache, and the internal id stays the name (the case could not
 * be opened anyway). `generation` is the page's load count: a lookup that failed is read
 * again on the next load.
 */
function useCaseLabels(
  ids: readonly string[],
  enabled: boolean,
  scopeKey: string,
  generation: number,
): (caseId: string) => string | null {
  const [, setVersion] = React.useState(0);
  const key = ids.join('\n');
  React.useEffect(() => {
    if (!enabled) return undefined;
    const scope = caseLabelScope(scopeKey);
    const missing = Array.from(new Set(ids.filter((id) => id && !scope.labels.has(id)))).slice(0, MAX_CASE_LOOKUPS);
    if (!missing.length) return undefined;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < missing.length && !cancelled; i += CASE_LOOKUP_BATCH) {
        const batch = missing.slice(i, i + CASE_LOOKUP_BATCH);
        const results = await Promise.allSettled(batch.map((id) => api.getCase(id)));
        results.forEach((result, j) => {
          const id = batch[j];
          if (result.status === 'fulfilled') {
            const label = result.value ? caseLabel(result.value) : '';
            scope.labels.set(id, label === id ? '' : label);
            scope.failed.delete(id);
          } else if (result.reason instanceof ApiError && result.reason.status === 404) {
            // The case is gone: its id is the last name it has, for good.
            scope.labels.set(id, '');
            scope.failed.delete(id);
          } else {
            scope.failed.add(id);
          }
        });
        if (!cancelled) setVersion((v) => v + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `key` stands for `ids` (a fresh array on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, scopeKey, generation]);
  return React.useCallback(
    (caseId: string) => {
      // The grant first: a warm cache never names a case for a viewer without it.
      if (!enabled) return caseId;
      const scope = CASE_LABEL_SCOPES.get(scopeKey);
      const known = scope?.labels.get(caseId);
      if (known) return known;
      if (known === '' || scope?.failed.has(caseId)) return caseId;
      return null;
    },
    [enabled, scopeKey],
  );
}

/* ------------------------------------------------------------ small badges -- */

function ConfidencePill({ confidence }: { confidence?: number }) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  const variant: 'success' | 'warning' | 'low' = pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'low';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant}>
          <Gauge className="h-3 w-3" aria-hidden />
          {fmtPercent(confidence)} confidence
        </Badge>
      </TooltipTrigger>
      <TooltipContent>The agent&apos;s confidence in this recommendation</TooltipContent>
    </Tooltip>
  );
}

function KindBadge({ kind }: { kind?: string }) {
  const meta = kindMeta(kind);
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

/** A field label inside a proposal row: sentence case, muted, on the 13px step. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-sm font-medium text-muted-foreground">{children}</div>;
}

/* ------------------------------------------------------------- proposal row -- */

interface ProposalRowProps {
  proposal: Proposal;
  /** This row's own decision is in flight (drives the "Working…" label). */
  busy: boolean;
  /** ANY decision (this or another row, or bulk) is in flight. It disables the actions
   *  so a click on a second row is never a silent no-op behind the page-level guard. */
  locked: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onApprove: (p: Proposal) => void;
  onReject: (p: Proposal) => void;
  onOpenCase?: (caseId: string) => void;
  /** The case number for a source case id; null while it is still being looked up. */
  labelFor: (caseId: string) => string | null;
}

function ProposalRow({
  proposal,
  busy,
  locked,
  selected,
  onToggleSelect,
  onApprove,
  onReject,
  onOpenCase,
  labelFor,
}: ProposalRowProps) {
  const band = kindBand(proposal.kind);
  const meta = kindMeta(proposal.kind);
  const sup = (proposal.payload || {}) as SuppressionPayload;
  const mem = (proposal.payload || {}) as MemoryPayload;
  const tuning = (proposal.payload || {}) as TuningProposalPayload;
  const ack = (proposal.payload || {}) as AutomationAcknowledgementPayload;
  const cases = proposal.source_case_ids || [];
  const status = (proposal.status || '').toLowerCase();
  const applying = status === 'applying';
  const decided = status === 'approved' || status === 'rejected';
  const decisionIntent = proposal.decision_intent;
  const approvalLocked = decisionIntent === 'reject';
  const rejectionLocked = decisionIntent === 'approve';

  const approveTip =
    band === 'suppression'
      ? 'Approving makes this suppression rule live. The server checks that you may approve proposals.'
      : band === 'memory'
        ? 'Approving saves this as a trusted durable memory. The server checks that you may approve proposals.'
        : band === 'tuning' && tuning.action === 'apply_change'
          ? 'Approving checks the live value again, then applies only this bounded detection-volume change. Case decisions are unchanged.'
          : band === 'tuning'
            ? 'Approving acknowledges this review item only. It does not change a threshold or case decision.'
            : band === 'automation_ack'
              ? 'Acknowledging records the operator review only. It does not change configuration, Memory, suppression, or case state.'
              : 'The server validates and applies this proposal according to its type.';

  return (
    <li className={cn('py-4', PANEL_PADDING_X, selected && 'bg-primary/5')} data-selected={selected || undefined}>
      <article aria-label={`${meta.label} proposal`} className="flex flex-col gap-3">
        {/* header row */}
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect(proposal.id)}
            aria-label="Select this proposal for a bulk action"
            disabled={busy}
          />
          <KindBadge kind={proposal.kind} />
          <ConfidencePill confidence={proposal.confidence} />
          {decided || applying ? (
            <Badge variant={status === 'approved' ? 'success' : 'secondary'}>{humanizeToken(proposal.status)}</Badge>
          ) : null}
          <span className="text-sm text-muted-foreground" title={formatTimestamp(proposal.created_at)}>
            Drafted {humanizeAge(proposal.created_at)}
            {proposal.created_by ? ` by ${proposal.created_by}` : ''}
          </span>
          {proposal.expires_at ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline">
                  <Clock className="h-3 w-3" aria-hidden />
                  Expires {humanizeUntil(proposal.expires_at)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Expires {formatTimestamp(proposal.expires_at)}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        {/* the candidate rule or fact (UNTRUSTED: InlineCode or plain text) */}
        {band === 'suppression' ? (
          <div>
            <FieldLabel>Candidate suppression rule</FieldLabel>
            <div className="mt-1">
              <InlineCode>
                {asText(sup.field) || '(field)'} == {asText(sup.value) || '(value)'}
              </InlineCode>
            </div>
            {sup.reason ? (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                <span className="text-muted-foreground">Reason: </span>
                {asText(sup.reason)}
              </p>
            ) : null}
          </div>
        ) : band === 'memory' ? (
          <div>
            <FieldLabel>Candidate memory</FieldLabel>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{asText(mem.text)}</p>
            {mem.category ? (
              <Badge variant="outline" className="mt-2">
                <FolderClosed className="h-3 w-3" aria-hidden />
                {humanizeToken(asText(mem.category))}
              </Badge>
            ) : null}
          </div>
        ) : band === 'tuning' ? (
          <div className="flex flex-col gap-3">
            <div>
              <FieldLabel>{tuningActionLabel(tuning)}</FieldLabel>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                <InlineCode>{asText(tuning.rule_id) || '(rule)'}</InlineCode>
                {tuning.target ? <Badge variant="outline">{humanizeToken(asText(tuning.target))}</Badge> : null}
                {tuning.before !== undefined || tuning.after !== undefined ? (
                  <span className="font-mono tabular-nums text-foreground">
                    {asText(tuning.before)} → {asText(tuning.after)}
                  </span>
                ) : null}
              </div>
            </div>
            {tuning.reason ? (
              <div>
                <FieldLabel>Why this needs attention</FieldLabel>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {asText(tuning.reason)}
                </p>
              </div>
            ) : null}
            {tuning.recommended_action ? (
              <div>
                <FieldLabel>Recommended action</FieldLabel>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {asText(tuning.recommended_action)}
                </p>
              </div>
            ) : null}
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-muted-foreground">Analyst labels</dt>
                <dd className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
                  {fmtNumber(tuning.analyst_samples ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Confirmed FP / TP</dt>
                <dd className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
                  {fmtNumber(tuning.confirmed_false_positives ?? 0)} / {fmtNumber(tuning.confirmed_true_positives ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Unconfirmed cases</dt>
                <dd className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
                  {fmtNumber(tuning.unconfirmed_cases ?? 0)}
                </dd>
              </div>
            </dl>
          </div>
        ) : band === 'automation_ack' ? (
          <div>
            <FieldLabel>Operator acknowledgement</FieldLabel>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {ack.rule_id ? <InlineCode>{asText(ack.rule_id)}</InlineCode> : null}
              {ack.requested_kind ? (
                <Badge variant="outline">Requested {humanizeToken(asText(ack.requested_kind)).toLowerCase()}</Badge>
              ) : null}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-foreground">
              This checkpoint asks an operator to confirm review only. Acknowledging it does not change a setting,
              create Memory, add suppression, or move the case.
            </p>
          </div>
        ) : (
          // Unknown kind: render the payload defensively as plain text so a proposal is
          // never dropped (and no markup is ever injected).
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{asText(proposal.payload)}</p>
        )}

        {/* rationale (UNTRUSTED: plain text) */}
        {proposal.rationale ? (
          <div>
            <FieldLabel>Why the agent drafted this</FieldLabel>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {plainRationale(asText(proposal.rationale), labelFor, cases)}
            </p>
          </div>
        ) : null}

        {proposal.approval_error ? (
          <Callout
            intent="error"
            title={`Previous ${decisionIntent === 'reject' ? 'rejection' : 'approval'} attempt did not complete`}
          >
            {asText(proposal.approval_error)} Review the item, then retry.
          </Callout>
        ) : null}

        {/* linked source case(s), named by case number */}
        {cases.length ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">Source {cases.length === 1 ? 'case' : 'cases'}</span>
            {cases.map((cid) => {
              const label = labelFor(cid);
              return onOpenCase ? (
                <button
                  key={cid}
                  type="button"
                  onClick={() => onOpenCase(cid)}
                  className="rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={label ? `Open case ${label}` : 'Open case'}
                  data-testid="approval-source-case"
                >
                  {label ?? 'Case'}
                </button>
              ) : (
                <span key={cid} className="font-medium text-foreground" data-testid="approval-source-case">
                  {label ?? 'Case'}
                </span>
              );
            })}
          </div>
        ) : null}

        {/* actions: Approve is always shown enabled; the server enforces the privileged
            check and a 403 surfaces inline. The per-action detail lives on the Approve
            button's own tooltip, not a padlock that reads as "disabled". */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* The console's row actions: Reject is a neutral ghost action, red only on
              hover and focus (§4.9.2 RowActions); both are 44px tall on phones (§3.3). */}
          <Button
            variant="ghost"
            size="sm"
            className={REJECT_ACTION}
            onClick={() => onReject(proposal)}
            disabled={busy || locked || decided || rejectionLocked || (applying && decisionIntent !== 'reject')}
          >
            <X className="h-4 w-4" aria-hidden />
            {applying && decisionIntent === 'reject'
              ? 'Resume rejection'
              : decisionIntent === 'reject'
                ? 'Retry rejection'
                : 'Reject'}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                className={PHONE_TARGET}
                onClick={() => onApprove(proposal)}
                disabled={busy || locked || decided || approvalLocked}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                {busy
                  ? 'Working…'
                  : applying
                    ? 'Resume approval'
                    : decisionIntent === 'approve'
                      ? 'Retry approval'
                      : band === 'automation_ack'
                        ? 'Acknowledge'
                        : 'Approve'}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{approveTip}</TooltipContent>
          </Tooltip>
        </div>
      </article>
    </li>
  );
}

/* -------------------------------------------------------------------- page -- */

type StatusFilter = 'pending' | 'all';

/**
 * The page help, two sentences (SPEC §4.9.3). What each kind of approval does in detail
 * is the Help Center's (Automation, "Case automation and proposals").
 */
export const APPROVALS_HELP =
  'Human review for suppression rules, memories, tuning changes and automation acknowledgements. ' +
  'Nothing applies until someone approves it, and the close or escalate decision never changes here.';

/** A primary row action is 44px tall on phones (SPEC §3.3), 32px from 768px. */
const PHONE_TARGET = 'max-md:min-h-11';

/** Reject: neutral at rest, red only on hover and keyboard focus (§4.9.2 RowActions). */
const REJECT_ACTION = cn(
  'text-muted-foreground hover:bg-critical/10 hover:text-critical focus-visible:text-critical',
  PHONE_TARGET,
);

export interface ApprovalsProps {
  onNavigate?: Navigate;
}

export default function Approvals({ onNavigate }: ApprovalsProps) {
  // Coupling-A: prop wins (host/test); else resolve navigate from the router context.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const canReadTuning = useCan('automation', 'read');
  const canReadCases = useCan('cases', 'read');
  const [proposals, setProposals] = React.useState<Proposal[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('pending');
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);

  const openCase = React.useCallback((caseId: string) => navigate('cases', { caseId }), [navigate]);

  const sourceCaseIds = React.useMemo(
    () => Array.from(new Set(proposals.flatMap((p) => p.source_case_ids ?? []))),
    [proposals],
  );
  // Each completed list load is a generation: a case number that failed to resolve is
  // read again on the next one.
  const [loadGeneration, setLoadGeneration] = React.useState(0);
  const labelScopeKey = useCaseLabelScopeKey();
  const labelFor = useCaseLabels(sourceCaseIds, canReadCases, labelScopeKey, loadGeneration);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProposals(statusFilter === 'all' ? undefined : 'pending');
      setProposals(res.proposals ?? []);
      setLoadGeneration((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The header count tracks pending proposals regardless of the active filter.
  const pendingCount = React.useMemo(
    () => proposals.filter((p) => ['pending', 'applying'].includes((p.status || '').toLowerCase())).length,
    [proposals],
  );

  const removeLocal = React.useCallback((id: string) => {
    setProposals((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const upsertLocal = React.useCallback((next: Proposal) => {
    setProposals((prev) => {
      const i = prev.findIndex((p) => p.id === next.id);
      if (i === -1) return prev;
      const copy = prev.slice();
      copy[i] = next;
      return copy;
    });
  }, []);

  // Keep selection in sync with the currently loaded proposals.
  React.useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(proposals.map((p) => p.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (ids.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [proposals]);

  const toggleSelect = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = React.useCallback(() => setSelected(new Set()), []);

  /** Apply a backend decision result to local state. */
  const applyDecision = React.useCallback(
    (p: Proposal, kind: 'approve' | 'reject', updated: Proposal | unknown) => {
      if (statusFilter === 'pending') {
        removeLocal(p.id);
      } else if (updated && typeof updated === 'object' && (updated as Proposal).id) {
        upsertLocal(updated as Proposal);
      } else {
        upsertLocal({ ...p, status: kind === 'approve' ? 'approved' : 'rejected' });
      }
    },
    [statusFilter, removeLocal, upsertLocal],
  );

  const decide = React.useCallback(
    async (proposal: Proposal, kind: 'approve' | 'reject') => {
      if (busyId) return;
      setBusyId(proposal.id);
      setActionError(null);
      try {
        const updated =
          kind === 'approve' ? await api.approveProposal(proposal.id) : await api.rejectProposal(proposal.id);
        applyDecision(proposal, kind, updated);
        const meta = kindMeta(proposal.kind);
        if (kind === 'approve') toast.success(approvedToast(proposal));
        else toast.success(`${meta.label} proposal rejected.`);
      } catch (e) {
        const message = describeError(e);
        setActionError(message);
        toast.error(message);
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) void load();
      } finally {
        setBusyId(null);
      }
    },
    [busyId, applyDecision, load],
  );

  // Decide every selected proposal sequentially. Each call is still individually
  // guarded server-side; nothing here bypasses the per-proposal approval.
  const decideSelected = React.useCallback(
    async (kind: 'approve' | 'reject') => {
      const targets = proposals.filter((p) => selected.has(p.id));
      if (!targets.length || bulkBusy) return;
      setBulkBusy(true);
      setActionError(null);
      let ok = 0;
      let failed = 0;
      for (const p of targets) {
        try {
          const updated = kind === 'approve' ? await api.approveProposal(p.id) : await api.rejectProposal(p.id);
          applyDecision(p, kind, updated);
          ok += 1;
        } catch (e) {
          failed += 1;
          setActionError(describeError(e));
        }
      }
      clearSelection();
      setBulkBusy(false);
      const verb = kind === 'approve' ? 'approved' : 'rejected';
      if (ok) {
        const msg = `${ok} proposal${ok === 1 ? '' : 's'} ${verb}${failed ? ` · ${failed} failed` : ''}.`;
        if (failed) toast.warning(msg);
        else toast.success(msg);
      } else if (failed) {
        toast.error(`All ${failed} action${failed === 1 ? '' : 's'} failed.`);
      }
      if (failed) void load();
    },
    [proposals, selected, bulkBusy, applyDecision, clearSelection, load],
  );

  // Group the visible proposals by source or rule when grouping is on.
  const groups = React.useMemo(() => {
    if (!groupBy) return null;
    const map = new Map<string, Proposal[]>();
    for (const p of proposals) {
      const key = groupKeyOf(p);
      const arr = map.get(key);
      if (arr) arr.push(p);
      else map.set(key, [p]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [proposals, groupBy]);

  const renderRow = (p: Proposal) => (
    <ProposalRow
      key={p.id}
      proposal={p}
      busy={busyId === p.id || bulkBusy}
      locked={busyId !== null || bulkBusy}
      selected={selected.has(p.id)}
      onToggleSelect={toggleSelect}
      onApprove={(pr) => void decide(pr, 'approve')}
      onReject={(pr) => void decide(pr, 'reject')}
      onOpenCase={canReadCases ? openCase : undefined}
      labelFor={labelFor}
    />
  );

  /* ---- the queue's own controls, in its panel's title row (C7) ---- */
  const queueControls = (
    <div role="group" aria-label="Approval queue controls" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <SegmentedControl<StatusFilter>
        aria-label="Show"
        size="sm"
        value={statusFilter}
        onValueChange={setStatusFilter}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'all', label: 'All' },
        ]}
      />
      {proposals.length > 0 ? (
        // Not a <label>: a native label does not forward clicks to a Radix Switch (a
        // <button role="switch">); the Switch is self-labelled via aria-label.
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={groupBy} onCheckedChange={setGroupBy} aria-label="Group by source or rule" />
          Group by source or rule
        </div>
      ) : null}
    </div>
  );

  /* ---- queue body ---- */
  let queueBody: React.ReactNode;
  if (loading && proposals.length === 0) {
    queueBody = (
      <LoadingState
        layout="panel"
        shape="rows"
        shapeRows={3}
        label="Loading approvals"
        description="Preparing pending proposals and decision controls."
      />
    );
  } else if (proposals.length === 0) {
    queueBody = (
      <div className={cn('pb-4 xl:pb-5 3xl:pb-6', PANEL_PADDING_X)}>
        <EmptyState
          compact
          icon={Flag}
          title={statusFilter === 'pending' ? 'No pending proposals' : 'No proposals yet'}
          description={
            statusFilter === 'pending'
              ? 'Nothing needs sign-off. Tuning proposals appear only when analyst-confirmed outcomes support a bounded change or when more human evidence is required; model verdicts and auto-closed cases do not count as confirmation.'
              : 'No proposal history exists yet. Suppressions, durable memories, evidence-grounded tuning changes and automation reviews appear here before an operator decision.'
          }
          action={
            canReadTuning ? (
              <Button variant="outline" size="sm" onClick={() => navigate('tuning')}>
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                Review auto-tuning evidence
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  } else if (groups) {
    queueBody = (
      <div className="flex flex-col">
        {groups.map(([label, rows]) => (
          <section key={label} aria-label={label} className="border-t border-border/70 first:border-t-0">
            <div className={cn('flex flex-wrap items-baseline gap-x-2 pt-3', PANEL_PADDING_X)}>
              <h3 className="min-w-0 break-words text-sm font-semibold text-foreground">{label}</h3>
              <span className="text-sm tabular-nums text-muted-foreground">
                {fmtNumber(rows.length)} proposal{rows.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className="divide-y divide-border/70">{rows.map(renderRow)}</ul>
          </section>
        ))}
      </div>
    );
  } else {
    queueBody = <ul className="divide-y divide-border/70 border-t border-border/70">{proposals.map(renderRow)}</ul>;
  }

  return (
    <PageContainer variant="wide">
      <PageHeader
        title="Approvals"
        help={APPROVALS_HELP}
        controls={
          <>
            <span className="text-sm tabular-nums text-muted-foreground" data-testid="approvals-count">
              {`${fmtNumber(pendingCount)} pending`}
            </span>
            <RefreshButton
              display="icon"
              label="Refresh approvals"
              onClick={() => void load()}
              refreshing={loading}
            />
          </>
        }
      />

      {/* sticky bulk-action bar, pinned flush below the app header so it is never
          drawn behind the z-30 top bar */}
      {selected.size > 0 ? (
        <div
          role="region"
          aria-label="Bulk approval actions"
          // Floating chrome over the scrolling queue: the ONE Console material (solid
          // under reduced transparency or increased contrast), never a page-local blur.
          className={cn(
            'sticky top-[var(--header-h)] z-20 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 px-3 py-2 shadow-sm',
            materialBar,
          )}
        >
          <span className="text-sm font-medium text-foreground">
            <span className="tabular-nums">{fmtNumber(selected.size)}</span> selected
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={clearSelection} disabled={bulkBusy}>
            Clear
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={REJECT_ACTION}
            onClick={() => void decideSelected('reject')}
            disabled={bulkBusy}
          >
            <X className="h-4 w-4" aria-hidden />
            Reject selected
          </Button>
          <Button size="sm" onClick={() => void decideSelected('approve')} disabled={bulkBusy}>
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {bulkBusy ? 'Working…' : 'Approve or acknowledge selected'}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <Callout intent="error" title="Could not complete that action">
          {actionError}
        </Callout>
      ) : null}

      {error ? (
        <LoadError error={error} title="Could not load proposals" onRetry={() => void load()} />
      ) : (
        <Panel
          title={statusFilter === 'pending' ? 'Pending proposals' : 'All proposals'}
          count={loading && proposals.length === 0 ? undefined : proposals.length}
          padding="none"
          actions={queueControls}
          data-testid="approvals-queue"
        >
          {queueBody}
        </Panel>
      )}
    </PageContainer>
  );
}
