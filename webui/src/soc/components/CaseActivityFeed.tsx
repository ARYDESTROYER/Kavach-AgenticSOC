/**
 * CaseActivityFeed — the case's who-did-what timeline (#4).
 *
 * Consumes `GET /api/cases/{id}/activity`: the authoritative audit rows for the case
 * UNIONed with the friendly `CaseActivityStore` feed, newest-first. The audit trail
 * stays the source of truth (#2); the friendly feed adds human-readable events.
 *
 * SECURITY (#9): every `actor`, `summary`, and `ref` value is operator-/log-derived
 * UNTRUSTED text — rendered EXCLUSIVELY as plain text nodes, never markup.
 *
 * LIVE (Wave 4): optionally subscribes to the per-case SSE room
 * (`cases:{liveCaseId}`) via `useEventStream`. A `case.activity` frame is a NUDGE — it
 * carries only plain identifiers and never a verdict; the component calls the caller's
 * `onLiveActivity` so the parent refetches the authoritative feed (#3 untouched). This
 * is purely additive: with no `liveCaseId` (the default) the component is exactly the
 * pure presentational timeline it has always been, and the parent keeps polling.
 *
 * AGENT STEPS: the same ONE subscription also consumes `agent.step`, the channel the
 * pipeline publishes while an investigation is actually running. They are rendered as
 * TRANSIENT rows above the persisted timeline — a narration of the run in flight, never
 * a record: nothing is decided from them (#3), they are dropped when the case changes,
 * and the authoritative feed still comes from the API. Folding them into the existing
 * stream (rather than opening a second `EventSource` on the same room) keeps one socket
 * per case, which matters because CaseDetail already mounts two components on it.
 */
import * as React from 'react';

