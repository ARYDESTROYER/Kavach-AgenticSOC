/**
 * Standup — the forward-looking shift handoff (Round 3 / Feature 11 rebuild).
 *
 * LEADS with the ATTENTION QUEUE: the open / NEEDS_HUMAN / escalated cases that need
 * a human THIS shift, urgency-ranked server-side, each row a deep-link that navigates
 * to the Cases list pre-seeded with the case's status filter. Below it: SLA
 * breached/at-risk, per-analyst workload, and period-over-period delta tiles; an
 * ACTION ITEMS panel (CRUD over the cross-shift living queue); and an Acknowledge /
 * sign-off control. The classic model-generated PROSE summary is kept as a secondary
 * block.
 *
 * Data:
 *   - GET /api/standup/report          → the deterministic shift snapshot (primary)
 *   - GET /api/standup (legacy)        → the prose summary (secondary)
 *   - GET/POST/PUT/DELETE action-items → the living attention queue
 *   - POST/GET acknowledge(ments)      → shift sign-off
 *
 * SECURITY (#9): every case title / entity / assignee / action-item title+note /
 * ack note / model-generated summary is UNTRUSTED — rendered strictly as PLAIN text
 * (`whitespace-pre-wrap` / plain spans / escaped badges). Never as HTML.
 */
import * as React from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  Clock3,
  FileText,
  Flame,
  Inbox,
  ListTodo,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Users,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { StandupResponse } from '@/lib/types';
import { DASH, fmtNumber, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';
import { LoadingState } from '@/design-system';
import { useAuth } from '@/soc/auth';
import { useNavigateOptional, type Navigate } from '@/soc/router';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { Stagger } from '@/soc/components/Stagger';
import { RiskBadge, SeverityBadge, StatusBadge } from '@/soc/components/badges';
import { ProvenanceTag, severityProvenance } from '@/soc/components/ProvenanceTag';
import { Can } from '@/soc/components/Can';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/ui/card';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import {
  acknowledgeHandoff,
  createActionItem,
  deleteActionItem,
  fetchStandupReport,
  updateActionItem,
  type ActionItem,
  type AttentionRow,
  type DeltaCell,
  type ShiftAck,
  type StandupReport,
} from './Standup.report.api';

/* ----------------------------------------------------------------- windows - */

const WINDOWS = [
  { id: '24', label: '24h', hours: 24 },
  { id: '168', label: '7d', hours: 168 },
] as const;

/* -------------------------------------------------------- copy button hook - */

/**
 * Copy-to-clipboard hook. Returns `[copied, copy, supported]`; `supported` is false on
 * insecure (plain-http, non-localhost) origins where `navigator.clipboard` is undefined,
 * so the caller can HIDE the Copy control rather than render a dead button that no-ops.
 */
function useCopy(): [boolean, (text: string) => void, boolean] {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function';
  const copy = React.useCallback((text: string) => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip?.writeText) return;
    clip
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard denied — silently no-op */
      });
  }, []);
  return [copied, copy, supported];
}

/* ------------------------------------------------------------- delta labels */

/** Human-readable label + lower-is-better hint for each headline delta metric. */
const DELTA_META: Array<{
  key: string;
  label: string;
  lowerIsBetter: boolean;
}> = [
  { key: 'open', label: 'Open', lowerIsBetter: true },
  { key: 'needs_human', label: 'Needs human', lowerIsBetter: true },
  { key: 'escalated', label: 'Escalated', lowerIsBetter: true },
  { key: 'unassigned', label: 'Unassigned', lowerIsBetter: true },
  { key: 'sla_breached', label: 'SLA breached', lowerIsBetter: true },
];

/* ----------------------------------------------------------------- props --- */

interface StandupProps {
  onNavigate?: Navigate;
}

/* ============================================================== component == */

