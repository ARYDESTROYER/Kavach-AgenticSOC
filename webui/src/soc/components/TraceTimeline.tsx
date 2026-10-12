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
  Bot,
  CheckCircle2,
  GitBranch,
  Lock,
  MessageSquare,
  ShieldCheck,
  Terminal,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, fmtMoney, fmtTokens, formatTimestamp, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Skeleton } from '@/ui/skeleton';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';

import type { DecisionPayload, TimelineResponse, TraceSpan } from '@/soc/pages/CaseDetail.api';
import type { CasePanelPresentation } from '@/soc/pages/casedetail/shared';

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
};

function kindMeta(kind: string): KindMeta {
  return KIND_META[kind] || { label: humanizeToken(kind) || 'Step', icon: GitBranch, tone: 'info' };
}

/* ----------------------------------------------------------- decision step -- */

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
          <div className="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
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
    {/* Same micro-label size as the "Policy clause evaluated" eyebrow above and the rest
        of the app's uppercase eyebrows — was an off-scale text-[0.6rem] (9.6px) outlier. */}
    <div className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
      {label}
    </div>
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
          {/* name is an actor/action token (TRUSTED) — plain text. */}
          <span className="text-sm font-semibold text-foreground">{humanizeToken(span.name)}</span>
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
            {typeof span.cost === 'number' && span.cost > 0 ? <span>{fmtMoney(span.cost)}</span> : null}
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
};

/** Compact terminal treatment used only by the Case Manager Investigation tab. */
const TerminalTrace: React.FC<{ data: TimelineResponse; spans: TraceSpan[] }> = ({ data, spans }) => {
  const toolCount = spans.filter((span) => span.kind === 'execute_tool').length;
  return (
    <div className="overflow-hidden rounded-[4px] border border-border bg-surface-sunken">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-xs font-medium text-muted-foreground">Agent investigation trace</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {spans.length} step{spans.length === 1 ? '' : 's'} · {toolCount} tool{toolCount === 1 ? '' : 's'}
        </span>
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
                <span className="text-foreground/80">{humanizeToken(span.name)}</span>
                {toolName ? <span className="text-foreground">{toolName}</span> : null}
                {model ? <span className="text-muted-foreground">{model}</span> : null}
                {typeof span.cost === 'number' && span.cost > 0 ? (
                  <span className="text-muted-foreground">{fmtMoney(span.cost)}</span>
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
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2 font-mono text-2xs text-muted-foreground">
        <span>cost {fmtMoney(data.totals?.cost)}</span>
        {typeof data.totals?.tokens === 'number' ? (
          <span>{fmtTokens(data.totals.tokens)} tokens</span>
        ) : null}
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

  const toolCount = spans.filter((s) => s.kind === 'execute_tool').length;
  const hasDecision = spans.some((s) => s.kind === 'decision');

  if (presentation === 'case-manager') {
    return <TerminalTrace data={data as TimelineResponse} spans={spans} />;
  }

  return (
    <div className="space-y-6 p-6">
      {/* ----------------------------------------------- run totals header */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">
            {spans.length} step{spans.length === 1 ? '' : 's'}
          </Badge>
          <Badge variant="medium" className="gap-1">
            <Terminal className="h-3 w-3" />
            {toolCount} tool{toolCount === 1 ? '' : 's'}
          </Badge>
          <Badge variant="outline">{fmtMoney(data?.totals?.cost)}</Badge>
          {typeof data?.totals?.tokens === 'number' && data.totals.tokens > 0 ? (
            <Badge variant="outline">{fmtTokens(data.totals.tokens)} tokens</Badge>
          ) : null}
          {hasDecision ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Deterministic decision recorded
            </Badge>
          ) : null}
        </div>
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
