/**
 * CaseDetail: the Evidence tab (Round 16, SPEC D8, §4.4 WP03). The source lane.
 *
 * What the sources said, and nothing the AI or the code made of it. Top to bottom, in
 * flat sections divided by hairlines:
 *
 *   1. WHAT HAPPENED  why the detection fired and the ingestion stage of the case's
 *                story (the source evidence blocks, fenced as untrusted), then the raw
 *                events behind the case (`CaseEvents`, which a finding's "Cites N events"
 *                narrows). A link to the retired Timeline tab lands here
 *                (`data-section="what-happened"`).
 *   2. ENTITIES  the primary entity with its scope, type and enrichment, to copy or ask
 *                about.
 *   3. THREAT CONTEXT  MITRE, indicator reputation, clustering and asset context (the
 *                caller passes it in, loaded when this tab opens); a link to the retired
 *                Threat context tab lands here (`data-section="threat-context"`).
 *   4. RELATED CASES  cases grouped with this one across sources (never merged) and the
 *                source breakdown, when any (`data-section="related-cases"`).
 *   5. BASELINE  the anomaly baseline of the case's signature, when it has one.
 *
 * SECURITY (#9): every case-derived value (trigger sentence, entity, enrichment, related
 * titles, source ids, event values) is UNTRUSTED, rendered as plain text or inside an
 * InlineCode or CodeBlock fence, never as markup or a CSS or href value. #3: read only; it
 * never decides or mutates the case.
 */
import * as React from 'react';
import { Check, Copy, Link2 } from 'lucide-react';

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';
import { humanizeToken } from '@/lib/format';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';

import { InlineCode } from '@/soc/components/CodeBlock';
import { BaselineSignatureCard } from '@/soc/components/BaselineGauge';
import { baselineApi, type BaselineSignature } from '@/soc/Baseline.api';
import type { Navigate } from '@/soc/router';

import { AskAi } from './AskAi';
import { CaseEvents } from './records/CaseEvents';
import { CASE_MANAGER_PANEL_PADDING, PanelSection } from './shared';

/** True when an IP sits in a private / link-local / loopback range (best-effort). */
function isPrivateIp(ip: string): boolean {
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1\b|fe80:|f[cd][0-9a-f]{2}:)/i.test(
    ip.trim(),
  );
}

/** Entity-type label in sentence case that keeps well-known acronyms intact. */
function entityTypeLabel(type: string): string {
  const t = type.trim().toLowerCase();
  if (t === 'ip' || t === 'url' || t === 'asn' || t === 'md5' || t === 'sha1' || t === 'sha256') {
    return t.toUpperCase();
  }
  return humanizeToken(type);
}

const FIELD_LABEL = 'text-xs font-medium text-muted-foreground';

/** The trigger sentence a detection recorded ("why it fired"), or empty. Plain data (#9). */
export function triggerSentence(c: Case): string {
  const trigger = c.trigger_reason as { sentence?: unknown } | undefined;
  return typeof trigger?.sentence === 'string' ? trigger.sentence.trim() : '';
}

/** A dependency-free "copy this value" chip (#9-safe: copies a plain string). */
const CopyChip: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = React.useCallback(() => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : label}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};

/* -------------------------------------------------------------- entities -- */