export default function Standup({ onNavigate }: StandupProps) {
  // Coupling-A: prop wins (host/test); else resolve navigate from the router context.
  // Threaded down to the drill-through cards as `onNavigate` (their internal wiring).
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const { username } = useAuth();
  const [windowId, setWindowId] = React.useState<string>('24');
  const [windowSeeded, setWindowSeeded] = React.useState(false);

  const [report, setReport] = React.useState<StandupReport | null>(null);
  const [prose, setProse] = React.useState<StandupResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const [summaryCopied, copySummary, canCopySummary] = useCopy();

  const requestedHours = React.useMemo(
    () => WINDOWS.find((w) => w.id === windowId)?.hours ?? 24,
    [windowId],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The report is primary; the prose summary is a best-effort secondary block.
      const [rep, pr] = await Promise.allSettled([
        fetchStandupReport(requestedHours),
        api.standup(requestedHours),
      ]);
      if (rep.status === 'fulfilled') {
        setReport(rep.value);
      } else {
        // The report endpoint always returns 200; a rejection is transport-level.
        setError(rep.reason);
      }
      if (pr.status === 'fulfilled') setProse(pr.value);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [requestedHours]);

  // Seed the window from prefs.standup.window_hours once, before first load.
  React.useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const hrs = (s as { prefs?: { standup?: { window_hours?: number } } })?.prefs?.standup
          ?.window_hours;
        if (typeof hrs === 'number') {
          // Pick the closest preset (widen the element type so reassignment is legal).
          let best: (typeof WINDOWS)[number] = WINDOWS[0];
          for (const w of WINDOWS) {
            if (Math.abs(w.hours - hrs) < Math.abs(best.hours - hrs)) best = w;
          }
          setWindowId(best.id);
        }
      })
      .catch(() => {
        /* prefs advisory; keep default */
      })
      .finally(() => {
        if (!cancelled) setWindowSeeded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (windowSeeded) void load();
  }, [load, windowSeeded]);

  // While a window switch is reloading, prefer the freshly-requested window over the
  // stale report so the header label matches the selector (report still holds the old one).
  const windowHours = loading ? requestedHours : (report?.window_hours ?? requestedHours);
  const windowLabel = windowHours >= 168 ? `${Math.round(windowHours / 24)}d` : `${windowHours}h`;
  const windowKey = report?.window ?? '';

  const disabled = report?.enabled === false;
  const degraded = report?.degraded === true;
  const initialLoading = loading && !report;

  const attention = report?.attention_queue ?? [];
  const sla = report?.sla_aging;
  const workload = report?.workload ?? [];
  const deltas = report?.deltas ?? {};

  const summaryText = prose?.summary?.trim() ?? '';
  const hasSummary = summaryText.length > 0;

  // Whether the signed-in user has already acknowledged THIS window.
  const myAck = React.useMemo(() => {
    const acks = report?.acknowledgements ?? [];
    const me = (username ?? 'operator').trim().toLowerCase();
    return acks.find((a) => a.user.trim().toLowerCase() === me);
  }, [report, username]);

  /* --------------------------------------------------------------- actions */
  const actions = (
    <>
      <Select value={windowId} onValueChange={setWindowId} disabled={loading}>
        <SelectTrigger className="h-9 w-[120px]" aria-label="Handoff window">
          <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WINDOWS.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasSummary && canCopySummary ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => copySummary(summaryText)}
          aria-label="Copy the shift summary"
        >
          {summaryCopied ? (
            <ClipboardCheck className="h-4 w-4 text-success" aria-hidden />
          ) : (
            <Clipboard className="h-4 w-4" aria-hidden />
          )}
          {summaryCopied ? 'Copied' : 'Copy summary'}
        </Button>
      ) : null}

      <Button size="sm" onClick={() => void load()} disabled={loading}>
        <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
        Refresh
      </Button>
    </>
  );

  const heroMeta = (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5 text-primary" aria-hidden />
        {windowLabel} window{windowKey ? ` · ${windowKey}` : ''}
      </span>
      {report?.generated_at ? <span>generated {humanizeAge(report.generated_at)}</span> : null}
    </div>
  );

  /* ------------------------------------------------------------------ body */
  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        variant="hero"
        eyebrow="Shift handoff"
        title="Standup"
        description="What needs attention this shift — the urgency-ranked open queue, SLA pressure, and the running action list."
        icon={Inbox}
        actions={
          <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
            <div className="font-mono text-xs text-muted-foreground">{heroMeta}</div>
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          </div>
        }
      >
        {error && !report ? (
          <LoadError
            error={error}
            title="Could not reach the standup service"
            fallback="The backend may be unreachable. Try refreshing in a moment."
            onRetry={() => void load()}
          />
        ) : initialLoading ? null : disabled ? null : (
          <div className="space-y-3">
            {degraded ? (
              <Alert variant="warning">
                <AlertTriangle aria-hidden />
                <AlertTitle>Generated from limited data</AlertTitle>
                <AlertDescription>
                  The shift snapshot ran on a degraded case store; some sections may be empty.
                </AlertDescription>
              </Alert>
            ) : null}
            {/* Headline delta tiles live up top so the shift trend reads at a glance. */}
            <DeltaTiles deltas={deltas} />
          </div>
        )}
      </PageHeader>

      {/* Disabled state — friendly, outside the hero. */}
      {!initialLoading && disabled ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              state="unavailable"
              icon={FileText}
              title="Standup is turned off"
              description="The daily handoff is disabled. Enable it under Settings → Standup to start generating the shift attention queue."
            />
          </CardContent>
        </Card>
      ) : null}

      {initialLoading ? (
        <LoadingState
          label="Loading shift handoff"
          description="Preparing the attention queue, SLA pressure, and action items."
          layout="page"
          shape="page"
        />
      ) : null}

      {error && report ? (
        <LoadError
          error={error}
          title="Could not refresh the standup"
          fallback="The current shift snapshot is still available. Try refreshing again."
          onRetry={() => void load()}
        />
      ) : null}

      {/* Populated content. */}
      {!initialLoading && !disabled && report ? (
        <>
          {/* ATTENTION QUEUE — the lead. */}
          <AttentionQueueCard
            attention={attention}
            evidenceComplete={!degraded}
            onNavigate={navigate}
          />

          {/* SLA + workload. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <SlaCard sla={sla} onNavigate={navigate} />
            <WorkloadCard workload={workload} />
          </div>

          {/* Action items + acknowledge. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <ActionItemsCard
              items={report.action_items}
              onChanged={() => void load()}
            />
            <AcknowledgeCard
              windowKey={windowKey}
              acks={report.acknowledgements}
              myAck={myAck}
              onAcked={() => void load()}
            />
          </div>

          {/* Secondary: the model-generated prose summary. */}
          {hasSummary ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Shift summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* Model-generated prose — rendered strictly as plain text. */}
                <p className="max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {summaryText}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </PageContainer>
  );
}

