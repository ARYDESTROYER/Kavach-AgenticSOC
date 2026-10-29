/**
 * Standup: the forward-looking shift handoff (Round 3 / Feature 11 rebuild).
 *
 * Round 14 (SPEC §4.9, ask 8): the Overview's grammar. The page header is the title, a help
 * tip, the handoff range and one refresh beside the title, and on the right the shift and
 * when the snapshot was generated, with Copy summary. Below it: one KPI strip of the shift's
 * headline counts against the previous window, then modules on the tinted panel, one panel
 * gutter apart:
 *
 *   - the ATTENTION QUEUE (the lead): open, awaiting-analyst and escalated cases ranked by
 *     urgency on the server; the first eight show, the rest behind "Show all";
 *   - SLA pressure (the shift's breaches, each with how far past its target) beside the
 *     analysts' workload;
 *   - the running action items beside the handoff sign-off;
 *   - the model-written shift summary, last.
 *
 * Data:
 *   - GET /api/standup/report          → the deterministic shift snapshot (primary)
 *   - GET /api/standup (legacy)        → the prose summary (secondary)
 *   - GET/POST/PUT/DELETE action-items → the living attention queue
 *   - POST/GET acknowledge(ments)      → shift sign-off
 *
 * SECURITY (#9): every case title, entity, assignee, action-item title and note, sign-off
 * note and the model-written summary is UNTRUSTED: rendered strictly as plain text, never
 * as HTML.
 */
import * as React from 'react';
import { CheckCircle2, Check, Clipboard, ClipboardCheck, FileText, Plus, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import type { StandupResponse } from '@/lib/types';
import { DASH, caseLabel, fmtDuration, fmtNumber, fmtOverage, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Callout, LoadingState, Panel, PANEL_GAP } from '@/design-system';
import { useAuth } from '@/soc/auth';
import { pageHash, useNavigateOptional, type Navigate, type PageId } from '@/soc/router';
import type { NavOpts } from '@/lib/types';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { KpiTile } from '@/soc/components/KpiTile';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { TimeRangePicker, type TimeRange } from '@/soc/components/TimeRangePicker';
import { followLink } from '@/soc/components/nav-shared';
import { RiskBadge, SeverityBadge, StatusBadge } from '@/soc/components/badges';
import { ProvenanceTag, severityProvenance } from '@/soc/components/ProvenanceTag';
import { Can } from '@/soc/components/Can';
import { isSafeCaseId } from '@/soc/case-result-route';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
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

/**
 * The handoff ranges: the last 24 hours (a shift) and the last 7 days (a week), shown with
 * the Overview's range pill. Standup keeps its own two ranges and does not share the
 * Analytics pages' session range: it is a separate destination with its own default from
 * the saved Standup preference. (It deliberately does not import `analytics-shared`: a
 * module shared by Standup and the Analytics pages becomes its own lazy chunk, and every
 * chunk costs the entry bundle a preload-map entry.)
 */
const WINDOWS: ReadonlyArray<{ hours: number; range: TimeRange }> = [
  { hours: 24, range: { from: 'now-24h', to: 'now', label: 'Last 24 hours' } },
  { hours: 168, range: { from: 'now-7d', to: 'now', label: 'Last 7 days' } },
];

const WINDOW_PRESETS: readonly TimeRange[] = WINDOWS.map((w) => w.range);

/** A handoff range inside a sentence: "last 24 hours", "last 7 days". */
export function rangeWords(hours: number): string {
  const preset = WINDOWS.find((w) => w.hours === hours);
  if (preset) return preset.range.label.charAt(0).toLowerCase() + preset.range.label.slice(1);
  if (hours >= 48 && hours % 24 === 0) return `last ${fmtNumber(hours / 24)} days`;
  return `last ${fmtNumber(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** The page header's range control: the Overview pill with the two handoff ranges. */
function HandoffRangePicker({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  const current = WINDOWS.find((w) => w.hours === hours) ?? WINDOWS[0];
  return (
    <TimeRangePicker
      value={current.range}
      presets={WINDOW_PRESETS}
      onChange={(range) => {
        const picked = WINDOWS.find((w) => w.range.from === range.from && w.range.to === range.to);
        if (picked) onChange(picked.hours);
      }}
      size="sm"
      chrome="command"
    />
  );
}

/**
 * A text link to a Console page (SPEC §3.3): an `<a href>`, so a modified click opens a
 * new tab, while a plain click navigates in the app through `navigate`.
 */
function PageLink({
  page,
  opts,
  navigate,
  children,
  className,
  'aria-label': ariaLabel,
}: {
  page: PageId;
  opts?: NavOpts;
  navigate: Navigate;
  children: React.ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <a
      href={pageHash(page, opts)}
      aria-label={ariaLabel}
      onClick={(event) => followLink(event, () => navigate(page, opts))}
      className={cn(
        'rounded-sm font-medium text-primary underline-offset-2 hover:underline',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
        className,
      )}
    >
      {children}
    </a>
  );
}

/** How many attention-queue rows show before "Show all" (the Overview queue's cap). */
const QUEUE_PREVIEW = 8;

/** The page title: the navigation label of `#/standup` (one name per page, D25). */
const PAGE_TITLE = 'Standup';

/** The header help tip (the page explains itself there, never in a line, C8). */
const PAGE_HELP =
  'What needs attention this shift: the ranked open queue, SLA pressure, who holds the ' +
  'open work, and the running action list, against the window before.';

/**
 * The shift a handoff window key names ("2026-10-29/swing" is the swing shift). The
 * server bands shifts by UTC hour: day 06:00 to 14:00, swing 14:00 to 22:00, night
 * otherwise. `null` for a key that names no known shift.
 */
export function shiftName(windowKey: string): { label: string; detail: string } | null {
  const [date, band] = windowKey.split('/');
  const hours: Record<string, string> = {
    day: '06:00 to 14:00 UTC',
    swing: '14:00 to 22:00 UTC',
    night: '22:00 to 06:00 UTC',
  };
  if (!band || !hours[band]) return null;
  const label = `${band.charAt(0).toUpperCase()}${band.slice(1)} shift`;
  return { label, detail: `${label}, ${date ? `${date}, ` : ''}${hours[band]}` };
}

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
        /* clipboard denied: silently no-op */
      });
  }, []);
  return [copied, copy, supported];
}

