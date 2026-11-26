/**
 * FactsRail: the case inspector, the facts beside EVERY tab (Round 12, CM-6; Round 15,
 * SPEC D8.4; Round 16, SPEC §4.4 WP03, [cmux] §5.6).
 *
 * The evidence narrative belongs in the tabs; the facts about the case belong here, each
 * with ONE home, in six collapsible sections divided by hairlines (no icon headings).
 * Whether each is open is kept per viewer in this browser (`soc.caseManager.
 * inspectorSections`); Record starts closed:
 *
 *   Outcome            the outcome of record, who classified it, the AI verdict and
 *                      confidence (with the auto-close bar of the entry for its verdict,
 *                      B27), who decided, the objection window, the auto-close review, and
 *                      why a case still waits for an investigation (`AwaitingReason`)
 *   Signal             the risk meter (its factors one click away), severity and its
 *                      provenance, one line of priority, impact and urgency, and the SLA
 *   Times              detected, opened, acknowledged, closed, updated
 *   Source and entity  where the case came from, its detection rules, the primary entity
 *                      and the related cases (a link to Evidence)
 *   Tags and campaign  the editable tags, and the campaign the case belongs to
 *   Record             the case number (Ask AI), the Sample mark, cost (`CaseUsageButton`),
 *                      build, profile, runbook, classification and AI verdict history,
 *                      notifications, and "View all fields" (`AllFieldsSheet`)
 *
 * The owner's one editable home is the header's meta strip, so the inspector does not
 * repeat it. The runbook's phases are the Response tab's (the Brief's People lane carries
 * the progress). From a 52rem pane the inspector is a column beside the tab content (`]`
 * shows or hides it); narrower panes open the same component in a non-blocking side sheet.
 *
 * SECURITY (#9): every case-derived value (names, ids, rule ids, entity, tags, source
 * names) is a plain text node or an InlineCode fence. #3: read-only except the existing
 * tag editor; nothing here decides or changes status, verdict or disposition.
 */
import * as React from 'react';
import { Bot, ChevronDown, Braces } from 'lucide-react';