/* ======================================================== delta tiles ===== */

function DeltaTiles({ deltas }: { deltas: Record<string, DeltaCell> }) {
  const present = DELTA_META.filter((m) => deltas[m.key]);
  if (!present.length) return null;
  return (
    <Stagger className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {present.map((m) => {
        const cell = deltas[m.key];
        const d = cell.delta;
        // A drop in a lower-is-better metric is good (green); rise is bad (red).
        const good = m.lowerIsBetter ? d <= 0 : d >= 0;
        const arrow =
          d === 0 ? null : d > 0 ? (
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />
          );
        // a11y (WCAG 1.4.1): the arrow is aria-hidden and good/bad is otherwise color-only,
        // so announce BOTH direction AND judgement (mirrors KpiTile's delta aria-label).
        const deltaAria = `changed ${d > 0 ? 'up' : 'down'} by ${Math.abs(d)}${
          good ? ', improved' : ', worse'
        }`;
        return (
          <Card key={m.key} className="p-4" data-testid={`delta-tile-${m.key}`}>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {m.label}
            </div>
            <div className="mt-2 flex items-end gap-2">
              <span className="text-2xl font-semibold leading-none tabular-nums text-foreground">
                {fmtNumber(cell.current)}
              </span>
              {d !== 0 ? (
                <span
                  className={cn(
                    'mb-0.5 inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums',
                    good ? 'text-success-text' : 'text-critical-text',
                  )}
                  aria-label={deltaAria}
                >
                  {arrow}
                  <span aria-hidden>{d > 0 ? `+${d}` : d}</span>
                </span>
              ) : (
                <span className="mb-0.5 text-xs text-muted-foreground">±0</span>
              )}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">was {fmtNumber(cell.prior)}</div>
          </Card>
        );
      })}
    </Stagger>
  );
}

