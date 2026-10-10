/**
 * Approvals — the human-in-the-loop queue for agent-drafted proposals.
 *
 * The agent parks governed suppression, durable-memory, threshold-tuning, and
 * acknowledgement-only automation reviews here for an operator decision.
 * The deterministic, operator-controlled case-decision spine stays intact:
 * Approvals can never change decide() or make model output authoritative.
 *
 * UNTRUSTED-safe: a proposal's `payload` (field / value / text) and `rationale`
 * derive from log events, so they render as plain text / <CodeBlock> /
 * <InlineCode> — never as markup.
 */
import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ClipboardCheck,
  Flag,
  FolderClosed,
  Gauge,
  Info,
  Layers,
  Link2,
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
  DASH,
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
import { Card } from '@/ui/card';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Checkbox } from '@/ui/checkbox';
import { Switch } from '@/ui/switch';
import { LoadingState } from '@/design-system';
import { Separator } from '@/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { ControlBar } from '@/soc/components/ControlBar';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { InlineCode } from '@/soc/components/CodeBlock';
import { useCan } from '@/soc/components/Can';
import { useNavigateOptional, type Navigate } from '@/soc/router';
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

/** A stable "source / rule" group label for a proposal (UNTRUSTED-safe plain text). */
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
  if (band === 'suppression') return 'Suppression approved — it is now live.';
  if (band === 'memory') return 'Memory approved — it is now trusted and active.';
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
    if (e.status === 403) return 'Approving requires admin access — you are not authorised.';
    if (e.status === 404) return 'This proposal no longer exists (it may have been decided already).';
    if (e.status === 409) {
      return e.message.toLowerCase().includes('applying')
        ? 'This approval is already in progress. Wait briefly, refresh, then resume if needed.'
        : 'This proposal was already decided. Refresh to see its current state.';
    }
    return e.message;
  }
  return e instanceof Error ? e.message : 'Action failed.';
}

/* ------------------------------------------------------------ small badges -- */

function ConfidencePill({ confidence }: { confidence?: number }) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  const variant: 'success' | 'warning' | 'low' =
    pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'low';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant}>
          <Gauge className="h-3 w-3" aria-hidden />
          {fmtPercent(confidence)} conf
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

/* ------------------------------------------------------------ proposal card -- */

interface ProposalCardProps {
  proposal: Proposal;
  /** This card's own decision is in flight (drives the "Working…" label). */
  busy: boolean;
  /** ANY decision (this or another card / bulk) is in flight — disables the actions
   *  so a click on a second card is never a silent no-op behind the page-level guard. */
  locked: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onApprove: (p: Proposal) => void;
  onReject: (p: Proposal) => void;
  onOpenCase?: (caseId: string) => void;
}