import {
  agentStepFromFrame,
  appendAgentStep,
  useEventStream,
  type AgentStep,
  type StreamEvent,
} from '@/lib/useEventStream';
import {
  Activity,
  Bell,
  CheckCircle2,
  GitBranch,
  ListChecks,
  MessageSquare,
  Shield,
  SmilePlus,
  Trash2,
  UserCog,
  Wrench,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, humanizeAge, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { LoadingState } from '@/design-system';
import { EmptyState } from '@/soc/components/EmptyState';

import type { CaseActivityItem } from '@/soc/pages/CaseDetail.api';

/**
 * How many in-flight `agent.step` frames the transient narration keeps.
 *
 * A narration, not a record: the authoritative trail is the audit feed above, so this
 * only has to hold the tail of a run that is happening right now. Bounded so a long or
 * looping investigation cannot grow the DOM without limit.
 */
const LIVE_STEP_LIMIT = 12;

/* ------------------------------------------------------------------ kinds -- */

type FeedTone = 'info' | 'medium' | 'low' | 'high' | 'critical';

const TONE_RING: Record<FeedTone, string> = {
  info: 'border-info/40 bg-info/10 text-info',
  medium: 'border-medium/40 bg-medium/10 text-medium',
  low: 'border-low/40 bg-low/10 text-low',
  high: 'border-high/40 bg-high/10 text-high',
  critical: 'border-critical/40 bg-critical/10 text-critical',
};

interface KindMeta {
  icon: React.ComponentType<{ className?: string }>;
  tone: FeedTone;
}

/** Map an activity/audit `kind` token → an icon + tone (defensive default). */
function kindMeta(kind: string): KindMeta {
  const k = (kind || '').toLowerCase();
  if (k.includes('comment') || k === 'thread_post' || k === 'commented') {
    return { icon: MessageSquare, tone: 'info' };
  }
  if (k.includes('delete')) return { icon: Trash2, tone: 'high' };
  if (k.includes('react')) return { icon: SmilePlus, tone: 'info' };
  if (k.includes('task')) return { icon: ListChecks, tone: 'medium' };
  if (k.includes('assign')) return { icon: UserCog, tone: 'info' };
  if (k.includes('escalat')) return { icon: Bell, tone: 'critical' };
  if (k.includes('decision') || k.includes('verdict')) return { icon: GitBranch, tone: 'low' };
  if (k.includes('resolve') || k.includes('close')) return { icon: CheckCircle2, tone: 'low' };
  if (k.includes('tool') || k.includes('query')) return { icon: Wrench, tone: 'medium' };
  if (k.includes('mention') || k.includes('notify')) return { icon: Bell, tone: 'info' };
  if (k.includes('prompt') || k.includes('context')) return { icon: Shield, tone: 'info' };
  return { icon: Activity, tone: 'info' };
}

/* --------------------------------------------------------------- component -- */

export interface CaseActivityFeedProps {
  items: CaseActivityItem[];
  loading?: boolean;
  className?: string;
  /**
   * Optional: the case id to subscribe to for LIVE `case.activity` frames. When set
   * (and realtime is enabled on the backend), the feed nudges the caller to refetch
   * as collaboration events land. Omitted by default → no stream, today's behaviour.
   */
  liveCaseId?: string;
  /**
   * Called when a live `case.activity` frame arrives (debounced upstream by the bus).
   * The caller should refetch the authoritative activity feed. Only fires when
   * `liveCaseId` is set and a stream is healthy.
   */
  onLiveActivity?: () => void;
}

/**
 * The activity feed: a newest-first vertical timeline. Each entry shows the kind
 * icon, an actor + relative time, and a plain-text summary.
 */
export const CaseActivityFeed: React.FC<CaseActivityFeedProps> = ({
  items,
  loading,
  className,
  liveCaseId,
  onLiveActivity,
}) => {
  // In-flight agent steps for THIS case. Bounded, and cleared whenever the case
  // changes so one run's narration can never bleed into another's.
  const [liveSteps, setLiveSteps] = React.useState<AgentStep[]>([]);
  React.useEffect(() => {
    setLiveSteps([]);
  }, [liveCaseId]);

  // ONE subscription, two frame types:
  //  * `case.activity` is a nudge — the payload is never rendered (#9); it only asks
  //    the parent to refetch the authoritative feed.
  //  * `agent.step` is the narration of a running investigation, rendered below.
  const onEvent = React.useCallback(
    (ev: StreamEvent) => {
      if (ev.type === 'case.activity') {
        onLiveActivity?.();
        return;
      }
      const entry = agentStepFromFrame(ev, liveCaseId);
      if (entry) setLiveSteps((prev) => appendAgentStep(prev, entry, LIVE_STEP_LIMIT));
    },
    [liveCaseId, onLiveActivity],
  );
  useEventStream(liveCaseId ? [`cases:${liveCaseId}`] : [], {
    enabled: Boolean(liveCaseId),
    onEvent,
  });

  if (loading) {
    return (
      <LoadingState
        layout="panel"
        shape="rows"
        shapeRows={4}
        label="Loading case activity"
        description="Retrieving the authoritative case timeline."
        className={cn('min-h-[14.25rem]', className)}
      />
    );
  }
  if (!items.length && !liveSteps.length) {
    return (
      <EmptyState
        icon={Activity}
        compact
        title="No activity yet"
        description="Lifecycle changes, comments, and agent steps for this case appear here."
      />
    );
  }
  return (
    <div className={cn('space-y-3', className)}>
      <LiveAgentSteps steps={liveSteps} />
      {items.length ? <ActivityTimeline items={items} /> : null}
    </div>
  );
};

/** The in-flight run narration. Renders nothing when no step has arrived. */
const LiveAgentSteps: React.FC<{ steps: AgentStep[] }> = ({ steps }) => {
  if (!steps.length) return null;
  return (
    <section
      aria-label="Investigation in progress"
      className="rounded-md border border-info/40 bg-info/5 px-3 py-2"
    >
      <p className="text-2xs font-medium uppercase tracking-wide text-info">
        Investigation in progress
      </p>
      <ol className="mt-1 space-y-0.5">
        {steps.map((s, i) => (
          <li
            key={`${s.receivedAt}-${i}`}
            className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground"
          >
            {/* UNTRUSTED, length-capped upstream — plain text nodes only (#9). */}
            <span className="font-medium text-foreground">{humanizeToken(s.step) || s.step}</span>
            <span>{s.status}</span>
            {s.detail ? <span className="truncate">{s.detail}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
};

/** The persisted, authoritative timeline: newest-first. */
const ActivityTimeline: React.FC<{ items: CaseActivityItem[] }> = ({ items }) => {
  return (
    <ol className="relative space-y-3 border-l border-border pl-5">
      {items.map((it, i) => {
        const meta = kindMeta(it.kind);
        const Icon = meta.icon;
        const refStr = summariseRef(it.ref);
        return (
          <li key={it.id || `${it.ts}-${i}`} className="relative">
            <span
              className={cn(
                'absolute -left-[1.85rem] flex h-6 w-6 items-center justify-center rounded-full border',
                TONE_RING[meta.tone],
              )}
              aria-hidden
            >
              <Icon className="h-3 w-3" />
            </span>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <Badge variant="outline" className="px-1.5 py-0 text-2xs">
                {humanizeToken(it.kind) || 'Event'}
              </Badge>
              {it.actor ? (
                /* UNTRUSTED actor — plain text. */
                <span className="text-sm font-medium text-foreground">{it.actor}</span>
              ) : (
                <span className="text-sm text-muted-foreground">system</span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {it.ts ? humanizeAge(it.ts) : DASH}
              </span>
            </div>
            {it.summary ? (
              /* UNTRUSTED summary — plain text. */
              <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {it.summary}
              </p>
            ) : null}
            {refStr ? (
              /* UNTRUSTED ref bits — plain text, mono. */
              <p className="mt-0.5 font-mono text-2xs text-muted-foreground/80">{refStr}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};

/** Flatten a small `ref` bag into a `k=v · k=v` plain string (scalars only). */
function summariseRef(ref: Record<string, unknown> | undefined): string {
  if (!ref || typeof ref !== 'object') return '';
  const bits: string[] = [];
  for (const [k, v] of Object.entries(ref)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    bits.push(`${k}=${String(v)}`);
    if (bits.length >= 4) break;
  }
  return bits.join(' · ');
}

export default CaseActivityFeed;
