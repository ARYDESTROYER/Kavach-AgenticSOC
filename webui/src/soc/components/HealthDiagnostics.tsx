/**
 * HealthDiagnostics: the full Analytics surface for failures that used to be SILENT.
 *
 * The precedent/auto-close incident had no operator-visible trace: an unrelated setting
 * change starved the resolved-case precedent corpus, auto-close stopped forever, and the
 * only evidence in the whole system was one INFO log line that reads identically whether
 * the corpus holds 2000 chunks or 0. This component renders the two read-only backend
 * signals that turn each of those into a diagnosable state:
 *
 *   • `GET /api/diagnostics/health`        (auth + `settings:read`)
 *   • `GET /api/metrics/auto-close-health` (auth + `metrics:view`)
 *
 * THE HONESTY CONTRACT (this is the whole point of the component):
 *
 *   • `alerts` (positively DETECTED conditions) and `unknowns` (signals that could not be
 *     evaluated) are separate lists and are rendered separately. An empty `alerts` list
 *     with a non-empty `unknowns` list is **not** a clean bill of health, and the summary
 *     line says exactly that.
 *   • `unknowns` render as "not yet measured": never as a problem, never as reassurance.
 *   • An auto-close status of `insufficient_evidence` / `no_volume` renders as those
 *     words. A window whose rate is unavailable shows "Not measured", never `0%`.
 *   • There is no composite health score, because the backend deliberately returns none.
 *
 * RBAC: the two signals carry DIFFERENT grants, so each is fetched only when its grant is
 * held (`useCan`) and the component self-hides when neither is. A principal with only
 * `metrics:view` still sees the auto-close status; a principal with only `settings:read`
 * still sees the roll-up (whose payload embeds the same auto-close block).
 *
 * #3: everything here is ADVISORY. The auto-close policy is displayed, never fed back:
 * `case_manager.decide()` is not involved in, and never reads, this surface.
 * #9: every string rendered here is backend-authored plain text placed in a text node,
 * with no markup and no `dangerouslySetInnerHTML`.
 */
import * as React from 'react';
import { AlertTriangle, CircleHelp } from 'lucide-react';

import type {
  AutoCloseWindow,
  DiagnosticsFinding,
  DiagnosticsHealth,
} from '@/lib/types';
import { DASH, fmtNumber, fmtPercent } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Panel } from '@/design-system/panel';

import { Badge } from '@/ui/badge';

import { RuleLink, RuleSheetHost } from './RuleLink';
import {
  autoCloseStatusView,
  healthDegradations,
  useHealthDiagnosticsData,
} from './health-diagnostics-state';

export { autoCloseStatusView } from './health-diagnostics-state';
export type { AutoCloseStatusView } from './health-diagnostics-state';

/* --------------------------------------------------------------- pure logic --- */

/**
 * Render one auto-close window's rate. An unavailable window returns the literal
 * "Not measured": the backend sends a DASH there precisely so a consumer cannot
 * accidentally present "no measurement" as a reassuring `0%`.
 */
export function autoCloseRateText(window: AutoCloseWindow | undefined | null): string {
  if (!window || !window.available || typeof window.rate !== 'number') return 'Not measured';
  return fmtPercent(window.rate);
}

/** The one-line, deliberately non-reassuring summary of the roll-up. */
export function healthSummaryText(alerts: number, unknowns: number): string {
  if (alerts > 0 && unknowns > 0) {
    return (
      `${fmtNumber(alerts)} problem${alerts === 1 ? '' : 's'} detected. ` +
      `${fmtNumber(unknowns)} further signal${unknowns === 1 ? '' : 's'} could not be measured.`
    );
  }
  if (alerts > 0) {
    return `${fmtNumber(alerts)} problem${alerts === 1 ? '' : 's'} detected.`;
  }
  if (unknowns > 0) {
    // The load-bearing sentence: an empty `alerts` list is NOT a clean bill of health.
    return (
      `No problems detected, but ${fmtNumber(unknowns)} signal${unknowns === 1 ? ' is' : 's are'} ` +
      'not yet measured, so this is not a clean bill of health.'
    );
  }
  return 'Every monitored signal was measured; no problems detected.';
}

/**
 * Shown when the auto-close signal is readable but the wider roll-up is NOT (a
 * `metrics:view`-only principal, or a failed/absent diagnostics read). Zero alerts here
 * would be an artefact of not having asked, so the summary must say so instead.
 */
export const PARTIAL_SCOPE_SUMMARY =
  'Only the auto-close signal was read. The wider diagnostics roll-up is not available ' +
  'here, so this says nothing about the rest of the system.';

/**
 * The precedent-corpus headline. `known` is the backend's "this count is a trustworthy
 * TOTAL" flag; without it the count is a bounded lower bound or the store was unreadable,
 * and we say so rather than printing a number that could look like a starvation.
 */
