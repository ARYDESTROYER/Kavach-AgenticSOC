/**
 * TraceTimeline — a typed ReAct span timeline for the agent's work on a case (#12).
 *
 * Consumes `GET /api/cases/{id}/timeline` (the `TraceSpan` shape): each step is one
 * of `invoke_agent | chat | execute_tool | decision`, with `step_index`, `latency`,
 * `cost`, `tokens`, and a `trusted` flag. The case_manager DECISION is rendered as a
 * visually DISTINCT TERMINAL step that shows the EXACT
 * `(verdict, confidence, risk_score, policy clause)` the deterministic `decide()`
 * produced — turning #3's determinism into a trust feature.
 *
 * SECURITY (#9): the timeline SEPARATES trusted agent prose from untrusted tool/log
 * payloads. A span with `trusted === true` (router/investigator/formatter/decision)
 * renders its `summary` as plain text; a span with `trusted === false`
 * (execute_tool / es_query — source-influenceable) renders its `summary` ONLY inside
 * an escaped <CodeBlock>, flagged "untrusted". The deterministic decision span is
 * always trusted (it is our own prose). Nothing is interpolated as markup.
 */
import * as React from 'react';
import {
  AlertTriangle,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  Cog,
  GitBranch,
  Lock,
  MessageSquare,
  ShieldCheck,
  Terminal,
  User,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, fmtMoney, fmtTokens, formatTimestamp, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Skeleton } from '@/ui/skeleton';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { JsonTree } from '@/soc/components/JsonTree';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';