/* ------------------------------------------------------------- delta labels */

/**
 * The headline counts of the shift, in strip order. Every one is lower-is-better.
 *
 * "Needs human" is the open cases whose VERDICT is Needs human, the figure chat's shift
 * report shows under the same label. The legacy `needs_human` STATUS count is
 * "Awaiting analyst", the console's word for that status (Round 13 close).
 */
const DELTA_META: Array<{ key: string; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'needs_human_verdict', label: 'Needs human' },
  { key: 'needs_human', label: 'Awaiting analyst' },
  { key: 'escalated', label: 'Escalated' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'sla_breached', label: 'SLA breached' },
];

/** A signed change as the strip shows it: "+3", "-2", "±0". */
function signedDelta(delta: number): string {
  if (delta === 0) return '±0';
  return delta > 0 ? `+${fmtNumber(delta)}` : `-${fmtNumber(Math.abs(delta))}`;
}

/* --------------------------------------------------------- generated stamp - */

/** Re-render every `ms` while mounted, so a relative time stays true. */
function useTick(ms: number): void {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/**
 * The header stamp: the shift and how long ago the snapshot was generated ("Swing shift ·
 * Generated 4m ago"), kept current while the page stays open, with the shift's hours in
 * the tooltip. Nothing when neither is known.
 */
export function GeneratedStamp({
  shift,
  generatedAt,
}: {
  shift: { label: string; detail: string } | null;
  generatedAt: string | null | undefined;
}) {
  useTick(30_000);
  const age = generatedAt ? humanizeAge(generatedAt) : '';
  const hasAge = Boolean(age) && age !== DASH;
  if (!shift && !hasAge) return null;
  return (
    <span className="whitespace-nowrap text-sm text-muted-foreground" title={shift?.detail} data-testid="standup-stamp">
      {shift ? shift.label : null}
      {shift && hasAge ? ' · ' : null}
      {hasAge ? `Generated ${age}` : null}
    </span>
  );
}

/* ----------------------------------------------------------------- props --- */

interface StandupProps {
  onNavigate?: Navigate;
}

/* ============================================================== component == */

export default function Standup({ onNavigate }: StandupProps) {
  // A prop wins (host and tests); else navigate comes from the router context. The hook
  // is called unconditionally (rules of hooks), then an explicit prop wins.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const { username } = useAuth();
  const [requestedHours, setRequestedHours] = React.useState<number>(24);
  const [windowSeeded, setWindowSeeded] = React.useState(false);

  const [report, setReport] = React.useState<StandupReport | null>(null);
  // The range the report on screen was read for: a failed read for a newly picked range
  // keeps the previous report, and the page must say which range that is.
  const [reportHours, setReportHours] = React.useState<number | null>(null);
  const [prose, setProse] = React.useState<StandupResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const [summaryCopied, copySummary, canCopySummary] = useCopy();

  // A range change (or a refresh) issues a new read; only the latest may commit, so a
  // slow earlier range can never overwrite the one picked since.
  const requestRef = React.useRef(0);
  const load = React.useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      // The report is primary; the prose summary is a best-effort secondary block.
      const [rep, pr] = await Promise.allSettled([
        fetchStandupReport(requestedHours),
        api.standup(requestedHours),
      ]);
      if (request !== requestRef.current) return;
      if (rep.status === 'fulfilled') {
        setReport(rep.value);
        setReportHours(requestedHours);
      } else {
        // The report endpoint always returns 200; a rejection is transport-level.
        setError(rep.reason);
      }
      // A failed summary read clears the previous one: an older range's summary must
      // never sit (or be copied) under the range picked since.
      setProse(pr.status === 'fulfilled' ? pr.value : null);
    } catch (e) {
      if (request === requestRef.current) setError(e);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [requestedHours]);

  // Seed the window from prefs.standup.window_hours once, before the first load.
  React.useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const hrs = (s as { prefs?: { standup?: { window_hours?: number } } })?.prefs?.standup
          ?.window_hours;
        if (typeof hrs === 'number') {
          // Pick the closest preset.
          let best = WINDOWS[0];
          for (const w of WINDOWS) {
            if (Math.abs(w.hours - hrs) < Math.abs(best.hours - hrs)) best = w;
          }
          setRequestedHours(best.hours);
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

  const windowKey = report?.window ?? '';
  const shift = shiftName(windowKey);

  const disabled = report?.enabled === false;
  const degraded = report?.degraded === true;
  const initialLoading = loading && !report;
  // The report on screen is for another range than the one picked (its read failed, or
  // is still in flight).
  const stale = report !== null && reportHours !== null && reportHours !== requestedHours;

  const summaryText = prose?.summary?.trim() ?? '';
  const hasSummary = summaryText.length > 0;

  // Whether the signed-in user has already acknowledged THIS window.
  const myAck = React.useMemo(() => {
    const acks = report?.acknowledgements ?? [];
    const me = (username ?? 'operator').trim().toLowerCase();
    return acks.find((a) => a.user.trim().toLowerCase() === me);
  }, [report, username]);

  /* --------------------------------------------------------------- header */
  const header = (
    <PageHeader
      title={PAGE_TITLE}
      help={PAGE_HELP}
      controls={
        <>
          <HandoffRangePicker hours={requestedHours} onChange={setRequestedHours} />
          <RefreshButton
            display="icon"
            label="Refresh standup"
            refreshing={loading && report !== null}
            disabled={loading}
            onClick={() => void load()}
          />
        </>
      }
      actions={
        <>
          <GeneratedStamp shift={shift} generatedAt={report?.generated_at} />
          {hasSummary && canCopySummary ? (
            // The visible label names the button (WCAG 2.5.3); the copy is announced in
            // the polite status below.
            <Button variant="outline" size="sm" onClick={() => copySummary(summaryText)}>
              {summaryCopied ? (
                <ClipboardCheck className="size-4 text-success-text" aria-hidden />
              ) : (
                <Clipboard className="size-4" aria-hidden />
              )}
              {summaryCopied ? 'Copied' : 'Copy summary'}
            </Button>
          ) : null}
          <span role="status" className="sr-only" data-testid="standup-copy-status">
            {summaryCopied ? 'Summary copied' : ''}
          </span>
        </>
      }
    />
  );

  /* ------------------------------------------------------------------ body */
  return (
    <PageContainer variant="wide">
      {header}

      {error && !report ? (
        <LoadError
          error={error}
          title="Could not reach the standup service"
          fallback="The backend may be unreachable. Try refreshing in a moment."
          onRetry={() => void load()}
        />
      ) : null}

      {initialLoading ? (
        <LoadingState
          label="Loading shift handoff"
          description="Preparing the attention queue, SLA pressure, and action items."
          layout="page"
          shape="page"
        />
      ) : null}

      {!initialLoading && disabled ? (
        <Panel title="Shift handoff" caption="turned off">
          <EmptyState
            compact
            state="unavailable"
            icon={FileText}
            title="Standup is turned off"
            description="The daily handoff is turned off. Turn it on in Settings, under Standup, to build the shift attention queue."
          />
        </Panel>
      ) : null}

      {error && report ? (
        <LoadError
          error={error}
          title={
            stale && reportHours !== null
              ? `Could not load the ${rangeWords(requestedHours)}; showing the ${rangeWords(reportHours)}`
              : 'Could not refresh the standup'
          }
          fallback="The current shift snapshot is still available. Try refreshing again."
          onRetry={() => void load()}
        />
      ) : null}

      {!initialLoading && !disabled && report ? (
        <>
          {degraded ? (
            <Callout intent="warning" title="Generated from limited data">
              The shift snapshot ran on a degraded case store; some sections may be empty.
            </Callout>
          ) : null}

          <DeltaStrip deltas={report.deltas ?? {}} hours={reportHours ?? requestedHours} />

          <AttentionQueuePanel
            attention={report.attention_queue ?? []}
            evidenceComplete={!degraded}
            navigate={navigate}
          />

          <div className={cn('grid items-stretch lg:grid-cols-2', PANEL_GAP)}>
            <SlaPanel sla={report.sla_aging} navigate={navigate} />
            <WorkloadPanel workload={report.workload ?? []} />
          </div>

          <div className={cn('grid items-stretch lg:grid-cols-2', PANEL_GAP)}>
            <ActionItemsPanel items={report.action_items} onChanged={() => void load()} />
            <AcknowledgePanel
              windowKey={windowKey}
              acks={report.acknowledgements}
              myAck={myAck}
              onAcked={() => void load()}
            />
          </div>

          {/* Secondary: the model-generated prose summary. */}
          {hasSummary ? (
            <Panel title="Shift summary" caption="written by the model from the counts above">
              {/* Model-generated prose: rendered strictly as plain text. */}
              <p className="max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-foreground">{summaryText}</p>
            </Panel>
          ) : null}
        </>
      ) : null}
    </PageContainer>
  );
}

/* ========================================================= delta strip ===== */

function DeltaStrip({ deltas, hours }: { deltas: Record<string, DeltaCell>; hours: number }) {
  const present = DELTA_META.filter((m) => deltas[m.key]);
  if (!present.length) return null;
  return (
    // The group's name carries the range the counts were read for.
    <KpiStrip label={`Shift counts, ${rangeWords(hours)}`} data-testid="standup-strip">
      {present.map((m) => {
        const cell = deltas[m.key];
        return (
          <KpiTile
            key={m.key}
            label={m.label}
            value={fmtNumber(cell.current)}
            countTo={cell.current}
            format={fmtNumber}
            // Every headline count is lower-is-better: a drop reads as an improvement.
            goodDirection="down"
            delta={{ value: cell.delta, label: signedDelta(cell.delta) }}
            context={`was ${fmtNumber(cell.prior)}`}
            testId={`delta-${m.key}`}
          />
        );
      })}
    </KpiStrip>
  );
}

/* ==================================================== attention queue ====== */

/** A case number that opens the case in Case Manager (plain text when its id is unusable). */
function CaseLink({
  caseId,
  label,
  navigate,
}: {
  caseId: string;
  label: string;
  navigate: Navigate;
}) {
  if (!caseId || !isSafeCaseId(caseId)) {
    return <span className="truncate font-mono text-sm font-medium text-foreground">{label}</span>;
  }
  return (
    <PageLink
      page="case_manager"
      opts={{ caseId }}
      navigate={navigate}
      aria-label={`Open ${label}`}
      className="truncate font-mono text-sm"
    >
      {label}
    </PageLink>
  );
}

function AttentionQueuePanel({
  attention,
  evidenceComplete,
  navigate,
}: {
  attention: AttentionRow[];
  evidenceComplete: boolean;
  navigate: Navigate;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const listId = React.useId();
  const rows = showAll ? attention : attention.slice(0, QUEUE_PREVIEW);
  const hidden = attention.length - rows.length;
  return (
    <Panel
      title="Attention queue"
      count={evidenceComplete ? attention.length : undefined}
      caption="ranked by urgency"
      aside={evidenceComplete ? undefined : <Badge variant="warning">Limited data</Badge>}
      actions={
        attention.length > QUEUE_PREVIEW ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showAll}
            aria-controls={listId}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show fewer' : `Show all ${fmtNumber(attention.length)}`}
          </Button>
        ) : undefined
      }
      data-testid="standup-attention"
    >
      {attention.length === 0 ? (
        <EmptyState
          compact
          state={evidenceComplete ? 'success' : 'unavailable'}
          title={evidenceComplete ? 'Nothing needs you right now' : 'Attention queue is incomplete'}
          description={
            evidenceComplete
              ? 'The current window has no open, escalated, or awaiting-analyst case in the attention queue. Continue with planned work and refresh after new cases arrive.'
              : 'The case store returned a degraded snapshot, so an empty queue cannot be verified. Refresh or check source health before treating this shift as clear.'
          }
        />
      ) : (
        <>
          <ol id={listId} className="flex flex-col divide-y divide-border/70" aria-label="Attention queue">
            {rows.map((row, i) => (
              <AttentionRowItem key={row.case_id || i} row={row} rank={i + 1} navigate={navigate} />
            ))}
          </ol>
          {hidden > 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {fmtNumber(hidden)} more {hidden === 1 ? 'case' : 'cases'} in the queue.
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function AttentionRowItem({
  row,
  rank,
  navigate,
}: {
  row: AttentionRow;
  rank: number;
  navigate: Navigate;
}) {
  const display = caseLabel(row);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground" aria-hidden>
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <CaseLink caseId={row.case_id} label={display} navigate={navigate} />
          <span className="truncate text-sm text-muted-foreground">
            {row.assignee ? `· ${row.assignee}` : '· unassigned'}
          </span>
        </div>
        {/* Case title: UNTRUSTED, plain text. */}
        <p className="mt-0.5 truncate text-sm text-foreground">{row.title || DASH}</p>
        {row.entity ? <p className="mt-0.5 truncate text-sm text-muted-foreground">{row.entity}</p> : null}
      </div>
      {/* On a phone the badges take their own line, aligned with the text above (the rank
          column is 24px plus the 12px gap). */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 max-sm:w-full max-sm:pl-9">
        {row.severity_band ? (
          <span className="inline-flex items-center gap-1">
            <SeverityBadge severity={row.severity_band} />
            {/* Severity provenance flips per row, so the tag lives beside the badge: the
                queue never shows a band derived from the risk score as if it were the
                source's own severity, next to that very risk badge. */}
            <ProvenanceTag kind={severityProvenance(row.severity_source)} variant="icon" />
          </span>
        ) : null}
        <StatusBadge status={row.status} />
        <RiskBadge score={row.risk_score} />
        <span className="whitespace-nowrap text-sm tabular-nums text-muted-foreground" title="Age in the queue">
          {fmtDuration(row.age_minutes)}
          <span className="sr-only"> in the queue</span>
        </span>
      </div>
    </li>
  );
}

/* ============================================================== SLA ======== */

/** How many breached cases SLA pressure lists before "Show all". */
const SLA_PREVIEW = 6;

function SlaPanel({
  sla,
  navigate,
}: {
  sla: StandupReport['sla_aging'] | undefined;
  navigate: Navigate;
}) {
  const enabled = sla?.enabled;
  const totals = sla?.totals;
  const breached = sla?.breached ?? [];
  const [showAll, setShowAll] = React.useState(false);
  const listId = React.useId();
  const rows = showAll ? breached : breached.slice(0, SLA_PREVIEW);
  const hidden = breached.length - rows.length;
  return (
    <Panel
      title="SLA pressure"
      caption="open now"
      actions={
        <>
          {enabled && breached.length > SLA_PREVIEW ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showAll}
              aria-controls={listId}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Show fewer' : `Show all ${fmtNumber(breached.length)}`}
            </Button>
          ) : null}
          {/* The shift-scoped breach pressure; the full SLA attainment and lifecycle timing
              rollup lives in one place, Metrics, Posture (only for those who may open it). */}
          <Can resource="metrics" action="view">
            <PageLink page="metrics" opts={{ tab: 'posture' }} navigate={navigate} className="text-sm">
              Open posture
            </PageLink>
          </Can>
        </>
      }
      data-testid="standup-sla"
    >
      {!enabled ? (
        <EmptyState
          compact
          state="unavailable"
          title="SLA tracking is off"
          description="Enable an SLA policy with per-priority response targets in Settings to surface breach pressure here."
        />
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-3 divide-x divide-border/70 border-y border-border/70">
            {(
              [
                ['Open', totals?.open, 'text-foreground'],
                ['Breached', totals?.breached, (totals?.breached ?? 0) > 0 ? 'text-critical-text' : 'text-foreground'],
                ['At risk', totals?.about_to_breach, 'text-foreground'],
              ] as Array<[string, number | undefined, string]>
            ).map(([label, value, ink]) => (
              <div key={label} className="px-3 py-2 first:pl-0">
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className={cn('mt-1 text-xl font-semibold tabular-nums', ink)}>{fmtNumber(value)}</dd>
              </div>
            ))}
          </dl>
          {breached.length ? (
            <>
              <ul id={listId} className="flex flex-col divide-y divide-border/70" aria-label="Cases past their response target">
                {rows.map((b) => (
                  <li key={b.case_id} className="flex min-h-10 items-center gap-2 py-2 text-sm">
                    <Badge variant="critical">Breached</Badge>
                    <CaseLink caseId={b.case_id} label={caseLabel(b)} navigate={navigate} />
                    {b.priority_level ? (
                      <span className="truncate text-muted-foreground">{b.priority_level}</span>
                    ) : null}
                    <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-critical-text">
                      {fmtOverage(b.overdue_minutes)}
                    </span>
                  </li>
                ))}
              </ul>
              {hidden > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {fmtNumber(hidden)} more {hidden === 1 ? 'case' : 'cases'} past the target.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No case is past its response target.</p>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ========================================================= workload ======= */

/** The workload row name: the server's no-owner bucket reads "Unassigned". */
export function workloadName(analyst: string): string {
  const name = (analyst ?? '').trim();
  return !name || name === '(unassigned)' ? 'Unassigned' : name;
}

function WorkloadPanel({ workload }: { workload: StandupReport['workload'] }) {
  const max = Math.max(1, ...workload.map((w) => w.open));
  return (
    <Panel title="Analyst workload" caption="open cases per assignee" data-testid="standup-workload">
      {workload.length === 0 ? (
        <EmptyState
          compact
          state="no-data"
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
                  {/* Assignee: UNTRUSTED, plain text. The server's no-owner bucket reads
                      as the Console word for it. */}
                  <span className="truncate text-sm font-medium text-foreground">{workloadName(w.analyst)}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {w.escalated > 0 ? <Badge variant="high">{fmtNumber(w.escalated)} escalated</Badge> : null}
                    {w.needs_human > 0 ? <Badge variant="warning">{fmtNumber(w.needs_human)} awaiting</Badge> : null}
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {fmtNumber(w.open)}
                      <span className="sr-only"> open</span>
                    </span>
                  </span>
                </div>
                {/* Decorative: the count beside the name carries the fact; the bar is only
                    relative to the busiest analyst, so it is no percentage to announce. */}
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ====================================================== action items ====== */

const AI_STATUS = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
] as const;

function ActionItemsPanel({ items, onChanged }: { items: ActionItem[]; onChanged: () => void }) {
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  // The last write that failed, said in words (a failed write never passes silently).
  const [failure, setFailure] = React.useState<string | null>(null);

  const add = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await createActionItem({ title: t });
      setTitle('');
      onChanged();
    } catch {
      // Keep the typed title for a retry.
      setFailure('Could not add the action item. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (item: ActionItem, status: string) => {
    setFailure(null);
    try {
      await updateActionItem(item.id, { status });
      onChanged();
    } catch {
      setFailure('Could not change the status of the action item. Try again.');
    }
  };

  const remove = async (item: ActionItem) => {
    setFailure(null);
    try {
      await deleteActionItem(item.id);
      onChanged();
    } catch {
      setFailure('Could not delete the action item. Try again.');
    }
  };

  return (
    <Panel title="Action items" count={items.length} caption="across shifts" data-testid="standup-actions">
      <div className="space-y-4">
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
              placeholder="Add a follow-up"
              maxLength={200}
              aria-label="New action item"
            />
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </form>
        </Can>

        {failure ? (
          <p role="alert" className="text-sm text-critical-text" data-testid="standup-actions-error">
            {failure}
          </p>
        ) : null}

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No action items yet. Track cross-shift follow-ups here.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/70" aria-label="Action items">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  {/* Title and note: UNTRUSTED, plain text. */}
                  <p
                    className={cn(
                      'truncate text-sm',
                      item.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground',
                    )}
                  >
                    {item.title || DASH}
                  </p>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {item.owner ? `${item.owner} · ` : ''}
                    {humanizeAge(item.created_at)}
                    {item.note ? ` · ${item.note}` : ''}
                  </p>
                </div>
                <Can
                  resource="cases"
                  action="write"
                  fallback={
                    <Badge variant={item.status === 'done' ? 'success' : 'outline'}>{humanizeToken(item.status)}</Badge>
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
                    className="size-8 text-muted-foreground hover:text-critical-text focus-visible:text-critical-text"
                    onClick={() => void remove(item)}
                    aria-label={`Delete action item ${item.title}`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </Can>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/* ====================================================== acknowledge ======= */

/** How many acknowledgements the sign-off lists before "Show all". */
const ACK_PREVIEW = 8;

function AcknowledgePanel({
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
  const [failed, setFailed] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const listId = React.useId();
  const shown = showAll ? acks : acks.slice(0, ACK_PREVIEW);
  const hidden = acks.length - shown.length;

  const ack = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await acknowledgeHandoff({ window: windowKey || undefined, note: note.trim() || undefined });
      setNote('');
      onAcked();
    } catch {
      // Keep the note for a retry, and say the sign-off did not land.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Handoff sign-off" caption="this shift" data-testid="standup-signoff">
      <div className="space-y-4">
        {myAck ? (
          <p className="flex items-center gap-2 text-sm text-success-text">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            You acknowledged this handoff {humanizeAge(myAck.at)}.
          </p>
        ) : (
          <Can
            resource="cases"
            action="write"
            fallback={
              <p className="text-sm text-muted-foreground">Acknowledging the handoff requires the case-write grant.</p>
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
                placeholder="Optional note"
                maxLength={200}
                aria-label="Acknowledgement note"
              />
              <Button type="submit" size="sm" disabled={busy}>
                <Check className="size-4" aria-hidden />
                Acknowledge
              </Button>
            </form>
          </Can>
        )}

        {failed && !myAck ? (
          <p role="alert" className="text-sm text-critical-text" data-testid="standup-signoff-error">
            Could not acknowledge the handoff. Try again.
          </p>
        ) : null}

        {acks.length ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">Acknowledged by</h3>
              {acks.length > ACK_PREVIEW ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showAll}
                  aria-controls={listId}
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? 'Show fewer' : `Show all ${fmtNumber(acks.length)}`}
                </Button>
              ) : null}
            </div>
            <ul id={listId} className="flex flex-col gap-1.5" aria-label="Acknowledgements">
              {shown.map((a, i) => (
                <li key={`${a.user}-${a.at}-${i}`} className="flex items-center gap-2 text-sm">
                  {/* Username: plain text. */}
                  <span className="font-medium text-foreground">{a.user || 'operator'}</span>
                  <span className="text-muted-foreground">{humanizeAge(a.at)}</span>
                  {a.note ? <span className="truncate text-muted-foreground">· {a.note}</span> : null}
                </li>
              ))}
            </ul>
            {hidden > 0 ? (
              <p className="text-sm text-muted-foreground">{fmtNumber(hidden)} more acknowledged this handoff.</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No one has acknowledged this window yet.</p>
        )}
      </div>
    </Panel>
  );
}