export function precedentCountText(
  corpus: DiagnosticsHealth['precedent_corpus'] | undefined | null,
): string {
  if (!corpus) return DASH;
  if (!corpus.available) return 'Unknown';
  if (!corpus.analyst_confirmed_count_exact) {
    return `≥ ${fmtNumber(corpus.analyst_confirmed_precedent_documents)}`;
  }
  return fmtNumber(corpus.analyst_confirmed_precedent_documents);
}

/**
 * The per-rule precedent headline: how the confirmed corpus is SPREAD, not just how big
 * it is. A single number hides the two failures that matter: one rule holding every
 * slot (starvation by success), and a rule whose abundant precedent is not changing any
 * outcome (futility). Both are silent today.
 */
export function precedentSpreadText(
  effectiveness: DiagnosticsHealth['precedent_effectiveness'] | undefined | null,
): string {
  const distribution = effectiveness?.distribution;
  if (!distribution) return DASH;
  if (distribution.disabled) return 'Turned off';
  if (!distribution.available) return 'Unknown';
  const prefix = distribution.truncated ? '≥ ' : '';
  const rules = distribution.rule_identities;
  return `${prefix}${fmtNumber(rules)} rule${rules === 1 ? '' : 's'}`;
}

/**
 * The supporting line under the tile. Ordered so an UNMEASURED state can never be
 * described with a measured-sounding sentence: turned off / unreadable / not evaluated
 * each say so in the backend's own words before any count is offered.
 */
export function precedentSpreadDetail(
  effectiveness: DiagnosticsHealth['precedent_effectiveness'] | undefined | null,
): string | undefined {
  if (!effectiveness) return undefined;
  const d = effectiveness.distribution;
  if (d.disabled || !d.available) return d.reason || undefined;
  if (effectiveness.futility_measured === false) {
    return effectiveness.futility_reason || undefined;
  }
  if (effectiveness.futile_rule_count > 0) {
    const n = effectiveness.futile_rule_count;
    return (
      `${fmtNumber(n)} rule${n === 1 ? '' : 's'} hold plenty of analyst-confirmed ` +
      'precedent but still need a human. Confirming more cases of those rules will ' +
      'not change that on its own.'
    );
  }
  return (
    `${fmtNumber(d.total_confirmed)} analyst-confirmed precedent ` +
    `document${d.total_confirmed === 1 ? '' : 's'} across ` +
    `${fmtNumber(d.rule_identities)} rule ` +
    `identit${d.rule_identities === 1 ? 'y' : 'ies'}; the projection window holds ` +
    `${fmtNumber(effectiveness.window_size)} and is ` +
    `${effectiveness.window_stratified ? 'shared fairly across rules' : 'filled newest-first'}.`
  );
}

/* --------------------------------------------------------------- components --- */

