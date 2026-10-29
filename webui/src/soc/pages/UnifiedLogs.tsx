/**
 * Logs: the `logs` route (Triage). Without a deep link it is the shared unified browser
 * (`UnifiedLogsBody`: recent events merged across every browse-capable source).
 *
 * With the chat's "Open in Logs" deep link (SPEC §10.7: `logQuery`, `from`, `to`,
 * `sourceId` NavOpts, serialised as `#/logs?logQuery=…`) the SAME browser opens on the
 * LINKED QUERY: the exact filter the answer used, with those bounds (absolute UTC
 * instants read as one readable range) and that source, summarised above the controls so
 * the analyst sees what the numbers were based on. "Browse all logs" drops the link and
 * returns to the default browser.
 *
 * Round 14 (SPEC §4.6.6): the link may also carry exact filters the server applies,
 * `rule` ("Rule is", the value kept byte for byte, spaces and any script allowed),
 * `severity` ("Severity is High") and `severity_gte` ("Severity High or above"). Each is
 * a removable chip; the Rule column is left out while "Rule is" fixes it; the matched
 * count is stated from the server's `matched` figure ("381 events · last 3 days", or "At
 * least 1,000 events" when a source could not count exactly), never a sum of the rows
 * shown, with which sources applied the filter exactly. Opened from an answer (a chat
 * drill, a rule sheet opened from an answer), the header offers the way back to it.
 *
 * The router already validated the link; this page validates it AGAIN (it is reachable
 * through a typed-in hash) and ignores the whole link when any part is malformed. A
 * well-formed link whose window is longer than the 90 days Logs reads keeps every filter
 * and reads the last 90 days of that window, and the header says so: an exact filter is
 * never dropped in favour of the unfiltered browser (a rule sheet over the last 6 months
 * leads here). Every
 * row value, rule value and source name is UNTRUSTED source data (#9): plain text, and
 * `_raw` only in a fenced code block. Read-only: nothing here writes.
 */
import * as React from 'react';
import { ArrowLeft, X } from 'lucide-react';

import type { NavOpts } from '@/lib/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { answerOrigin, clearAnswerOrigin, type AnswerOrigin } from '@/soc/answer-origin';
import { PANEL_PADDING } from '@/design-system';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { UnifiedLogsBody } from '@/soc/components/UnifiedLogsSheet';
import { useNavigateOptional, useRoute } from '@/soc/router';
import type {
  LogSeverityLevel,
  UnifiedLogSourceStatus,
  UnifiedLogsMatched,
  UnifiedLogsResponse,
} from '@/soc/UnifiedLogs.api';

/* -------------------------------------------------------------------------- */
/* The deep link.                                                              */
/* -------------------------------------------------------------------------- */

/** The router's grammars (router.tsx `DEEP_LINK_KEYS`), re-checked at the point of use. */
const SOURCE_ID_RE = /^[\w.:-]{1,128}$/;
const TIME_RE = /^(now(-\d{1,5}[mhdw])?|\d{4}-\d\d-\d\d[\dTt:.Zz+-]{0,24})$/;
const QUERY_RE = /^[^\p{C}\u2028\u2029]{1,512}$/u;
/** "Rule is": the exact rule value (the `logQuery` rule at 256 characters, SPEC §4.6.6). */
const RULE_RE = /^[^\p{C}\u2028\u2029]{1,256}$/u;
const LEVEL_RE = /^(info|low|medium|high|critical)$/;
/** The longest window a linked query may span (the chat's own bound, SPEC §3.1). */
export const MAX_WINDOW_DAYS = 90;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 86_400_000;

