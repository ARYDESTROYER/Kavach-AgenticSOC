/**
 * CaseHeaderMeta: the case header's meta strip (Round 12, CM-2; Round 15, SPEC D8.2;
 * Round 16, SPEC §4.4 WP03, [cmux] §5.3).
 *
 * One 24px line under the title that never wraps. Its items, in priority order: the case
 * number with its copy control, severity, the STATUS while the case is open or the
 * OUTCOME of record once it ended (never both, the same rule as a queue row), the Risk
 * chip (its explanation one hover or click away), the AI verdict chip (the decision's
 * explanation) with the AI run chip right after it, the owner (its one editable home:
 * quick reassign and "Assign to me"), the SLA while the case is open, and the review chip
 * on a pending auto-close sample.
 *
 * Items hide by container query in reverse priority, so the line stays one line in a
 * narrow pane: the review chip below 44rem, the SLA below 52rem, the AI verdict below
 * 36rem and the Risk chip below 30rem. The owner control never hides (only its name,
 * below 44rem): it is the owner's editable home and the anchor of the M shortcut. A hidden
 * SLA stays in the inspector's Signal section; the review sentence is the Brief's first
 * block. Tags, the campaign, Ask AI and the Sample mark live in the inspector.
 *
 * On a short line the status words (or the outcome) give way last (WP16): the owner's name
 * truncates first, down to its disk, then the verdict chip's words, and the status words
 * only once both are at their minimum (`META_SHRINK`).
 *
 * While an AI run is under way the status words keep priority (WP16): the verdict chip is
 * dimmed and drops its label word ("Previous verdict. The running investigation replaces
 * it." leads its hover line), below a 56rem strip the run chip shows the ring and the time
 * only, and below 30rem the items sit closer and the status glyph gives way to the ring.
 * The "AI finished" chip of the next few seconds fits the strip the same way.
 *
 * SECURITY (#9): every case-derived value (id, owner) renders as a plain text node. #3:
 * the owner edit is the existing collaboration route; nothing here changes status,
 * verdict or disposition.
 */
import * as React from 'react';
import { Check, ClipboardCheck, Copy, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import {
  explainPriority,
  explainSeverity,
  explainSla,
  type AssetRangeReading,
  type SlaReadingWire,
} from '@/lib/explain/builders';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import type { Case, SlaPolicy } from '@/lib/types';

import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

import { AiVerdictChip, OutcomeBadge, SeverityBadge, severityBand } from '@/soc/components/badges';
import { OwnerMonogram, assignedToLabel } from '@/soc/components/OwnerMonogram';
import type { CaseOutcome } from '@/soc/components/outcome';
import { scoreBand, semanticIcon } from '@/soc/components/palette';
import { AiRunChip } from '@/soc/investigations/AiRunChip';
import { useAiRun, useAiRunFinished } from '@/soc/investigations/useAiRun';
import type { PickableUser, TriageChips } from '@/soc/pages/CaseDetail.api';

import { AssigneePicker } from './AssigneePicker';
import { caseDisplayId, riskValue, statusWords } from './caseFacts';
import { DecisionExplain } from './explain/DecisionExplain';
import { FactExplain } from './explain/FactExplain';
import { RiskExplain } from './explain/RiskExplain';
import { caseSlaReading } from './triageReads';
import { REVIEW_BAND_TEXT } from './review/review-plan';

const SLA_TONE: Record<string, string> = {
  met: 'text-muted-foreground',
  running: 'text-foreground',
  due_soon: 'text-warning-text',
  breached: 'text-critical-text',
};

/** The Risk chip's tone, from the one score ladder (`scoreBand`). */
const RISK_TONE: Record<string, string> = {
  critical: 'border-critical/40 text-critical-text',
  high: 'border-high/40 text-high-text',
  medium: 'border-medium/40 text-medium-text',
  low: 'border-border text-low-text',
};

/**
 * The container-query classes that hide a meta item in a narrow pane (reverse priority).
 * The owner control has none: it never hides.
 */
export const META_HIDE = {
  risk: 'hidden @[30rem]/case:inline-flex',
  verdict: 'hidden @[36rem]/case:inline-flex',
  ownerName: 'hidden @[44rem]/case:inline',
  sla: 'hidden @[52rem]/case:inline-flex',
  review: 'hidden @[44rem]/case:inline-flex',
} as const;

/**
 * Who gives way on a short line (WP16), in order: the owner's name (down to its disk), then
 * the verdict chip's words (the label and the confidence keep their width), and the status
 * words or the outcome last, so they never truncate while the owner's name or the verdict
 * could still give. On a phone-width strip the owner's name and the verdict are already
 * hidden, so there the status words are what gives.
 *
 * Flex shrinking is shared out in proportion to each weight, so each weight is a million
 * times the next: the share of the next item stays far below a pixel until the item before
 * it reaches its minimum and stops shrinking. Every weight is at least 1, because a set of
 * shrinking items whose weights add up to less than 1 takes only that fraction of the
 * shortfall (CSS Flexbox 9.7) and the line would overflow.
 */
export const META_SHRINK = {
  owner: 'min-w-5 shrink-[1000000000000]',
  verdict: 'min-w-0 shrink-[1000000]',
  verdictChip: 'min-w-0 max-w-full overflow-hidden',
  verdictWords: 'min-w-0 truncate',
  status: 'min-w-0 shrink',
  statusWords: 'min-w-0 truncate',
} as const;

/** The verdict chip's note while an AI run is under way on the case. */
export const PREVIOUS_VERDICT_NOTE = 'Previous verdict. The running investigation replaces it.';

/**
 * Below this strip width (56rem) the AI run chip drops its words ("0:42" with the ring),
 * and below 30rem it keeps the ring alone, so the status words keep their place beside
 * it (WP16).
 */
export const META_COMPACT_RUN_PX = 896;
export const META_RING_RUN_PX = 480;

/**
 * The strip's spacing: closer on a phone-width strip while it holds the run chip
 * (`data-meta-item="ai-run"`), running or just finished.
 */
export const META_RUN_GAP =
  'gap-x-2.5 has-[[data-meta-item=ai-run]]:gap-x-1.5 @[30rem]/case:has-[[data-meta-item=ai-run]]:gap-x-2.5';

/** How much of the run chip a strip of `width` px shows (`width` null: not measured). */
export function runChipFit(width: number | null): boolean | 'ring' {
  if (width === null || width <= 0) return false;
  if (width < META_RING_RUN_PX) return 'ring';
  return width < META_COMPACT_RUN_PX;
}

/** The width of `ref`'s element while `active` (null where it cannot be measured). */
function useWidth(ref: React.RefObject<HTMLElement | null>, active: boolean): number | null {
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setWidth(null);
      return undefined;
    }
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, active]);
  return width;
}

