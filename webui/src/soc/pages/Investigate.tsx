/**
 * Investigate — start an ad-hoc, agentic investigation of an entity.
 *
 * Submits POST /api/investigate ({ entity, group_by, source_surface, lookback })
 * and renders the returned Case as a rich verdict card: badge row, recommended
 * action, evidence, MITRE techniques, the reproduce query, and the risk
 * breakdown. A 400 "no events" response is rendered as a neutral empty state
 * (not a scary error) with a hint to widen the lookback. Each completed run is
 * kept in a small per-session history (sessionStorage).
 *
 * SECURITY: every value derived from the backend (titles, summaries, entity
 * values, evidence text, MITRE ids, the reproduce query, rule ids) is UNTRUSTED
 * and rendered as PLAIN text or inside <CodeBlock>/<InlineCode> — never via
 * dangerouslySetInnerHTML.
 */
import * as React from 'react';
import {
  Globe,
  User as UserIcon,
  Monitor,
  Play,
  Search,
  Save,
  ExternalLink,
  Megaphone,
  GitBranch,
  Clock,
  Telescope,
  Database,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { Case, Entity, Evidence } from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import { DASH, fmtMoney, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { LoadingState, Panel, PANEL_GAP } from '@/design-system';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { CodeBlock, InlineCode } from '@/soc/components/CodeBlock';
import {
  VerdictBadge,
  RiskBadge,
  ConfidenceBadge,
  StatusBadge,
} from '@/soc/components/badges';

import { CaseDetail } from '@/soc/pages/CaseDetail';
import { useNavigateOptional, type Navigate } from '@/soc/router';

/* ---------------------------------------------------------------- consts --- */

/** sessionStorage key for the in-session investigation history. */
const RECENT_KEY = 'tlsoc.investigate.recent';
const RECENT_CAP = 6;

type EntityType = Entity['type'];

interface EntityOption {
  id: EntityType;
  label: string;
  placeholder: string;
  icon: LucideIcon;
}

const ENTITY_OPTIONS: EntityOption[] = [
  { id: 'ip', label: 'IP', placeholder: 'e.g. 10.0.0.5', icon: Globe },
  { id: 'user', label: 'User', placeholder: 'e.g. jdoe', icon: UserIcon },
  { id: 'host', label: 'Host', placeholder: 'e.g. web-prod-01', icon: Monitor },
];

interface LookbackOption {
  value: string;
  label: string;
}

const LOOKBACK_OPTIONS: LookbackOption[] = [
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
  { value: 'now-30d', label: 'Last 30 days' },
];

/** A finished run in the session history. */
interface RunRecord {
  id: string;
  entity: Entity;
  lookback: string;
  case: Case;
}

/* ------------------------------------------------------------- helpers ----- */

function entityIcon(t: EntityType): LucideIcon {
  return ENTITY_OPTIONS.find((o) => o.id === t)?.icon ?? Telescope;
}

function lookbackLabelFor(value: string): string {
  return LOOKBACK_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** Round a factor to at most two decimals for the bar-list value label. */
function roundFactor(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pull a numeric risk-factor map off the case (if the backend included one) and
 *  shape it as ranked rows for the shared `BarList`. */
function riskFactors(c: Case): BarListItem[] {
  const candidates = [
    c['risk_factors'],
    c['risk_breakdown'],
    c['risk_components'],
  ];
  for (const raw of candidates) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: BarListItem[] = [];
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isNaN(n)) {
          out.push({ label: humanizeToken(k), value: n });
        }
      }
      if (out.length) return out.sort((a, b) => b.value - a.value);
    }
  }
  return [];
}

/** The page's explanation, in its help tip (Round 14, C8: never a line under the title). */
export const INVESTIGATE_HELP =
  'Check one IP, user or host across the selected log window. Matching evidence is correlated, investigated and saved as a case.';