export interface LogsDeepLink {
  query: string | null;
  from: string | null;
  to: string | null;
  sourceId: string | null;
  /** Round 14: "Rule is", the exact rule value, kept byte for byte (present only when set). */
  rule?: string;
  /** Round 14: "Severity is High", one named level (present only when set). */
  severity?: LogSeverityLevel;
  /** Round 14: "Severity High or above" (present only when set). */
  severityGte?: LogSeverityLevel;
  /**
   * The link asked for a window longer than Logs reads: `from` is the start of its last
   * 90 days and `requestedFrom` the start it asked for (kept in the hash when a chip is
   * removed, so the view and its notice stay the same). Present only when narrowed.
   */
  requestedFrom?: string;
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

const isLevel = (value: unknown): value is LogSeverityLevel => typeof value === 'string' && LEVEL_RE.test(value);

/**
 * The validated logs deep link, or null when there is none or ANY part is malformed
 * (a bad link is ignored whole, never half-applied). A window longer than 90 days is not
 * malformed: it is narrowed to its last 90 days (`requestedFrom` keeps the asked start),
 * so a link's exact filters still apply.
 */
export function parseLogsDeepLink(opts: NavOpts | null | undefined, now: number = Date.now()): LogsDeepLink | null {
  if (!opts) return null;
  const { logQuery, from, to, sourceId, rule, severity, severity_gte: severityGte } = opts;
  if (
    [logQuery, from, to, sourceId, rule, severity, severityGte].every((value) => value === undefined)
  ) {
    return null;
  }
  if (logQuery !== undefined && (typeof logQuery !== 'string' || !QUERY_RE.test(logQuery) || !logQuery.trim())) return null;
  if (from !== undefined && (typeof from !== 'string' || !TIME_RE.test(from))) return null;
  if (to !== undefined && (typeof to !== 'string' || !TIME_RE.test(to))) return null;
  if (sourceId !== undefined && (typeof sourceId !== 'string' || !SOURCE_ID_RE.test(sourceId))) return null;
  // The rule value is matched exactly, so it is never trimmed; a blank one names nothing.
  if (rule !== undefined && (typeof rule !== 'string' || !RULE_RE.test(rule) || !rule.trim())) return null;
  if (severity !== undefined && !isLevel(severity)) return null;
  if (severityGte !== undefined && !isLevel(severityGte)) return null;
  let windowFrom = from;
  if (from !== undefined) {
    const start = boundMs(from, now);
    const end = boundMs(to ?? 'now', now);
    if (start === null || end === null || start >= end) return null;
    if (end - start > MAX_WINDOW_MS) {
      // The last 90 days of the asked window: relative to now when it ends now, else from
      // its absolute end.
      windowFrom = to === undefined || to === 'now' ? `now-${MAX_WINDOW_DAYS}d` : new Date(end - MAX_WINDOW_MS).toISOString();
    }
  } else if (to !== undefined && boundMs(to, now) === null) {
    return null;
  }
  return {
    query: logQuery ?? null,
    from: windowFrom ?? null,
    to: to ?? null,
    sourceId: sourceId ?? null,
    ...(rule !== undefined ? { rule } : {}),
    ...(isLevel(severity) ? { severity } : {}),
    ...(isLevel(severityGte) ? { severityGte } : {}),
    ...(windowFrom !== from && from !== undefined ? { requestedFrom: from } : {}),
  };
}

/**
 * The link as router NavOpts (a chip removed, the rest kept exactly). A narrowed window
 * keeps the start the link asked for, so the page narrows it again the same way.
 */
export function logsLinkOpts(link: LogsDeepLink): NavOpts {
  const from = link.requestedFrom ?? link.from;
  return {
    ...(link.query ? { logQuery: link.query } : {}),
    ...(from ? { from } : {}),
    ...(link.to ? { to: link.to } : {}),
    ...(link.sourceId ? { sourceId: link.sourceId } : {}),
    ...(link.rule !== undefined ? { rule: link.rule } : {}),
    ...(link.severity ? { severity: link.severity } : {}),
    ...(link.severityGte ? { severity_gte: link.severityGte } : {}),
  };
}

/** Whether the link still carries anything (a query, a window, a source or a filter). */
function linkCarriesAnything(link: LogsDeepLink): boolean {
  return Object.keys(logsLinkOpts(link)).length > 0;
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

const UNIT_WORDS: Record<string, [string, string]> = {
  m: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
  w: ['week', 'weeks'],
};

/**
 * How a linked window reads (SPEC A14, Round 14 §4.6.6): `last 3 days` for
 * `now-3d → now`; absolute instants as one readable UTC range (`2026-10-01 12:00 →
 * 2026-10-08 12:00 UTC`, the date written once when both fall on the same day, seconds
 * only when a bound has them, never the raw `…T12:00:00.250Z`). A relative bound paired
 * with another bound keeps its own grammar.
 */
export function windowLabel(from: string | null, to: string | null): string {
  const end = to ?? 'now';
  if (!from) {
    if (!to) return 'the default window';
    const d = absoluteBound(to);
    return d ? `until ${utcDate(d)} ${utcTime(d, hasSeconds(d))} UTC` : `until ${to}`;
  }
  const rel = /^now-(\d{1,5})([mhdw])$/.exec(from);
  if (rel && end === 'now') {
    const n = Number(rel[1]);
    const [one, many] = UNIT_WORDS[rel[2]];
    return `last ${n} ${n === 1 ? one : many}`;
  }
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
/* What the filtered read found.                                               */
/* -------------------------------------------------------------------------- */

/** A named level as a word ("High"). */
export function levelWord(level: LogSeverityLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

/**
 * The matched count line (SPEC §4.6.6), from the server's `matched` figure over every
 * source read, never the rows shown: "381 events · last 3 days", "At least 1,000 events
 * · last 3 days" when a source could only give a floor, "No events counted · …" for a
 * floor of zero (a source failed or could not count, so "none" would be untrue).
 */
export function matchedPhrase(matched: UnifiedLogsMatched, windowText?: string | null): string {
  const n = Math.max(0, Math.floor(Number(matched.count) || 0));
  const figure = `${n.toLocaleString('en-US')} ${n === 1 ? 'event' : 'events'}`;
  const head = matched.relation === 'eq' ? figure : n === 0 ? 'No events counted' : `At least ${figure}`;
  return windowText ? `${head} · ${lowerFirst(windowText)}` : head;
}

const sourceName = (s: UnifiedLogSourceStatus) => (s.source_name || s.source_id).slice(0, 120);

/** "A", "A and B", "A, B and 2 more": source names, plain text. */
function nameList(sources: UnifiedLogSourceStatus[]): string {
  const names = sources.map(sourceName);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/**
 * Which sources applied the filter exactly (SPEC §4.6.6): "Sources: all 5 that support
 * browsing" when every source did, otherwise how many did and which were filtered only
 * after a bounded read (a live-tail buffer, part of a store) or could not be read. Null
 * when the server did not say (an older backend), or for a link pinned to one source
 * that applied it exactly (its name is already on the Source line).
 */
export function sourcesPhrase(sources: UnifiedLogSourceStatus[], pinnedSource = false): string | null {
  if (!sources.length || !sources.some((s) => typeof s.exact === 'boolean' || !s.ok)) return null;
  const failed = sources.filter((s) => !s.ok);
  const bounded = sources.filter((s) => s.ok && s.exact !== true);
  const exact = sources.length - failed.length - bounded.length;
  if (sources.length === 1) {
    const only = sources[0];
    if (!only.ok) return `Source: ${sourceName(only)} could not be read`;
    if (bounded.length) return `Source: ${sourceName(only)}, filtered after a bounded read`;
    return pinnedSource ? null : `Source: ${sourceName(only)}`;
  }
  if (!failed.length && !bounded.length) return `Sources: all ${sources.length} that support browsing`;
  const parts = [`${exact} of ${sources.length} applied the filter exactly`];
  if (bounded.length) parts.push(`filtered after a bounded read: ${nameList(bounded)}`);
  if (failed.length) parts.push(`could not be read: ${nameList(failed)}`);
  return `Sources: ${parts.join('; ')}`;
}

/** What a filtered read reported, for the header's count line. */
export interface LogsReadSummary {
  matched: UnifiedLogsMatched | null;
  sources: UnifiedLogSourceStatus[];
  windowLabel: string;
}

/* -------------------------------------------------------------------------- */
/* The linked query's summary.                                                 */
/* -------------------------------------------------------------------------- */

type FilterId = 'rule' | 'severity' | 'severityGte';

interface LinkFilterChip {
  id: FilterId;
  /** The chip's words, for its accessible name ("Rule is ssh_bruteforce"). */
  label: string;
  content: React.ReactNode;
  /** The full value as a tooltip when the chip cuts it. */
  title?: string;
}

function linkChips(link: LogsDeepLink): LinkFilterChip[] {
  const chips: LinkFilterChip[] = [];
  if (link.rule !== undefined) {
    chips.push({
      id: 'rule',
      label: `Rule is ${link.rule}`,
      // Untrusted: a text node in mono, never interpreted.
      content: (
        <>
          Rule is <span className="font-mono">{link.rule}</span>
        </>
      ),
      title: link.rule,
    });
  }
  if (link.severity) {
    const label = `Severity is ${levelWord(link.severity)}`;
    chips.push({ id: 'severity', label, content: label });
  }
  if (link.severityGte) {
    const label = `Severity ${levelWord(link.severityGte)} or above`;
    chips.push({ id: 'severityGte', label, content: label });
  }
  return chips;
}

/** The link without one filter. */
export function withoutFilter(link: LogsDeepLink, id: FilterId): LogsDeepLink {
  const next: LogsDeepLink = { ...link };
  delete next[id];
  return next;
}

/**
 * What the linked view was opened with, above the ONE shared log browser (which starts
 * on exactly this query, window and source and stays editable): the exact filters as
 * removable chips, the query, window and source, and for a filtered read the matched
 * count and which sources applied the filter exactly.
 */
export function LinkedQueryHeader({
  link,
  onClear,
  sourceName: linkedSourceName = null,
  onRemoveFilter,
  summary = null,
  origin = null,
}: {
  link: LogsDeepLink;
  onClear: () => void;
  /** The linked source's configured name, once a read has resolved it. */
  sourceName?: string | null;
  /** Remove one exact filter (a chip); the rest of the link stays. */
  onRemoveFilter?: (id: FilterId) => void;
  /** The latest filtered read (the count line), or null before one lands. */
  summary?: LogsReadSummary | null;
  /** The answer this view was opened from ("Back to answer"), if any. */
  origin?: AnswerOrigin | null;
}) {
  const chips = linkChips(link);
  const filtered = chips.length > 0;
  const chipRefs = React.useRef(new Map<FilterId, HTMLButtonElement>());
  const clearRef = React.useRef<HTMLButtonElement>(null);
  const sectionRef = React.useRef<HTMLElement>(null);
  // Removing a chip moves focus to the next chip, else the previous one, else "Browse
  // all logs" (ui-standard, Filters): never to the page body.
  const pendingFocus = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const next = chips[Math.min(index, chips.length - 1)];
    const target = (next && chipRefs.current.get(next.id)) || clearRef.current || sectionRef.current;
    target?.focus();
  });
  // The count names the window its read used ("381 events · last 3 days"), so the live
  // announcement is whole on its own and stays right after another range is picked.
  const countLine = filtered && summary?.matched ? matchedPhrase(summary.matched, summary.windowLabel) : null;
  const sourcesLine = filtered && summary ? sourcesPhrase(summary.sources, Boolean(link.sourceId)) : null;

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label="Linked query"
      // On the tinted panel, like every module (Round 14, C7).
      className={cn('surface-panel flex flex-wrap items-start justify-between gap-3 focus-visible:outline-none', PANEL_PADDING)}
      data-testid="linked-logs"
    >
      {/* A real basis (20rem) so the actions wrap onto their own row on a narrow screen
          instead of squeezing the chips to a letter each. */}
      <div className="min-w-0 flex-[1_1_20rem] space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Opened from a linked query</p>
        {filtered ? (
          <ul className="flex flex-wrap items-center gap-2" aria-label="Exact filters" data-testid="logs-filter-chips">
            {chips.map((chip, index) => (
              <li key={chip.id} className="min-w-0 max-w-full">
                <button
                  ref={(el) => {
                    if (el) chipRefs.current.set(chip.id, el);
                    else chipRefs.current.delete(chip.id);
                  }}
                  type="button"
                  onClick={() => {
                    pendingFocus.current = index;
                    onRemoveFilter?.(chip.id);
                  }}
                  aria-label={`Remove filter: ${chip.label}`}
                  title={chip.title}
                  data-filter={chip.id}
                  className={cn(
                    'inline-flex h-7 max-w-full items-center gap-1 rounded-sm border border-border bg-muted px-2 text-xs text-foreground transition-colors sm:max-w-[28rem]',
                    'hover:border-border-strong hover:bg-hover',
                    // On the panel the ring's offset is the panel's own colour (no halo).
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
                  )}
                >
                  <span className="min-w-0 truncate">{chip.content}</span>
                  <X className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
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
          <dd className="tabular-nums">
            {windowLabel(link.from, link.to)}
            {link.requestedFrom ? (
              <span className="block text-xs text-muted-foreground" data-testid="logs-window-narrowed">
                Logs reads at most {MAX_WINDOW_DAYS} days, so this shows the last {MAX_WINDOW_DAYS} days of the linked
                window ({windowLabel(link.requestedFrom, link.to)}).
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="min-w-0 truncate" title={link.sourceId ?? undefined}>
            {/* The operator's name for the source (plain text, #9); its id only until a
                read resolves it, or if the source is no longer listed. */}
            {link.sourceId ? (
              linkedSourceName ? (
                linkedSourceName
              ) : (
                <span className="font-mono text-xs">{link.sourceId}</span>
              )
            ) : (
              'All browse-capable sources'
            )}
          </dd>
        </dl>
        {/* One polite live region for the whole filtered view: it is in the page before
            the first read lands and only its text changes, so each new count is announced
            (a region inserted together with its text usually is not). */}
        {filtered ? (
          <p className="min-h-5 text-sm" data-testid="logs-matched" aria-live="polite" aria-atomic="true">
            {countLine ? <span className="font-medium tabular-nums text-foreground">{countLine}</span> : null}
            {countLine && sourcesLine ? <span className="text-muted-foreground"> · </span> : null}
            {sourcesLine ? <span className="text-muted-foreground">{sourcesLine}</span> : null}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {origin ? (
          <Button asChild variant="ghost" size="sm">
            {/* The remembered hash of the page the answer is on, re-validated by its
                grammar in answer-origin.ts: never a URL from data. */}
            <a href={origin.hash} onClick={() => clearAnswerOrigin()}>
              <ArrowLeft className="h-4 w-4" aria-hidden /> {origin.label}
            </a>
          </Button>
        ) : null}
        <Button ref={clearRef} variant="ghost" size="sm" onClick={onClear}>
          <X className="h-4 w-4" aria-hidden /> Browse all logs
        </Button>
      </div>
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
  const rule = opts?.rule;
  const severity = opts?.severity;
  const severityGte = opts?.severity_gte;
  const link = React.useMemo(
    () => parseLogsDeepLink({ logQuery, from, to, sourceId, rule, severity, severity_gte: severityGte }),
    [logQuery, from, to, sourceId, rule, severity, severityGte],
  );
  const [dismissed, setDismissed] = React.useState(false);
  // A chip removed here, until the route catches up with it (an embed's opts never do).
  const [edited, setEdited] = React.useState<LogsDeepLink | null | undefined>(undefined);
  React.useEffect(() => {
    setDismissed(false);
    setEdited(undefined);
  }, [link]);
  const current = edited !== undefined ? edited : link;
  const active = current && !dismissed ? current : null;
  // The answer this view was opened from ("Back to answer"). Read when a link arrives and
  // kept while the person edits that link here (a removed chip); any other link (one a
  // rule sheet on this page opened, say) reads it again, and the store answers only for
  // the location the answer's drill opened (answer-origin.ts), so a later link on the
  // same page never inherits it, even when it renders before its `hashchange` arrives.
  const linkKey = link ? JSON.stringify(logsLinkOpts(link)) : '';
  const [origin, setOrigin] = React.useState<AnswerOrigin | null>(() => (link ? answerOrigin() : null));
  const seenLinkKey = React.useRef(linkKey);
  const editedLinkKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (seenLinkKey.current === linkKey) return;
    seenLinkKey.current = linkKey;
    const ownEdit = editedLinkKey.current === linkKey;
    editedLinkKey.current = null;
    if (!ownEdit) setOrigin(linkKey ? answerOrigin() : null);
  }, [linkKey]);
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
  // The latest filtered read's count; cleared when the filters change, so a figure is
  // never shown beside filters it was not counted for.
  const [summary, setSummary] = React.useState<LogsReadSummary | null>(null);
  const filterKey = `${active?.rule ?? ''}\u0000${active?.severity ?? ''}\u0000${active?.severityGte ?? ''}`;
  React.useEffect(() => setSummary(null), [filterKey]);
  const onResult = React.useCallback((res: UnifiedLogsResponse, read: { windowLabel: string }) => {
    setSummary({ matched: res.matched ?? null, sources: res.sources ?? [], windowLabel: read.windowLabel });
  }, []);
  // The last chip of a link, or "Browse all logs", takes the linked header with it: the
  // plain browser that replaces it takes focus on its search box (never the page body).
  // One shot: the browser reads it as it mounts, then it is cleared, so a later visit to
  // the plain browser never moves focus.
  const [focusBrowser, setFocusBrowser] = React.useState(false);
  React.useEffect(() => {
    if (focusBrowser && !active) setFocusBrowser(false);
  }, [focusBrowser, active]);
  const removeFilter = React.useCallback(
    (id: FilterId) => {
      if (!active) return;
      const next = withoutFilter(active, id);
      const keep = linkCarriesAnything(next);
      if (!keep) setFocusBrowser(true);
      setEdited(keep ? next : null);
      editedLinkKey.current = keep ? JSON.stringify(logsLinkOpts(next)) : '';
      // The hash follows, so a refresh shows what the chips show.
      if (keep) navigate('logs', logsLinkOpts(next));
      else navigate('logs');
    },
    [active, navigate],
  );
  const filtered = Boolean(active && (active.rule !== undefined || active.severity || active.severityGte));

  // The page header, with the browser's time range and Refresh in its controls slot
  // (Round 14, C8 1): the explanation is its help tip, never a line under the title.
  const help = filtered
    ? 'Events matching exact filters, read again from each source with the same bounds.'
    : active?.query
      ? 'The exact query behind an answer, read again from the source with the same bounds.'
      : active
        ? // A link with only a window and a source (its last chip removed, say).
          'Events over the linked window, read again with the same bounds.'
        : 'Recent normalised events merged across every browse-capable source, newest first.';
  const renderHeader = (controls: React.ReactNode) => <PageHeader title="Logs" help={help} controls={controls} />;

  return (
    <PageContainer variant="wide">
      {active ? (
        <UnifiedLogsBody
          // A new link starts a fresh browser on its own query, window and source; a
          // removed filter chip re-reads in place (the typed search and range stay).
          key={`${active.query ?? ''}|${active.from ?? ''}|${active.to ?? ''}|${active.sourceId ?? ''}`}
          initialQuery={active.query ?? undefined}
          initialFrom={active.from ?? undefined}
          initialTo={active.to ?? undefined}
          initialWindowLabel={windowLabel(active.from, active.to)}
          sourceId={active.sourceId ?? undefined}
          rule={active.rule}
          severity={active.severity}
          severityGte={active.severityGte}
          // "Rule is" fixes every row's rule, so the column would repeat it.
          hideRuleColumn={active.rule !== undefined}
          onSources={onSources}
          onResult={onResult}
          renderHeader={renderHeader}
          header={
            <LinkedQueryHeader
              link={active}
              sourceName={sourceName}
              onRemoveFilter={removeFilter}
              summary={summary}
              origin={origin}
              onClear={() => {
                setFocusBrowser(true);
                setDismissed(true);
                // Drop the deep link from the hash so a refresh shows the normal browser.
                navigate('logs');
              }}
            />
          }
        />
      ) : (
        <UnifiedLogsBody autoFocusSearch={focusBrowser} renderHeader={renderHeader} />
      )}
    </PageContainer>
  );
}