function FindingList({
  findings,
  kind,
}: {
  findings: DiagnosticsFinding[];
  kind: 'alert' | 'unknown';
}) {
  if (!findings.length) return null;
  return (
    <ul className="divide-y divide-border/70 border-t border-border/70">
      {findings.map((f) => (
        <li key={f.id} className="flex gap-2.5 py-3">
          {kind === 'alert' ? (
            <AlertTriangle
              className={cn(
                'mt-0.5 size-4 shrink-0',
                f.severity === 'critical' ? 'text-critical' : 'text-warning',
              )}
              aria-hidden
            />
          ) : (
            <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">{f.title}</p>
            {/* Backend-authored plain text (#9): rendered as a text node, never markup. */}
            {f.detail ? (
              <p className="text-sm leading-relaxed text-muted-foreground">{f.detail}</p>
            ) : null}
            {f.remediation ? (
              <p className="text-sm leading-relaxed text-foreground/80">{f.remediation}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * One signal on the Agent health panel: a quiet sentence-case label, the reading and its
 * state badge, then the backend's own explanation. No icon: the label names the signal.
 */
function SignalTile({
  label,
  value,
  badge,
  detail,
  extra,
}: {
  label: string;
  value: string;
  badge?: React.ReactNode;
  detail?: string;
  /** Interactive detail under the text (the rules a "Precedent by rule" finding names). */
  extra?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5 py-3 sm:px-4 sm:first:pl-0">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold tabular-nums text-foreground">{value}</span>
        {badge}
      </div>
      {detail ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{detail}</p>
      ) : null}
      {extra}
    </div>
  );
}

/** How many rules the "Precedent by rule" tile names before "and N more". */
const FUTILE_RULES_SHOWN = 5;

/**
 * The rules whose precedent is not helping ("Rules that still need a human:", a line that
 * stands on its own for a screen reader), each opening its picture (Round 14, SPEC
 * §4.6.5: every rule name opens the rule sheet through `RuleLink`). Rule values are
 * backend-reported identifiers: plain text inside the link (#9). Renders nothing when the
 * report did not run or found none. The links share one sheet that outlives the line, so
 * a reload that changes the list never closes the sheet being read.
 */
export function FutileRuleLinks({
  effectiveness,
}: {
  effectiveness: DiagnosticsHealth['precedent_effectiveness'] | undefined | null;
}) {
  return (
    <RuleSheetHost>
      <FutileRuleLine effectiveness={effectiveness} />
    </RuleSheetHost>
  );
}

function FutileRuleLine({
  effectiveness,
}: {
  effectiveness: DiagnosticsHealth['precedent_effectiveness'] | undefined | null;
}) {
  if (!effectiveness || effectiveness.futility_measured === false) return null;
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const futile of effectiveness.futile_rules ?? []) {
    const ids = Array.isArray(futile.rule_ids) && futile.rule_ids.length ? futile.rule_ids : [futile.rule_identity];
    for (const id of ids) {
      if (typeof id === 'string' && id.trim() && !seen.has(id)) {
        seen.add(id);
        rules.push(id);
      }
    }
  }
  if (!rules.length) return null;
  const shown = rules.slice(0, FUTILE_RULES_SHOWN);
  const more = rules.length - shown.length;
  // The server lists at most 20 rule identities while `futile_rule_count` counts them
  // all; the unlisted ones may share rule ids with the listed ones, so their number of
  // rules is unknown and the line says "at least" (or just "and more"), never a count it
  // cannot back.
  const unlisted = (effectiveness.futile_rule_count ?? 0) > (effectiveness.futile_rules?.length ?? 0);
  const tail = unlisted
    ? more > 0
      ? ` and at least ${fmtNumber(more)} more`
      : ' and more'
    : more > 0
      ? ` and ${fmtNumber(more)} more`
      : null;
  return (
    <p className="text-xs leading-relaxed text-muted-foreground" data-testid="futile-rule-links">
      Rules that still need a human:{' '}
      {shown.map((rule, index) => (
        <React.Fragment key={rule}>
          {index > 0 ? ', ' : null}
          <RuleLink rule={rule} origin="Health diagnostics" className="text-foreground" />
        </React.Fragment>
      ))}
      {tail}
    </p>
  );
}

export interface HealthDiagnosticsProps {
  /** Rolling window for both signals (hours). Defaults to the backend's own 24h. */
  windowHours?: number;
  /**
   * Increment to read both signals again. The panel has no refresh of its own: the page
   * header's one refresh drives it (Round 14, SPEC §4.9.2).
   */
  refreshKey?: number;
  className?: string;
}

/** The panel caption for the rolling window ("last 24 hours", "last 7 days"). */
export function healthWindowCaption(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return 'last 24 hours';
  if (hours % 24 === 0 && hours >= 48) {
    const days = hours / 24;
    return `last ${fmtNumber(days)} days`;
  }
  return hours === 1 ? 'last hour' : `last ${fmtNumber(hours)} hours`;
}

/**
 * The full Analytics health surface. Self-fetching, self-hiding, and permission-aware.
 *
 * Both API methods are called through a `typeof` guard so a trimmed test/mock `api`
 * surface (or an older proxy) simply yields no panel rather than throwing.
 */
export function HealthDiagnostics({ windowHours = 24, refreshKey = 0, className }: HealthDiagnosticsProps) {
  const { health, autoClose, reload } = useHealthDiagnosticsData(windowHours);

  // The page's refresh: read again when the key moves, never on the first render (the
  // hook already reads on mount and on a window change).
  const lastKey = React.useRef(refreshKey);
  React.useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    void reload();
  }, [refreshKey, reload]);

  // Prefer the dedicated endpoint (it is the one the operator can grant on its own);
  // fall back to the identical block embedded in the roll-up.
  const ac = autoClose ?? health?.auto_close ?? null;

  // Nothing readable → render nothing at all. A blank panel would itself be a
  // misleading "all clear".
  if (!health && !ac) return null;

  const status = autoCloseStatusView(ac?.status);
  const corpus = health?.precedent_corpus ?? null;
  const effectiveness = health?.precedent_effectiveness ?? null;
  const migration = health?.schema_migration ?? null;
  const unknowns = health?.unknowns ?? [];
  const degradations = healthDegradations(health, autoClose);
  const detectedFindings: DiagnosticsFinding[] = degradations.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    title: finding.label,
    detail: finding.detail,
    // Migration SQL has its own selectable remediation block below the signal
    // tiles; do not repeat it in the detected-problem row.
    remediation:
      finding.id === 'sql_schema_migration_failed' ? '' : finding.remediation,
  }));

  const corpusBadge = !corpus ? null : !corpus.available ? (
    <Badge variant="outline">Not measured</Badge>
  ) : corpus.starved ? (
    <Badge variant="critical">Starved</Badge>
  ) : corpus.status === 'disabled' ? (
    <Badge variant="secondary">Turned off</Badge>
  ) : corpus.status === 'unknown' ? (
    <Badge variant="outline">Not measured</Badge>
  ) : (
    <Badge variant="success">Available</Badge>
  );

  return (
    <Panel
      title="Agent health"
      caption={healthWindowCaption(windowHours)}
      data-testid="health-diagnostics"
      data-health-state={degradations.length ? 'degraded' : 'healthy'}
      className={className}
    >
      <div className="space-y-3">
        <p className="text-sm leading-relaxed text-muted-foreground" data-testid="health-summary">
          {/* Without the roll-up, "0 alerts" would only mean "we never asked". */}
          {health ? healthSummaryText(detectedFindings.length, unknowns.length) : PARTIAL_SCOPE_SUMMARY}
        </p>

        <div className="grid divide-y divide-border/70 border-t border-border/70 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-3">
          <SignalTile
            label="Auto-close"
            value={autoCloseRateText(ac?.current)}
            badge={<Badge variant={status.tone}>{status.label}</Badge>}
            detail={
              ac?.reason ||
              (ac?.current?.available
                ? `${fmtNumber(ac.current.auto_closed)} of ${fmtNumber(ac.current.decided)} decided ` +
                  `case${ac.current.decided === 1 ? '' : 's'} auto-closed in the ${healthWindowCaption(
                    ac.window_hours,
                  )}.`
                : undefined)
            }
          />

          {corpus ? (
            <SignalTile
              label="Analyst-confirmed precedents"
              value={precedentCountText(corpus)}
              badge={corpusBadge}
              detail={
                corpus.status_reason ||
                corpus.reason ||
                `${fmtNumber(corpus.ground_truth.analyst_confirmed_cases)} analyst-confirmed case ` +
                  `outcome${corpus.ground_truth.analyst_confirmed_cases === 1 ? '' : 's'} in the ` +
                  'scanned history back this corpus.'
              }
            />
          ) : null}

          {effectiveness ? (
            <SignalTile
              label="Precedent by rule"
              value={precedentSpreadText(effectiveness)}
              badge={
                effectiveness.distribution.disabled ? (
                  <Badge variant="secondary">Turned off</Badge>
                ) : !effectiveness.distribution.available ? (
                  <Badge variant="outline">Not measured</Badge>
                ) : effectiveness.futile_rule_count > 0 ? (
                  <Badge variant="warning">
                    {fmtNumber(effectiveness.futile_rule_count)} not helping
                  </Badge>
                ) : /* An empty corpus is not "Balanced": there is nothing to spread. */
                effectiveness.distribution.rule_identities === 0 ||
                  effectiveness.distribution.total_confirmed === 0 ? (
                  <Badge variant="outline">No precedents</Badge>
                ) : /* A green "Balanced" badge on a report that never RAN would be the
                       exact false reassurance this panel exists to remove. */
                effectiveness.futility_measured === false ? (
                  <Badge variant="outline">Not measured</Badge>
                ) : effectiveness.window_stratified ? (
                  <Badge variant="success">Balanced</Badge>
                ) : (
                  <Badge variant="outline">Unstratified</Badge>
                )
              }
              detail={precedentSpreadDetail(effectiveness)}
              extra={<FutileRuleLinks effectiveness={effectiveness} />}
            />
          ) : null}

          {migration && migration.state !== 'not_applicable' ? (
            <SignalTile
              label="State schema"
              value={migration.failed ? 'Migration failed' : 'Migrated'}
              badge={
                migration.failed ? (
                  <Badge variant="critical">Strict audit writes broken</Badge>
                ) : (
                  <Badge variant="success">OK</Badge>
                )
              }
              detail={migration.detail || migration.reason || undefined}
            />
          ) : null}
        </div>

        {migration?.failed && migration.remediation ? (
          <div className="space-y-1.5">
            <h3 className="text-sm font-semibold text-foreground">Remediation</h3>
            {/* Backend-authored SQL, shown as selectable plain text (#9). */}
            <pre className="overflow-x-auto rounded-md bg-background/60 p-3 text-xs text-foreground">
              <code>{migration.remediation}</code>
            </pre>
          </div>
        ) : null}

        {detectedFindings.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              Detected problems ({fmtNumber(detectedFindings.length)})
            </h3>
            <FindingList findings={detectedFindings} kind="alert" />
          </div>
        ) : null}

        {unknowns.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">
              Not yet measured ({fmtNumber(unknowns.length)})
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              These signals could not be evaluated. They are not problems, and they are not
              evidence that anything is healthy.
            </p>
            <FindingList findings={unknowns} kind="unknown" />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

export default HealthDiagnostics;
