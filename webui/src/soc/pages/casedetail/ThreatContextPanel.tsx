/**
 * CaseDetail: the Threat context section (Coupling-D split).
 *
 * Since Round 16 (D8) this is the "Threat context" section of the Evidence tab, which
 * owns its heading and the content rail (Round 15 had it on the Investigation tab). It
 * holds the threat summary, MITRE ATT&CK techniques (with canonical links), IOC
 * reputation, the clustering story and the asset context, as flat divider-led
 * sub-sections. Fail-open: renders empty/disabled states when the panel is off or bare.
 * The Related cases list and the AI verdict and risk are NOT repeated here: the list is
 * the Evidence tab's own section, and the verdict and risk are the case header's and the
 * inspector's. The clustering story names each related case by its number, as a link
 * that opens it in Case Manager (`ClusterFormationDiagram`).
 *
 * Round 16 (SPEC §4.5 WP14, research data-visibility R7): each indicator opens its
 * providers, one line each (score, the provider's own call, confidence, an error, from
 * the cache), how they were fused, and the provider's raw excerpt in a fenced CodeBlock.
 * The panel is read when the case is opened ("Checked when you opened this case"), so
 * its reading can differ from the one the investigation used; that one is shown beside
 * it from the recorded risk inputs ("At investigation: 0").
 *
 * SECURITY (#9): every indicator, country, entity, asset attribute, provider tag, error
 * and raw value and summary string is UNTRUSTED: rendered plain text / inside
 * <CodeBlock>. MITRE technique NAMES are from the curated corpus (TRUSTED) but still
 * rendered as plain text nodes. #3: read-only projection; it never decides or mutates
 * the case.
 */
import * as React from 'react';
import { AlertTriangle, Globe, Link2 } from 'lucide-react';

import type {
  Case,
  IocReputation,
  ThreatContextPanel as ThreatContextPanelData,
} from '@/lib/types';
import { DASH, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { LoadingState } from '@/design-system';

import { CodeBlock } from '@/soc/components/CodeBlock';

import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import type { Navigate } from '@/soc/router';

import { AskAi } from './AskAi';
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
  return String(value ?? DASH);
}

export type IocVerdictKind = 'malicious' | 'no_detections' | 'not_checked';

/**
 * The indicator verdict, TRI-STATE (CM-8). "Clean" was shown whenever `is_malicious`
 * was false: even when no provider answered and the confidence was 0, which reads as a
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

/** The fence the server wraps each provider string in (`agents/prompts.fence`). */
const FENCE_OPEN = '<<<UNTRUSTED_LOG_DATA>>>';
const FENCE_CLOSE = '<<<END_UNTRUSTED_LOG_DATA>>>';

/**
 * The text inside one fenced provider string, for a plain text node; any other value as
 * written. Presentation only: the raw excerpt stays fenced in a CodeBlock.
 */
export function unfenced(value: unknown): string {
  if (typeof value !== 'string') return value === null || value === undefined ? '' : String(value);
  const text = value.trim();
  if (!text.startsWith(FENCE_OPEN) || !text.endsWith(FENCE_CLOSE)) return value;
  const inner = text.slice(0, text.length - FENCE_CLOSE.length);
  const newline = inner.indexOf('\n');
  return (newline >= 0 ? inner.slice(newline + 1) : '').trim();
}

/** One provider's answer as the threat-context route returns it (fenced strings). */
export interface IocProvider {
  provider: string;
  score: number | null;
  malicious: boolean | null;
  confidence: number | null;
  tags: string[];
  raw: Record<string, unknown>;
  ok: boolean;
  error: string | null;
  cached: boolean;
}

/** The per-provider part of an indicator row (WP13), read defensively. */
export function iocProviders(ioc: IocReputation): {
  providers: IocProvider[];
  method: string | null;
  status: string | null;
} {
  const list = Array.isArray(ioc.providers) ? (ioc.providers as unknown[]) : [];
  const providers = list
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
    .map((p) => ({
      provider: typeof p.provider === 'string' ? p.provider : '',
      score: typeof p.score === 'number' && Number.isFinite(p.score) ? p.score : null,
      malicious: typeof p.malicious === 'boolean' ? p.malicious : null,
      confidence: typeof p.confidence === 'number' && Number.isFinite(p.confidence) ? p.confidence : null,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      raw: p.raw && typeof p.raw === 'object' ? (p.raw as Record<string, unknown>) : {},
      ok: p.ok !== false,
      error: typeof p.error === 'string' && p.error ? p.error : null,
      cached: p.cached === true,
    }));
  return {
    providers,
    method: typeof ioc.method === 'string' && ioc.method ? ioc.method : null,
    status: typeof ioc.providers_status === 'string' ? ioc.providers_status : null,
  };
}

