/**
 * CaseDetail: the Overview tab (Round 15, SPEC D8.3).
 *
 * The case's brief, and nothing the header or the facts rail already shows. Top to
 * bottom, in flat sections divided by hairlines:
 *
 *   1. RUNBOOK   the runbook's Next step card, when one is attached to an open case
 *                (Round 14, §4.10.11; read only here).
 *   2. SUMMARY   the AI's summary in two or three sentences (the lead of the model's
 *                reasoning, never the code's decision text, G17), with its recommended
 *                action (or, once the case ended, the recommendation it made at triage).
 *                A case the AI did not assess shows its system summary, untagged.
 *   3. WHAT HAPPENED  why the detection fired and the six-stage story of how one alert
 *                became this case (the stage timeline that was the Timeline tab; the
 *                caller passes it in, `whatHappened`). A link to the retired Timeline tab
 *                lands here (`data-section="what-happened"`).
 *   4. KEY ENTITIES  the primary entity with its scope, type and enrichment, to copy or
 *                ask about.
 *   5. RELATED CASES  cases grouped with this one across sources (never merged) and the
 *                source breakdown, when any (the facts rail's Related cases link lands
 *                here, `data-section="related-cases"`).
 *   6. BASELINE  the anomaly baseline of the case's signature, when it has one.
 *
 * Moved out (one home per fact, D8.4): the outcome headline and the AI verdict (the
 * header and the rail's Outcome), severity, rules and source (the rail's Signal and
 * Source), the decision, its authority sentence, the auto-close reading and the
 * automation applied (Investigation's Decision), the agent's findings and the reproduce
 * queries (Investigation's AI assessment), MITRE (Investigation's Threat context), the
 * investigation inputs (Investigation) and the status timeline (Collaboration's History).
 *
 * SECURITY (#9): every case-derived value (summary, recommendation, trigger sentence,
 * entity, enrichment, related titles, source ids) is UNTRUSTED, rendered as plain text or
 * inside an InlineCode fence, never as markup or a CSS/href value. #3: read only; it
 * never decides or mutates the case.
 */
import * as React from 'react';
import { AlertTriangle, Check, ChevronDown, Copy, Link2 } from 'lucide-react';

import { api } from '@/lib/api';
import type { Case, CaseRationale } from '@/lib/types';
import { humanizeToken } from '@/lib/format';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';

import { InlineCode } from '@/soc/components/CodeBlock';
import { ProvenanceTag } from '@/soc/components/ProvenanceTag';
import { isTerminalStatus } from '@/soc/components/outcome';
import { BaselineSignatureCard } from '@/soc/components/BaselineGauge';
import { baselineApi, type BaselineSignature } from '@/soc/Baseline.api';
import type { Navigate } from '@/soc/router';

import { AskAi } from './AskAi';
import { aiAssessed, aiAssessmentText } from './caseFacts';
import { riskFactorBarColor } from './SignalProfile';
import { CASE_MANAGER_PANEL_PADDING, PanelSection } from './shared';

// Re-exported for existing importers: the factor bars live in the facts rail.
export { riskFactorBarColor };

/** At most this many sentences of the AI summary lead the Overview (D8.3). */
const SUMMARY_SENTENCES = 3;

/** The first `max` sentences of a longer text (falls back to the trimmed whole). */
export function leadSentences(text: string | null | undefined, max = SUMMARY_SENTENCES): string {
  const trimmed = (text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  // A sentence ends at . ! or ? followed by a space, so "62.5" or "10.0.0.5" never split.
  return trimmed.split(/(?<=[.!?])\s+/).slice(0, max).join(' ').trim();
}

/** Compare two prose sentences ignoring case, spacing and trailing punctuation. */
function normalizeSentence(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

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

/** A dependency-free "copy this value" chip (#9-safe: copies a plain string). */
const CopyChip: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
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
      testId="overview-related"
      description="Grouped with this case by a shared entity across sources, within the cross-source window. Related cases are never merged into this one."
    >
      <div className="grid gap-x-8 gap-y-4 @[40rem]/overview:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
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
      data-testid="overview-baseline"
      className="border-t border-border/60 pt-6 first:border-t-0 first:pt-0"
    >
      <BaselineSignatureCard data={data} embedded />
    </section>
  );
};

/* --------------------------------------------------------------- component -- */