/** How an investigation works, shown before the first run. */
const INVESTIGATE_STEPS: ReadonlyArray<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Database,
    title: '1. Scope telemetry',
    body: 'Search configured sources for one IP, user, or host in the selected lookback.',
  },
  {
    icon: ShieldCheck,
    title: '2. Analyze evidence',
    body: 'Correlate matching events, enrich context, score risk, and explain the assessment.',
  },
  {
    icon: Save,
    title: '3. Create a case',
    body: 'Persist the result in the shared case queue for review, assignment, and action.',
  },
];

/* ------------------------------------------------------------ result view -- */

/** A section title inside the result (sentence case, the panel's sub-heading). UNTRUSTED-
 *  safe: children are static literals only. */
const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="text-sm font-semibold text-foreground">{children}</h3>
);

const ResultCard: React.FC<{ c: Case; onOpen?: (caseId: string) => void }> = ({
  c,
  onOpen,
}) => {
  const entityLabel = c.entity
    ? `${humanizeToken(c.entity.type)} · ${c.entity.value}`
    : DASH;
  const evidence: Evidence[] = Array.isArray(c.evidence) ? c.evidence : [];
  const mitre: string[] = Array.isArray(c.mitre) ? c.mitre : [];
  const factors = riskFactors(c);
  const ruleIds: string[] = Array.isArray(c.rule_ids) ? c.rule_ids : [];

  return (
    // The result is one module on the tinted panel (Round 14, C7): no card inside it.
    <Panel as="article" aria-label="Investigation result" data-testid="investigation-result">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h2 className="text-lg font-semibold leading-snug text-foreground">
            {c.title || `Investigation: ${entityLabel}`}
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
            {c.entity ? (
              <span className="inline-flex items-center gap-1.5">
                <span>{humanizeToken(c.entity.type)}</span>
                <InlineCode value={c.entity.value} />
              </span>
            ) : (
              <span>{DASH}</span>
            )}
            <span aria-hidden>·</span>
            <span>updated {humanizeAge(c.updated_at || c.created_at)}</span>
          </p>
        </div>
        {onOpen && c.case_id ? (
          <Button size="sm" onClick={() => onOpen(c.case_id)}>
            <ExternalLink className="size-4" aria-hidden />
            Open case
          </Button>
        ) : null}
      </div>

      <div className="mt-5 space-y-6">
        {/* Badge row */}
        <div className="flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={c.verdict} />
          <RiskBadge score={c.risk_score} />
          <ConfidenceBadge confidence={c.confidence} />
          <StatusBadge status={c.status} />
        </div>

        {/* Summary */}
        {c.summary ? (
          <p className="max-w-prose whitespace-pre-wrap text-sm text-foreground">{c.summary}</p>
        ) : null}

        {/* Recommended action */}
        {c.recommended_action ? (
          <section className="space-y-2.5">
            <SectionLabel>
              <span className="inline-flex items-center gap-1.5">
                <Megaphone className="size-4 text-muted-foreground" aria-hidden />
                Recommended action
              </span>
            </SectionLabel>
            <p className="max-w-prose whitespace-pre-wrap text-sm text-foreground">{c.recommended_action}</p>
          </section>
        ) : null}

        {/* Evidence */}
        {evidence.length ? (
          <section className="space-y-2.5">
            <SectionLabel>Evidence</SectionLabel>
            <ul className="divide-y divide-border/70">
              {evidence.map((ev, i) => (
                <li key={i} className="flex items-start gap-3 py-3 first:pt-0">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="text-sm leading-relaxed text-foreground">{ev.summary}</p>
                    {ev.event_ids && ev.event_ids.length ? (
                      <p className="text-xs text-muted-foreground">
                        {ev.event_ids.length} event
                        {ev.event_ids.length === 1 ? '' : 's'}
                      </p>
                    ) : null}
                    {ev.query ? <CodeBlock value={ev.query} caption="query" wrap /> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* MITRE */}
        {mitre.length ? (
          <section className="space-y-2.5">
            <SectionLabel>MITRE ATT&amp;CK</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {mitre.map((m) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground"
                >
                  <GitBranch className="size-3 text-muted-foreground" aria-hidden />
                  {m}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {/* Risk breakdown */}
        {factors.length ? (
          <section className="space-y-2.5">
            <SectionLabel>Risk breakdown</SectionLabel>
            <BarList items={factors} format={(n) => String(roundFactor(n))} />
          </section>
        ) : null}

        {/* Reproduce query */}
        {c.reproduce_query ? (
          <section className="space-y-2.5">
            <SectionLabel>Reproduce query</SectionLabel>
            <CodeBlock value={c.reproduce_query} caption="reproduce" wrap />
          </section>
        ) : null}

        {/* Facts grid */}
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 border-t border-border/70 pt-5 text-sm sm:grid-cols-2">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Case</dt>
            <dd className="min-w-0 truncate text-right">
              <InlineCode value={c.case_number || c.case_id} />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Entity</dt>
            <dd className="min-w-0 truncate text-right text-foreground">{entityLabel}</dd>
          </div>
          {ruleIds.length ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Rules</dt>
              <dd className="min-w-0 truncate text-right">
                <InlineCode value={ruleIds.join(', ')} />
              </dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Members</dt>
            <dd className="text-right tabular-nums text-foreground">
              {String(c.member_event_keys?.length || c.member_event_ids?.length || 0)} events
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Investigation cost</dt>
            <dd className="text-right font-mono tabular-nums text-foreground">{fmtMoney(c.token_cost)}</dd>
          </div>
        </dl>

        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Save className="size-4 shrink-0" aria-hidden />
          Saved to the case queue. Review it in Cases.
        </p>
      </div>
    </Panel>
  );
};

/** The standalone page's column: modules one panel gutter apart. */
function StandaloneColumn({ children }: { children?: React.ReactNode }) {
  return <div className={cn('flex flex-col', PANEL_GAP)}>{children}</div>;
}

/* ---------------------------------------------------------------- page ----- */

export interface InvestigateProps {
  onNavigate?: Navigate;
  /**
   * When hosted as a tab inside the Workspace scaffold (Round-2 W4 consolidation),
   * suppress the page's own PageHeader and surface only the "View cases" action so
   * the host owns the title (no duplicate headers).
   */
  embedded?: boolean;
}

export default function Investigate({ onNavigate, embedded = false }: InvestigateProps = {}) {
  // Coupling-A: prop wins (host/test); else resolve navigate from the router context.
  // Call the hook UNCONDITIONALLY (rules-of-hooks), then let an explicit prop win.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const [entityType, setEntityType] = React.useState<EntityType>('ip');
  const [entityValue, setEntityValue] = React.useState('');
  const [lookback, setLookback] = React.useState<string>('now-24h');

  const [result, setResult] = React.useState<Case | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [noEvents, setNoEvents] = React.useState<{
    entity: Entity;
    lookback: string;
  } | null>(null);
  const [runningEntity, setRunningEntity] = React.useState<Entity | null>(null);
  const [emptySubmit, setEmptySubmit] = React.useState(false);
  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);

  // Hydrate the in-session history from sessionStorage so it survives a soft
  // navigation away and back within the same tab.
  const [recent, setRecent] = React.useState<RunRecord[]>(() => {
    try {
      const raw = sessionStorage.getItem(RECENT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed)
        ? (parsed as RunRecord[]).slice(0, RECENT_CAP)
        : [];
    } catch {
      return [];
    }
  });

  // Persist the history whenever it changes (best-effort; quota-safe).
  React.useEffect(() => {
    try {
      sessionStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_CAP)));
    } catch {
      /* private mode / quota — history is non-essential. */
    }
  }, [recent]);

  // Seed the lookback from prefs.investigate_lookback once (best-effort).
  React.useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const lb = s?.prefs?.investigate_lookback;
        if (typeof lb === 'string' && LOOKBACK_OPTIONS.some((o) => o.value === lb)) {
          setLookback(lb);
        }
      })
      .catch(() => {
        /* advisory seed; keep the default lookback. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = React.useMemo(
    () => ENTITY_OPTIONS.find((o) => o.id === entityType) ?? ENTITY_OPTIONS[0],
    [entityType],
  );

  const run = React.useCallback(async () => {
    const value = entityValue.trim();
    if (!value) {
      setEmptySubmit(true);
      return;
    }
    if (loading) return;
    setEmptySubmit(false);
    const entity: Entity = { type: entityType, value };
    setLoading(true);
    setError(null);
    setResult(null);
    setNoEvents(null);
    setRunningEntity(entity);

    try {
      const c = await api.investigate({
        entity,
        group_by: entityType,
        source_surface: 'investigate',
        lookback,
      });
      setResult(c);
      setRecent((prev) =>
        [{ id: `${Date.now()}`, entity, lookback, case: c }, ...prev].slice(
          0,
          RECENT_CAP,
        ),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        // Neutral "no in-scope events" outcome, not a failure.
        setNoEvents({ entity, lookback });
      } else {
        setError(e);
      }
    } finally {
      setLoading(false);
      setRunningEntity(null);
    }
  }, [entityType, entityValue, lookback, loading]);

  const widenLookback = React.useCallback(() => {
    const idx = LOOKBACK_OPTIONS.findIndex((o) => o.value === lookback);
    const next = LOOKBACK_OPTIONS[Math.min(idx + 1, LOOKBACK_OPTIONS.length - 1)];
    setLookback(next.value);
    setNoEvents(null);
  }, [lookback]);

  const replayRecent = React.useCallback((r: RunRecord) => {
    setEntityType(r.entity.type);
    setEntityValue(r.entity.value);
    setLookback(r.lookback);
    setResult(r.case);
    setNoEvents(null);
    setError(null);
    // The field is now repopulated with a valid value — clear any stale
    // empty-submit validation state so the red border/message don't linger.
    setEmptySubmit(false);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void run();
  };

  const isLastLookback =
    lookback === LOOKBACK_OPTIONS[LOOKBACK_OPTIONS.length - 1].value;

  const viewCasesAction = (
    <Button variant="outline" size="sm" onClick={() => navigate('cases')}>
      View cases
    </Button>
  );

  // Embedded in Workspace, the modules are the host page's own children (its page rhythm
  // spaces them); standalone, the page's own column does, one panel gutter apart.
  const Shell = embedded ? React.Fragment : StandaloneColumn;
  return (
    <Shell>
      {embedded ? null : (
        <PageHeader
          title="Entity investigation"
          help={INVESTIGATE_HELP}
          actions={viewCasesAction}
        />
      )}

      {/* Form */}
      <Panel title="New investigation" data-testid="investigate-form">
        {/* items-start keeps the controls aligned to the top of the row so the
            entity-value validation message (which grows the cell) never shifts
            the Lookback/Run cells down (they top-align, not bottom-align). */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-12 md:items-start">
          {/* Entity type */}
          <div className="space-y-1.5 md:col-span-4">
            <Label>Entity type</Label>
            <SegmentedControl<EntityType>
              fitted
              aria-label="Entity type"
              value={entityType}
              onValueChange={setEntityType}
              options={ENTITY_OPTIONS.map((o) => ({
                value: o.id,
                label: o.label,
                icon: <o.icon className="size-4" />,
              }))}
            />
          </div>

          {/* Entity value */}
          <div className="space-y-1.5 md:col-span-4">
            <Label htmlFor="investigate-entity">{selected.label} value</Label>
            <Input
              id="investigate-entity"
              placeholder={selected.placeholder}
              value={entityValue}
              onChange={(e) => {
                setEntityValue(e.target.value);
                if (emptySubmit && e.target.value.trim()) setEmptySubmit(false);
              }}
              onKeyDown={onKeyDown}
              aria-invalid={emptySubmit || undefined}
              aria-describedby={emptySubmit ? 'investigate-entity-error' : undefined}
              aria-label={`${selected.label} to investigate`}
              className={cn(emptySubmit && 'border-critical focus-visible:ring-critical')}
            />
            {emptySubmit ? (
              <p id="investigate-entity-error" role="alert" className="text-xs font-medium text-critical-text">
                Enter a {selected.label.toLowerCase()} value to investigate.
              </p>
            ) : null}
          </div>

          {/* Lookback */}
          <div className="space-y-1.5 md:col-span-2">
            <Label>Lookback</Label>
            <Select value={lookback} onValueChange={setLookback}>
              <SelectTrigger aria-label="Lookback window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOOKBACK_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Run: the invisible md-only spacer reserves the label row so the button lines
              up with the other controls under items-start. It wraps the label in a block,
              as the other cells' inline labels sit in their div's line box: a block label
              alone (leading-none) is a shorter row, and the button sat 7px high. */}
          <div className="space-y-1.5 md:col-span-2">
            <div aria-hidden="true" className="invisible hidden md:block" data-testid="investigate-run-spacer">
              <Label>Run</Label>
            </div>
            <Button
              className="w-full"
              onClick={() => void run()}
              disabled={loading || (!entityValue.trim() && !emptySubmit)}
            >
              <Play className="size-4" />
              {loading ? 'Running…' : 'Run investigation'}
            </Button>
          </div>
        </div>
      </Panel>

      {/* Loading */}
      {loading ? (
        <LoadingState
          layout="panel"
          shape="panel"
          label={`Investigating ${runningEntity?.value ?? selected.label}`}
          description="Correlating events, enriching indicators, and assembling evidence."
        />
      ) : null}

      {/* Hard error */}
      {!loading && error ? (
        <LoadError error={error} title="Investigation failed" onRetry={() => void run()} />
      ) : null}

      {/* Neutral no-events empty state */}
      {!loading && noEvents ? (
        <Panel aria-label="No in-scope events">
          <EmptyState
            compact
            icon={Search}
            title={`No in-scope events for ${noEvents.entity.type}:${noEvents.entity.value}`}
            description={`Nothing matched in ${lookbackLabelFor(
              noEvents.lookback,
            )}. The activity may be older, or outside the configured scope. Try widening the lookback window.`}
            action={
              !isLastLookback ? (
                <Button variant="outline" onClick={widenLookback}>
                  <Clock className="h-4 w-4" />
                  Widen lookback
                </Button>
              ) : undefined
            }
          />
        </Panel>
      ) : null}

      {/* Result */}
      {!loading && result ? (
        <ResultCard c={result} onOpen={setOpenCaseId} />
      ) : null}

      {/* Idle: how an investigation works (Round 14, EI2: shown only before the first
          run, never above the form on every visit). */}
      {!loading && !result && !error && !noEvents ? (
        <Panel
          title="How an investigation works"
          caption={`This is an explicit analyst action over ${lookbackLabelFor(lookback).toLowerCase()}, and the result is saved to Cases.`}
          aria-label="Entity investigation workflow"
        >
          <ol className="grid gap-4 md:grid-cols-3">
            {INVESTIGATE_STEPS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex min-w-0 gap-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      {/* Recent (this session) */}
      {recent.length ? (
        <Panel title="Recent investigations" caption="this session" padding="none" data-testid="investigate-recent">
          <ul className="divide-y divide-border/70 border-t border-border/70">
            {recent.map((r) => {
              const Icon = entityIcon(r.entity.type);
              return (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 xl:px-5 3xl:px-6">
                  {/* The replay control and "Open" are separate buttons, never nested
                      (one interactive element inside another is invalid). */}
                  <button
                    type="button"
                    onClick={() => replayRecent(r)}
                    aria-label={`Replay ${humanizeToken(r.entity.type)}:${r.entity.value}`}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-3 rounded-md text-left transition-colors',
                      'hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {humanizeToken(r.entity.type)}:{r.entity.value}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.case.title || r.case.case_number || r.case.case_id} · {lookbackLabelFor(r.lookback)}
                      </p>
                    </div>
                  </button>
                  <VerdictBadge verdict={r.case.verdict} />
                  <RiskBadge score={r.case.risk_score} />
                  {r.case.case_id ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpenCaseId(r.case.case_id)}
                      aria-label={`Open ${r.case.case_number || r.case.case_id}`}
                    >
                      <ExternalLink className="size-4" aria-hidden />
                      Open
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}

      {/* Case detail sheet, opened from the result card or a recent row. */}
      <CaseDetail
        caseId={openCaseId}
        onClose={() => setOpenCaseId(null)}
        onNavigate={navigate}
      />
    </Shell>
  );
}