/** Copy the case's display id; confirms in place and via a toast. */
const CopyId: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={copied ? 'Case ID copied' : 'Copy case ID'}
          onClick={() =>
            void copyText(value).then((ok) => {
              if (!ok) {
                toast.error('Could not copy the case ID.');
                return;
              }
              setCopied(true);
              toast.success('Case ID copied.');
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success-text" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{copied ? 'Copied' : 'Copy case ID'}</TooltipContent>
    </Tooltip>
  );
};

export interface CaseHeaderMetaProps {
  c: Case;
  outcome: CaseOutcome;
  users: PickableUser[];
  currentUser?: string | null;
  canAssign: boolean;
  slaPolicy?: SlaPolicy | null;
  /** The server's SLA reading (the triage read), used when the settings cannot be read. */
  serverSla?: SlaReadingWire | null;
  /** The triage chips, for the severity and priority explanations. */
  triage?: TriageChips | null;
  /** Today's internal network range that holds the entity (`settings:read` only). */
  assetRange?: AssetRangeReading | null;
  /** The authoritative case after an owner edit (queue + detail sync). */
  onCaseChange: (next: Case) => void;
  /** Controlled owner popover (the M shortcut opens it). */
  ownerOpen: boolean;
  onOwnerOpenChange: (open: boolean) => void;
  /**
   * A pending auto-close review sample: the review chip shows, and opens the review (the
   * same as Start review). Omitted: no review chip.
   */
  onStartReview?: (opener: HTMLElement) => void;
}

export const CaseHeaderMeta: React.FC<CaseHeaderMetaProps> = ({
  c,
  outcome,
  users,
  currentUser,
  canAssign,
  slaPolicy,
  serverSla = null,
  triage = null,
  assetRange = null,
  onCaseChange,
  ownerOpen,
  onOwnerOpenChange,
  onStartReview,
}) => {
  const displayId = caseDisplayId(c);
  const severity = severityBand(c.severity_band) ?? severityBand(c.risk_score);
  const status = String(c.status || '').toLowerCase();
  const StatusGlyph = semanticIcon(status === 'reopened' ? 'investigating' : status);
  const owner = (c.assignee || '').trim();
  const risk = riskValue(c.risk_score);
  // Once the case ended, its outcome of record replaces the status (never both).
  const showOutcome = outcome.terminal && outcome.source !== 'pending';
  const sla = outcome.terminal ? null : caseSlaReading(c, slaPolicy, serverSla);
  // The SLA's priority is the matrix lookup the triage read explains only when the two
  // name the same level (a case can carry a stored level of its own).
  const priorityExplanation = explainPriority(triage);
  const priorityMatches =
    sla !== null &&
    priorityExplanation !== null &&
    String(priorityExplanation.value ?? '').trim().toUpperCase() === sla.priority;
  const [assigningSelf, setAssigningSelf] = React.useState(false);
  const ownerTitleId = React.useId();
  // An AI run under way: the verdict on screen is the one it replaces, and the run chip
  // takes room on the line, so the status words keep priority (WP16).
  const run = useAiRun(c.case_id);
  const aiRunning = run !== null && run.state !== 'finished';
  // The chip also shows for a few seconds after a run this console saw ends ("AI
  // finished"), so the strip is measured then too and the finished chip fits the same way.
  const ended = useAiRunFinished(c.case_id);
  const stripRef = React.useRef<HTMLDivElement | null>(null);
  const runFit = runChipFit(useWidth(stripRef, aiRunning || Boolean(ended?.shown)));

  const assignToMe = React.useCallback(async () => {
    if (!currentUser) return;
    setAssigningSelf(true);
    try {
      onCaseChange(await api.caseAssign(c.case_id, currentUser));
      onOwnerOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not assign the case.');
    } finally {
      setAssigningSelf(false);
    }
  }, [c.case_id, currentUser, onCaseChange, onOwnerOpenChange]);

  return (
    <div
      ref={stripRef}
      data-testid="case-detail-meta"
      className={cn(
        'flex h-6 min-w-0 flex-nowrap items-center overflow-x-auto whitespace-nowrap text-xs text-muted-foreground',
        // A phone-width strip that holds the run chip (a run under way, or the few seconds
        // of "AI finished" after one) spaces its items closer, so the status words keep
        // their room beside it. Keyed on the chip itself, so the spacing follows it exactly.
        META_RUN_GAP,
        // Never a visible scrollbar: in a very narrow pane the line scrolls sideways.
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
    >
      <span className="inline-flex shrink-0 items-center gap-0.5">
        <span data-testid="case-detail-id" className="font-mono text-foreground/80">
          {displayId}
        </span>
        <CopyId value={displayId} />
      </span>

      {severity ? (
        // A wrapper that never shrinks: the explain trigger inside may, and its badge
        // would then run under the status words on a short line.
        <span className="inline-flex shrink-0">
          <FactExplain explanation={explainSeverity(triage)}>
            {/* "High severity"; in a phone-width pane the word alone ("High"), so the
                owner control keeps its place on the line. */}
            <span className="inline-flex shrink-0 items-center" data-meta-item="severity">
              <SeverityBadge
                severity={severity}
                labelSuffix="severity"
                className="hidden h-5 shrink-0 px-1.5 @[36rem]/case:inline-flex"
              />
              <span className="inline-flex items-center @[36rem]/case:hidden">
                <SeverityBadge severity={severity} className="h-5 shrink-0 px-1.5" />
                <span className="sr-only"> severity</span>
              </span>
            </span>
          </FactExplain>
        </span>
      ) : null}

      {/* The status or outcome gives way last: on a short line the owner's name and then
          the verdict chip's words go first (META_SHRINK). */}
      {showOutcome ? (
        <span className={cn('inline-flex items-center overflow-hidden', META_SHRINK.status)} data-meta-item="outcome">
          <OutcomeBadge outcome={outcome} className="max-w-full" />
        </span>
      ) : (
        <span
          data-testid="case-detail-status"
          data-meta-item="status"
          className={cn('inline-flex items-center gap-1 font-medium text-foreground', META_SHRINK.status)}
        >
          {/* Beside a run chip on a phone-width strip the chip's ring is the glyph. */}
          {StatusGlyph ? (
            <StatusGlyph
              className={cn('size-3.5 shrink-0 text-muted-foreground', aiRunning && 'hidden @[30rem]/case:block')}
              aria-hidden
            />
          ) : null}
          <span className={META_SHRINK.statusWords}>{statusWords(c.status)}</span>
        </span>
      )}

      {risk !== null ? (
        <span className={cn('shrink-0 items-center', META_HIDE.risk)} data-meta-item="risk">
          <RiskExplain caseId={c.case_id} score={c.risk_score} breakdown={c.risk_breakdown} assetRange={assetRange}>
            <span
              data-testid="case-detail-risk"
              className={cn(
                'inline-flex h-5 items-center rounded-sm border px-1.5 font-medium tabular-nums',
                RISK_TONE[scoreBand(risk)],
              )}
            >
              Risk {risk}
            </span>
          </RiskExplain>
        </span>
      ) : null}

      {c.verdict ? (
        <span
          className={cn('items-center', META_SHRINK.verdict, META_HIDE.verdict)}
          data-meta-item="verdict"
          data-previous-verdict={aiRunning ? '' : undefined}
        >
          {/* While an AI run is under way the verdict is the one it replaces: dimmed, its
              label word dropped, and the hover line says so first. */}
          <DecisionExplain caseRecord={c} note={aiRunning ? PREVIOUS_VERDICT_NOTE : null}>
            {aiRunning ? <span className="sr-only">Previous verdict: </span> : null}
            <AiVerdictChip
              verdict={c.verdict}
              confidence={c.confidence}
              className={cn('h-5', META_SHRINK.verdictChip, aiRunning && 'border-dashed text-muted-foreground [&>svg]:text-muted-foreground')}
              labelClassName={aiRunning ? 'hidden' : 'hidden @[48rem]/case:inline'}
              wordsClassName={META_SHRINK.verdictWords}
            />
          </DecisionExplain>
        </span>
      ) : null}
      {/* The AI working on this case right now (WP09); renders nothing otherwise. On a
          narrow strip it drops its words, so the status words keep their place. The
          "AI finished" chip has no clock to keep and the verdict beside it has its label
          back, so below 56rem it keeps its mark alone. */}
      <AiRunChip caseId={c.case_id} compact={aiRunning ? runFit : runFit ? 'ring' : false} />

      <Popover open={ownerOpen} onOpenChange={onOwnerOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="case-detail-owner"
            data-meta-item="owner"
            aria-keyshortcuts="M"
            aria-label={owner ? `${assignedToLabel(owner)}. Change owner` : 'Unassigned. Choose an owner'}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm text-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              META_SHRINK.owner,
            )}
          >
            {owner ? (
              /* The button's label already names the owner: the disk is decorative here. */
              <OwnerMonogram name={owner} decorative />
            ) : (
              <UserRound className="size-3.5 text-muted-foreground" aria-hidden />
            )}
            <span
              data-testid="case-detail-owner-name"
              className={cn('min-w-0 max-w-[10rem] truncate', META_HIDE.ownerName, !owner && 'text-muted-foreground')}
            >
              {owner || 'Unassigned'}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-3" aria-labelledby={ownerTitleId}>
          <p id={ownerTitleId} className="text-sm font-semibold text-foreground">
            Owner
          </p>
          <AssigneePicker
            c={c}
            users={users}
            canWrite={canAssign}
            onAssigned={(next) => {
              onCaseChange(next);
              onOwnerOpenChange(false);
            }}
          />
          {canAssign && currentUser && owner.toLowerCase() !== currentUser.toLowerCase() ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full"
              disabled={assigningSelf}
              onClick={() => void assignToMe()}
            >
              Assign to me
            </Button>
          ) : null}
          {!canAssign ? (
            <p className="text-xs text-muted-foreground">You can view the owner but not change it.</p>
          ) : null}
        </PopoverContent>
      </Popover>

      {sla ? (
        <span
          className={cn('shrink-0 items-center gap-1 font-medium', META_HIDE.sla, SLA_TONE[sla.state])}
          data-meta-item="sla"
          data-testid="case-detail-sla"
          data-sla-state={sla.state}
        >
          {/* The priority opens the matrix lookup when it is the matrix's level; one the
              case carries itself is explained by the SLA reading (its source line). */}
          {priorityMatches ? (
            <FactExplain explanation={priorityExplanation}>
              <span data-testid="case-detail-sla-priority">{sla.priority}</span>
            </FactExplain>
          ) : (
            <span data-testid="case-detail-sla-priority">{sla.priority}</span>
          )}
          <span aria-hidden>·</span>
          <FactExplain explanation={explainSla(sla.wire)}>
            <span data-testid="case-detail-sla-text">{sla.text}</span>
          </FactExplain>
        </span>
      ) : null}

      {onStartReview ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="case-review-chip"
              data-meta-item="review"
              onClick={(event) => onStartReview(event.currentTarget)}
              className={cn(
                'h-5 shrink-0 items-center gap-1 rounded-sm bg-primary/10 px-1.5 font-medium text-primary hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                META_HIDE.review,
              )}
            >
              <ClipboardCheck className="size-3.5" aria-hidden />
              Review waiting
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {REVIEW_BAND_TEXT}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
};

export default CaseHeaderMeta;