export const OverviewPanel: React.FC<{
  c: Case;
  /** The latest run's rationale: the summary leads with the model's reasoning. */
  rationale?: CaseRationale | null;
  onNavigate?: Navigate;
  /**
   * The "What happened" story (Round 15, D8.3): the stage timeline, which the caller
   * loads when the Overview opens and passes in. Omitted: the section shows only why the
   * detection fired.
   */
  whatHappened?: React.ReactNode;
  /**
   * Round 14 (SPEC §4.10.11): the runbook's Next step card, at the top of the Overview
   * when a runbook is attached to an open case. Read only here; its button opens the
   * Runbook tab. Nothing in it changes the case (#3).
   */
  runbookCard?: React.ReactNode;
}> = ({ c, rationale = null, onNavigate, whatHappened = null, runbookCard = null }) => {
  const trigger = c.trigger_reason as { sentence?: string } | undefined;
  const triggerSentence = typeof trigger?.sentence === 'string' ? trigger.sentence.trim() : '';
  const terminal = isTerminalStatus(c.status);

  // The AI's reading, led by the model's reasoning (G17); a case the AI did not assess
  // (a candidate, a policy close) shows its system summary, without the AI tag.
  const aiText = aiAssessmentText(c, rationale);
  const fromAi = Boolean(aiText) || aiAssessed(c);
  const summary = leadSentences(aiText || (aiAssessed(c) ? '' : c.summary));
  const recommended = (c.recommended_action || '').trim();
  // The summary and the recommendation sometimes say the same thing: one paragraph,
  // labelled as both, so the datum is kept and the duplicate dropped.
  const recommendationIsSummary =
    Boolean(recommended) && Boolean(summary) && normalizeSentence(recommended) === normalizeSentence(summary);

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
  const entityEnrichRows: Array<{ k: string; v: string; mono: boolean }> = [];
  if (caseEnrichment) {
    for (const { key, label, mono = false } of ENTITY_ENRICH_KEYS) {
      const v = caseEnrichment[key];
      if (v === null || v === undefined || typeof v === 'object') continue;
      entityEnrichRows.push({ k: label, v: String(v), mono });
    }
  }

  return (
    <div
      className={cn('@container/overview space-y-6', CASE_MANAGER_PANEL_PADDING)}
      data-case-panel="overview"
      data-presentation="case-manager"
    >
      {runbookCard}

      {c.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Investigation error</AlertTitle>
          {/* UNTRUSTED: plain text. */}
          <AlertDescription className="whitespace-pre-wrap">{c.error}</AlertDescription>
        </Alert>
      ) : null}

      {/* ============================================================ 1. SUMMARY */}
      <PanelSection
        title="Summary"
        adornment={fromAi ? <ProvenanceTag kind="ai" /> : null}
        testId="overview-summary"
      >
        <div className="max-w-3xl space-y-4">
          {recommendationIsSummary && !terminal ? (
            <div className="space-y-1" data-testid="overview-summary-and-action">
              <h3 className={FIELD_LABEL}>Summary and recommended action</h3>
              {/* UNTRUSTED: plain text. */}
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{recommended}</p>
            </div>
          ) : (
            <>
              {/* UNTRUSTED summary: plain text. */}
              <p
                data-testid="overview-summary-text"
                className={cn('text-sm leading-relaxed', summary ? 'text-foreground/90' : 'text-muted-foreground')}
              >
                {summary || 'The AI has not written a summary for this case.'}
              </p>
              {!terminal && recommended ? (
                <div className="space-y-1" data-testid="overview-recommended-action">
                  <h3 className={FIELD_LABEL}>Recommended action</h3>
                  {/* UNTRUSTED: plain text. */}
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{recommended}</p>
                </div>
              ) : null}
            </>
          )}
          {/* On a case that ended, the AI's triage-time recommendation is demoted: kept,
              retitled, and never presented as the next step. */}
          {terminal && recommended ? (
            <details className="group text-sm" data-testid="overview-triage-recommendation">
              <summary className="w-fit cursor-pointer list-none rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="inline-flex items-center gap-1.5">
                  <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden />
                  AI recommendation at triage
                </span>
              </summary>
              {/* UNTRUSTED: plain text. */}
              <p className="mt-2 whitespace-pre-wrap pl-5 text-sm leading-relaxed text-muted-foreground">{recommended}</p>
            </details>
          ) : null}
        </div>
      </PanelSection>

      {/* ====================================================== 2. WHAT HAPPENED */}
      <PanelSection title="What happened" section="what-happened" testId="overview-what-happened">
        {triggerSentence ? (
          <p className="max-w-3xl text-sm leading-relaxed text-foreground/90" data-testid="overview-trigger">
            <span className="text-muted-foreground">Why it fired: </span>
            {/* UNTRUSTED: plain text. */}
            {triggerSentence}
          </p>
        ) : null}
        {whatHappened}
      </PanelSection>

      {/* ======================================================= 3. KEY ENTITIES */}
      <PanelSection title="Key entities" testId="overview-entities">
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
                {/* Round 12 WP-ASK: an action row, so always shown, as a labelled chip in
                    the Copy chip's shape. Opens a NEW Workspace chat, never the case chat (#5). */}
                <AskAi type={entityType} value={entityValue} reveal={false} />
              </div>
            </div>
            {entityEnrichRows.length ? (
              <dl className="grid max-w-3xl grid-cols-2 gap-x-6 gap-y-2 @[40rem]/overview:grid-cols-3">
                {entityEnrichRows.map((row, i) => (
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

      {/* ================================================ 4. RELATED, 5. BASELINE */}
      <RelatedCases c={c} onNavigate={onNavigate} />
      <BaselineAdvisory c={c} />
    </div>
  );
};

export default OverviewPanel;