/** The primary entity: its value, scope, type and enrichment (#9: value fenced). */
const KeyEntities: React.FC<{ c: Case }> = ({ c }) => {
  const entityType = c.entity?.type || c.entity_type || null;
  const entityValue = c.entity?.value || '';
  // Primary-entity scope (Internal / External), best-effort, omitted when unknown.
  const entityScope: 'Internal' | 'External' | null = (() => {
    if (!entityValue) return null;
    if (entityType === 'host' || entityType === 'user') return 'Internal';
    if (entityType === 'ip') return isPrivateIp(entityValue) ? 'Internal' : 'External';
    return null;
  })();
  // Enrichment rows for the primary entity (known scalar keys only).
  const caseEnrichment =
    c.enrichment && typeof c.enrichment === 'object' ? (c.enrichment as Record<string, unknown>) : null;
  const ENTITY_ENRICH_KEYS: Array<{ key: string; label: string; mono?: boolean }> = [
    { key: 'reputation_score', label: 'Reputation' },
    { key: 'country', label: 'Country' },
    { key: 'asn', label: 'ASN', mono: true },
    { key: 'org', label: 'Org' },
    { key: 'first_seen', label: 'First seen' },
    { key: 'last_seen', label: 'Last seen' },
  ];
  const rows: Array<{ k: string; v: string; mono: boolean }> = [];
  if (caseEnrichment) {
    for (const { key, label, mono = false } of ENTITY_ENRICH_KEYS) {
      const v = caseEnrichment[key];
      if (v === null || v === undefined || typeof v === 'object') continue;
      rows.push({ k: label, v: String(v), mono });
    }
  }

  return (
    <PanelSection title="Entities" testId="evidence-entities">
      {entityValue ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <span className={cn('block', FIELD_LABEL)}>Primary entity</span>
            <div className="flex flex-wrap items-center gap-2">
              {/* UNTRUSTED entity value: inside an InlineCode fence. */}
              <InlineCode className="break-all">{entityValue}</InlineCode>
              {entityScope ? (
                <Badge variant={entityScope === 'External' ? 'high' : 'outline'}>{entityScope}</Badge>
              ) : null}
              <Badge variant="outline">{entityType ? entityTypeLabel(entityType) : 'Entity'}</Badge>
              <CopyChip value={entityValue} label="Copy indicator" />
              {/* Opens a NEW Workspace chat, never the case chat (#5). */}
              <AskAi type={entityType} value={entityValue} reveal={false} />
            </div>
          </div>
          {rows.length ? (
            <dl className="grid max-w-3xl grid-cols-2 gap-x-6 gap-y-2 @[40rem]/evidence:grid-cols-3">
              {rows.map((row, i) => (
                <div key={`${row.k}-${i}`} className="min-w-0">
                  <dt className={FIELD_LABEL}>{row.k}</dt>
                  {/* UNTRUSTED enrichment value: plain text; only a true identifier (the
                      ASN) keeps the mono face. */}
                  <dd className={cn('truncate text-sm text-foreground', row.mono && 'font-mono')} title={row.v}>
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No primary entity was recorded for this case.</p>
      )}
    </PanelSection>
  );
};

/* ----------------------------------------- related cases + source breakdown */

/**
 * Cross-source linkage (F6): the RELATED cases (never merged), the source breakdown and
 * the cross-source group. Case-derived text is UNTRUSTED: plain text. Renders nothing
 * when there is no cross-source data.
 */
const RelatedCases: React.FC<{ c: Case; onNavigate?: Navigate }> = ({ c, onNavigate }) => {
  const relatedIds = React.useMemo(
    () =>
      (Array.isArray(c.related_case_ids) ? c.related_case_ids : []).filter(
        (rid): rid is string => typeof rid === 'string' && !!rid && rid !== c.case_id,
      ),
    [c.related_case_ids, c.case_id],
  );
  const breakdown = React.useMemo(() => {
    const b = c.source_breakdown;
    if (!b || typeof b !== 'object') return [] as Array<[string, number]>;
    return Object.entries(b)
      .filter(([, v]) => typeof v === 'number')
      .sort((a, bb) => bb[1] - a[1]);
  }, [c.source_breakdown]);

  // Best-effort titles for the related case ids (fetch the recent list, map by id).
  const [titles, setTitles] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!relatedIds.length) return;
    let cancelled = false;
    void api
      .listCases({ limit: 200 })
      .then((res) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const rc of res.cases) {
          if (relatedIds.includes(rc.case_id)) map[rc.case_id] = rc.title || rc.case_number || rc.case_id;
        }
        setTitles(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [relatedIds]);

  if (!relatedIds.length && !breakdown.length && !c.cross_source_cluster_id) return null;

  return (
    <PanelSection
      title="Related cases"
      section="related-cases"
      testId="evidence-related"
      description="Grouped with this case by a shared entity across sources, within the cross-source window. Related cases are never merged into this one."
    >
      <div className="grid gap-x-8 gap-y-4 @[40rem]/evidence:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        {relatedIds.length ? (
          <ul className="min-w-0 space-y-1.5">
            {relatedIds.map((rid) => (
              <li key={rid} className="flex min-w-0 items-center gap-2">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <button
                  type="button"
                  onClick={() => onNavigate?.('case_manager', { caseId: rid })}
                  disabled={!onNavigate}
                  className={cn(
                    'min-w-0 truncate rounded-sm text-left text-sm',
                    onNavigate
                      ? 'text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                      : 'cursor-default text-foreground',
                  )}
                  title={titles[rid] || rid}
                >
                  {/* UNTRUSTED title / id: plain text. */}
                  {titles[rid] || rid}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No related cases.</p>
        )}
        <div className="min-w-0 space-y-1.5">
          <span className={cn('block', FIELD_LABEL)}>Sources</span>
          {breakdown.length ? (
            <dl className="space-y-1">
              {breakdown.map(([sid, count]) => (
                <div key={sid} className="flex items-baseline justify-between gap-3">
                  {/* UNTRUSTED source id: plain text, truncated. */}
                  <dt className="min-w-0 truncate font-mono text-xs text-foreground" title={sid}>
                    {sid}
                  </dt>
                  <dd className="shrink-0 text-xs tabular-nums text-muted-foreground">{count.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Single source.</p>
          )}
          {c.cross_source_cluster_id ? (
            <p className="text-xs text-muted-foreground">
              Cross-source group{' '}
              {/* UNTRUSTED id: plain text, mono. */}
              <span className="break-all font-mono text-foreground/80">{c.cross_source_cluster_id}</span>
            </p>
          ) : null}
        </div>
      </div>
    </PanelSection>
  );
};

/* ----------------------------------------------- anomaly baseline (advisory) */

/**
 * Advisory anomaly-baseline section (#4). When the case has a cluster signature AND the
 * baseline has recorded stats for it, this embeds the ready-made `BaselineSignatureCard`.
 * FAIL-QUIET: no signature, a disabled baseline, an unseen signature (`found=false`) or a
 * fetch error all render NOTHING. READ ONLY / advisory (#3/#4). `signature` is
 * source-derived and the card renders it as a plain text node only (#9).
 */
const BaselineAdvisory: React.FC<{ c: Case }> = ({ c }) => {
  const signature = typeof c.cluster_signature === 'string' ? c.cluster_signature.trim() : '';
  const [data, setData] = React.useState<BaselineSignature | null>(null);

  React.useEffect(() => {
    if (!signature) {
      setData(null);
      return;
    }
    let cancelled = false;
    void baselineApi
      .signature(signature)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  if (!signature || !data || !data.found) return null;

  return (
    <section
      aria-label="Anomaly baseline"
      data-testid="evidence-baseline"
      className="border-t border-border/60 pt-6 first:border-t-0 first:pt-0"
    >
      <BaselineSignatureCard data={data} embedded />
    </section>
  );
};

/* --------------------------------------------------------------- component -- */

export interface EvidencePanelProps {
  c: Case;
  onNavigate?: Navigate;
  /**
   * The ingestion stage of the case's story (the stage timeline narrowed to the input
   * stage), which the caller loads when this tab opens. Omitted: What happened shows only
   * why the detection fired and the events.
   */
  sourceStory?: React.ReactNode;
  /** Threat context's body, loaded when this tab opens. Omitted: no Threat context section. */
  threatContext?: React.ReactNode;
  /** The event ids one finding cites (its "Cites N events"); null shows every event. */
  filterEventIds?: string[] | null;
  onClearEventFilter?: () => void;
}

export const EvidencePanel: React.FC<EvidencePanelProps> = ({
  c,
  onNavigate,
  sourceStory = null,
  threatContext = null,
  filterEventIds = null,
  onClearEventFilter,
}) => {
  const sentence = triggerSentence(c);
  return (
    <div
      className={cn('@container/evidence space-y-6', CASE_MANAGER_PANEL_PADDING)}
      data-case-panel="evidence"
      data-presentation="case-manager"
    >
      {/* ====================================================== 1. WHAT HAPPENED */}
      <PanelSection title="What happened" section="what-happened" testId="evidence-what-happened" tabFirst>
        {sentence ? (
          <p className="max-w-[42rem] text-sm leading-relaxed text-foreground/90" data-testid="evidence-trigger">
            <span className="text-muted-foreground">Why it fired: </span>
            {/* UNTRUSTED: plain text. */}
            {sentence}
          </p>
        ) : null}
        {sourceStory}
        <CaseEvents caseId={c.case_id} filterEventIds={filterEventIds} onClearFilter={onClearEventFilter} />
      </PanelSection>

      {/* ============================================================ 2. ENTITIES */}
      <KeyEntities c={c} />

      {/* ====================================================== 3. THREAT CONTEXT */}
      {threatContext ? (
        <PanelSection title="Threat context" section="threat-context" testId="evidence-threat-context">
          {threatContext}
        </PanelSection>
      ) : null}

      {/* ================================================ 4. RELATED, 5. BASELINE */}
      <RelatedCases c={c} onNavigate={onNavigate} />
      <BaselineAdvisory c={c} />
    </div>
  );
};

export default EvidencePanel;
