/**
 * `timeline` block (BLOCKS.md `timeline`): an ordered list in TraceTimeline's dialect —
 * a UTC time gutter with day dividers, a node glyph per kind (plus the semantic glyph),
 * the label in plain text, the detail muted (in a CodeBlock when the block is untrusted,
 * so log text is fenced visually and never linkified), and an optional validated ref.
 * Ten or more events get a decorative density strip above the list.
 */
import { Bell, Briefcase, Play, Radar, StickyNote, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { SEMANTIC_ICON, token } from '@/soc/components/palette';

import { RefLink } from '../context';
import { instantOf, utcDateKey, utcDay, utcHm } from '../format';
import type { TimelineBlock, TimelineKind } from '../schema';

const KIND_ICON: Record<TimelineKind, LucideIcon> = {
  alert: Bell,
  detection: Radar,
  case: Briefcase,
  action: Play,
  note: StickyNote,
};

const KIND_LABEL: Record<TimelineKind, string> = {
  alert: 'Alert',
  detection: 'Detection',
  case: 'Case',
  action: 'Action',
  note: 'Note',
};

const STRIP_BUCKETS = 24;

/** Events per bucket across the timeline's span (decorative density strip). */
export function densityBuckets(instants: ReadonlyArray<number | null>, buckets = STRIP_BUCKETS): number[] {
  const ms = instants.filter((v): v is number => v !== null);
  const out = Array.from({ length: buckets }, () => 0);
  if (!ms.length) return out;
  const lo = Math.min(...ms);
  const hi = Math.max(...ms);
  const span = Math.max(1, hi - lo);
  for (const t of ms) out[Math.min(buckets - 1, Math.floor(((t - lo) / span) * buckets))] += 1;
  return out;
}

function DensityStrip({ block }: { block: TimelineBlock }) {
  const counts = densityBuckets(block.events.map((e) => instantOf(e.at)));
  const max = Math.max(1, ...counts);
  return (
    <svg aria-hidden viewBox={`0 0 ${counts.length * 6} 20`} preserveAspectRatio="none" className="mb-2 block h-5 w-full" data-testid="timeline-density">
      {counts.map((c, i) => {
        const h = c ? Math.max(2, (c / max) * 20) : 0;
        return c ? <rect key={i} x={i * 6 + 1} y={20 - h} width={4} height={h} fill={token('muted-foreground', 0.5)} /> : null;
      })}
    </svg>
  );
}

export function TimelineView({ block }: { block: TimelineBlock }) {
  if (!block.events.length) return <p className="text-sm text-muted-foreground">No events.</p>;
  let lastDay = '';
  return (
    <div className="min-w-0" data-testid="block-timeline">
      {block.events.length >= 10 ? <DensityStrip block={block} /> : null}
      <ol className="relative space-y-0">
        {block.events.map((ev, i) => {
          const ms = instantOf(ev.at);
          const day = utcDateKey(ev.at);
          const newDay = day !== lastDay;
          lastDay = day;
          const Icon = ev.semantic ? SEMANTIC_ICON[ev.semantic] : ev.kind ? KIND_ICON[ev.kind] : undefined;
          return (
            <li key={i} className="relative grid grid-cols-[3.5rem_1rem_minmax(0,1fr)] gap-x-2 pb-3 last:pb-0">
              {newDay ? (
                <p className="col-span-3 mb-1 mt-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {ms !== null ? `${utcDay(ms)} (UTC)` : ev.at}
                </p>
              ) : null}
              <time dateTime={ev.at} className="pt-0.5 text-right text-2xs tabular-nums text-muted-foreground">
                {ms !== null && ev.at.length > 10 ? utcHm(ms) : ''}
              </time>
              <span className="relative flex justify-center pt-1" aria-hidden>
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
                <span className="relative flex size-4 items-center justify-center rounded-full border border-border bg-background">
                  {Icon ? <Icon className="size-2.5 text-muted-foreground" /> : <span className="size-1.5 rounded-full bg-muted-foreground" />}
                </span>
              </span>
              <div className="min-w-0">
                <p className={cn('break-words text-sm text-foreground', block.untrusted && 'font-mono text-xs')}>
                  {ev.kind ? <span className="sr-only">{KIND_LABEL[ev.kind]}: </span> : null}
                  {ev.label}
                  {ev.ref ? (
                    <>
                      {' '}
                      <RefLink refValue={ev.ref} className="text-xs">
                        Open ›
                      </RefLink>
                    </>
                  ) : null}
                </p>
                {ev.detail ? (
                  block.untrusted ? (
                    <CodeBlock value={ev.detail} copyable={false} wrap maxHeightClassName="max-h-32" className="mt-1 [&_pre]:p-2 [&_pre]:text-xs" />
                  ) : (
                    <p className="mt-0.5 whitespace-pre-line break-words text-xs text-muted-foreground">{ev.detail}</p>
                  )
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