/* ==================================================== attention queue ====== */

function AttentionQueueCard({
  attention,
  evidenceComplete,
  onNavigate,
}: {
  attention: AttentionRow[];
  evidenceComplete: boolean;
  onNavigate?: Navigate;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Flame className="h-4 w-4 text-critical" aria-hidden />
          Attention queue
          {evidenceComplete ? (
            <Badge variant="secondary" className="ml-1">
              {fmtNumber(attention.length)}
            </Badge>
          ) : (
            <Badge variant="warning" className="ml-1">
              Limited data
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {attention.length === 0 ? (
          <EmptyState
            compact
            state={evidenceComplete ? 'success' : 'unavailable'}
            icon={evidenceComplete ? CheckCircle2 : AlertTriangle}
            title={evidenceComplete ? 'Nothing needs you right now' : 'Attention queue is incomplete'}
            description={
              evidenceComplete
                ? 'The current window has no open, escalated, or NEEDS_HUMAN case in the attention queue. Continue with planned work and refresh after new cases arrive.'
                : 'The case store returned a degraded snapshot, so an empty queue cannot be verified. Refresh or check source health before treating this shift as clear.'
            }
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border" aria-label="Attention queue">
            {attention.map((row, i) => (
              <AttentionRowItem key={row.case_id || i} row={row} rank={i + 1} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AttentionRowItem({
  row,
  rank,
  onNavigate,
}: {
  row: AttentionRow;
  rank: number;
  onNavigate?: Navigate;
}) {
  // Deep-link to the Cases list pre-seeded with this case's status filter (the wired
  // NavOpts.status seeds the Cases filter; the analyst lands on the right queue).
  const go = onNavigate ? () => onNavigate('cases', { status: row.status }) : undefined;
  const ageHours = row.age_minutes / 60;
  const ageLabel =
    ageHours >= 24
      ? `${Math.floor(ageHours / 24)}d`
      : ageHours >= 1
        ? `${Math.round(ageHours)}h`
        : `${Math.round(row.age_minutes)}m`;
  const display = row.display_id || row.case_number || row.case_id;

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className="w-6 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {go ? (
            <Button
              variant="link"
              onClick={go}
              className="h-auto truncate p-0 font-mono text-sm font-medium"
              aria-label={`Open ${display} in the cases list`}
            >
              {display}
            </Button>
          ) : (
            <span className="truncate font-mono text-sm font-medium text-foreground">{display}</span>
          )}
          {row.assignee ? (
            <span className="truncate text-xs text-muted-foreground">· {row.assignee}</span>
          ) : (
            <span className="text-xs text-muted-foreground">· unassigned</span>
          )}
        </div>
        {/* Case title — UNTRUSTED, plain text. */}
        <p className="mt-0.5 truncate text-sm text-foreground">{row.title || DASH}</p>
        {row.entity ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.entity}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {row.severity_band ? (
          <span className="inline-flex items-center gap-1">
            <SeverityBadge severity={row.severity_band} />
            {/* Severity provenance FLIPS per row, so the tag lives beside the badge —
                the same per-cell contract the Cases list uses. Without it the queue
                would show a band derived from the risk score as if it were the
                source's own severity, right next to that very risk badge. */}
            <ProvenanceTag kind={severityProvenance(row.severity_source)} variant="icon" />
          </span>
        ) : null}
        <StatusBadge status={row.status} />
        <RiskBadge score={row.risk_score} />
        <span
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-muted-foreground"
          title="Age in the queue"
        >
          <Clock3 className="h-3 w-3" aria-hidden />
          {ageLabel}
        </span>
      </div>
    </li>
  );
}

/* ============================================================== SLA ======== */

function SlaCard({
  sla,
  onNavigate,
}: {
  sla: StandupReport['sla_aging'] | undefined;
  onNavigate?: Navigate;
}) {
  const enabled = sla?.enabled;
  const totals = sla?.totals;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-high" aria-hidden />
            SLA pressure
          </span>
          {/* This card is the SHIFT-scoped breach pressure; the full SLA attainment +
              lifecycle timing rollup lives in ONE place — Analytics → Posture (#10). */}
          {onNavigate ? (
            <Button
              variant="link"
              onClick={() => onNavigate('metrics', { tab: 'posture' })}
              className="h-auto p-0 text-xs font-medium"
            >
              Full posture →
            </Button>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <EmptyState
            compact
            state="unavailable"
            icon={ShieldAlert}
            title="SLA tracking is off"
            description="Enable an SLA policy with per-priority response targets in Settings to surface breach pressure here."
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <MiniStat label="Open" value={fmtNumber(totals?.open)} accent="text-info-text" />
              <MiniStat label="Breached" value={fmtNumber(totals?.breached)} accent="text-critical-text" />
              <MiniStat label="At risk" value={fmtNumber(totals?.about_to_breach)} accent="text-high-text" />
            </div>
            {sla.breached.length ? (
              <ul className="flex flex-col divide-y divide-border">
                {sla.breached.slice(0, 6).map((b) => {
                  const go = onNavigate ? () => onNavigate('cases', { status: 'open' }) : undefined;
                  return (
                    <li key={b.case_id} className="flex items-center gap-2 py-2 text-xs">
                      <Badge variant="critical">Breached</Badge>
                      {go ? (
                        <Button
                          variant="link"
                          onClick={go}
                          className="h-auto truncate p-0 font-mono text-xs"
                          aria-label={`Open ${b.display_id || b.case_id}`}
                        >
                          {b.display_id || b.case_id}
                        </Button>
                      ) : (
                        <span className="truncate font-mono text-foreground">
                          {b.display_id || b.case_id}
                        </span>
                      )}
                      <span className="truncate text-muted-foreground">
                        {b.priority_level || '—'}
                      </span>
                      <span className="ml-auto font-mono tabular-nums text-critical-text">
                        +{Math.round(b.overdue_minutes)}m
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No case is currently breaching its response target.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-1 font-mono text-xl font-semibold tabular-nums', accent)}>{value}</div>
    </div>
  );
}

/* ========================================================= workload ======= */

function WorkloadCard({ workload }: { workload: StandupReport['workload'] }) {
  const max = Math.max(1, ...workload.map((w) => w.open));
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4 text-primary" aria-hidden />
          Analyst workload
        </CardTitle>
      </CardHeader>
      <CardContent>
        {workload.length === 0 ? (
          <EmptyState
            compact
            state="no-data"
            icon={Users}
            title="No open workload"
            description="This handoff has no assignee workload rows. Open cases will appear here grouped by assignee."
          />
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Analyst workload">
            {workload.map((w) => {
              const pct = Math.round((w.open / max) * 100);
              return (
                <li key={w.analyst}>
                  <div className="flex items-center justify-between gap-3">
                    {/* Assignee — UNTRUSTED, plain text. */}
                    <span className="truncate text-sm font-medium text-foreground">{w.analyst}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {w.escalated > 0 ? (
                        <Badge variant="high">{fmtNumber(w.escalated)} esc</Badge>
                      ) : null}
                      {w.needs_human > 0 ? (
                        <Badge variant="warning">{fmtNumber(w.needs_human)} NH</Badge>
                      ) : null}
                      <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                        {fmtNumber(w.open)}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, pct)}%` }}
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${w.analyst} open workload`}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ====================================================== action items ====== */

const AI_STATUS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
] as const;

function ActionItemsCard({
  items,
  onChanged,
}: {
  items: ActionItem[];
  onChanged: () => void;
}) {
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const add = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await createActionItem({ title: t });
      setTitle('');
      onChanged();
    } catch {
      /* surfaced by the unchanged state; keep the input for a retry */
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (item: ActionItem, status: string) => {
    try {
      await updateActionItem(item.id, { status });
      onChanged();
    } catch {
      /* no-op; the next load reconciles */
    }
  };

  const remove = async (item: ActionItem) => {
    try {
      await deleteActionItem(item.id);
      onChanged();
    } catch {
      /* no-op */
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <ListTodo className="h-4 w-4 text-medium" aria-hidden />
          Action items
          <Badge variant="secondary" className="ml-1">
            {fmtNumber(items.length)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Can resource="cases" action="write">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a follow-up…"
              maxLength={200}
              aria-label="New action item"
            />
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>
              <Plus className="h-4 w-4" aria-hidden />
              Add
            </Button>
          </form>
        </Can>

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No action items yet. Track cross-shift follow-ups here.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" aria-label="Action items">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  {/* Title + note — UNTRUSTED, plain text. */}
                  <p
                    className={cn(
                      'truncate text-sm',
                      item.status === 'done'
                        ? 'text-muted-foreground line-through'
                        : 'text-foreground',
                    )}
                  >
                    {item.title || DASH}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.owner ? `${item.owner} · ` : ''}
                    {humanizeAge(item.created_at)}
                    {item.note ? ` · ${item.note}` : ''}
                  </p>
                </div>
                <Can
                  resource="cases"
                  action="write"
                  fallback={
                    <Badge variant={item.status === 'done' ? 'success' : 'outline'}>
                      {humanizeToken(item.status)}
                    </Badge>
                  }
                >
                  <Select value={item.status} onValueChange={(v) => void setStatus(item, v)}>
                    <SelectTrigger className="h-8 w-[130px]" aria-label={`Status of ${item.title}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AI_STATUS.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-critical"
                    onClick={() => void remove(item)}
                    aria-label={`Delete action item ${item.title}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </Can>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ====================================================== acknowledge ======= */

function AcknowledgeCard({
  windowKey,
  acks,
  myAck,
  onAcked,
}: {
  windowKey: string;
  acks: ShiftAck[];
  myAck: ShiftAck | undefined;
  onAcked: () => void;
}) {
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const ack = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await acknowledgeHandoff({ window: windowKey || undefined, note: note.trim() || undefined });
      setNote('');
      onAcked();
    } catch {
      /* no-op; reconciled on the next load */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Check className="h-4 w-4 text-success" aria-hidden />
          Handoff sign-off
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {myAck ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-success-text">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <p className="text-sm font-medium">You acknowledged this handoff</p>
              <p className="text-xs opacity-90">{humanizeAge(myAck.at)}</p>
            </div>
          </div>
        ) : (
          <Can
            resource="cases"
            action="write"
            fallback={
              <p className="text-sm text-muted-foreground">
                Acknowledging the handoff requires the case-write grant.
              </p>
            }
          >
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ack();
              }}
            >
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note…"
                maxLength={200}
                aria-label="Acknowledgement note"
              />
              <Button type="submit" size="sm" disabled={busy}>
                <Check className="h-4 w-4" aria-hidden />
                Acknowledge
              </Button>
            </form>
          </Can>
        )}

        {acks.length ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Acknowledged by
            </p>
            <ul className="flex flex-col gap-1.5" aria-label="Acknowledgements">
              {acks.slice(0, 8).map((a, i) => (
                <li key={`${a.user}-${a.at}-${i}`} className="flex items-center gap-2 text-sm">
                  <Badge variant="success">
                    {/* Username — plain text. */}
                    {a.user || 'operator'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{humanizeAge(a.at)}</span>
                  {a.note ? (
                    <span className="truncate text-xs text-muted-foreground">· {a.note}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No one has acknowledged this window yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
