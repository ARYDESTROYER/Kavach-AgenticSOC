/**
 * Logs — the `logs` route (Triage). Without a deep link it is the shared unified browser
 * (`UnifiedLogsBody`: recent events merged across every browse-capable source).
 *
 * With the chat's "Open in Logs" deep link (SPEC §10.7: `logQuery`, `from`, `to`,
 * `sourceId` NavOpts, serialised as `#/logs?logQuery=…`) the SAME browser opens on the
 * LINKED QUERY: the exact filter the answer used, with those bounds (absolute UTC
 * instants read as one readable range) and that source, summarised above the controls so
 * the analyst sees what the numbers were based on. "Browse all logs" drops the link and
 * returns to the default browser.
 *
 * The router already validated the link; this page validates it AGAIN (it is reachable
 * through a typed-in hash) and ignores the whole link when any part is malformed. Every
 * row value is UNTRUSTED source data (#9): plain text, and `_raw` only in a fenced code
 * block. Read-only: nothing here writes.
 */
import * as React from 'react';
import { Layers, X } from 'lucide-react';

import type { NavOpts } from '@/lib/types';
import { Button } from '@/ui/button';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { UnifiedLogsBody } from '@/soc/components/UnifiedLogsSheet';
import { useNavigateOptional, useRoute } from '@/soc/router';
import type { UnifiedLogSourceStatus } from '@/soc/UnifiedLogs.api';

/* -------------------------------------------------------------------------- */
/* The deep link.                                                              */
/* -------------------------------------------------------------------------- */

/** The router's grammars (router.tsx `DEEP_LINK_KEYS`), re-checked at the point of use. */
const SOURCE_ID_RE = /^[\w.:-]{1,128}$/;
const TIME_RE = /^(now(-\d{1,5}[mhdw])?|\d{4}-\d\d-\d\d[\dTt:.Zz+-]{0,24})$/;
const QUERY_RE = /^[^\p{C}\u2028\u2029]{1,512}$/u;
/** The longest window a linked query may span (the chat's own bound, SPEC §3.1). */
const MAX_WINDOW_MS = 90 * 86_400_000;

export interface LogsDeepLink {
  query: string | null;
  from: string | null;
  to: string | null;
  sourceId: string | null;
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Epoch ms of a bound (`now`, `now-<n><unit>` or ISO-8601), else null. */
export function boundMs(value: string, now: number = Date.now()): number | null {
  if (value === 'now') return now;
  const rel = /^now-(\d{1,5})([mhdw])$/.exec(value);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]];
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The validated logs deep link, or null when there is none or ANY part is malformed
 * (a bad link is ignored whole, never half-applied).
 */
export function parseLogsDeepLink(opts: NavOpts | null | undefined, now: number = Date.now()): LogsDeepLink | null {
  if (!opts) return null;
  const { logQuery, from, to, sourceId } = opts;
  if (logQuery === undefined && from === undefined && to === undefined && sourceId === undefined) return null;
  if (logQuery !== undefined && (typeof logQuery !== 'string' || !QUERY_RE.test(logQuery) || !logQuery.trim())) return null;
  if (from !== undefined && (typeof from !== 'string' || !TIME_RE.test(from))) return null;
  if (to !== undefined && (typeof to !== 'string' || !TIME_RE.test(to))) return null;
  if (sourceId !== undefined && (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId))) return null;
  if (from !== undefined) {
    const start = boundMs(from, now);
    const end = boundMs(to ?? 'now', now);
    if (start === null || end === null || start >= end || end - start > MAX_WINDOW_MS) return null;
  } else if (to !== undefined && boundMs(to, now) === null) {
    return null;
  }
  return { query: logQuery ?? null, from: from ?? null, to: to ?? null, sourceId: sourceId ?? null };
}