import type { Case, SlaPolicy } from '@/lib/types';
import type { CaseReviewState } from '@/lib/types-reviews';
import {
  compareWithPolicy,
  comparisonSentence,
  explainPolicyToday,
  explainPriority,
  explainSeverity,
  explainSla,
  explainTimeToDetect,
  type AssetRangeReading,
  type SlaReadingWire,
} from '@/lib/explain/builders';
import { cn } from '@/lib/cn';
import { DASH, formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';
import { caseLabel } from '@/lib/format-values';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';

import { SeverityBadge, isAutoClosedByAI, severityBand } from '@/soc/components/badges';
import { DemoBadge, isDemoCase } from '@/soc/components/DemoBadge';
import {
  agreementWords,
  classificationEntry,
  confidencePercent,
  dispositionWords,
  latestReview,
  verdictWords,
  type CaseOutcome,
} from '@/soc/components/outcome';
import { InlineCode } from '@/soc/components/CodeBlock';
import { RuleLink, RuleSheetHost } from '@/soc/components/RuleLink';
import { ProvenanceTag, severityProvenance } from '@/soc/components/ProvenanceTag';
import { scoreBand } from '@/soc/components/palette';
import type { TriageChips } from '@/soc/pages/CaseDetail.api';
import { CampaignChip } from '@/soc/pages/Campaigns';
import type { Campaign } from '@/soc/pages/Campaigns.api';

import { AskAi } from './AskAi';
import { CaseTagsEditor } from './CaseTagsEditor';
import { SignalProfile } from './SignalProfile';
import { DecisionExplain } from './explain/DecisionExplain';
import { FactExplain } from './explain/FactExplain';
import { AllFieldsSheet } from './records/AllFieldsSheet';
import { AwaitingReason } from './records/AwaitingReason';
import { CaseUsageButton } from './records/CaseUsageButton';
import { NotificationsSent } from './records/NotificationsSent';
import type { FpPolicy } from './shared';
import { caseClocks, caseDisplayId, entityTypeLabel, firstEventAt, severityVersusRiskNote } from './caseFacts';
import { caseSlaReading } from './triageReads';

const FIELD_LABEL = 'text-xs font-medium text-muted-foreground';

/** The inspector's sections, in order, and whether each starts open. */
export const INSPECTOR_SECTIONS = [
  { id: 'outcome', title: 'Outcome', open: true },
  { id: 'signal', title: 'Signal', open: true },
  { id: 'times', title: 'Times', open: true },
  { id: 'source', title: 'Source and entity', open: true },
  { id: 'tags', title: 'Tags and campaign', open: true },
  { id: 'record', title: 'Record', open: false },
] as const;

export type InspectorSectionId = (typeof INSPECTOR_SECTIONS)[number]['id'];

/** Where the open sections are kept (a per-viewer convenience; never required). */
export const INSPECTOR_SECTIONS_KEY = 'soc.caseManager.inspectorSections';

function readOpenSections(): Partial<Record<InspectorSectionId, boolean>> {
  try {
    const raw = window.localStorage.getItem(INSPECTOR_SECTIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Partial<Record<InspectorSectionId, boolean>> = {};
    for (const { id } of INSPECTOR_SECTIONS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === 'boolean') out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOpenSections(value: Partial<Record<InspectorSectionId, boolean>>): void {
  try {
    window.localStorage.setItem(INSPECTOR_SECTIONS_KEY, JSON.stringify(value));
  } catch {
    /* private mode or blocked storage: the sections still open and close. */
  }
}

/** The open state of the six sections, shared by every inspector on the page. */
function useOpenSections(): [Record<InspectorSectionId, boolean>, (id: InspectorSectionId, open: boolean) => void] {
  const [stored, setStored] = React.useState<Partial<Record<InspectorSectionId, boolean>>>(() => readOpenSections());
  const state = React.useMemo(() => {
    const out = {} as Record<InspectorSectionId, boolean>;
    for (const section of INSPECTOR_SECTIONS) out[section.id] = stored[section.id] ?? section.open;
    return out;
  }, [stored]);
  const set = React.useCallback((id: InspectorSectionId, open: boolean) => {
    setStored((current) => {
      const next = { ...current, [id]: open };
      writeOpenSections(next);
      return next;
    });
  }, []);
  return [state, set];
}

/** One inspector section: a quiet heading that folds its facts, over a hairline. */
const RailSection: React.FC<{
  id: InspectorSectionId;
  title: string;
  open: boolean;
  onOpenChange: (id: InspectorSectionId, open: boolean) => void;
  testId?: string;
  children: React.ReactNode;
}> = ({ id, title, open, onOpenChange, testId, children }) => (
  <Collapsible
    open={open}
    onOpenChange={(next) => onOpenChange(id, next)}
    asChild
  >
    <section
      data-testid={testId}
      data-section-id={id}
      className="border-t border-border/60 py-3 first:border-t-0 first:pt-0 last:pb-0"
    >
      <h3>
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-sm text-left text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {title}
          <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="space-y-2.5 pt-2.5">{children}</CollapsibleContent>
    </section>
  </Collapsible>
);

/** One label/value row; `value` is a plain text node (UNTRUSTED-safe). */
const Fact: React.FC<{ label: string; children: React.ReactNode; mono?: boolean }> = ({
  label,
  children,
  mono = false,
}) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className={cn('shrink-0', FIELD_LABEL)}>{label}</dt>
    <dd className={cn('min-w-0 text-right text-sm text-foreground [overflow-wrap:anywhere]', mono && 'font-mono text-xs')}>
      {children}
    </dd>
  </div>
);

function chipLabel(token?: string | null): string {
  const t = (token || '').trim();
  if (!t) return DASH;
  if (/^p\d$/i.test(t)) return t.toUpperCase();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Every explicit analyst classification, newest first ("who classified, when"). */
function classificationHistory(c: Case): Array<{ disposition: string; by?: string; at?: string }> {
  const history = (c as { history?: unknown }).history;
  if (!Array.isArray(history)) return [];
  const out: Array<{ disposition: string; by?: string; at?: string }> = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i] as Record<string, unknown> | null;
    if (!entry || entry.event !== 'analyst_action') continue;
    const action = typeof entry.action === 'string' ? entry.action : '';
    const declared = typeof entry.classified_disposition === 'string' ? entry.classified_disposition.trim() : '';
    // A stored `confirm_fp` entry (an older Console's verb) still reads as a classification.
    if (!declared && action !== 'set_disposition' && action !== 'confirm_fp') continue;
    out.push({
      disposition: declared || (action === 'confirm_fp' ? 'false_positive' : 'recorded'),
      by: typeof entry.analyst === 'string' ? entry.analyst : undefined,
      at: typeof entry.ts === 'string' ? entry.ts : undefined,
    });
  }
  return out;
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The auto-close entry for the case's verdict as the decision builders read it. */
function policyThresholds(policy: FpPolicy | undefined) {
  if (!policy) return null;
  return {
    enabled: typeof policy.enabled === 'boolean' ? policy.enabled : null,
    min_confidence: finite(policy.min_confidence),
    max_risk_score: finite(policy.max_risk_score),
  };
}

/**
 * Both auto-close conditions of today's entry for the case's verdict (B27), with the
 * case's own numbers (D8): "Today's policy routes it to a person: confidence 97% >= 85%
 * (met); risk 45 <= 30 (not met)." `decide()` closes only when BOTH hold, so the line
 * never states half of the predicate. Null for a needs-human verdict (code fixes it, so
 * there is no bar) and when the entry does not name both bars.
 */
export function autoCloseBarLine(
  policy: FpPolicy | undefined,
  verdict?: string | null,
  confidence?: number | null,
  risk?: number | null,
): string | null {
  const comparison = compareWithPolicy(verdict ?? null, finite(confidence), finite(risk), policyThresholds(policy));
  if (comparison.klass === 'needs_human' || comparison.policyOutcome === 'unknown') return null;
  return comparisonSentence(comparison, 'current');
}

export interface FactsRailProps {
  c: Case;
  outcome: CaseOutcome;
  triage: TriageChips | null;
  slaPolicy?: SlaPolicy | null;
  /**
   * The server's SLA reading (the triage read's `sla`), used when the settings cannot be
   * read (no `settings:read`).
   */
  serverSla?: SlaReadingWire | null;
  /**
   * Today's internal network range that holds the entity (the triage read's `asset_cidr`,
   * sent only to a person who may read the settings), for the risk explanation.
   */
  assetRange?: AssetRangeReading | null;
  /** The auto-close entry for the case's verdict (`policyForVerdict`, B27). */
  policy?: FpPolicy;
  /**
   * Whether the viewer holds `cost:view`. Without it the Record section leaves the
   * investigation cost out (the server answers `token_cost: null` for that viewer too).
   */
  canViewCost: boolean;
  onCaseChange: (next: Case) => void;
  /** Open the Set disposition dialog (offered when a human close recorded no outcome). */
  onSetDisposition?: () => void;
  /** Open the Evidence tab's related-cases list. */
  onShowRelated?: () => void;
  /** Open the Evidence tab's events table (the Signal section's event count). */
  onShowEvents?: () => void;
  /** The viewer may edit the tags (`cases:write`) on the case on screen. */
  canTag?: boolean;
  /** The tag editor popover, controlled so T and "Edit tags" can open it. */
  tagsOpen?: boolean;
  onTagsOpenChange?: (open: boolean) => void;
  /** The campaign the case belongs to, if any (advisory, #3/#4). */
  campaign?: Campaign | null;
  onOpenCampaign?: () => void;
  /**
   * Round 15 (D8.4): the case's auto-close review state. `bandShown` when the pending
   * review is said elsewhere on screen (the header's review chip and the Brief's note), so
   * the inspector does not repeat it.
   */
  review?: { state: CaseReviewState | null; bandShown: boolean };
  className?: string;
}

/** The inspector's review line for a case that has no review result yet, or null. */
export function reviewStatusLine(review: FactsRailProps['review']): string | null {
  const state = review?.state;
  if (!state || !state.agent_closed) return null;
  if (state.state === 'pending' && !review?.bandShown) {
    return 'Picked at random for auto-close review. Waiting for a person.';
  }
  if (state.state === 'expired') {
    return state.expires_at
      ? `Picked at random for auto-close review. The review expired ${humanizeAge(state.expires_at)}.`
      : 'Picked at random for auto-close review. The review expired.';
  }
  return null;
}

export const FactsRail: React.FC<FactsRailProps> = ({
  c,
  outcome,
  triage,
  slaPolicy,
  serverSla = null,
  assetRange = null,
  policy,
  canViewCost,
  onCaseChange,
  onSetDisposition,
  onShowRelated,
  onShowEvents,
  canTag = false,
  tagsOpen = false,
  onTagsOpenChange,
  campaign,
  onOpenCampaign,
  review,
  className,
}) => {
  const [openSections, setSectionOpen] = useOpenSections();
  const [allFieldsOpen, setAllFieldsOpen] = React.useState(false);
  const entry = classificationEntry(c);
  // A recorded review (the outcome reads as it) names who reviewed it and when.
  const reviewed = outcome.source === 'review' ? latestReview(c) : null;
  const reviewLine = reviewed ? null : reviewStatusLine(review);
  const recordedDisposition = (() => {
    const value = typeof c.disposition === 'string' ? c.disposition.trim().toLowerCase() : '';
    return value && value !== 'none' ? value : null;
  })();
  const humanSettled = outcome.source === 'analyst' || outcome.source === 'analyst_policy';
  const severity = severityBand(triage?.severity?.band ?? c.severity_band) ?? severityBand(c.risk_score);
  const severitySource = triage?.severity?.source ?? c.severity_source;
  const riskVal = typeof triage?.risk?.value === 'number' ? triage.risk.value : c.risk_score;
  const riskBand = typeof riskVal === 'number' ? scoreBand(riskVal) : null;
  const disagree =
    severitySource === 'source_asserted' &&
    severity !== null &&
    severity !== 'info' &&
    riskBand !== null &&
    severity !== riskBand;
  const impact = triage?.impact?.band ?? c.impact_band;
  // D9: the triage read's priority is the matrix lookup; with the matrix off it carries no
  // level on purpose, and the case has no priority (never the matrix's default level).
  const triagePriority = triage?.priority ?? null;
  const priority = triagePriority ? triagePriority.level : c.priority_level;
  const noPriority =
    triagePriority !== null &&
    (triagePriority.level === null ||
      triagePriority.level === undefined ||
      triagePriority.inputs?.matrix_enabled === false ||
      (triagePriority as { enabled?: unknown }).enabled === false);
  const clocks = caseClocks(c);
  // Once the case ended, only the server's reading speaks for its SLA: it knows whether a
  // stopped clock was late (the SLA metrics count that case as a breach).
  const sla = caseSlaReading(c, slaPolicy, serverSla, Date.now(), outcome.terminal);
  const ruleIds = (c.rule_ids || []).filter((r): r is string => typeof r === 'string' && !!r.trim());
  const entityValue = c.entity?.value || '';
  const entityType = c.entity?.type || c.entity_type || '';
  const related = (Array.isArray(c.related_case_ids) ? c.related_case_ids : []).filter(
    (rid) => typeof rid === 'string' && rid && rid !== c.case_id,
  );
  const classifications = classificationHistory(c);
  const verdictHistory = Array.isArray(c.verdict_history) ? (c.verdict_history as Array<Record<string, unknown>>) : [];
  const appVersion = typeof c.app_version === 'string' ? c.app_version.trim() : '';
  const buildSha = typeof c.build_sha === 'string' ? c.build_sha.trim() : '';
  const objectionOpen =
    typeof c.objection_window_expires_at === 'string' && Date.parse(c.objection_window_expires_at) > Date.now();
  // After a person classified the case, the AI's confidence is the AI's, at assessment.
  // The bar is TODAY's policy, so it reads only against an open case: once the case ended,
  // the decision record (the Brief) names the bar it was decided against, and today's
  // ("auto-close off") beside "Auto-closed as false positive" would contradict it.
  const barConfidence = finite(c.confidence);
  const barRisk = finite(c.risk_score);
  const barLine =
    c.verdict && !humanSettled && !outcome.terminal ? autoCloseBarLine(policy, c.verdict, barConfidence, barRisk) : null;
  const barExplanation = barLine
    ? explainPolicyToday(String(c.verdict), barConfidence, barRisk, policyThresholds(policy))
    : null;
  const displayId = caseDisplayId(c);
  // T and "Edit tags" open the tag editor, which lives inside "Tags and campaign": a
  // folded section renders none of its content, so the editor opens the section with it,
  // and the section stays open (the viewer asked for the tags). Folding the section while
  // the editor is open closes the editor too, so nothing holds the case keys.
  const tagsSectionOpen = openSections.tags || tagsOpen;
  React.useEffect(() => {
    if (tagsOpen && !openSections.tags) setSectionOpen('tags', true);
  }, [tagsOpen, openSections.tags, setSectionOpen]);
  // The section sits low in the inspector, often below the fold of its column or sheet:
  // bring it into view as the editor opens, so the editor anchored to it is on screen
  // (it would otherwise open, and take focus, out of sight).
  const railRef = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (!tagsOpen) return;
    const tags = railRef.current?.querySelector<HTMLElement>('[data-section-id="tags"]');
    if (tags && typeof tags.scrollIntoView === 'function') tags.scrollIntoView({ block: 'nearest' });
  }, [tagsOpen]);
  const onSectionOpenChange = React.useCallback(
    (id: InspectorSectionId, next: boolean) => {
      setSectionOpen(id, next);
      if (id === 'tags' && !next && tagsOpen) onTagsOpenChange?.(false);
    },
    [setSectionOpen, tagsOpen, onTagsOpenChange],
  );
  const section = (id: InspectorSectionId) => ({
    id,
    title: INSPECTOR_SECTIONS.find((s) => s.id === id)!.title,
    open: id === 'tags' ? tagsSectionOpen : openSections[id],
    onOpenChange: onSectionOpenChange,
  });

  return (
    // A labelled region, not an aside: it sits inside the case's own region, and a
    // complementary landmark must be top level (axe landmark-complementary-is-top-level).
    <section ref={railRef} aria-label="Case facts" data-testid="case-facts-rail" className={cn('text-sm', className)}>
      <RailSection {...section('outcome')} testId="facts-outcome">
        <p data-testid="facts-outcome-headline" className="font-medium text-foreground">
          {outcome.headline}
        </p>
        {outcome.source === 'analyst' && (entry?.by || entry?.at) ? (
          <p className="text-xs text-muted-foreground">
            Classified
            {entry?.by ? <> by <span className="text-foreground">{entry.by}</span></> : null}
            {entry?.at ? <> · {humanizeAge(entry.at)}</> : null}
          </p>
        ) : null}
        {reviewed ? (
          <p data-testid="facts-review" className="text-xs text-muted-foreground">
            Auto-close review
            {reviewed.entry.analyst ? <> by <span className="text-foreground">{reviewed.entry.analyst}</span></> : null}
            {reviewed.entry.ts ? <> · {humanizeAge(reviewed.entry.ts)}</> : null}
          </p>
        ) : reviewLine ? (
          <p data-testid="facts-review" className="text-xs text-muted-foreground">
            {reviewLine}
          </p>
        ) : null}
        {outcome.aiLine ? (
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Bot className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 space-y-0.5">
              <p>
                {/* The verdict and its confidence open the decision's explanation (the
                    recorded gate, both conditions), as the header's verdict chip does. */}
                {c.verdict ? (
                  <DecisionExplain caseRecord={c}>
                    <span data-testid="facts-ai-line">{outcome.aiLine}</span>
                  </DecisionExplain>
                ) : (
                  outcome.aiLine
                )}
                {/* A review's agreement is its headline ("Review disagreed: ..."). */}
                {outcome.source !== 'review' && agreementWords(outcome.agreement)
                  ? ` · ${agreementWords(outcome.agreement)}`
                  : ''}
              </p>
              {barLine ? (
                <p data-testid="facts-auto-close-bar">
                  <FactExplain explanation={barExplanation}>{barLine}</FactExplain>
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {/* The disposition stored on the case when no analyst classified it (triage maps
            it from the AI verdict). Kept visible, and labelled for what it is (D15). */}
        {outcome.source !== 'analyst' && recordedDisposition ? (
          <p data-testid="facts-recorded-disposition" className="text-xs text-muted-foreground">
            Recorded disposition: <span className="text-foreground">{dispositionWords(recordedDisposition)}</span> (not
            confirmed by an analyst)
          </p>
        ) : null}
        {outcome.source === 'analyst_unrecorded' && onSetDisposition ? (
          <Button type="button" size="sm" variant="outline" onClick={onSetDisposition}>
            Set disposition
          </Button>
        ) : null}
        <dl className="space-y-1.5">
          <Fact label="Decided by">{c.decision_by ? humanizeToken(c.decision_by) : DASH}</Fact>
        </dl>
        {objectionOpen && !humanSettled ? (
          <p className="text-xs text-muted-foreground">
            {isAutoClosedByAI(c.status, c.decision_by) ? 'Reopen before ' : 'Objection window open until '}
            {formatTimestamp(c.objection_window_expires_at)}
          </p>
        ) : null}
        {/* Why the case still waits for an investigation, when it does (WP14). */}
        <AwaitingReason caseRecord={c} />
      </RailSection>

      <RailSection {...section('signal')} testId="facts-signal">
        <SignalProfile c={c} triage={triage} assetRange={assetRange} onShowEvents={onShowEvents} />
        <dl className="space-y-1.5" data-testid="facts-triage">
          <Fact label="Severity">
            {severity ? (
              <FactExplain explanation={explainSeverity(triage)}>
                <span className="inline-flex items-center gap-1">
                  <SeverityBadge severity={severity} />
                  <ProvenanceTag kind={severityProvenance(severitySource)} variant="icon" />
                </span>
              </FactExplain>
            ) : (
              DASH
            )}
          </Fact>
        </dl>
        <FactExplain explanation={explainPriority(triage)}>
          <p className="text-xs text-muted-foreground" data-testid="facts-priority-line">
            {noPriority ? (
              <span className="text-foreground">No priority</span>
            ) : (
              <>
                Priority <span className="text-foreground">{chipLabel(priority)}</span>
              </>
            )}{' '}
            · Impact <span className="text-foreground">{chipLabel(impact)}</span> · Urgency{' '}
            <span className="text-foreground">{chipLabel(c.urgency_band)}</span>
          </p>
        </FactExplain>
        {sla ? (
          <dl className="space-y-1.5">
            <Fact label={`SLA (${sla.priority})`}>
              <FactExplain explanation={explainSla(sla.wire)}>
                <span data-testid="facts-sla" data-sla-state={sla.state}>
                  {sla.text}
                </span>
              </FactExplain>
            </Fact>
          </dl>
        ) : null}
        {disagree ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{severityVersusRiskNote(severitySource)}</p>
        ) : null}
      </RailSection>

      <RailSection {...section('times')} testId="facts-times">
        <dl className="space-y-1.5">
          {clocks.map((clock) => (
            <Fact key={clock.label} label={clock.label}>
              {clock.label === 'Time to detect' ? (
                /* The one computed clock: its subtraction one hover or click away. */
                <FactExplain explanation={explainTimeToDetect(firstEventAt(c), c.created_at, clock.relative)}>
                  <span data-testid="facts-time-to-detect">{clock.relative}</span>
                </FactExplain>
              ) : (
                <span title={formatTimestamp(clock.at)}>{clock.relative}</span>
              )}
            </Fact>
          ))}
        </dl>
      </RailSection>

      <RailSection {...section('source')} testId="facts-source">
        <dl className="space-y-1.5">
          <Fact label="Source">{c.source_name || DASH}</Fact>
          {c.source_id ? (
            <Fact label="Source id" mono>
              {c.source_id}
            </Fact>
          ) : null}
          {c.detection_source ? <Fact label="Detected by">{humanizeToken(c.detection_source)}</Fact> : null}
          {c.source_surface ? <Fact label="Surface">{humanizeToken(c.source_surface)}</Fact> : null}
          {c.origin_surface ? <Fact label="Origin">{humanizeToken(c.origin_surface)}</Fact> : null}
        </dl>
        {ruleIds.length ? (
          <div className="space-y-1">
            <span className={cn('block', FIELD_LABEL)}>Detection rule{ruleIds.length === 1 ? '' : 's'}</span>
            <div className="flex flex-wrap gap-1">
              {/* Round 14 (SPEC §4.6.5): each rule opens its picture, the rule sheet. The
                  rail's rules share one sheet, so a live case update that re-renders them
                  never closes the sheet being read. */}
              <RuleSheetHost>
                {ruleIds.map((rule, index) => (
                  <span key={`${rule}-${index}`} className="group/ask inline-flex min-w-0 max-w-full items-center gap-1">
                    <RuleLink rule={rule} origin={caseLabel(c)} className="min-w-0 text-xs text-foreground" />
                    <AskAi kind="rule" value={rule} />
                  </span>
                ))}
              </RuleSheetHost>
            </div>
          </div>
        ) : null}
        {entityValue ? (
          <div className="space-y-1" data-testid="facts-entity">
            <span className={cn('block', FIELD_LABEL)}>Primary entity</span>
            <div className="group/ask flex flex-wrap items-center gap-1.5">
              <InlineCode className="break-all">{entityValue}</InlineCode>
              {entityType ? <Badge variant="outline">{entityTypeLabel(String(entityType))}</Badge> : null}
              {/* Round 12 WP-ASK: a NEW Workspace chat, never this case's chat (#5). */}
              <AskAi type={String(entityType || '')} value={entityValue} />
            </div>
            {ruleIds[0] || c.source_name ? (
              <p className="text-xs text-muted-foreground">
                Seen by <span className="text-foreground">{ruleIds[0] || 'a detection'}</span>
                {c.source_name ? (
                  <>
                    {' '}
                    on <span className="text-foreground">{c.source_name}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}
        {related.length ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto px-0 text-primary hover:bg-transparent hover:underline"
            onClick={onShowRelated}
            disabled={!onShowRelated}
            data-testid="facts-related"
          >
            {related.length.toLocaleString()} related case{related.length === 1 ? '' : 's'}
          </Button>
        ) : null}
      </RailSection>

      <RailSection {...section('tags')} testId="facts-tags">
        <CaseTagsEditor
          c={c}
          canTag={canTag}
          onCaseChange={onCaseChange}
          open={tagsOpen}
          onOpenChange={(next) => onTagsOpenChange?.(next)}
        />
        {campaign ? (
          /* A generated campaign id can be very long: the chip truncates, and its full
             name stays in its accessible name and on hover. */
          <div className="min-w-0" title={campaign.name || campaign.id} data-testid="facts-campaign">
            <CampaignChip campaign={campaign} onOpen={onOpenCampaign} className="inline-flex min-w-0 max-w-full" />
          </div>
        ) : null}
      </RailSection>

      <RailSection {...section('record')} testId="facts-record">
        <dl className="space-y-1.5">
          <Fact label="Case">
            {/* Round 12 WP-ASK: a NEW Workspace chat about this case, never this case's
                own chat thread (#5). A case number in a custom format the question cannot
                name falls back to the id. */}
            <span className="group/ask inline-flex min-w-0 max-w-full items-center justify-end gap-1">
              <span className="font-mono text-xs">{displayId}</span>
              <AskAi kind="case" value={displayId} fallbackValue={c.case_id} />
            </span>
          </Fact>
          {isDemoCase(c) ? (
            <Fact label="Data">
              <DemoBadge className="h-5 px-1.5 text-2xs" />
            </Fact>
          ) : null}
          {canViewCost && c.token_cost != null ? (
            <Fact label="Investigation cost">
              <CaseUsageButton caseId={c.case_id} totalCost={c.token_cost} />
            </Fact>
          ) : null}
          <Fact label="Creation build">
            {appVersion || buildSha
              ? `${appVersion ? `v${appVersion}` : 'version unavailable'} · ${
                  buildSha ? (buildSha === 'unknown' ? 'SHA unknown' : buildSha.slice(0, 12)) : 'SHA unavailable'
                }`
              : 'Unavailable'}
          </Fact>
          {c.agent_persona ? <Fact label="Profile">{humanizeToken(c.agent_persona)}</Fact> : null}
          {c.runbook_id ? (
            <Fact label="Investigator runbook" mono>
              {c.runbook_id}
              {typeof c.runbook_version === 'number' ? ` v${c.runbook_version}` : ''}
            </Fact>
          ) : c.playbook_id ? (
            /* A case investigated before Round 14 keeps its stored id (shown verbatim). */
            <Fact label="Older runbook" mono>
              {c.playbook_id}
            </Fact>
          ) : null}
        </dl>
        {classifications.length ? (
          <div className="space-y-1">
            <span className={cn('block', FIELD_LABEL)}>Classification history</span>
            <ol className="space-y-1 text-xs">
              {classifications.map((item, index) => (
                <li key={`${item.at ?? ''}-${index}`} className="text-foreground">
                  {dispositionWords(item.disposition)}
                  <span className="text-muted-foreground">
                    {item.by ? ` · ${item.by}` : ''}
                    {item.at ? ` · ${humanizeAge(item.at)}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {verdictHistory.length ? (
          <div className="space-y-1">
            <span className={cn('block', FIELD_LABEL)}>AI verdict history</span>
            <ol className="space-y-1 text-xs">
              {[...verdictHistory].reverse().map((item, index) => {
                const pct = confidencePercent(item.confidence);
                return (
                  <li key={`${String(item.ts ?? '')}-${index}`} className="text-foreground">
                    {verdictWords(item.verdict)}
                    <span className="text-muted-foreground">
                      {pct !== null ? ` · ${pct}%` : ''}
                      {typeof item.risk_score === 'number' ? ` · risk ${Math.round(item.risk_score)}` : ''}
                      {typeof item.ts === 'string' ? ` · ${humanizeAge(item.ts)}` : ''}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}
        {/* The newest five, then "Show all", each with its channel id (WP14). */}
        <NotificationsSent records={c.notifications_sent} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={() => setAllFieldsOpen(true)}
          aria-haspopup="dialog"
        >
          <Braces className="size-3.5" aria-hidden />
          View all fields
        </Button>
        <AllFieldsSheet caseId={c.case_id} open={allFieldsOpen} onOpenChange={setAllFieldsOpen} />
      </RailSection>
    </section>
  );
};

export default FactsRail;