import { AuditLogLink } from '@/soc/components/audit/AuditLink';
import { activityActorLabel } from '@/soc/components/caseActivityText';
import type { DecisionPayload, TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';
import type { CasePanelPresentation } from '@/soc/pages/casedetail/shared';

/**
 * "View in audit log" (Round 14 SPEC §4.5.8): every audit row of this case, in all
 * scopes. Shown only to people who hold `audit:view`, and only for a case id the audit
 * log's `case` link key accepts. The range starts an hour before the earliest step of the
 * trace (so the default last 7 days never hides an older investigation) and runs to now,
 * which keeps the case work that followed; with no readable step time it is the last 90
 * days.
 */
function auditTrailFrom(spans: readonly TraceSpan[] | undefined): string {
  let earliest = Number.POSITIVE_INFINITY;
  for (const span of spans ?? []) {
    const ms = Date.parse(span.ts);
    if (Number.isFinite(ms) && ms < earliest) earliest = ms;
  }
  if (!Number.isFinite(earliest)) return 'now-90d';
  return new Date(Math.floor((earliest - 3_600_000) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function AuditTrailLink({
  caseId,
  spans,
  className,
}: {
  caseId: string | undefined;
  spans: readonly TraceSpan[] | undefined;
  className?: string;
}) {
  if (!caseId || !/^[\w.:-]{1,128}$/.test(caseId)) return null;
  return (
    <AuditLogLink opts={{ scope: 'all', case: caseId, from: auditTrailFrom(spans) }} className={className}>
      View in audit log
    </AuditLogLink>
  );
}

/* ----------------------------------------------------------------- actors -- */

/**
 * Who did a step (Round 16 SPEC §4.5 WP14, research data-visibility R4): the AI agent,
 * one of its tools, our own code (the deterministic decision and other system steps), a
 * person (Acknowledge, a tag, a comment), case chat, or runbook AI help (a model call a
 * person asked for on a runbook step, `runbook_ai`). Since Round 16 the server
 * classifies a span by who acted first (`person`, `runbook_ai`, `chat`, `system`), so
 * neither a person's work nor the help they asked for is counted as the investigation's
 * AI steps; an older server's kinds read the same way.
 */
export type TraceActor = 'agent' | 'tool' | 'code' | 'person' | 'chat' | 'runbook';

export function spanActor(span: Pick<TraceSpan, 'kind'>): TraceActor {
  switch (span.kind) {
    case 'execute_tool':
      return 'tool';
    case 'decision':
    case 'system':
      return 'code';
    case 'person':
      return 'person';
    case 'chat':
      return 'chat';
    case 'runbook_ai':
      return 'runbook';
    default:
      return 'agent';
  }
}

/** Whether a step is the AI's own work (the agent or one of its tools). */
export function isAiStep(span: Pick<TraceSpan, 'kind'>): boolean {
  const actor = spanActor(span);
  return actor === 'agent' || actor === 'tool';
}

/** The trace's counts: AI steps (agent and tool), tools, people, chat, runbook AI help and code steps. */
export function traceStepCounts(spans: readonly Pick<TraceSpan, 'kind'>[]): Record<TraceActor | 'ai', number> {
  const counts = { ai: 0, agent: 0, tool: 0, code: 0, person: 0, chat: 0, runbook: 0 };
  for (const span of spans) {
    const actor = spanActor(span);
    counts[actor] += 1;
    if (actor === 'agent' || actor === 'tool') counts.ai += 1;
  }
  return counts;
}

/** "5 AI steps · 2 tools", plus the people's steps and runbook AI help when there are any. */
export function traceCountsText(spans: readonly Pick<TraceSpan, 'kind'>[]): string {
  const c = traceStepCounts(spans);
  const parts = [`${c.ai.toLocaleString('en-US')} AI step${c.ai === 1 ? '' : 's'}`, `${c.tool.toLocaleString('en-US')} tool${c.tool === 1 ? '' : 's'}`];
  if (c.person) parts.push(`${c.person.toLocaleString('en-US')} by people`);
  if (c.runbook) parts.push(`${c.runbook.toLocaleString('en-US')} runbook AI help`);
  return parts.join(' · ');
}

/**
 * The structured action of a person reading the case's raw events on the Evidence tab
 * (`case.events_viewed`, one row per viewer per 10 minutes). It is a person's span of the
 * timeline, never a step of the investigation.
 */
export const EVENTS_VIEWED_ACTION = 'case.events_viewed';

/**
 * The spans of the AI investigation tab's trace: every span but a person opening the
 * Evidence tab (SPEC 8.1). Those rows stay in Activity and the audit log.
 */
export function investigationSpans<T extends Pick<TraceSpan, 'payload_ref'>>(spans: readonly T[]): T[] {
  return spans.filter((span) => span.payload_ref?.action !== EVENTS_VIEWED_ACTION);
}

/** The trace filter's choices, in order (the actor filter of the AI investigation tab). */
export const TRACE_FILTERS: ReadonlyArray<{ value: TraceActor | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'agent', label: 'Agent' },
  { value: 'tool', label: 'Tool' },
  { value: 'code', label: 'Code' },
  { value: 'person', label: 'People' },
  { value: 'chat', label: 'Chat' },
  { value: 'runbook', label: 'Runbook' },
];

/** The spans one filter choice keeps. */
export function filterSpans<T extends Pick<TraceSpan, 'kind'>>(spans: readonly T[], actor: TraceActor | 'all'): T[] {
  return actor === 'all' ? [...spans] : spans.filter((span) => spanActor(span) === actor);
}

/** How a step's cost was found, in words. */
export const COST_BASIS_WORDS: Record<string, string> = {
  exact: "Cost and latency from this call's own ledger row.",
  split: "An even share of this role's recorded cost, split across its steps. Not this call's own cost.",
};

/** The decision step's cost, in words: code decided, so there is no call and no ledger row. */
export const DECISION_COST_WORDS = 'No model call. Code made this decision.';

/** Whether the trace shows only the newest records, and of how many (WP10, additive). */
function traceCut(data: TimelineResponse): { truncated: boolean; total: number | null; atLeast: boolean } {
  const extra = data as TimelineResponse & {
    truncated?: unknown;
    rows_total?: unknown;
    rows_total_relation?: unknown;
  };
  const total = typeof extra.rows_total === 'number' && Number.isFinite(extra.rows_total) ? extra.rows_total : null;
  return { truncated: extra.truncated === true, total, atLeast: extra.rows_total_relation === 'gte' };
}

/** "Showing the newest 500 of 1,240 records. The audit log has the rest." */
export function traceCutText(data: TimelineResponse): string | null {
  const cut = traceCut(data);
  if (!cut.truncated) return null;
  const shown = (data.spans?.length ?? 0).toLocaleString('en-US');
  if (cut.total === null) return `Showing the newest ${shown} records. Older records are not shown here.`;
  return `Showing the newest ${shown} of ${cut.atLeast ? 'at least ' : ''}${cut.total.toLocaleString('en-US')} records. The audit log has the rest.`;
}

/* ----------------------------------------------------------- span details -- */

/**
 * Whether a span carries anything for its Details disclosure. The decision step always
 * does: its Details say code made it with no model call, even when no gate was recorded.
 */
function hasDetails(span: TraceSpan): boolean {
  const d = span.detail;
  const model = typeof span.payload_ref?.model === 'string' && span.payload_ref.model;
  return Boolean(
    span.kind === 'decision' ||
      model ||
      (typeof span.latency_ms === 'number' && span.latency_ms > 0) ||
      span.cost_basis ||
      (d &&
        (d.tool_input != null ||
          d.query_text ||
          d.tool_output_summary ||
          d.prompt_excerpt ||
          (d.result_summary && d.result_summary !== span.summary) ||
          d.outcome ||
          d.run_id ||
          d.app_version ||
          d.build_sha)),
  );
}

const DetailFact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{children}</dd>
  </>
);

/**
 * The bounded record behind one span (WP10 `detail`): the model, latency, tokens and cost
 * with how the cost was found, the tool input as a JSON tree, the query, the tool output
 * and the prompt excerpt in fenced code blocks marked untrusted (#9), the outcome, the run
 * and the build. The trace loads it with the span, so opening it asks nothing.
 */
export const SpanDetails: React.FC<{ span: TraceSpan }> = ({ span }) => {
  const [open, setOpen] = React.useState(false);
  if (!hasDetails(span)) return null;
  const d = span.detail ?? null;
  const model = typeof span.payload_ref?.model === 'string' ? (span.payload_ref.model as string) : '';
  const build =
    d && (d.app_version || d.build_sha)
      ? `${d.app_version ? `v${d.app_version}` : 'version not recorded'} · ${d.build_sha ? d.build_sha.slice(0, 12) : 'SHA not recorded'}`
      : '';
  const toolInput = d?.tool_input;
  const hasToolInput = toolInput !== null && toolInput !== undefined && !(typeof toolInput === 'object' && Object.keys(toolInput as object).length === 0);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1.5 font-sans">
      <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-3" data-testid="trace-span-details">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {model ? <DetailFact label="Model">{model}</DetailFact> : null}
          {typeof span.latency_ms === 'number' && span.latency_ms > 0 ? (
            <DetailFact label="Latency">{`${span.latency_ms.toLocaleString('en-US')} ms`}</DetailFact>
          ) : null}
          {typeof span.tokens === 'number' && span.tokens > 0 ? (
            <DetailFact label="Tokens">{span.tokens.toLocaleString('en-US')}</DetailFact>
          ) : null}
          {span.kind === 'decision' ? (
            <DetailFact label="Cost">{DECISION_COST_WORDS}</DetailFact>
          ) : (
            <>
              {typeof span.cost === 'number' ? <DetailFact label="Cost">{fmtMoney(span.cost)}</DetailFact> : null}
              {span.cost_basis ? (
                <DetailFact label="Cost basis">{COST_BASIS_WORDS[span.cost_basis] ?? humanizeToken(span.cost_basis)}</DetailFact>
              ) : null}
            </>
          )}
          {d?.outcome ? <DetailFact label="Outcome">{humanizeToken(d.outcome)}</DetailFact> : null}
          {d?.run_id ? (
            <DetailFact label="Run">
              <span className="font-mono">{d.run_id}</span>
            </DetailFact>
          ) : null}
          {build ? <DetailFact label="Build">{build}</DetailFact> : null}
        </dl>
        {hasToolInput ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Tool input</p>
            {typeof toolInput === 'string' ? (
              /* A cut input arrives as its first 16 KB of JSON text: fenced, never parsed (#9). */
              <CodeBlock value={toolInput} caption="untrusted tool input, cut" wrap copyable maxHeightClassName="max-h-48" />
            ) : (
              <JsonTree value={toolInput} label="Tool input" />
            )}
          </div>
        ) : null}
        {d?.query_text ? (
          <CodeBlock value={d.query_text} caption="untrusted query" wrap copyable maxHeightClassName="max-h-40" />
        ) : null}
        {d?.tool_output_summary ? (
          <CodeBlock value={d.tool_output_summary} caption="untrusted tool output" wrap copyable maxHeightClassName="max-h-48" />
        ) : null}
        {d?.prompt_excerpt ? (
          <CodeBlock value={d.prompt_excerpt} caption="untrusted prompt excerpt" wrap copyable maxHeightClassName="max-h-48" />
        ) : null}
        {d?.result_summary && d.result_summary !== span.summary ? (
          <CodeBlock value={d.result_summary} caption="recorded summary" wrap copyable maxHeightClassName="max-h-40" />
        ) : null}
        {d?.truncated ? (
          <p className="text-xs text-muted-foreground">Part of this record was cut to keep the trace small. The audit log has it in full.</p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
};

/* ------------------------------------------------------------------ kinds -- */

type SpanTone = 'info' | 'medium' | 'low' | 'high';

const TONE_TEXT: Record<SpanTone, string> = {
  info: 'text-info',
  medium: 'text-medium',
  low: 'text-low',
  high: 'text-high',
};
const TONE_RING: Record<SpanTone, string> = {
  info: 'border-info/40 bg-info/10',
  medium: 'border-medium/40 bg-medium/10',
  low: 'border-low/40 bg-low/10',
  high: 'border-high/40 bg-high/10',
};

interface KindMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: SpanTone;
}

const KIND_META: Record<string, KindMeta> = {
  invoke_agent: { label: 'Agent', icon: Bot, tone: 'info' },
  chat: { label: 'Chat', icon: MessageSquare, tone: 'info' },
  execute_tool: { label: 'Tool', icon: Terminal, tone: 'medium' },
  decision: { label: 'Decision', icon: ShieldCheck, tone: 'low' },
  person: { label: 'Person', icon: User, tone: 'info' },
  system: { label: 'System', icon: Cog, tone: 'low' },
  runbook_ai: { label: 'Runbook AI help', icon: BookOpen, tone: 'info' },
};

/**
 * A span's name as shown: a person's name exactly as recorded; runbook AI help as the
 * person who asked (its kind label says what ran); a pipeline actor by the name the activity feed gives it
 * (`agentic_soc` is "Agentic SOC"); any other token in words.
 */
export function spanName(span: Pick<TraceSpan, 'kind' | 'name'>): string {
  if (span.kind === 'person') return span.name;
  if (span.kind === 'runbook_ai') {
    const asker = String(span.name ?? '').trim();
    return asker ? `Asked by ${asker}` : 'Runbook AI help';
  }
  const label = activityActorLabel(span.name);
  return label === String(span.name ?? '').trim() ? humanizeToken(span.name) : label;
}

/** The span's cost, marked when it is an even share rather than the call's own. */
function spanCost(span: TraceSpan): string {
  return `${fmtMoney(span.cost ?? 0)}${span.cost_basis === 'split' ? ' (split)' : ''}`;
}

function kindMeta(kind: string): KindMeta {
  return KIND_META[kind] || { label: humanizeToken(kind) || 'Step', icon: GitBranch, tone: 'info' };
}

/* ----------------------------------------------------------- decision step -- */

/**
 * The decision step's small labels ("Policy clause evaluated", "Verdict", ...): 12 px,
 * sentence case, in the body face. Never tracked capitals and never below the type floor
 * (Round 14, SPEC §3.1; the ui-standard keeps context text at 12 px or larger).
 */
const MICRO_LABEL = 'text-xs font-medium text-muted-foreground';

/** Read the typed decision payload off a terminal `decision` span (defensive).
 *  Exported so the pinned DecisionCard (casedetail/DecisionCard.tsx) reads the exact
 *  `policy_clause` from the same span shape without duplicating the coercion. */
export function decisionPayload(span: TraceSpan): DecisionPayload {
  const p = span.payload_ref;
  return (p && typeof p === 'object' ? (p as DecisionPayload) : {}) as DecisionPayload;
}

/** Format a 0..1 confidence as a percent string for the decision clause. */
function pct(v: number | undefined): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return DASH;
  const p = v <= 1 ? v * 100 : v;
  return `${Math.round(p)}%`;
}

/**
 * The DISTINCT terminal decision step. It is intentionally heavier than a normal
 * span: a full bordered card calling out that this step was made by deterministic
 * code (#3), with the exact verdict / confidence / risk inputs and the matched
 * AutoClosePolicy clause. Always trusted (our own prose).
 */
const DecisionStep: React.FC<{ span: TraceSpan }> = ({ span }) => {
  const d = decisionPayload(span);
  const clause = d.policy_clause || {};
  const autoClosable = clause.auto_closable;
  return (
    <li className="relative" data-testid="trace-decision-step">
      <span
        className={cn(
          'absolute -left-[2.15rem] flex h-8 w-8 items-center justify-center rounded-full border-2',
          'border-low/50 bg-low/15',
        )}
        aria-hidden
      >
        <ShieldCheck className="h-4 w-4 text-low" />
      </span>
      <div className="rounded-xl border-2 border-low/40 bg-low/5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success" className="gap-1">
            <Lock className="h-3 w-3" />
            Deterministic decision
          </Badge>
          <span className="text-sm font-semibold text-foreground">case_manager</span>
          {d.escalate ? (
            <Badge variant="high" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              Escalate
            </Badge>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground">
            {span.ts ? formatTimestamp(span.ts) : DASH}
          </span>
        </div>

        <p className="mt-1 text-xs text-muted-foreground">
          The close / escalate decision is made by deterministic code against the operator-
          configured auto-close policy — never by raw model output.
        </p>

        {/* The exact (verdict, confidence, risk_score) inputs to decide(). */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <DecisionFact label="Verdict" value={d.verdict ? humanizeToken(d.verdict) : DASH} />
          <DecisionFact label="Confidence" value={pct(d.confidence)} />
          <DecisionFact
            label="Risk score"
            value={typeof d.risk_score === 'number' ? `${Math.round(d.risk_score)}/100` : DASH}
          />
          <DecisionFact
            label="Result"
            value={d.decision_status ? humanizeToken(d.decision_status) : DASH}
          />
        </div>

        {/* The matched AutoClosePolicy clause (the thresholds decide() compared against). */}
        <div className="mt-3 rounded-lg border border-border bg-card p-3">
          <div className={cn('mb-1.5 flex items-center gap-1.5', MICRO_LABEL)}>
            <GitBranch className="h-3 w-3" />
            Policy clause evaluated
          </div>
          {clause.note ? (
            /* TRUSTED policy note (our own copy) — still a plain text node. */
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

        {span.summary ? (
          /* TRUSTED deterministic rationale — plain text. */
          <p className="mt-3 whitespace-pre-wrap text-sm text-foreground/90">{span.summary}</p>
        ) : null}

        {d.objection_window_expires_at ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Objection window open until {formatTimestamp(d.objection_window_expires_at)}.
          </p>
        ) : null}
      </div>
    </li>
  );
};

const DecisionFact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md border border-border bg-card px-2.5 py-2">
    <div className={MICRO_LABEL}>{label}</div>
    <div className="mt-0.5 truncate font-mono text-sm text-foreground">{value}</div>
  </div>
);

/* --------------------------------------------------------------- react step */

/** A normal ReAct span. TRUSTED prose → plain text; UNTRUSTED payload → CodeBlock. */
const ReactStep: React.FC<{ span: TraceSpan }> = ({ span }) => {
  const meta = kindMeta(span.kind);
  const Icon = meta.icon;
  const untrusted = span.trusted === false;
  const model =
    span.payload_ref && typeof span.payload_ref.model === 'string'
      ? (span.payload_ref.model as string)
      : null;
  const toolName =
    span.payload_ref && typeof span.payload_ref.tool_name === 'string'
      ? (span.payload_ref.tool_name as string)
      : null;
  return (
    <li className="relative">
      <span
        className={cn(
          'absolute -left-[2.05rem] flex h-7 w-7 items-center justify-center rounded-full border',
          TONE_RING[meta.tone],
        )}
        aria-hidden
      >
        <Icon className={cn('h-3.5 w-3.5', TONE_TEXT[meta.tone])} />
      </span>
      <div className="rounded-lg border border-border bg-card p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={meta.tone}>{meta.label}</Badge>
          {/* An actor or action token, or a person's name: a plain text node. */}
          <span className="text-sm font-semibold text-foreground">{spanName(span)}</span>
          {toolName ? (
            <Badge variant="outline" className="font-mono">
              {toolName}
            </Badge>
          ) : null}
          {model ? (
            <span className="font-mono text-xs text-muted-foreground">{model}</span>
          ) : null}
          {untrusted ? (
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              untrusted
            </Badge>
          ) : null}
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {typeof span.cost === 'number' && span.cost > 0 ? <span>{spanCost(span)}</span> : null}
            {typeof span.tokens === 'number' && span.tokens > 0 ? (
              <span>{fmtTokens(span.tokens)} tok</span>
            ) : null}
            <span>{span.ts ? formatTimestamp(span.ts) : DASH}</span>
          </span>
        </div>

        {span.summary ? (
          untrusted ? (
            /* UNTRUSTED tool/log payload — fenced in an escaped CodeBlock (#9). */
            <div className="mt-2">
              <CodeBlock
                value={span.summary}
                caption="untrusted tool / log payload"
                wrap
                copyable
                maxHeightClassName="max-h-40"
              />
            </div>
          ) : (
            /* TRUSTED agent prose — plain text. */
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{span.summary}</p>
          )
        ) : null}
        <SpanDetails span={span} />
      </div>
    </li>
  );
};

/* --------------------------------------------------------------- component -- */

export interface TraceTimelineProps {
  data: TimelineResponse | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  presentation?: CasePanelPresentation;
  /**
   * The step count in the case manager trace's header. Left out, the trace counts its own
   * steps; `null` shows none (the AI tab counts the steps beside its heading, and passes
   * a count here only while a filter narrows the trace).
   */
  countsText?: string | null;
}

function terminalTime(ts?: string | null): string {
  if (!ts) return DASH;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return ts;
  try {
    return new Date(ms).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });
  } catch {
    return formatTimestamp(ts);
  }
}

const TERMINAL_LABEL: Record<string, { label: string; tone: string }> = {
  invoke_agent: { label: 'AGENT', tone: 'text-primary' },
  chat: { label: 'CHAT', tone: 'text-info-text' },
  execute_tool: { label: 'TOOL', tone: 'text-medium-text' },
  decision: { label: 'DECISION', tone: 'text-critical-text' },
  person: { label: 'PERSON', tone: 'text-foreground' },
  system: { label: 'SYSTEM', tone: 'text-muted-foreground' },
  runbook_ai: { label: 'RUNBOOK AI', tone: 'text-primary' },
};

/** Compact terminal treatment used only by the Case Manager Investigation tab. */
const TerminalTrace: React.FC<{ data: TimelineResponse; spans: TraceSpan[]; countsText?: string | null }> = ({
  data,
  spans,
  countsText,
}) => {
  const cut = traceCutText(data);
  const counts = countsText === undefined ? traceCountsText(spans) : countsText;
  return (
    <div className="overflow-hidden rounded-[4px] border border-border bg-surface-sunken">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-xs font-medium text-muted-foreground">Agent investigation trace</span>
        {counts ? (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground" data-testid="trace-step-counts">
            {counts}
          </span>
        ) : null}
      </div>
      <ol className="space-y-3 p-4">
        {spans.map((span) => {
          const meta = TERMINAL_LABEL[span.kind] || {
            label: humanizeToken(span.kind) || 'STEP',
            tone: 'text-foreground',
          };
          const untrusted = span.trusted === false;
          // The per-step tool, model, cost and tokens the full layout shows (kept here
          // now that every case surface uses this compact trace).
          const toolName =
            span.payload_ref && typeof span.payload_ref.tool_name === 'string'
              ? (span.payload_ref.tool_name as string)
              : null;
          const model =
            span.payload_ref && typeof span.payload_ref.model === 'string'
              ? (span.payload_ref.model as string)
              : null;
          return (
            <li
              key={span.id || span.step_index}
              data-trace-kind={span.kind}
              tabIndex={span.kind === 'decision' ? -1 : undefined}
              className="scroll-mt-24 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <time className="text-muted-foreground">{terminalTime(span.ts)}</time>
                <span className={cn('font-semibold', meta.tone)}>[{meta.label}]</span>
                <span className="text-foreground/80">{spanName(span)}</span>
                {toolName ? <span className="text-foreground">{toolName}</span> : null}
                {model ? <span className="text-muted-foreground">{model}</span> : null}
                {typeof span.cost === 'number' && span.cost > 0 ? (
                  <span className="text-muted-foreground">{spanCost(span)}</span>
                ) : null}
                {typeof span.tokens === 'number' && span.tokens > 0 ? (
                  <span className="text-muted-foreground">{fmtTokens(span.tokens)} tok</span>
                ) : null}
                {untrusted ? (
                  <Badge variant="warning" className="h-5 gap-1 px-1.5 font-sans text-2xs">
                    <Lock className="h-3 w-3" /> untrusted
                  </Badge>
                ) : null}
              </div>
              {span.summary ? (
                untrusted ? (
                  <div className="mt-2">
                    <CodeBlock
                      value={span.summary}
                      caption="untrusted tool / log payload"
                      wrap
                      copyable
                      maxHeightClassName="max-h-36"
                    />
                  </div>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap pl-0 text-foreground/90 sm:pl-[5.75rem]">
                    {span.summary}
                  </p>
                )
              ) : null}
              <div className="sm:pl-[5.75rem]">
                <SpanDetails span={span} />
              </div>
            </li>
          );
        })}
      </ol>
      {cut ? (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground" data-testid="trace-cut">
          {cut}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 font-mono text-2xs text-muted-foreground">
        {typeof data.totals?.cost === 'number' ? <span>cost {fmtMoney(data.totals.cost)}</span> : null}
        {typeof data.totals?.tokens === 'number' ? (
          <span>{fmtTokens(data.totals.tokens)} tokens</span>
        ) : null}
        <AuditTrailLink caseId={data.case_id} spans={spans} className="ml-auto font-sans text-xs" />
      </div>
    </div>
  );
};

/**
 * The case agent-work timeline. Renders a header with the run totals (steps / tools /
 * cost / tokens), then the span list with the terminal decision step distinct.
 */
export const TraceTimeline: React.FC<TraceTimelineProps> = ({
  data,
  loading,
  error,
  onRetry,
  presentation = 'default',
  countsText,
}) => {
  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <LoadError error={error} title="Could not load the timeline" onRetry={onRetry} />
      </div>
    );
  }
  const spans = data?.spans ?? [];
  if (spans.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={GitBranch}
          title="No agent trace yet"
          description="The ReAct timeline appears after an investigation runs (router → investigator → tools → the deterministic decision)."
        />
      </div>
    );
  }

  const counts = traceStepCounts(spans);
  const hasDecision = spans.some((s) => s.kind === 'decision');
  const cut = data ? traceCutText(data) : null;

  if (presentation === 'case-manager') {
    return <TerminalTrace data={data as TimelineResponse} spans={spans} countsText={countsText} />;
  }

  return (
    <div className="space-y-6 p-6">
      {/* ----------------------------------------------- run totals header */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">
            {counts.ai.toLocaleString('en-US')} AI step{counts.ai === 1 ? '' : 's'}
          </Badge>
          <Badge variant="medium" className="gap-1">
            <Terminal className="h-3 w-3" />
            {counts.tool.toLocaleString('en-US')} tool{counts.tool === 1 ? '' : 's'}
          </Badge>
          {counts.person ? (
            <Badge variant="outline">{counts.person.toLocaleString('en-US')} by people</Badge>
          ) : null}
          {/* No cost badge when the cost is withheld (`null` without cost:view). */}
          {typeof data?.totals?.cost === 'number' ? (
            <Badge variant="outline">{fmtMoney(data.totals.cost)}</Badge>
          ) : null}
          {typeof data?.totals?.tokens === 'number' && data.totals.tokens > 0 ? (
            <Badge variant="outline">{fmtTokens(data.totals.tokens)} tokens</Badge>
          ) : null}
          {hasDecision ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Deterministic decision recorded
            </Badge>
          ) : null}
          <AuditTrailLink caseId={data?.case_id} spans={spans} className="ml-auto text-sm" />
        </div>
        {cut ? <p className="mt-2 text-xs text-muted-foreground">{cut}</p> : null}
      </div>

      {/* ----------------------------------------------- the span timeline */}
      <ol className="relative space-y-4 border-l border-border pl-6">
        {spans.map((span) =>
          span.kind === 'decision' ? (
            <DecisionStep key={span.id || span.step_index} span={span} />
          ) : (
            <ReactStep key={span.id || span.step_index} span={span} />
          ),
        )}
      </ol>
    </div>
  );
};

export default TraceTimeline;
