/**
 * FactsRail: the case's facts, visible beside EVERY tab (Round 12, CM-6; Round 15,
 * SPEC D8.4).
 *
 * The evidence narrative belongs in the tabs; the facts about the case belong here, each
 * with ONE home, in eight sections divided by hairlines (no icon headings):
 *
 *   Outcome   the outcome of record, who classified it, the AI verdict and confidence
 *             (with the auto-close bar), who decided, the objection window
 *   Signal    the risk meter (its factors one click away), severity and its provenance,
 *             priority, impact and urgency
 *   Runbook   the runbook on the case (Round 14, §4.10.11): phases with counts
 *   Times     detected, opened, acknowledged, closed, updated, and the SLA
 *   Tags      the editable tags, and the campaign the case belongs to
 *   Source    where the case came from, its detection rules and the primary entity
 *   Related   the related cases
 *   Record    the case number (Ask AI), the Sample mark, cost, build, profile, runbook,
 *             classification and AI verdict history, notifications
 *
 * The owner's one editable home is the header's meta row, so the rail does not repeat it.
 * On a pane of 60rem or wider the rail is a column beside the tab content; narrower panes
 * open the same component in a non-blocking side sheet from the header's "Details".
 *
 * SECURITY (#9): every case-derived value (names, ids, rule ids, entity, tags, source
 * names) is a plain text node or an InlineCode fence. #3: read-only except the existing
 * tag editor; nothing here decides or changes status, verdict or disposition.
 */
import * as React from 'react';
import { Bot } from 'lucide-react';

