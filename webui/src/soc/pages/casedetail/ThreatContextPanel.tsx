/**
 * CaseDetail — Threat context panel (Coupling-D split).
 *
 * The threat-context tab (F11): a threat summary banner, IOC reputation, MITRE
 * ATT&CK techniques (with canonical links), and asset context. Fail-open: renders
 * empty/disabled states when the panel is off or bare. Related cases + evidence are
 * intentionally NOT repeated here — they live on the Overview tab (Round-7 dedup).
 *
 * SECURITY (#9): every indicator, country, entity, asset attribute and summary string
 * is UNTRUSTED — rendered plain text / inside <CodeBlock>. MITRE technique NAMES are
 * from the curated corpus (TRUSTED) but still rendered as plain text nodes. #3:
 * read-only projection; it never decides or mutates the case.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Crosshair,
  Gauge,
  Globe,
  Link2,
  Shield,
  Target,
} from 'lucide-react';

import type {
  Case,
  IocReputation,
  ThreatContextPanel as ThreatContextPanelData,
} from '@/lib/types';
import { humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { LoadingState } from '@/design-system';

import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { AiVerdictChip, VerdictBadge, RiskBadge } from '@/soc/components/badges';
import type { Navigate } from '@/soc/router';

import { CASE_MANAGER_PANEL_PADDING, PanelCard, SectionHeading } from './shared';
import type { CasePanelPresentation } from './shared';
import {
  ClusterFormationDiagram,
  type ClusterExplanation,
} from './ClusterFormationDiagram';

/** Canonical MITRE ATT&CK technique URL (id like "T1110" or "T1110.001"). */
function mitreUrl(id: string, fallback?: string): string {
  if (fallback && /^https?:\/\//i.test(fallback)) return fallback;
  const clean = (id || '').trim().toUpperCase();
  const m = /^T(\d{4})(?:\.(\d{3}))?$/.exec(clean);
  if (!m) return 'https://attack.mitre.org/techniques/';
  return m[2]
    ? `https://attack.mitre.org/techniques/T${m[1]}/${m[2]}/`
    : `https://attack.mitre.org/techniques/T${m[1]}/`;
}

/** The backend currently emits `score`; older saved payloads used
 * `reputation_score`. Read both without changing the API or losing history. */
function iocScore(ioc: IocReputation): number | undefined {
  const value =
    typeof ioc.reputation_score === 'number' ? ioc.reputation_score : ioc.score;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Likewise, live payloads carry a provider map while older projections had one
 * source string. Provider ids remain plain text (#9). */
function iocSource(ioc: IocReputation): string | undefined {
  if (typeof ioc.source === 'string' && ioc.source.trim()) return ioc.source;
  if (ioc.sources && typeof ioc.sources === 'object') {
    // Some fail-open enrichers return metadata-only maps such as `{note: ...}`;
    // those are not provider names and must not be labelled as the IOC source.
    const metadataKeys = new Set(['note', 'error', 'cached', 'score', 'country', 'raw']);
    const first = Object.keys(ioc.sources).find((key) => !metadataKeys.has(key.toLowerCase()));
    if (first) return first;
  }
  return undefined;
}

function scalarLabel(value: unknown): string {
  if (typeof value === 'string') return humanizeToken(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '—');
}

export type IocVerdictKind = 'malicious' | 'no_detections' | 'not_checked';

/**
 * The indicator verdict, TRI-STATE (CM-8). "Clean" was shown whenever `is_malicious`
 * was false — even when no provider answered and the confidence was 0, which reads as a
 * clean bill of health nobody issued. Now: Malicious when a provider flagged it; No
 * detections only when a named provider was actually consulted; otherwise Not checked.
 */
export function iocVerdict(ioc: IocReputation): {
  kind: IocVerdictKind;
  label: string;
  variant: 'critical' | 'secondary' | 'outline';
  detail: string;
} {
  if (ioc.is_malicious === true) {
    return {
      kind: 'malicious',
      label: 'Malicious',
      variant: 'critical',
      detail: 'A reputation provider flagged this indicator as malicious.',
    };
  }
  const source = iocSource(ioc);
  if (ioc.is_malicious === false && source) {
    return {
      kind: 'no_detections',
      label: 'No detections',
      variant: 'secondary',
      detail: `${humanizeToken(source)} was checked and reported no detections. That is not proof the indicator is safe.`,
    };
  }
  return {
    kind: 'not_checked',
    label: 'Not checked',
    variant: 'outline',
    detail: 'No reputation provider answered for this indicator, so it was not checked.',
  };
}

/** A tactic token as sentence-case words ("initial-access" → "Initial access"). */
function tacticWords(tactic: string): string {
  const words = String(tactic || '').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—';
}

const FlatHeading: React.FC<{
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
  children: React.ReactNode;
}> = ({ id, icon: Icon, count, children }) => (
  <div className="mb-3 flex items-center gap-2">
    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
    <h2 id={id} className="text-sm font-semibold text-foreground">
      {children}
    </h2>
    {typeof count === 'number' && count > 0 ? (
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    ) : null}
  </div>
);

export const ThreatContextPanel: React.FC<{
  c: Case;
  panel: ThreatContextPanelData | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /**
   * Accepted for API stability with the CaseDetail shell, but no longer used: the
   * only case-to-case navigation on this panel was the Related-cases list, which now
   * lives on the Overview tab (Round-7 dedup). Kept optional so callers can pass it.
   */
  onNavigate?: Navigate;
  presentation?: CasePanelPresentation;
}> = ({ c, panel, loading, error, onRetry, presentation = 'default' }) => {
  if (loading) {
    return (
      <div className="p-6">
        <LoadingState
          label="Loading threat context"
          description="Preparing IOC reputation, ATT&CK techniques, and asset context."
          layout="panel"
          shape="panel"
        />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <LoadError error={error} title="Could not load threat context" onRetry={onRetry} />
      </div>
    );
  }
  if (panel?.disabled) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Globe}
          title="Threat context is disabled"
          description="Enable the threat-context panel under Settings → Threat context to assemble IOC reputation, MITRE techniques, related cases and asset context for each case."
        />
      </div>
    );
  }
  if (!panel) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Globe}
          title="No threat context"
          description="No threat context could be assembled for this case yet."
        />
      </div>
    );
  }

  const iocs = (panel.ioc_reputation || []).filter((x) => x && x.indicator);
  const techniques = (panel.mitre_techniques || []).filter((t) => t && t.id);
  const asset = panel.asset_context || null;
  const assetAttrs =
    asset && asset.attributes && typeof asset.attributes === 'object'
      ? Object.entries(asset.attributes).filter(
          ([, v]) => v !== null && v !== undefined && typeof v !== 'object',
        )
      : [];
  const assetNetworks =
    asset && Array.isArray(asset.networks)
      ? asset.networks.filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
      : [];
  const clustering = (panel.clustering || null) as ClusterExplanation | null;
  // Related cases + evidence are shown on the Overview tab, not repeated here
  // (Round-7 dedup), so they no longer participate in the "any section" gate.
  const anySection =
    !!panel.summary || iocs.length > 0 || techniques.length > 0 || !!asset || !!clustering?.available;

  if (presentation === 'case-manager') {
    const assetEmpty =
      !asset ||
      (!asset.entity &&
        asset.criticality === undefined &&
        asset.is_internal === undefined &&
        assetNetworks.length === 0 &&
        assetAttrs.length === 0);
    return (
      <div
        className={cn('divide-y divide-border', CASE_MANAGER_PANEL_PADDING)}
        data-case-panel="threat-context"
        data-presentation="case-manager"
      >
        {/* Flat, divider-led sections (CM-8): no card-in-card. Every field of both earlier
            layouts is kept — summary, AI verdict, risk, malicious-indicator flag, the
            assembled time, each technique's id/name/every tactic/description/link, each
            indicator's value/type/verdict/score/source/country, the clustering story and
            the asset context. Log-derived values stay plain text nodes (#9). */}
        <section aria-labelledby="threat-summary-title" className="pb-5">
          <FlatHeading id="threat-summary-title" icon={Shield}>
            Threat summary
          </FlatHeading>
          {panel.summary ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{panel.summary}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No threat summary was assembled for this case.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <AiVerdictChip verdict={c.verdict} confidence={c.confidence} />
            <RiskBadge score={c.risk_score} />
            {iocs.some((i) => i.is_malicious) ? (
              <Badge variant="critical" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                Malicious indicator present
              </Badge>
            ) : null}
            {panel.generated_at ? (
              <span className="ml-auto text-xs text-muted-foreground">
                Assembled {humanizeAge(panel.generated_at)}
              </span>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="threat-mitre-title" className="py-5" data-testid="threat-mitre">
          <FlatHeading id="threat-mitre-title" icon={Shield} count={techniques.length}>
            MITRE ATT&amp;CK techniques
          </FlatHeading>
          {techniques.length === 0 ? (
            <p className="text-sm text-muted-foreground">No MITRE ATT&amp;CK techniques were resolved for this case.</p>
          ) : (
            <ul className="divide-y divide-border/70">
              {techniques.map((technique, index) => (
                <li key={`${technique.id}-${index}`} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-xs font-semibold text-foreground">{technique.id}</span>
                    {/* Name is from the curated MITRE corpus (TRUSTED) — still a plain text node. */}
                    <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                      {technique.name || 'Unknown technique'}
                    </span>
                    <a
                      href={mitreUrl(technique.id, technique.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open MITRE ATT&CK ${technique.id} in a new tab`}
                      className="inline-flex items-center gap-1 rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Link2 className="h-3 w-3" aria-hidden /> MITRE
                    </a>
                  </div>
                  {technique.tactics && technique.tactics.length ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {technique.tactics.length === 1 ? 'Tactic: ' : 'Tactics: '}
                      {technique.tactics.map((tactic) => tacticWords(tactic)).join(', ')}
                    </p>
                  ) : null}
                  {technique.description ? (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{technique.description}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="threat-ioc-title" className="py-5" data-testid="threat-ioc">
          <FlatHeading id="threat-ioc-title" icon={Target} count={iocs.length}>
            Indicator reputation
          </FlatHeading>
          {iocs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No indicator reputation was available. Enrichment may be off or uncached, or the indicators are internal.
            </p>
          ) : (
            <ul className="divide-y divide-border/70">
              {iocs.map((ioc, index) => {
                const score = iocScore(ioc);
                const source = iocSource(ioc);
                const verdict = iocVerdict(ioc);
                return (
                  <li
                    key={`${ioc.indicator}-${index}`}
                    className="grid gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0 @[40rem]/case:grid-cols-[minmax(0,1fr)_auto]"
                    data-testid="threat-ioc-row"
                    data-ioc-verdict={verdict.kind}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {/* UNTRUSTED indicator — plain text, mono. */}
                      <span className="min-w-0 truncate font-mono text-sm text-foreground" title={ioc.indicator}>
                        {ioc.indicator}
                      </span>
                      {ioc.type ? <span className="text-xs text-muted-foreground">{humanizeToken(ioc.type)}</span> : null}
                      <Badge variant={verdict.variant} title={verdict.detail}>
                        {verdict.label}
                      </Badge>
                    </div>
                    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs @[40rem]/case:justify-end">
                      <div className="flex gap-1">
                        <dt className="text-muted-foreground">Source</dt>
                        <dd className="text-foreground">{source ? humanizeToken(source) : 'Unavailable'}</dd>
                      </div>
                      <div className="flex gap-1">
                        <dt className="text-muted-foreground">Confidence</dt>
                        <dd
                          className={cn(
                            'tabular-nums',
                            typeof score === 'number' && score >= 50 ? 'font-medium text-critical-text' : 'text-foreground',
                          )}
                        >
                          {typeof score === 'number' ? `${Math.round(score)}%` : 'Unavailable'}
                        </dd>
                      </div>
                      {ioc.country ? (
                        <div className="flex gap-1">
                          <dt className="text-muted-foreground">Country</dt>
                          {/* UNTRUSTED — plain text. */}
                          <dd className="max-w-[10rem] truncate text-foreground">{ioc.country}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {clustering?.available ? (
          // The diagram draws its own top/bottom rules; inside this divider-led stack the
          // dividers already separate it, so its own rules are dropped here.
          <div className="py-5 [&>section]:border-y-0 [&>section]:py-0">
            <ClusterFormationDiagram data={clustering} />
          </div>
        ) : null}

        <section aria-labelledby="threat-asset-title" className="pt-5">
          <FlatHeading id="threat-asset-title" icon={Crosshair}>
            Asset context
          </FlatHeading>
          {assetEmpty || !asset ? (
            <p className="text-sm text-muted-foreground">
              No additional context was recorded for the case&apos;s primary entity.
            </p>
          ) : (
            <dl className="grid gap-x-6 gap-y-2 text-sm @[40rem]/case:grid-cols-2">
              {asset.entity ? (
                <div className="flex min-w-0 items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">{humanizeToken(asset.entity_type || 'Entity')}</dt>
                  {/* UNTRUSTED — plain text, mono. */}
                  <dd className="truncate text-right font-mono text-foreground">{asset.entity}</dd>
                </div>
              ) : null}
              {asset.criticality !== undefined ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">Criticality</dt>
                  <dd className="text-right font-mono text-foreground">{scalarLabel(asset.criticality)}</dd>
                </div>
              ) : null}
              {asset.is_internal !== undefined ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">Internal asset</dt>
                  <dd className="text-right text-foreground">{asset.is_internal ? 'Yes' : 'No'}</dd>
                </div>
              ) : null}
              {assetNetworks.length ? (
                <div className="flex items-start justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">Networks</dt>
                  <dd className="max-w-[70%] text-right font-mono text-foreground">
                    {assetNetworks.map(String).join(', ')}
                  </dd>
                </div>
              ) : null}
              {assetAttrs.map(([key, value], index) => (
                <div key={`${key}-${index}`} className="flex min-w-0 items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">{humanizeToken(key)}</dt>
                  {/* UNTRUSTED — plain text. */}
                  <dd className="truncate text-right font-mono text-foreground">{scalarLabel(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        {!anySection ? (
          <p className="pt-5 text-xs text-muted-foreground">
            Threat context is enabled but produced no sections for this case.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* ---------------------------------------------- threat banner */}
      <PanelCard>
        <SectionHeading icon={Shield}>
          Threat summary
        </SectionHeading>
        {panel.summary ? (
          /* UNTRUSTED — plain text. */
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {panel.summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No threat summary was assembled for this case.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={c.verdict} />
          <RiskBadge score={c.risk_score} />
          {iocs.some((i) => i.is_malicious) ? (
            <Badge variant="critical" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              Malicious indicator present
            </Badge>
          ) : null}
          {panel.generated_at ? (
            <span className="ml-auto text-xs text-muted-foreground">
              assembled {humanizeAge(panel.generated_at)}
            </span>
          ) : null}
        </div>
      </PanelCard>

      <ClusterFormationDiagram data={clustering} />

      {/* ---------------------------------------------- IOC reputation */}
      <PanelCard>
        <SectionHeading icon={Target}>
          IOC reputation
        </SectionHeading>
        {iocs.length === 0 ? (
          <EmptyState
            icon={Target}
            compact
            title="No indicator reputation"
            description="No IOC reputation was available — enrichment may be off, uncached, or the indicators are internal."
          />
        ) : (
          <div className="space-y-2">
            {iocs.map((ioc, i) => {
              const score = iocScore(ioc);
              const source = iocSource(ioc);
              return (
                <div
                  key={`${ioc.indicator}-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3"
                >
                  {/* UNTRUSTED indicator — plain text, mono. */}
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                    {ioc.indicator}
                  </span>
                  {ioc.type ? <Badge variant="outline">{humanizeToken(ioc.type)}</Badge> : null}
                  {typeof score === 'number' ? (
                    <Badge variant={score >= 50 ? 'critical' : 'secondary'}>
                      <Gauge className="h-3 w-3" />
                      score {Math.round(score)}
                    </Badge>
                  ) : null}
                  {(() => {
                    const verdict = iocVerdict(ioc);
                    return (
                      <Badge variant={verdict.variant} title={verdict.detail}>
                        {verdict.label}
                      </Badge>
                    );
                  })()}
                  {ioc.country ? (
                    /* UNTRUSTED — plain text. */
                    <Badge variant="outline" className="gap-1">
                      <Globe className="h-3 w-3" />
                      <span className="max-w-[10rem] truncate">{ioc.country}</span>
                    </Badge>
                  ) : null}
                  {source ? (
                    <span className="text-xs text-muted-foreground">{humanizeToken(source)}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      {/* ---------------------------------------------- MITRE techniques */}
      <PanelCard>
        <SectionHeading icon={Shield}>
          MITRE ATT&amp;CK techniques
        </SectionHeading>
        {techniques.length === 0 ? (
          <EmptyState
            icon={Shield}
            compact
            title="No techniques mapped"
            description="No MITRE ATT&CK techniques were resolved for this case."
          />
        ) : (
          <div className="space-y-2">
            {techniques.map((t, i) => (
              <div key={`${t.id}-${i}`} className="rounded-md border border-border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {t.id}
                  </Badge>
                  {/* Name is from the curated MITRE corpus (TRUSTED) — still a plain text node. */}
                  <span className="text-sm font-semibold text-foreground">
                    {t.name || 'Unknown technique'}
                  </span>
                  <a
                    href={mitreUrl(t.id, t.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open MITRE ATT&CK ${t.id} in a new tab`}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <Link2 className="h-3 w-3" aria-hidden /> MITRE
                  </a>
                </div>
                {t.tactics && t.tactics.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {t.tactics.map((tac, j) => (
                      <Badge key={`${tac}-${j}`} variant="medium">
                        {humanizeToken(tac)}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {t.description ? (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {t.description}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </PanelCard>

      {/* ---------------------------------------------- asset context */}
      <PanelCard>
        <SectionHeading icon={Crosshair}>
          Asset context
        </SectionHeading>
        {!asset ||
        (!asset.entity &&
          asset.criticality === undefined &&
          asset.is_internal === undefined &&
          assetNetworks.length === 0 &&
          assetAttrs.length === 0) ? (
          <EmptyState
            icon={Crosshair}
            compact
            title="No asset context"
            description="No additional context was recorded for the case's primary entity."
          />
        ) : (
          <dl className="divide-y divide-border">
            {asset.entity ? (
              <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium text-muted-foreground">
                  {humanizeToken(asset.entity_type || 'Entity')}
                </dt>
                {/* UNTRUSTED — plain text, mono. */}
                <dd className="truncate text-right font-mono text-sm text-foreground">
                  {asset.entity}
                </dd>
              </div>
            ) : null}
            {asset.criticality !== undefined ? (
              <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium text-muted-foreground">
                  Criticality
                </dt>
                <dd className="text-right text-sm text-foreground">
                  {scalarLabel(asset.criticality)}
                </dd>
              </div>
            ) : null}
            {asset.is_internal !== undefined ? (
              <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium text-muted-foreground">
                  Internal asset
                </dt>
                <dd className="text-right text-sm text-foreground">
                  {asset.is_internal ? 'Yes' : 'No'}
                </dd>
              </div>
            ) : null}
            {assetNetworks.length ? (
              <div className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium text-muted-foreground">
                  Networks
                </dt>
                <dd className="max-w-[70%] text-right font-mono text-sm text-foreground">
                  {assetNetworks.map(String).join(', ')}
                </dd>
              </div>
            ) : null}
            {assetAttrs.map(([k, v], i) => (
              <div
                key={`${k}-${i}`}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <dt className="text-xs font-medium text-muted-foreground">
                  {humanizeToken(k)}
                </dt>
                {/* UNTRUSTED — plain text. */}
                <dd className="truncate text-right font-mono text-sm text-foreground">
                  {scalarLabel(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </PanelCard>

      {!anySection ? (
        <p className="text-xs text-muted-foreground">
          Threat context is enabled but produced no sections for this case.
        </p>
      ) : null}
    </div>
  );
};

export default ThreatContextPanel;