/** "Fused by the highest score: 87 from abuseipdb.", or the weighted blend. */
export function fusionLine(method: string | null, score: number | undefined, providers: readonly IocProvider[]): string {
  const value = typeof score === 'number' ? Math.round(score).toLocaleString('en-US') : 'no score';
  if (method === 'weighted') return `Fused by a confidence-weighted average: ${value}.`;
  if (method === 'max') {
    const top = providers
      .filter((p) => p.ok && p.score !== null)
      .reduce<IocProvider | null>((best, p) => (best === null || (p.score ?? 0) > (best.score ?? 0) ? p : best), null);
    return top ? `Fused by the highest score: ${value} from ${top.provider}.` : `Fused by the highest score: ${value}.`;
  }
  return 'How the providers were fused was not recorded.';
}

/** Where the providers' answers came from, in words. */
const PROVIDER_STATUS_WORDS: Record<string, string> = {
  checked: 'Checked when you opened this case.',
  cached: 'Read from the enrichment cache when you opened this case.',
  not_recorded: 'A cached answer, kept without its provider results.',
  skipped: 'No provider was asked.',
};

/** The provider lines of one indicator, its fusion and the raw excerpts (fenced). */
const IocProvidersPanel: React.FC<{ ioc: IocReputation }> = ({ ioc }) => {
  const { providers, method, status } = iocProviders(ioc);
  const score = iocScore(ioc);
  return (
    <div className="space-y-2 text-xs" data-testid="ioc-providers">
      <p className="text-muted-foreground">{(status && PROVIDER_STATUS_WORDS[status]) || 'Checked when you opened this case.'}</p>
      {providers.length ? (
        <>
          <p className="text-foreground">{fusionLine(method, score, providers)}</p>
          <ul className="max-h-[50vh] divide-y divide-border/60 overflow-y-auto">
            {providers.map((p, index) => (
              <li key={`${p.provider}-${index}`} className="space-y-1 py-1.5 first:pt-0 last:pb-0" data-testid="ioc-provider">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-medium text-foreground">{p.provider || 'Provider'}</span>
                  {p.ok ? (
                    <span className="text-muted-foreground">
                      {p.score !== null ? `score ${Math.round(p.score)}` : 'no score'}
                      {p.malicious === true ? ', malicious' : p.malicious === false ? ', not malicious' : ''}
                      {p.confidence !== null
                        ? `, confidence ${Math.round(p.confidence <= 1 ? p.confidence * 100 : p.confidence)}%`
                        : ''}
                    </span>
                  ) : (
                    <span className="text-critical-text">did not answer</span>
                  )}
                  {p.cached ? <span className="text-muted-foreground">from the cache</span> : null}
                </div>
                {p.error ? (
                  /* UNTRUSTED provider error: plain text. */
                  <p className="text-muted-foreground [overflow-wrap:anywhere]">{`Error: ${unfenced(p.error)}`}</p>
                ) : null}
                {p.tags.length ? (
                  /* UNTRUSTED tags: plain text. */
                  <p className="text-muted-foreground [overflow-wrap:anywhere]">{`Tags: ${p.tags.map(unfenced).join(', ')}`}</p>
                ) : null}
                {Object.keys(p.raw).length ? (
                  <CodeBlock value={p.raw} caption="untrusted provider response" wrap copyable maxHeightClassName="max-h-40" />
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-muted-foreground">No provider results were recorded for this indicator.</p>
      )}
    </div>
  );
};

/** The reputation the investigation used, from the recorded risk inputs (WP10). */
export function investigationReputation(c: Case): string | null {
  const breakdown = c.risk_breakdown as
    | { inputs?: { reputation_input?: unknown; reputation_source?: unknown } | null }
    | null
    | undefined;
  const inputs = breakdown?.inputs;
  if (!inputs || typeof inputs.reputation_input !== 'number') return null;
  const value = Math.round(inputs.reputation_input).toLocaleString('en-US');
  switch (inputs.reputation_source) {
    case 'enrichment':
      return `At investigation: ${value}.`;
    case 'enrichment_off':
      return `At investigation: ${value}, enrichment was off.`;
    case 'not_ip_entity':
      return `At investigation: ${value}, the entity was not an IP address.`;
    default:
      return `At investigation: ${value}, not looked up.`;
  }
}

/** A tactic token as sentence-case words ("initial-access" → "Initial access"). */
function tacticWords(tactic: string): string {
  const words = String(tactic || '').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : DASH;
}

/** A sub-section heading under the "Threat context" section (h3, no icon, D8.5). */
const FlatHeading: React.FC<{
  id: string;
  count?: number;
  children: React.ReactNode;
}> = ({ id, count, children }) => (
  <div className="mb-3 flex items-baseline gap-2">
    <h3 id={id} className="text-sm font-semibold text-foreground">
      {children}
    </h3>
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
   * Accepted for API stability with the CaseDetail shell, and not used. The only cases
   * this panel opens are the related cases in the clustering story, and those are links
   * that go through the router themselves (`ClusterFormationDiagram`, Round 16), so the
   * panel needs no navigation callback. Kept optional so callers can pass it.
   */
  onNavigate?: Navigate;
}> = ({ c, panel, loading, error, onRetry }) => {
  if (loading) {
    return (
      <div>
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
      <div>
        <LoadError error={error} title="Could not load threat context" onRetry={onRetry} />
      </div>
    );
  }
  if (panel?.disabled) {
    return (
      <div>
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
      <div>
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
  // The Related cases list and the evidence are the Evidence tab's own sections, not
  // repeated here, so they do not take part in the "any section" gate.
  const anySection =
    !!panel.summary || iocs.length > 0 || techniques.length > 0 || !!asset || !!clustering?.available;

  const assetEmpty =
    !asset ||
    (!asset.entity &&
      asset.criticality === undefined &&
      asset.is_internal === undefined &&
      assetNetworks.length === 0 &&
      assetAttrs.length === 0);
  return (
    <div
      className="space-y-6"
      data-case-panel="threat-context"
      data-presentation="case-manager"
    >
      {/* Flat sections (CM-8): no card-in-card. Since Round 15 this is ONE section of the
          Investigation tab, whose sections the hairlines divide, so its own parts are set
          apart by space and an h3 alone: a hairline here would read as a sibling of
          "Decision" and "Threat context". Every field of both earlier
          layouts is kept: summary, AI verdict, risk, malicious-indicator flag, the
          assembled time, each technique's id/name/every tactic/description/link, each
          indicator's value/type/verdict/score/source/country, the clustering story and
          the asset context. Log-derived values stay plain text nodes (#9). */}
      {/* The summary leads without a heading of its own: the section is "Threat context".
          The AI verdict and the risk are the header's and the inspector's (D8). */}
      <section aria-label="Threat summary">
        {panel.summary ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{panel.summary}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No threat summary for this case.</p>
        )}
        {iocs.some((i) => i.is_malicious) || panel.generated_at ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {iocs.some((i) => i.is_malicious) ? (
              <Badge variant="critical" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                Malicious indicator present
              </Badge>
            ) : null}
            {panel.generated_at ? (
              <span className="text-xs text-muted-foreground">
                {panel.summary ? 'Assembled' : 'Context assembled'} {humanizeAge(panel.generated_at)}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="threat-mitre-title" data-testid="threat-mitre">
        <FlatHeading id="threat-mitre-title" count={techniques.length}>
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
                  {/* Name is from the curated MITRE corpus (TRUSTED): still a plain text node. */}
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

      <section aria-labelledby="threat-ioc-title" data-testid="threat-ioc">
        <FlatHeading id="threat-ioc-title" count={iocs.length}>
          Indicator reputation
        </FlatHeading>
        {iocs.length ? (
          <p className="-mt-2 mb-3 text-xs text-muted-foreground" data-testid="threat-ioc-when">
            {iocs.every((ioc) => ioc.providers_status === 'skipped')
              ? 'No provider was asked when you opened this case.'
              : 'Checked when you opened this case.'}
            {investigationReputation(c) ? ` ${investigationReputation(c)}` : ''}
          </p>
        ) : null}
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
                  className="group/ask grid gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0 @[40rem]/case:grid-cols-[minmax(0,1fr)_auto]"
                  data-testid="threat-ioc-row"
                  data-ioc-verdict={verdict.kind}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {/* UNTRUSTED indicator: plain text, mono. */}
                    <span className="min-w-0 truncate font-mono text-sm text-foreground" title={ioc.indicator}>
                      {ioc.indicator}
                    </span>
                    {ioc.type ? <span className="text-xs text-muted-foreground">{humanizeToken(ioc.type)}</span> : null}
                    <Badge variant={verdict.variant} title={verdict.detail}>
                      {verdict.label}
                    </Badge>
                    <AskAi type={ioc.type} value={ioc.indicator} />
                  </div>
                  <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs @[40rem]/case:justify-end">
                    <div className="flex gap-1">
                      <dt className="text-muted-foreground">Source</dt>
                      <dd className="text-foreground">{source ? humanizeToken(source) : 'Unavailable'}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt className="sr-only">Providers</dt>
                      <dd>
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Providers for ${ioc.indicator}`}
                            >
                              Providers
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            align="end"
                            aria-label={`Providers for ${ioc.indicator}`}
                            className="w-[min(92vw,26rem)]"
                          >
                            <IocProvidersPanel ioc={ioc} />
                          </PopoverContent>
                        </Popover>
                      </dd>
                    </div>
                    <div className="flex gap-1">
                      {/* The fused reputation score, the number "At investigation: N" and
                          the fusion line show, not a provider's confidence. A placeholder 0
                          for an indicator no provider was asked about is never shown as a
                          measured score (numbers review). */}
                      <dt className="text-muted-foreground">Reputation</dt>
                      {ioc.providers_status === 'skipped' ? (
                        <dd
                          className="text-muted-foreground"
                          title="No provider was asked, so there is no reputation score."
                        >
                          Not checked
                        </dd>
                      ) : (
                        <dd
                          className={cn(
                            'tabular-nums',
                            typeof score === 'number' && score >= 50 ? 'font-medium text-critical-text' : 'text-foreground',
                          )}
                        >
                          {typeof score === 'number' ? String(Math.round(score)) : 'Unavailable'}
                        </dd>
                      )}
                    </div>
                    {ioc.country ? (
                      <div className="flex gap-1">
                        <dt className="text-muted-foreground">Country</dt>
                        {/* UNTRUSTED: plain text. */}
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
        // The diagram draws its own top/bottom rules; inside this section its parts are
        // set apart by space, so its own rules are dropped here.
        <div className="[&>section]:border-y-0 [&>section]:py-0">
          <ClusterFormationDiagram data={clustering} />
        </div>
      ) : null}

      <section aria-labelledby="threat-asset-title">
        <FlatHeading id="threat-asset-title">
          Asset context
        </FlatHeading>
        {assetEmpty || !asset ? (
          <p className="text-sm text-muted-foreground">
            No additional context was recorded for the case&apos;s primary entity.
          </p>
        ) : (
          <dl className="grid max-w-3xl grid-cols-2 gap-x-6 gap-y-3 text-sm @[40rem]/case:grid-cols-3">
            {asset.entity ? (
              <div className="group/ask min-w-0">
                <dt className="text-xs text-muted-foreground">{humanizeToken(asset.entity_type || 'Entity')}</dt>
                <dd className="flex min-w-0 items-center gap-1.5">
                  {/* UNTRUSTED: plain text, mono. */}
                  <span className="truncate font-mono text-foreground">{asset.entity}</span>
                  <AskAi type={asset.entity_type} value={asset.entity} />
                </dd>
              </div>
            ) : null}
            {asset.criticality !== undefined ? (
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Criticality</dt>
                <dd className="truncate text-foreground">{scalarLabel(asset.criticality)}</dd>
              </div>
            ) : null}
            {asset.is_internal !== undefined ? (
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Internal asset</dt>
                <dd className="text-foreground">{asset.is_internal ? 'Yes' : 'No'}</dd>
              </div>
            ) : null}
            {assetNetworks.length ? (
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Networks</dt>
                <dd className="break-words font-mono text-foreground">
                  {assetNetworks.map(String).join(', ')}
                </dd>
              </div>
            ) : null}
            {assetAttrs.map(([key, value], index) => (
              <div key={`${key}-${index}`} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{humanizeToken(key)}</dt>
                {/* UNTRUSTED: plain text. */}
                <dd className="truncate text-foreground" title={scalarLabel(value)}>{scalarLabel(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {!anySection ? (
        <p className="text-xs text-muted-foreground">
          Threat context is enabled but produced no sections for this case.
        </p>
      ) : null}
    </div>
  );
};

export default ThreatContextPanel;