import type { Case, SlaPolicy } from '@/lib/types';
import type { CaseRunbooks, PhaseId } from '@/lib/types-runbooks';
import { cn } from '@/lib/cn';
import { DASH, fmtMoney, formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';
import { caseLabel } from '@/lib/format-values';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';

import { SeverityBadge, isAutoClosedByAI, severityBand } from '@/soc/components/badges';
import { DemoBadge, isDemoCase } from '@/soc/components/DemoBadge';
import {
  agreementWords,
  classificationEntry,
  confidencePercent,
  dispositionWords,
  verdictWords,
  type CaseOutcome,
} from '@/soc/components/outcome';
import { InlineCode } from '@/soc/components/CodeBlock';
import { RuleLink, RuleSheetHost } from '@/soc/components/RuleLink';
import { ProvenanceTag, severityProvenance } from '@/soc/components/ProvenanceTag';
import { scoreBand } from '@/soc/components/palette';
import { RunbookRail } from '@/soc/runbooks/run/RunbookRail';
import type { TriageChips } from '@/soc/pages/CaseDetail.api';
import { CampaignChip } from '@/soc/pages/Campaigns';
import type { Campaign } from '@/soc/pages/Campaigns.api';

import { AskAi } from './AskAi';
import { CaseTagsEditor } from './CaseTagsEditor';
import { SignalProfile } from './SignalProfile';
import { confidenceCalibration, type FpPolicy } from './shared';
import { caseClocks, caseDisplayId, entityTypeLabel, severityVersusRiskNote, slaReading } from './caseFacts';

const FIELD_LABEL = 'text-xs font-medium text-muted-foreground';

/** One rail section: a 13px heading over its facts, divided from the next by a hairline. */
const RailSection: React.FC<{ title: string; testId?: string; children: React.ReactNode }> = ({
  title,
  testId,
  children,
}) => (
  <section
    data-testid={testId}
    className="space-y-2.5 border-t border-border/60 py-4 first:border-t-0 first:pt-0 last:pb-0"
  >
    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    {children}
  </section>
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

/** "Auto-close bar 90% · FP auto-close enabled at this bar", when the policy is known. */
function autoCloseBarLine(fpPolicy: FpPolicy | undefined, verdict?: string | null): string | null {
  const calibration = confidenceCalibration(fpPolicy ?? null, verdict ?? undefined);
  if (typeof calibration.threshold !== 'number') return null;
  const bar = confidencePercent(calibration.threshold);
  if (bar === null) return null;
  return `Auto-close bar ${bar}%${calibration.note ? ` · ${calibration.note}` : ''}`;
}

export interface FactsRailProps {
  c: Case;
  outcome: CaseOutcome;
  triage: TriageChips | null;
  slaPolicy?: SlaPolicy | null;
  /** The FP auto-close policy, so the AI confidence is read against its bar. */
  fpPolicy?: FpPolicy;
  /**
   * Whether the viewer holds `cost:view`. Without it the Record section leaves the
   * investigation cost out (the server answers `token_cost: null` for that viewer too).
   */
  canViewCost: boolean;
  onCaseChange: (next: Case) => void;
  /** Open the Set disposition dialog (offered when a human close recorded no outcome). */
  onSetDisposition?: () => void;
  /** Jump to the Overview's related-cases list. */
  onShowRelated?: () => void;
  /**
   * Round 14 (SPEC §4.10.11): the case's runbook runs for the "Runbook" section. Left out
   * when the viewer cannot read runbooks or runbooks are off; the section is then hidden.
   */
  runbook?: {
    data: CaseRunbooks | null;
    loading: boolean;
    failed: boolean;
    onOpenPhase: (phase: PhaseId | null) => void;
  };
  /** The viewer may edit the tags (`cases:write`) on the case on screen. */
  canTag?: boolean;
  /** The tag editor popover, controlled so T and "Edit tags" can open it. */
  tagsOpen?: boolean;
  onTagsOpenChange?: (open: boolean) => void;
  /** The campaign the case belongs to, if any (advisory, #3/#4). */
  campaign?: Campaign | null;
  onOpenCampaign?: () => void;
  className?: string;
}

export const FactsRail: React.FC<FactsRailProps> = ({
  c,
  outcome,
  triage,
  slaPolicy,
  fpPolicy,
  canViewCost,
  onCaseChange,
  onSetDisposition,
  onShowRelated,
  runbook,
  canTag = false,
  tagsOpen = false,
  onTagsOpenChange,
  campaign,
  onOpenCampaign,
  className,
}) => {
  const entry = classificationEntry(c);
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
  const priority = triage?.priority?.level ?? triage?.priority?.default ?? c.priority_level;
  const clocks = caseClocks(c);
  const sla = slaReading(c, slaPolicy);
  const ruleIds = (c.rule_ids || []).filter((r): r is string => typeof r === 'string' && !!r.trim());
  const entityValue = c.entity?.value || '';
  const entityType = c.entity?.type || c.entity_type || '';
  const related = (Array.isArray(c.related_case_ids) ? c.related_case_ids : []).filter(
    (rid) => typeof rid === 'string' && rid && rid !== c.case_id,
  );
  const notifications = Array.isArray(c.notifications_sent) ? c.notifications_sent : [];
  const classifications = classificationHistory(c);
  const verdictHistory = Array.isArray(c.verdict_history) ? (c.verdict_history as Array<Record<string, unknown>>) : [];
  const appVersion = typeof c.app_version === 'string' ? c.app_version.trim() : '';
  const buildSha = typeof c.build_sha === 'string' ? c.build_sha.trim() : '';
  const objectionOpen =
    typeof c.objection_window_expires_at === 'string' && Date.parse(c.objection_window_expires_at) > Date.now();
  // After a person classified the case, the AI's confidence is the AI's, at assessment.
  const barLine = c.verdict && !humanSettled ? autoCloseBarLine(fpPolicy, c.verdict) : null;
  const displayId = caseDisplayId(c);

  return (
    <aside aria-label="Case facts" data-testid="case-facts-rail" className={cn('text-sm', className)}>
      <RailSection title="Outcome" testId="facts-outcome">
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
        {outcome.aiLine ? (
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Bot className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 space-y-0.5">
              <p>
                {outcome.aiLine}
                {agreementWords(outcome.agreement) ? ` · ${agreementWords(outcome.agreement)}` : ''}
              </p>
              {barLine ? <p data-testid="facts-auto-close-bar">{barLine}</p> : null}
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
      </RailSection>

      <RailSection title="Signal" testId="facts-signal">
        <SignalProfile c={c} triage={triage} />
        <dl className="space-y-1.5" data-testid="facts-triage">
          <Fact label="Severity">
            {severity ? (
              <span className="inline-flex items-center gap-1">
                <SeverityBadge severity={severity} />
                <ProvenanceTag kind={severityProvenance(severitySource)} variant="icon" />
              </span>
            ) : (
              DASH
            )}
          </Fact>
          <Fact label="Priority">{chipLabel(priority)}</Fact>
          <Fact label="Impact">{chipLabel(impact)}</Fact>
          <Fact label="Urgency">{chipLabel(c.urgency_band)}</Fact>
        </dl>
        {disagree ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{severityVersusRiskNote(severitySource)}</p>
        ) : null}
      </RailSection>

      {runbook ? (
        <RailSection title="Runbook" testId="facts-runbook">
          <RunbookRail
            data={runbook.data}
            loading={runbook.loading}
            failed={runbook.failed}
            onOpenPhase={runbook.onOpenPhase}
          />
        </RailSection>
      ) : null}

      <RailSection title="Times" testId="facts-times">
        <dl className="space-y-1.5">
          {clocks.map((clock) => (
            <Fact key={clock.label} label={clock.label}>
              <span title={formatTimestamp(clock.at)}>{clock.relative}</span>
            </Fact>
          ))}
          {sla ? <Fact label={`SLA (${sla.priority})`}>{sla.text}</Fact> : null}
        </dl>
      </RailSection>

      <RailSection title="Tags" testId="facts-tags">
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

      <RailSection title="Source" testId="facts-source">
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
      </RailSection>

      {related.length ? (
        <RailSection title="Related cases" testId="facts-related">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto px-0 text-primary hover:bg-transparent hover:underline"
            onClick={onShowRelated}
            disabled={!onShowRelated}
          >
            {related.length} related case{related.length === 1 ? '' : 's'}
          </Button>
        </RailSection>
      ) : null}

      <RailSection title="Record" testId="facts-record">
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
          {canViewCost && c.token_cost != null ? <Fact label="Investigation cost">{fmtMoney(c.token_cost)}</Fact> : null}
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
            <Fact label="Runbook (before Round 14)" mono>
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
        {notifications.length ? (
          <div className="space-y-1">
            <span className={cn('block', FIELD_LABEL)}>Notifications sent ({notifications.length})</span>
            <ol className="space-y-1 text-xs">
              {[...notifications]
                .reverse()
                .slice(0, 5)
                .map((n, index) => (
                  <li key={`${n.ts ?? ''}-${index}`} className="text-foreground">
                    {humanizeToken(String(n.type || 'channel'))}
                    <span className="text-muted-foreground">
                      {n.trigger ? ` · ${humanizeToken(n.trigger)}` : ''}
                      {` · ${n.ok ? 'sent' : 'failed'}`}
                      {/* Delivery detail is operator or provider text, rendered as plain text (#9). */}
                      {!n.ok && n.detail ? ` (${n.detail})` : ''}
                      {n.ts ? ` · ${humanizeAge(n.ts)}` : ''}
                    </span>
                  </li>
                ))}
            </ol>
          </div>
        ) : null}
      </RailSection>
    </aside>
  );
};

export default FactsRail;