/** An ISO-8601 bound as a UTC instant, or null for `now` / a relative bound. */
function absoluteBound(value: string | null): Date | null {
  if (!value || value === 'now' || value.startsWith('now-')) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const utcDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcTime = (d: Date, seconds: boolean) =>
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ''}`;
const hasSeconds = (d: Date | null) => !!d && (d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0);

/**
 * How a linked window reads (SPEC A14): `last 24h` for `now-24h → now`; absolute
 * instants as one readable UTC range (`2026-10-01 12:00 → 2026-10-08 12:00 UTC`, the
 * date written once when both fall on the same day, seconds only when a bound has them,
 * never the raw `…T12:00:00.250Z`). A relative bound keeps its own grammar.
 */
export function windowLabel(from: string | null, to: string | null): string {
  const end = to ?? 'now';
  if (!from) {
    if (!to) return 'the default window';
    const d = absoluteBound(to);
    return d ? `until ${utcDate(d)} ${utcTime(d, hasSeconds(d))} UTC` : `until ${to}`;
  }
  const rel = /^now-(\d{1,5})([mhdw])$/.exec(from);
  if (rel && end === 'now') return `last ${rel[1]}${rel[2]}`;
  const a = absoluteBound(from);
  const b = absoluteBound(end);
  const seconds = hasSeconds(a) || hasSeconds(b);
  if (a && b) {
    const tail = utcDate(a) === utcDate(b) ? utcTime(b, seconds) : `${utcDate(b)} ${utcTime(b, seconds)}`;
    return `${utcDate(a)} ${utcTime(a, seconds)} → ${tail} UTC`;
  }
  const side = (d: Date | null, raw: string) => (d ? `${utcDate(d)} ${utcTime(d, seconds)} UTC` : raw);
  return `${side(a, from)} → ${side(b, end)}`;
}

/* -------------------------------------------------------------------------- */
/* The linked query's summary.                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the linked view was opened with, above the ONE shared log browser (which starts
 * on exactly this query, window and source and stays editable).
 */
export function LinkedQueryHeader({
  link,
  onClear,
  sourceName = null,
}: {
  link: LogsDeepLink;
  onClear: () => void;
  /** The linked source's configured name, once a read has resolved it. */
  sourceName?: string | null;
}) {
  return (
    <section
      aria-label="Linked query"
      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3"
      data-testid="linked-logs"
    >
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Opened from a linked query</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {link.query ? (
            <>
              <dt className="text-muted-foreground">Query</dt>
              <dd className="min-w-0">
                {/* Untrusted: shown verbatim as code, never interpreted. */}
                <code className="break-all rounded bg-muted px-1 font-mono text-xs">{link.query}</code>
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Window</dt>
          <dd className="tabular-nums">{windowLabel(link.from, link.to)}</dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="min-w-0 truncate" title={link.sourceId ?? undefined}>
            {/* The operator's name for the source (plain text, #9); its id only until a
                read resolves it, or if the source is no longer listed. */}
            {link.sourceId ? (
              sourceName ? (
                sourceName
              ) : (
                <span className="font-mono text-xs">{link.sourceId}</span>
              )
            ) : (
              'All browse-capable sources'
            )}
          </dd>
        </dl>
      </div>
      <Button variant="ghost" size="sm" className="shrink-0" onClick={onClear}>
        <X className="h-4 w-4" aria-hidden /> Browse all logs
      </Button>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The page.                                                                   */
/* -------------------------------------------------------------------------- */

export interface UnifiedLogsPageProps {
  /**
   * NavOpts to read instead of the router's (an embed or a test). The route itself passes
   * nothing: the page reads the router, so the registry carries no render thunk.
   */
  opts?: NavOpts;
}

export default function UnifiedLogsPage({ opts: explicit }: UnifiedLogsPageProps = {}) {
  const navigate = useNavigateOptional();
  const route = useRoute();
  const opts = explicit ?? (route.page === 'logs' ? route.opts : undefined);
  const logQuery = opts?.logQuery;
  const from = opts?.from;
  const to = opts?.to;
  const sourceId = opts?.sourceId;
  const link = React.useMemo(
    () => parseLogsDeepLink({ logQuery, from, to, sourceId }),
    [logQuery, from, to, sourceId],
  );
  const [dismissed, setDismissed] = React.useState(false);
  React.useEffect(() => setDismissed(false), [link]);
  const active = link && !dismissed ? link : null;
  // The linked source's name, from the browser's own per-source status.
  const [sourceName, setSourceName] = React.useState<string | null>(null);
  const linkedSourceId = active?.sourceId ?? null;
  React.useEffect(() => setSourceName(null), [linkedSourceId]);
  const onSources = React.useCallback(
    (sources: UnifiedLogSourceStatus[]) => {
      if (!linkedSourceId) return;
      const match = sources.find((s) => s.source_id === linkedSourceId);
      const name = match?.source_name?.trim();
      if (name) setSourceName(name.slice(0, 120));
    },
    [linkedSourceId],
  );

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={Layers}
        eyebrow="Triage"
        title="Logs"
        description={
          active
            ? 'The exact query behind an answer, read again from the source with the same bounds.'
            : 'Recent normalised events merged across every browse-capable source, newest first.'
        }
      />
      {active ? (
        <UnifiedLogsBody
          // A new link starts a fresh browser on its own query, window and source.
          key={`${active.query ?? ''}|${active.from ?? ''}|${active.to ?? ''}|${active.sourceId ?? ''}`}
          initialQuery={active.query ?? undefined}
          initialFrom={active.from ?? undefined}
          initialTo={active.to ?? undefined}
          initialWindowLabel={windowLabel(active.from, active.to)}
          sourceId={active.sourceId ?? undefined}
          onSources={onSources}
          header={
            <LinkedQueryHeader
              link={active}
              sourceName={sourceName}
              onClear={() => {
                setDismissed(true);
                // Drop the deep link from the hash so a refresh shows the normal browser.
                navigate('logs');
              }}
            />
          }
        />
      ) : (
        <UnifiedLogsBody />
      )}
    </PageContainer>
  );
}