function ProposalCard({
  proposal,
  busy,
  locked,
  selected,
  onToggleSelect,
  onApprove,
  onReject,
  onOpenCase,
}: ProposalCardProps) {
  const band = kindBand(proposal.kind);
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

  const accentClass =
    band === 'suppression'
      ? 'before:bg-warning'
      : band === 'memory'
      ? 'before:bg-info'
      : band === 'tuning'
      ? 'before:bg-warning'
      : band === 'automation_ack'
      ? 'before:bg-info'
      : 'before:bg-primary';

  const approveTip =
    band === 'suppression'
      ? 'Approving makes this suppression rule LIVE. Privileged action — the server enforces admin access.'
      : band === 'memory'
        ? 'Approving saves this as a trusted durable memory. The server enforces the proposal approval grant.'
        : band === 'tuning' && tuning.action === 'apply_change'
          ? 'Approving validates the live value again, then applies only this bounded detection-volume change. Case decisions are unchanged.'
          : band === 'tuning'
            ? 'Approving acknowledges this review item only. It does not change a threshold or case decision.'
            : band === 'automation_ack'
              ? 'Acknowledging records the operator review only. It does not change configuration, Memory, suppression, or case state.'
            : 'The server validates and applies this proposal according to its type.';

  return (
    <Card
      className={cn(
        'relative overflow-hidden p-6 transition-colors hover:border-primary/35',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[""]',
        accentClass,
        selected && 'ring-1 ring-primary',
      )}
    >
      {/* header row */}
      <div className="flex flex-wrap items-center gap-2 pl-3">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(proposal.id)}
          aria-label="Select this proposal for a bulk action"
          disabled={busy}
        />
        <KindBadge kind={proposal.kind} />
        <ConfidencePill confidence={proposal.confidence} />
        {decided || applying ? (
          <Badge variant={proposal.status?.toLowerCase() === 'approved' ? 'success' : 'secondary'}>
            {humanizeToken(proposal.status)}
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground" title={formatTimestamp(proposal.created_at)}>
          drafted {humanizeAge(proposal.created_at)}
          {proposal.created_by ? ` · by ${proposal.created_by}` : ''}
        </span>
        {proposal.expires_at ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline">
                <Clock className="h-3 w-3" aria-hidden />
                expires {humanizeUntil(proposal.expires_at)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Expires {formatTimestamp(proposal.expires_at)}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {/* the candidate rule / fact (UNTRUSTED → InlineCode / plain text) */}
      <div className="mt-4 pl-3">
        {band === 'suppression' ? (
          <div>
            <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Candidate suppression rule
            </div>
            <div className="mt-1.5">
              <InlineCode>
                {asText(sup.field) || '(field)'} == {asText(sup.value) || '(value)'}
              </InlineCode>
            </div>
            {sup.reason ? (
              <p className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                <span className="text-muted-foreground">Reason: </span>
                {asText(sup.reason)}
              </p>
            ) : null}
          </div>
        ) : band === 'memory' ? (
          <div>
            <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Candidate memory
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {asText(mem.text)}
            </p>
            {mem.category ? (
              <Badge variant="outline" className="mt-2.5">
                <FolderClosed className="h-3 w-3" aria-hidden />
                {humanizeToken(asText(mem.category))}
              </Badge>
            ) : null}
          </div>
        ) : band === 'tuning' ? (
          <div className="space-y-4">
            <div>
              <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {tuningActionLabel(tuning)}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
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
                <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Why this needs attention
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {asText(tuning.reason)}
                </p>
              </div>
            ) : null}

            {tuning.recommended_action ? (
              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Recommended action
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {asText(tuning.recommended_action)}
                </p>
              </div>
            ) : null}

            <div className="grid gap-3 border-t border-border/70 pt-3 sm:grid-cols-3">
              <div>
                <div className="text-2xs uppercase tracking-wider text-muted-foreground">Analyst labels</div>
                <div className="mt-1 font-mono text-sm tabular-nums text-foreground">
                  {fmtNumber(tuning.analyst_samples ?? 0)}
                </div>
              </div>
              <div>
                <div className="text-2xs uppercase tracking-wider text-muted-foreground">Confirmed FP / TP</div>
                <div className="mt-1 font-mono text-sm tabular-nums text-foreground">
                  {fmtNumber(tuning.confirmed_false_positives ?? 0)} / {fmtNumber(tuning.confirmed_true_positives ?? 0)}
                </div>
              </div>
              <div>
                <div className="text-2xs uppercase tracking-wider text-muted-foreground">Unconfirmed cases</div>
                <div className="mt-1 font-mono text-sm tabular-nums text-foreground">
                  {fmtNumber(tuning.unconfirmed_cases ?? 0)}
                </div>
              </div>
            </div>
          </div>
        ) : band === 'automation_ack' ? (
          <div>
            <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Operator acknowledgement
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {ack.rule_id ? <InlineCode>{asText(ack.rule_id)}</InlineCode> : null}
              {ack.requested_kind ? (
                <Badge variant="outline">Requested {humanizeToken(asText(ack.requested_kind))}</Badge>
              ) : null}
            </div>
            <p className="mt-2.5 text-sm leading-relaxed text-foreground">
              This checkpoint asks an operator to confirm review only. Acknowledging it does not
              change a setting, create Memory, add suppression, or move the case.
            </p>
          </div>
        ) : (
          // Unknown kind: render the payload defensively as plain text so we never
          // drop a proposal (and never inject markup).
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {asText(proposal.payload)}
          </p>
        )}
      </div>

      {/* rationale (UNTRUSTED → plain text) */}
      {proposal.rationale ? (
        <div className="mt-4 pl-3">
          <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Why the agent drafted this
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {asText(proposal.rationale)}
          </p>
        </div>
      ) : null}

      {proposal.approval_error ? (
        <Alert variant="destructive" className="mt-4 ml-3">
          <AlertTriangle aria-hidden />
          <AlertTitle>
            Previous {decisionIntent === 'reject' ? 'rejection' : 'approval'} attempt did not complete
          </AlertTitle>
          <AlertDescription>
            {asText(proposal.approval_error)} Review the item, then retry.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* linked source case(s) */}
      {cases.length ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 pl-3">
          <span className="text-xs text-muted-foreground">
            Source {cases.length === 1 ? 'case' : 'cases'}:
          </span>
          {cases.map((cid) =>
            onOpenCase ? (
              <button
                key={cid}
                type="button"
                onClick={() => onOpenCase(cid)}
                className="rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open case ${cid}`}
              >
                <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                  <Link2 className="h-3 w-3" aria-hidden />
                  {cid}
                </Badge>
              </button>
            ) : (
              <Badge variant="outline" key={cid}>
                <Link2 className="h-3 w-3" aria-hidden />
                {cid}
              </Badge>
            ),
          )}
        </div>
      ) : null}

      <Separator className="my-4" />

      {/* actions — Approve is always shown enabled; the server enforces the
          privileged check and a 403 surfaces inline (see the page Alert). The
          per-action detail lives on the Approve button's own tooltip, not a
          misleading padlock that reads as "disabled". */}
      <div className="flex flex-wrap items-center justify-end gap-2 pl-3">
        <Button
          variant="ghost"
          size="sm"
          className="text-critical hover:bg-critical/10 hover:text-critical"
          onClick={() => onReject(proposal)}
          disabled={busy || locked || decided || rejectionLocked || (applying && decisionIntent !== 'reject')}
        >
          <X className="h-4 w-4" aria-hidden />
          {applying && decisionIntent === 'reject' ? 'Resume rejection' : decisionIntent === 'reject' ? 'Retry rejection' : 'Reject'}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
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
    </Card>
  );
}

/* -------------------------------------------------------------------- page -- */

type StatusFilter = 'pending' | 'all';

export interface ApprovalsProps {
  onNavigate?: Navigate;
}

export default function Approvals({ onNavigate }: ApprovalsProps) {
  // Coupling-A: prop wins (host/test); else resolve navigate from the router context.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const canReadTuning = useCan('automation', 'read');
  const [proposals, setProposals] = React.useState<Proposal[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('pending');
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);

  const openCase = React.useCallback(
    (caseId: string) => navigate('cases', { caseId }),
    [navigate],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProposals(statusFilter === 'all' ? undefined : 'pending');
      setProposals(res.proposals ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The count badge tracks pending proposals regardless of the active filter.
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

  // Keep selection in sync with the currently-loaded proposals.
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
          kind === 'approve'
            ? await api.approveProposal(proposal.id)
            : await api.rejectProposal(proposal.id);
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

  // Decide every selected proposal sequentially — each call is still individually
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
          const updated =
            kind === 'approve' ? await api.approveProposal(p.id) : await api.rejectProposal(p.id);
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

  // Group the visible proposals by source/rule when group-by is on.
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

  const renderCard = (p: Proposal) => (
    <ProposalCard
      key={p.id}
      proposal={p}
      busy={busyId === p.id || bulkBusy}
      locked={busyId !== null || bulkBusy}
      selected={selected.has(p.id)}
      onToggleSelect={toggleSelect}
      onApprove={(pr) => void decide(pr, 'approve')}
      onReject={(pr) => void decide(pr, 'reject')}
      onOpenCase={openCase}
    />
  );

  /* ---- filter / refresh toolbar ---- */
  const headerActions = (
    <>
      {pendingCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="warning">
              <Flag className="h-3 w-3" aria-hidden />
              {fmtNumber(pendingCount)} pending
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Pending proposals awaiting a decision</TooltipContent>
        </Tooltip>
      ) : null}
      <SegmentedControl<StatusFilter>
        aria-label="Filter by status"
        size="sm"
        value={statusFilter}
        onValueChange={setStatusFilter}
        options={[
          { value: 'pending', label: 'Pending' },
          { value: 'all', label: 'All' },
        ]}
      />
      <RefreshButton onClick={() => void load()} refreshing={loading} />
    </>
  );

  /* ---- body ---- */
  let body: React.ReactNode;
  if (error) {
    body = (
      <LoadError
        error={error}
        title="Couldn't load proposals"
        onRetry={() => void load()}
      />
    );
  } else if (loading && proposals.length === 0) {
    body = (
      <LoadingState
        layout="panel"
        shape="panel"
        label="Loading approvals"
        description="Preparing pending proposals and decision controls."
      />
    );
  } else if (proposals.length === 0) {
    body = (
      <EmptyState
        icon={Flag}
        title={statusFilter === 'pending' ? 'No pending proposals' : 'No proposals yet'}
        description={
          statusFilter === 'pending'
            ? 'Nothing currently requires sign-off. Tuning proposals appear only when analyst-confirmed outcomes support a bounded change or when more human evidence is required; model verdicts and auto-closed cases do not count as confirmation.'
            : 'No proposal history exists yet. Suppressions, durable memories, evidence-grounded tuning changes, and automation reviews appear here before an operator decision.'
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
    );
  } else if (groups) {
    body = (
      <div className="flex flex-col gap-6">
        {groups.map(([label, rows]) => (
          <div key={label}>
            <div className="mb-3 flex items-center gap-2">
              <Badge variant="info">
                <Layers className="h-3 w-3" aria-hidden />
                {label}
              </Badge>
              <span className="text-xs tabular-nums text-muted-foreground">
                {fmtNumber(rows.length)} proposal{rows.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex flex-col gap-4">{rows.map(renderCard)}</div>
          </div>
        ))}
      </div>
    );
  } else {
    body = <div className="flex flex-col gap-4">{proposals.map(renderCard)}</div>;
  }

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        variant="dense"
        icon={Flag}
        breadcrumb={[{ label: 'Automation' }, { label: 'Approvals' }]}
        title="Approvals"
        description="Human review for suppression rules, durable memories, evidence-grounded tuning changes, and automation acknowledgements."
      />

      <ControlBar
        title="Review queue"
        meta="Filter and refresh proposals before making a governed decision."
        controls={headerActions}
        label="Approval queue controls"
      />

      <Alert>
        <Info aria-hidden />
        <AlertTitle>Every pending item requires an explicit decision</AlertTitle>
        <AlertDescription>
          <p className="leading-relaxed">
            These are <strong>evidence-backed recommendations</strong>. An apply proposal changes only
            the bounded setting shown on its card; evidence and history proposals are
            acknowledgement-only. Generic automation reviews also acknowledge only; they never
            create trusted Memory. The server enforces the <strong>proposal approval</strong> grant,
            and deterministic close/escalate logic is never changed here.
          </p>
        </AlertDescription>
      </Alert>

      {/* section header + group toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {statusFilter === 'pending' ? 'Pending proposals' : 'All proposals'}
          </h2>
          <span className="text-sm tabular-nums text-muted-foreground">
            {loading ? 'Loading…' : `${fmtNumber(proposals.length)} shown`}
          </span>
        </div>
        {proposals.length > 0 ? (
          // Not a <label>: a native label does not forward clicks to a Radix
          // Switch (a <button role="switch">); the Switch is self-labeled via
          // aria-label. A <div> keeps the layout/behavior identical.
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={groupBy} onCheckedChange={setGroupBy} aria-label="Group by source or rule" />
            Group by source / rule
          </div>
        ) : null}
      </div>

      {/* sticky bulk-action bar — pin flush BELOW the app header (matches the
          PageHeader/FilterBar convention) so it isn't drawn behind the z-30 top bar. */}
      {selected.size > 0 ? (
        <div
          role="region"
          aria-label="Bulk approval actions"
          // Floating chrome over the scrolling queue: the ONE Console material (solid
          // under reduced transparency or increased contrast), never a page-local blur.
          className={cn(
            'sticky top-[var(--header-h)] z-20 flex flex-wrap items-center gap-2 border-y border-primary/30 px-3 py-2 shadow-sm',
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
            className="text-critical hover:bg-critical/10 hover:text-critical"
            onClick={() => void decideSelected('reject')}
            disabled={bulkBusy}
          >
            <X className="h-4 w-4" aria-hidden />
            Reject selected
          </Button>
          <Button size="sm" onClick={() => void decideSelected('approve')} disabled={bulkBusy}>
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {bulkBusy ? 'Working…' : 'Approve / acknowledge selected'}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>Could not complete that action</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      {body}

      <Separator />
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        A suppression rule only suppresses future matching alerts once approved; a memory only
        becomes trusted once approved; and a tuning change is revalidated against the live value
        before application. Rejected proposals are retained in history but never materialised.
        Automation acknowledgements record review only and materialise nothing.
        Proposal fields, values and rationale are rendered as plain text. {DASH}
      </p>
    </PageContainer>
  );
}
