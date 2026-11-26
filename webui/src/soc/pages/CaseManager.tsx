/**
 * Case Manager: the split queue and case workspace (Round 12 redesign, CM-1 to CM-9;
 * Round 15, SPEC D8.1).
 *
 * The queue is SERVER-backed: Active / Mine / All, status, severity, search and sort are
 * answered by `GET /api/cases` over the whole corpus and paged with "Load more" (the old
 * newest-200 client filter silently dropped older open cases). The scope line in the
 * list footer always states loaded against total. Rows update live from the `cases`
 * realtime topic, bulk work shows per-row progress from the job stream, and the queue has
 * one tab stop with a roving focus: Up/Down or J/K move and open, X or Space toggle
 * selection, Shift extends, Enter focuses the case, / searches, ? lists the shortcuts,
 * Esc clears the selection.
 *
 * Round 15 (D8.1) calms the queue pane: a two-row control band (the scope and a view menu
 * for sort, density and the shortcuts; then "Select visible", the search and one Filters
 * control holding Severity, Status and Closed by, with removable chips), a bulk bar that
 * appears only with a selection, two-line rows that show the status of an open case or
 * the outcome of an ended one (never both), and the scope line in the list footer.
 *
 * The embedded `CaseDetail` is NOT remounted per case: it renders the queue row at once
 * and refreshes in the background, so switching cases never blanks the pane.
 *
 * SECURITY (#9): case-derived strings are rendered only as plain React text nodes.
 * #3: every bulk and single mutation is the existing analyst verb or durable job; the
 * outcome shown on a row is presentation (`caseOutcome`), never a decision.
 *
 * Round 15 (D6.12) adds the Review scope: the auto-close review sample, with its pending
 * count from `GET /api/auto-close-review/summary` on the scope control, read through
 * `GET /api/cases?review=` (pending by default; "Show completed reviews" in the footer;
 * `#/case_manager?review=disagreed|expired` deep links) and refreshed by `case.review`
 * frames. Bulk Set status and Set disposition leave out the cases the agent closed (D4.7).
 *
 * Round 14 (SPEC §4.9.4, D27, ui-audit CM1): the split workspace sits on one panel. The
 * queue takes a "Closed by" filter from `#/case_manager?closedBy=` (the retired `#/scans`
 * page lands here with `agent`), shown as a removable chip and sent to `GET /api/cases`
 * as `closed_by`.
 *
 * Round 16 (SPEC §4.4 WP02) gives the workspace the route's top band. There is no routed
 * page header: the title is an `sr-only` h1 (the top bar's breadcrumb already names the
 * page), and Live, Refresh and "About Case Manager" sit in row 1 of the queue's control
 * band. The board keeps a 16px inset on every side. A row's leading 40px slot shows the
 * severity glyph and turns into the checkbox on hover, on focus, while anything is
 * selected or a bulk job runs, and always on a touch screen; "Risk N" is neutral and
 * carries the risk explainer; the AI run mark sits in the status node. `[` (or "Hide
 * queue" in the view menu) folds the queue to a 44px strip with Previous and Next, and
 * J and K keep moving through the cases. With no case open the pane says so and offers
 * up to three counted queue shortcuts.
 */
import * as React from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleSlash,
  Columns3,
  Eye,
  HelpCircle,
  Inbox,
  Keyboard,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  SlidersHorizontal,
  Tag as TagIcon,
  UserCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { AutoCloseReviewSummary } from '@/lib/types-reviews';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errorMessage';
import { DASH, humanizeAge, humanizeToken } from '@/lib/format';
import { caseTagError } from '@/lib/tags';
import type { BackgroundJob, BackgroundJobKind, Case, CaseLifecycleInput } from '@/lib/types';
import { useEventStream } from '@/lib/useEventStream';

import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { LoadingBar, LoadingState, StatusDot } from '@/design-system';

import { FilterBar, type FilterChip } from '@/soc/components/FilterBar';

import { EmptyState } from '@/soc/components/EmptyState';
import { HelpTip } from '@/soc/components/HelpTip';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { Can, ProtectedRoute } from '@/soc/components/Can';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { OwnerMonogram } from '@/soc/components/OwnerMonogram';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { OutcomeBadge } from '@/soc/components/badges';
import { caseOutcome } from '@/soc/components/outcome';
import { semanticIcon } from '@/soc/components/palette';
import { useAnnouncer } from '@/soc/components/announcer';
import { AnimatePresence, MotionProvider, SPRING_UI, motion, useReducedMotion } from '@/soc/components/motion';
import { useAuth } from '@/soc/auth';
import { CASE_TABS } from '@/soc/case-tabs';
import { useDemo } from '@/soc/demo';
import { useMediaQuery } from '@/soc/hooks/useMediaQuery';
import { AiQueueNotice } from '@/soc/investigations/AiQueueNotice';
import { AiRunCloseNotice } from '@/soc/investigations/AiRunCloseNotice';
import { AiRunMark } from '@/soc/investigations/AiRunMark';
import { aiRunAccessibleText } from '@/soc/investigations/aiRunText';
import { useAiRun } from '@/soc/investigations/useAiRun';
import { useRoute } from '@/soc/router';
import type { NavOpts } from '@/soc/nav-types';
import {
  announceJobAccepted,
  isTerminalJobStatus,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';
import { listPickableUsers, type PickableUser } from './CaseDetail.api';
import { CaseDetail } from './CaseDetail';
import { ActivityGlyph } from '@/soc/chat-activity/glyph';
import { useCaseChatActivity } from '@/soc/chat-activity/case-glyph';
import {
  BulkCloseDialog,
  type BulkCloseInput,
  type BulkTerminalAction,
} from './casedetail/BulkCloseDialog';
import {
  caseDisplayId,
  caseTitle,
  middleEllipsis,
  primaryFact,
  riskValue,
  statusWords,
} from './casedetail/caseFacts';
import { RiskExplain } from './casedetail/explain/RiskExplain';
import { DISPOSITION_OPTIONS } from './casedetail/shared';
import {
  QUEUE_MAX_PAGE,
  QUEUE_PAGE_SIZE,
  QUEUE_SELECT_ALL_LIMIT,
  QUEUE_SEVERITIES,
  QUEUE_STATUS_OPTIONS,
  TERMINAL_STATUSES,
  AGENT_CLOSED_LEFT_OUT,
  asQueueReview,
  caseInScope,
  isAgentClosedCase,
  matchesSearch,
  mergeQueueRow,
  queueMembership,
  queueQuery,
  queueSeverity,
  scopeHeading,
  scopeSummary,
  QUEUE_SORT_LABEL,
  windowPlacement,
  type QueueQueryInput,
  type QueueReview,
  type QueueScope,
  type QueueSort,
} from './casedetail/queue';
import { shortcutBlocked } from './casedetail/keyboard';

const ANY_SEVERITY = '__any_severity__';
const ANY_STATUS = '__any_status__';
const ANY_CLOSER = '__any_closer__';
const SPLIT_STORAGE_KEY = 'soc.caseManager.queueWidth';
const DENSITY_STORAGE_KEY = 'soc.caseManager.density';
/** Focus mode (Round 16, WP02): the queue folded to its strip, per viewer. */
const COLLAPSED_STORAGE_KEY = 'soc.caseManager.queueCollapsed';
/** The folded queue's strip width. */
const QUEUE_STRIP_PX = 44;
/** The strip's Previous and Next at either end: dimmed, still focusable, inert on press. */
const STRIP_STEP_INERT = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent';
/** Where the queue and the case sit side by side (Tailwind `xl`). Below it they are two screens. */
const SPLIT_QUERY = '(min-width: 1280px)';
/** A touch screen: no hover reveals the row checkbox, so it always shows. */
const COARSE_POINTER_QUERY = '(pointer: coarse)';
/**
 * The queue width from which band row 1 holds the scope and every tool. Measured at
 * 1440 by 900 in the seeded demo: the scope control with Mine and Review is 237px; the
 * Live dot, Refresh, the view menu and the help tip are 106px; with the 6px gap and the
 * 24px of padding that is 373px.
 */
const BAND_FULL_ROW_PX = 400;
const SPLIT_MIN_QUEUE_PX = 320;
const SPLIT_MAX_QUEUE_PX = 680;
const SPLIT_MIN_DETAIL_PX = 560;
const SPLIT_HANDLE_PX = 9;
const SPLIT_DEFAULT_QUEUE_PX = 400;
const SPLIT_KEYBOARD_STEP_PX = 24;
const SEARCH_DEBOUNCE_MS = 250;
const LIVE_FLUSH_MS = 600;
/** A burst of `case.review` frames reads the review summary once. */
const REVIEW_SUMMARY_MS = 400;

/** The Review scope's empty queue, per review state (D6.12). */
const REVIEW_EMPTY_TITLE: Readonly<Record<QueueReview, string>> = {
  pending: 'No reviews waiting',
  completed: 'No completed reviews',
  disagreed: 'No reviews that disagreed',
  expired: 'No expired reviews',
};
export const REVIEW_EMPTY_DESCRIPTION =
  'A small random sample of the cases the AI agent closes waits here for a person to classify.';
export const REVIEW_OFF_DESCRIPTION = 'Auto-close review is off. Turn it on in Settings, under Detection.';

type Density = 'comfortable' | 'compact';
type ConfirmableBulkAction = 'acknowledge' | 'reinvestigate';
type BulkFormAction = 'assign' | 'tag' | 'status' | 'disposition';

const BULK_STATUSES = [
  { value: 'open', text: 'Open' },
  { value: 'investigating', text: 'Investigating' },
  { value: 'on_hold', text: 'On hold' },
  { value: 'escalated', text: 'Escalated' },
] as const;

/**
 * The queue's left-edge severity rail. It REINFORCES the visible severity word (never
 * the only channel, WCAG 1.4.1): solid for the two bands that demand attention, a dashed
 * rail for medium, and no rail for low/info.
 */
const SEVERITY_RAIL: Record<string, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium:
    'bg-[repeating-linear-gradient(to_bottom,hsl(var(--medium))_0_4px,transparent_4px_7px)]',
  low: '',
  info: '',
};

/** Severity word tone on the row's meta line: tinted text only for critical/high. */
const SEVERITY_WORD: Record<string, string> = {
  critical: 'font-medium text-critical-text',
  high: 'font-medium text-high-text',
  medium: 'text-muted-foreground',
  low: 'text-muted-foreground',
  info: 'text-muted-foreground',
};

/**
 * The leading slot's severity glyph (Round 16, WP02): tinted like the severity word, so
 * only the two bands that demand attention carry colour. "Risk N" stays neutral: a high
 * row shows one orange token, not two (risk keeps its colour in the case header).
 */
const SEVERITY_GLYPH: Record<string, string> = {
  critical: 'text-critical-text',
  high: 'text-high-text',
  medium: 'text-muted-foreground',
  low: 'text-muted-foreground',
  info: 'text-muted-foreground',
};

/** The neutral "Risk N" on a queue row (Round 16, WP02; [cmux] §5.2). */
const RISK_TEXT = 'text-foreground/80 tabular-nums';

function clampQueueWidth(value: number, maximum = SPLIT_MAX_QUEUE_PX): number {
  const safeMaximum = Math.max(SPLIT_MIN_QUEUE_PX, Math.min(SPLIT_MAX_QUEUE_PX, maximum));
  return Math.round(Math.min(safeMaximum, Math.max(SPLIT_MIN_QUEUE_PX, value)));
}

function readStoredQueueWidth(): number | null {
  try {
    const raw = window.localStorage?.getItem(SPLIT_STORAGE_KEY);
    if (raw === null || raw === undefined || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clampQueueWidth(value) : null;
  } catch {
    return null;
  }
}

function persistQueueWidth(value: number): void {
  try {
    window.localStorage?.setItem(SPLIT_STORAGE_KEY, String(value));
  } catch {
    /* Storage is a convenience; resizing remains fully functional without it. */
  }
}

function readDensity(): Density {
  try {
    return window.localStorage?.getItem(DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/**
 * The responsive default queue width: 28% of the board, 340 to 520px (casemanager §4.1;
 * Round 16 [cmux] R5 lowered the floor from 360px, so the case gets the width back).
 */
export function responsiveQueueWidth(frameWidth: number): number {
  if (!frameWidth) return SPLIT_DEFAULT_QUEUE_PX;
  return Math.round(Math.min(520, Math.max(340, frameWidth * 0.28)));
}

function readCollapsed(): boolean {
  try {
    return window.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistCollapsed(value: boolean): void {
  try {
    if (value) window.localStorage?.setItem(COLLAPSED_STORAGE_KEY, '1');
    else window.localStorage?.removeItem(COLLAPSED_STORAGE_KEY);
  } catch {
    /* Storage is a convenience; focus mode works for this visit without it. */
  }
}

const caseSeverity = queueSeverity;

function updatedAt(c: Case): string {
  return c.updated_at || c.created_at || '';
}

function millisOf(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Can `el` take focus right now? Connected is not enough: below xl the queue is
 * `hidden xl:flex` while a case is open, so its row buttons stay mounted under a
 * display:none ancestor, and `.focus()` on one does nothing (focus falls to <body>).
 * `checkVisibility()` where the browser has it, else no ancestor with display:none.
 */
function isFocusable(el: HTMLElement | null | undefined): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(el);
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (view.getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/** The beside-text status glyph from the ONE semantic icon map (reopened → investigating). */
function queueStatusIcon(status: string) {
  const t = status.trim().toLowerCase();
  return semanticIcon(t === 'reopened' ? 'investigating' : t) ?? Circle;
}

/** A quiet separator between meta facts; decorative, so screen readers skip it. */
const MetaDot = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn('shrink-0 text-muted-foreground/60', className)}>
    ·
  </span>
);

/**
 * Where a queue row shows its status words (and the dot before them) while the AI run's
 * mark is in the status node: only in a queue of 30rem or wider. The run's own words,
 * "AI working" or "AI queued", always show, because the ring alone is the case chat
 * glyph and only the words tell the two apart. So in a narrower queue the status words
 * give way to the run's words while it runs (the outcome badge of a case that ended
 * does the same, `RUN_MARK_OUTCOME`); the row's accessible name keeps both, and the
 * case header still shows the status.
 */
export const RUN_MARK_WORDS = 'hidden @[30rem]/queue:inline';
/** The compact outcome badge beside a run's mark: it gives way below a 30rem queue. */
export const RUN_MARK_OUTCOME = 'hidden @[30rem]/queue:inline-flex';

interface RowJobState {
  /** The case is in a bulk job that is still running. */
  pending: boolean;
  /** The reason a bulk job failed for this case, when it did. */
  failure?: string;
}

/**
 * One queue row (Round 15, SPEC D8.1; Round 16, WP02). Comfortable (default) is two
 * lines beside a 40px leading slot:
 *
 *   slot  line 1  title (one line, truncates) ············ chat glyph · relative age
 *         line 2  severity · Risk N · case number · status OR outcome ········ owner
 *
 * An open case shows its status (glyph and words); a case that ended shows its outcome
 * badge instead, never both. While the AI investigates the case, the AI run mark takes
 * the status glyph's place inside that node (never the case chat glyph's slot before the
 * age, so a row can show both) and the row's accessible name says so. The source fact
 * and the runbook chip are not on the row; the fact stays in the row's accessible name.
 * Compact is one line: title · risk · status or outcome · age.
 *
 * The leading slot (Round 16, [cmux] §5.2) shows the severity glyph. For a role that may
 * do bulk work it turns into the checkbox on row hover and focus, and stays the checkbox
 * whenever `revealCheckbox` is set (anything selected, a bulk job running, or a touch
 * screen), so bulk work is one hover away without a column of empty boxes. The checkbox
 * is a sibling of the open control, never nested; a role with no bulk action keeps the
 * glyph and gets no checkbox. The open control is the row's single tab stop (roving
 * tabindex on the list), and X or Space toggles a row whose checkbox is hidden.
 *
 * "Risk N" is neutral and wears the risk explainer's mouse-only row variant (S11): no
 * focusable content inside the row button; the accessible name carries the number.
 */
const QueueRow: React.FC<{
  item: Case;
  active: boolean;
  checked: boolean;
  focusTarget: boolean;
  density: Density;
  /** False for a role with no bulk action: the row has no checkbox and no X key. */
  selectable?: boolean;
  /** Keep the checkbox in the slot (a selection, a running bulk job, a touch screen). */
  revealCheckbox?: boolean;
  selectionDisabled: boolean;
  job: RowJobState | null;
  registerButton: (id: string, el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onFocusRow: () => void;
  onPrefetch: () => void;
  onCheckedChange: (checked: boolean, shift: boolean) => void;
}> = ({
  item,
  active,
  checked,
  focusTarget,
  density,
  selectable = true,
  revealCheckbox = false,
  selectionDisabled,
  job,
  registerButton,
  onOpen,
  onFocusRow,
  onPrefetch,
  onCheckedChange,
}) => {
  const severity = caseSeverity(item);
  const displayId = caseDisplayId(item);
  const title = caseTitle(item);
  const fact = primaryFact(item);
  const risk = riskValue(item.risk_score);
  const SeverityGlyph = semanticIcon(severity) ?? Circle;
  const StatusGlyph = item.status ? queueStatusIcon(item.status) : null;
  const outcome = caseOutcome(item);
  // A case that ended shows its outcome of record in place of its status (D8.1).
  const showOutcome = outcome.terminal && outcome.source !== 'pending';
  const owner = (item.assignee || '').trim();
  const age = humanizeAge(updatedAt(item));
  const sourceAsserted = item.severity_source === 'source_asserted';
  const statusText = item.status ? statusWords(item.status) : 'Unknown status';
  // A case-scoped chat answer being written, unread, waiting or failed (SPEC D13).
  const chat = useCaseChatActivity(item.case_id);
  // The AI investigation running or queued on this case, if any (Round 16, A1).
  const run = useAiRun(item.case_id);
  // The `aria-label` overrides descendant text, so the run's words join the name here.
  const runText = aiRunAccessibleText(run, Date.now());
  const accessibleName = [
    title,
    displayId,
    fact,
    `${humanizeToken(severity)} severity${sourceAsserted ? ' (reported by the source)' : ''}`,
    risk !== null ? `risk ${risk}` : null,
    showOutcome ? `outcome ${outcome.shortLabel}` : statusText,
    owner ? `assigned to ${owner}` : 'unassigned',
    `updated ${age}`,
    job?.failure ? `last bulk action failed: ${job.failure}` : null,
    chat.text || null,
    runText,
  ]
    .filter(Boolean)
    .join(', ');

  // The bulk job's state first, then the AI run mark, else the status glyph.
  const jobGlyph = job?.pending ? (
    <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" aria-hidden />
  ) : job?.failure ? (
    <AlertTriangle className="size-3 shrink-0 text-warning-text" aria-hidden />
  ) : null;
  // The run's words always show; in a narrow queue the status words after them give way.
  const runMark = run ? (
    <>
      <AiRunMark caseId={item.case_id} />
      <MetaDot className={RUN_MARK_WORDS} />
    </>
  ) : null;
  const statusNode = (
    <span data-testid="case-queue-status" className="inline-flex min-w-0 items-center gap-1 text-foreground/80">
      {jobGlyph}
      {runMark ??
        (!jobGlyph && StatusGlyph ? <StatusGlyph className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null)}
      {/* A cut word keeps its whole value on hover, as the title and case number do. */}
      {item.status ? (
        <span data-testid="case-queue-status-words" className={cn('truncate', run && RUN_MARK_WORDS)} title={statusText}>
          {statusText}
        </span>
      ) : (
        <span className={cn('text-muted-foreground', run && RUN_MARK_WORDS)}>{DASH}</span>
      )}
    </span>
  );
  const outcomeNode = (
    <span
      data-testid="case-queue-outcome"
      data-outcome-source={outcome.source}
      className="inline-flex min-w-0 items-center gap-1"
    >
      {job?.pending ? <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" aria-hidden /> : null}
      {runMark}
      <OutcomeBadge outcome={outcome} compact className={cn('max-w-[10rem]', run && RUN_MARK_OUTCOME)} />
    </span>
  );
  // Neutral, and the explainer's mouse-only row hover card (S11).
  const riskNode =
    risk !== null ? (
      <RiskExplain caseId={item.case_id} score={item.risk_score} breakdown={item.risk_breakdown} variant="row">
        <span data-testid="case-queue-risk" className={cn('shrink-0', RISK_TEXT)}>
          Risk {risk}
        </span>
      </RiskExplain>
    ) : null;
  // The slot's top edge follows line 1 in either density.
  const slotTop = density === 'compact' ? 'top-[0.5625rem]' : 'top-[0.875rem]';

  return (
    <div
      data-testid="case-queue-row"
      data-queue-row=""
      data-case-id={item.case_id}
      data-row-state={active ? 'open' : checked ? 'selected' : 'idle'}
      className={cn(
        'group/row relative transition-colors duration-fast',
        active
          ? 'bg-primary/[0.09] dark:bg-primary/[0.12]'
          : checked
            ? 'bg-primary/[0.04] hover:bg-primary/[0.06] dark:bg-primary/[0.06]'
            : 'hover:bg-muted/70 active:bg-muted',
      )}
    >
      <span
        data-testid="case-queue-severity-rail"
        className={cn('pointer-events-none absolute inset-y-0 left-0 w-[3px]', SEVERITY_RAIL[severity])}
        aria-hidden
      />
      {active ? (
        <span
          data-testid="case-queue-open-rail"
          className="pointer-events-none absolute inset-y-0 right-0 w-0.5 bg-primary"
          aria-hidden
        />
      ) : null}

      {/* The leading slot: the severity glyph, which gives way to the checkbox on hover
          and focus (or for good while `revealCheckbox`). Decorative: the severity word
          and the accessible name carry it. */}
      <span
        data-testid="case-queue-severity-glyph"
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-3 z-10 flex size-4 items-center justify-center',
          slotTop,
          SEVERITY_GLYPH[severity],
          selectable && (revealCheckbox ? 'hidden' : 'group-hover/row:hidden group-focus-within/row:hidden'),
        )}
      >
        <SeverityGlyph className="size-4" />
      </span>

      {/* The checkbox is a sibling of the row-open button, never a nested button, so
          toggling selection cannot open the case. X / Space toggles it from the keyboard
          (roving focus keeps the queue to ONE tab stop) even while it is hidden. */}
      {selectable ? (
        <Checkbox
          checked={checked}
          disabled={selectionDisabled}
          tabIndex={-1}
          data-reveal={revealCheckbox ? 'always' : 'hover'}
          onClick={(event) => {
            // Shift-click extends the selection from the last toggled row.
            if (event.shiftKey) {
              event.preventDefault();
              onCheckedChange(!checked, true);
            }
          }}
          onCheckedChange={(next) => onCheckedChange(next === true, false)}
          // A clicked checkbox takes focus: it becomes the roving stop, so J/K/X act on it.
          onFocus={onFocusRow}
          aria-label={`Select ${displayId}`}
          className={cn(
            'absolute left-3 z-10 bg-background',
            slotTop,
            revealCheckbox ? 'block' : 'hidden group-hover/row:block group-focus-within/row:block',
            "before:absolute before:-inset-1 before:content-['']",
          )}
        />
      ) : null}

      <button
        type="button"
        ref={(el) => registerButton(item.case_id, el)}
        tabIndex={focusTarget ? 0 : -1}
        onClick={onOpen}
        onFocus={onFocusRow}
        onPointerEnter={onPrefetch}
        aria-current={active ? 'true' : undefined}
        aria-label={accessibleName}
        aria-keyshortcuts={selectable ? 'ArrowUp ArrowDown J K X Enter' : 'ArrowUp ArrowDown J K Enter'}
        className={cn(
          'block w-full pl-10 pr-3 text-left',
          density === 'compact' ? 'py-1.5' : 'py-3',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
      >
        {density === 'compact' ? (
          <span className="flex min-w-0 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={title}>
              {title}
            </span>
            {riskNode}
            {showOutcome ? outcomeNode : statusNode}
            <ActivityGlyph status={chat.status} />
            <span className="shrink-0 tabular-nums text-muted-foreground">{age}</span>
          </span>
        ) : (
          <>
            <span className="flex min-w-0 items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={title}>
                {title}
              </span>
              <ActivityGlyph status={chat.status} className="self-center" />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{age}</span>
            </span>

            {/* A fixed 20px line: the owner monogram and the outcome badge are 20px, the
                status words 16px, so without it rows step between 64px and 68px. */}
            <span
              data-testid="case-queue-meta"
              className="mt-1.5 flex h-5 min-w-0 items-center gap-1 text-xs text-muted-foreground"
            >
              <span
                data-testid="case-queue-severity"
                className={cn('inline-flex shrink-0 items-center', SEVERITY_WORD[severity])}
                title={sourceAsserted ? 'Severity reported by the source' : 'Severity derived from the risk score'}
              >
                {humanizeToken(severity)}
              </span>
              {riskNode ? (
                <>
                  <MetaDot />
                  {riskNode}
                </>
              ) : null}
              <MetaDot />
              {/* The case number names the row, so it never gives way: middleEllipsis
                  bounds it at 14 characters, and the status beside it truncates first. */}
              <span data-testid="case-queue-id" className="shrink-0 whitespace-nowrap font-mono" title={displayId}>
                {middleEllipsis(displayId)}
              </span>
              <MetaDot />
              {showOutcome ? outcomeNode : statusNode}
              <span className="ml-auto flex shrink-0 items-center pl-1">
                <OwnerMonogram name={owner} decorative />
              </span>
            </span>
            {job?.failure ? (
              <span className="mt-1 block truncate text-xs text-warning-text">{job.failure}</span>
            ) : null}
          </>
        )}
      </button>
    </div>
  );
};

const QueueSkeleton = () => (
  <LoadingState
    label="Loading cases"
    description="Preparing the case queue."
    layout="panel"
    shape="rows"
    shapeRows={5}
    className="min-h-[28rem]"
  />
);

/**
 * Whether the viewer may do any bulk work: the bar's jobs are checked against
 * `cases:write` (acknowledge, tag, status, disposition), `cases:assign`,
 * `cases:reinvestigate` and `cases:close`. Without one of them (the read-only auditor)
 * the queue offers no selection at all, as the Cases page does.
 */
export function canSelectCases(can: (resource: string, action: string) => boolean): boolean {
  return (
    can('cases', 'write') || can('cases', 'assign') || can('cases', 'reinvestigate') || can('cases', 'close')
  );
}

/**
 * The keyboard shortcuts sheet, listing only the keys the viewer's role can use: the case
 * keys follow the grants the open case checks before it acts (A, E, H and T `cases:write`,
 * C `cases:close`, R `cases:reinvestigate`, M `cases:assign`), and the selection keys
 * follow {@link canSelectCases}. A key the role cannot use does nothing, so it is not
 * promised; nor is a key the layout cannot use: `[` folds the queue only where the queue
 * and the case sit side by side (`splitShown`). `]` (the case details) and W (the live AI
 * run) need no grant: the open case handles both for every viewer. The case tab keys
 * count the case's own tabs, so the line stays true when the tabs change.
 */
export function caseManagerShortcuts(
  can: (resource: string, action: string) => boolean,
  opts: { splitShown?: boolean } = {},
): ReadonlyArray<{ keys: string; action: string }> {
  const write = can('cases', 'write');
  const close = can('cases', 'close');
  const assign = can('cases', 'assign');
  const select = canSelectCases(can);
  const rows: Array<{ keys: string; action: string } | false> = [
    { keys: '↑ ↓  or  K J', action: 'Move through the queue and open the case' },
    Boolean(opts.splitShown) && { keys: '[', action: 'Hide or show the queue' },
    { keys: ']', action: 'Show or hide the case details' },
    { keys: 'Home  End', action: 'First or last loaded case' },
    select && { keys: 'X  or  Space', action: 'Select or clear the focused case' },
    select && { keys: 'Shift + ↑ ↓  or  Shift + X', action: 'Extend the selection' },
    { keys: 'Enter', action: 'Move focus into the open case' },
    select && { keys: 'Esc', action: 'Clear the selection' },
    { keys: '/', action: 'Search the queue' },
    { keys: '?', action: 'Show these shortcuts' },
    write && close
      ? { keys: 'A  C  E  H', action: 'Acknowledge, close, escalate or hold the open case' }
      : write
        ? { keys: 'A  E  H', action: 'Acknowledge, escalate or hold the open case' }
        : close && { keys: 'C', action: 'Close the open case' },
    can('cases', 'reinvestigate') && { keys: 'R', action: 'Reinvestigate the open case' },
    { keys: 'W', action: 'Watch the AI run, while one is under way' },
    assign && write
      ? { keys: 'M  T', action: 'Change the owner or edit tags' }
      : assign
        ? { keys: 'M', action: 'Change the owner' }
        : write && { keys: 'T', action: 'Edit tags' },
    { keys: `Alt + 1 to ${CASE_TABS.length}`, action: 'Switch case tabs' },
  ];
  return rows.filter((row): row is { keys: string; action: string } => Boolean(row));
}

/* ---- "Closed by" (Round 14, D27) ------------------------------------------------------ */

/** Who closed a terminal case: the engine's `closed_by` values (`case_aggregate`). */
export type QueueCloser = 'agent' | 'analyst' | 'analyst_policy' | 'system';

/** The queue's "Closed by" filter chip, one plain phrase per closer. */
export const CLOSED_BY_LABEL: Readonly<Record<QueueCloser, string>> = {
  agent: 'Closed by the AI agent',
  analyst: 'Closed by an analyst',
  analyst_policy: 'Closed by an analyst policy',
  system: 'Closed by the system',
};

function asCloser(value: unknown): QueueCloser | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CLOSED_BY_LABEL, value)
    ? (value as QueueCloser)
    : null;
}

/**
 * Who closed a case, as far as the client can tell (a mirror of `case_aggregate`'s
 * `closed_by`); null while the case is open. It only keeps a filtered view honest
 * between server reads: whenever it disagrees with the filter, the server is asked.
 */
function caseCloser(c: Case): QueueCloser | null {
  if (!TERMINAL_STATUSES.has(String(c.status || '').trim().toLowerCase())) return null;
  const by = String(c.decision_by || '').trim().toLowerCase();
  if (c.analyst_policy || by === 'analyst_policy') return 'analyst_policy';
  if (by === 'agent') return 'agent';
  if (by === 'analyst') return 'analyst';
  return 'system';
}

/** The page help (the header's "About Case Manager" tip). */
export const CASE_MANAGER_HELP =
  'Work the case queue and the open case side by side: the queue reads every case on the server and updates live. Open a case to act on it here, and press ? for the keyboard shortcuts.';

/* ---- The empty case pane (Round 16, WP02; [cmux] §5.9) ------------------------------- */

export const NO_CASE_OPEN_TITLE = 'No case open';
export const NO_CASE_OPEN_DESCRIPTION = 'Pick a case from the queue to work on it here.';

/** The empty pane's counts before (or between) reads: unknown, so no button shows. */
const NO_PANE_COUNTS: { critical: number | null; awaiting: number | null } = { critical: null, awaiting: null };

/** A counted queue shortcut the empty pane offers: what it opens and how many it holds. */
export type PaneShortcutKind = 'critical' | 'awaiting' | 'review';

/** The shortcut's words: the count and what the queue will show ("4 critical cases"). */
export function paneShortcutLabel(kind: PaneShortcutKind, count: number): string {
  const n = count.toLocaleString();
  if (kind === 'critical') return `${n} critical ${count === 1 ? 'case' : 'cases'}`;
  if (kind === 'awaiting') return `${n} ${count === 1 ? 'case' : 'cases'} awaiting an analyst`;
  return `${n} ${count === 1 ? 'review' : 'reviews'} waiting`;
}

/**
 * The shortcuts worth offering, in order: only a known count above zero (an unknown or
 * empty count would open an empty queue), three at most.
 */
export function paneShortcuts(
  counts: Partial<Record<PaneShortcutKind, number | null>>,
): ReadonlyArray<{ kind: PaneShortcutKind; count: number }> {
  const out: Array<{ kind: PaneShortcutKind; count: number }> = [];
  for (const kind of ['critical', 'awaiting', 'review'] as const) {
    const count = counts[kind];
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) out.push({ kind, count });
  }
  return out.slice(0, 3);
}

interface TrackedJob {
  jobId: string;
  label: string;
  ids: Set<string>;
  done: number;
  total: number;
  status: string;
}

export interface CaseManagerProps {
  /** Fresh-tab/deep-link case selection supplied by the route registry. */
  initialCaseId?: string;
}

export default function CaseManager(props: CaseManagerProps) {
  return (
    <MotionProvider>
      <CaseManagerWorkspace {...props} />
    </MotionProvider>
  );
}

function CaseManagerWorkspace({ initialCaseId }: CaseManagerProps) {
  const route = useRoute();
  const announce = useAnnouncer();
  const reduceMotion = useReducedMotion();
  const { username: currentUser, hasPermission } = useAuth();
  // Selection exists only for bulk work, so a role with no bulk action gets none (roles-07).
  const canBulk = canSelectCases(hasPermission);
  // The queue and the case side by side (xl); below it they are separate screens.
  const splitShown = useMediaQuery(SPLIT_QUERY);
  // A touch screen has no hover to reveal a row checkbox, so it always shows there.
  const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  const shortcuts = React.useMemo(
    () => caseManagerShortcuts(hasPermission, { splitShown }),
    [hasPermission, splitShown],
  );
  const { active: demoActive } = useDemo();
  const routeCaseId = initialCaseId ?? route.opts?.caseId;
  // D27: `#/case_manager?closedBy=agent` (and the `#/scans` redirect) opens the queue on
  // the cases that closer closed; it only matches terminal cases, so the scope is All.
  const routeClosedBy = route.page === 'case_manager' ? asCloser(route.opts?.closedBy) : null;
  // `#/case_manager?caseId=…&tab=investigation` (the audit log's "Open case trace") opens
  // the case on that tab; the router and CaseDetail both accept only its real tab ids.
  const routeTab = route.page === 'case_manager' ? (route.opts?.tab ?? null) : null;
  // A rewritten link to a retired tab asks for the section that tab became (D8.3).
  const routeSection = route.page === 'case_manager' ? (route.opts?.section ?? null) : null;
  // D6.12: `#/case_manager?review=pending|completed|disagreed|expired` opens the Review scope.
  const routeReview = route.page === 'case_manager' ? asQueueReview(route.opts?.review) : null;

  // ---- queue query --------------------------------------------------------- //
  const [closedBy, setClosedBy] = React.useState<QueueCloser | null>(routeClosedBy);
  const closedByRef = React.useRef(closedBy);
  closedByRef.current = closedBy;
  const [scope, setScope] = React.useState<QueueScope>(routeReview ? 'review' : routeClosedBy ? 'all' : 'active');
  const scopeRef = React.useRef(scope);
  scopeRef.current = scope;
  // The Review scope's queue (pending by default), carried in the address like "Closed by".
  const [review, setReview] = React.useState<QueueReview>(routeReview ?? 'pending');
  const reviewKeyRef = React.useRef<QueueReview | null>(scope === 'review' ? review : null);
  reviewKeyRef.current = scope === 'review' ? review : null;
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [severity, setSeverity] = React.useState(ANY_SEVERITY);
  const [status, setStatus] = React.useState(ANY_STATUS);
  const [sort, setSort] = React.useState<QueueSort>('updated_desc');
  const [density, setDensity] = React.useState<Density>(readDensity);

  React.useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const queueInput = React.useMemo<QueueQueryInput>(
    () => ({
      scope,
      review: scope === 'review' ? review : null,
      username: currentUser,
      search,
      severity: severity === ANY_SEVERITY ? null : severity,
      status: status === ANY_STATUS ? null : status,
      sort,
    }),
    [scope, review, currentUser, search, severity, status, sort],
  );
  const query = React.useMemo(() => {
    const next = queueQuery(queueInput);
    if (closedBy) next.closed_by = closedBy;
    return next;
  }, [queueInput, closedBy]);
  const queryKey = JSON.stringify(query);
  const queryKeyRef = React.useRef(queryKey);
  queryKeyRef.current = queryKey;
  const queueInputRef = React.useRef(queueInput);
  queueInputRef.current = queueInput;

  // ---- queue data ---------------------------------------------------------- //
  const [rows, setRows] = React.useState<Case[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [newCount, setNewCount] = React.useState(0);
  const requestRef = React.useRef(0);

  // The loaded window and its total as of the LAST write, readable synchronously: a live
  // flush and a detail sync can both land before React re-renders, and each must see
  // the other's removal (or the total would be decremented twice).
  const rowsRef = React.useRef<Case[]>(rows);
  const totalRef = React.useRef(total);
  const commitRows = React.useCallback((next: Case[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);
  const commitTotal = React.useCallback((next: number) => {
    totalRef.current = Math.max(0, next);
    setTotal(Math.max(0, next));
  }, []);

  const [selectedCaseId, setSelectedCaseId] = React.useState<string | null>(routeCaseId || null);
  const [dismissedSelection, setDismissedSelection] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const anchorIdRef = React.useRef<string | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  /** Where the roving stop landed when the open case left the view (see `onListKeyDown`). */
  const gapStopRef = React.useRef<{ id: string; side: 'after' | 'before' } | null>(null);
  const buttonsRef = React.useRef(new Map<string, HTMLButtonElement>());
  // The queue's filter band (its search field is the `/` target).
  const filterBarRef = React.useRef<HTMLDivElement | null>(null);
  const searchField = React.useCallback(
    () => filterBarRef.current?.querySelector<HTMLInputElement>('[data-filter-search] input') ?? null,
    [],
  );
  const viewMenuRef = React.useRef<HTMLButtonElement | null>(null);
  /** The selected-case workspace; its case title is the focus target when the queue is hidden. */
  const detailRef = React.useRef<HTMLElement | null>(null);

  // Focus mode (Round 16, WP02; [cmux] §5.2): `[` (or "Hide queue" in the view menu)
  // folds the queue to a 44px strip, so the case gets the width. Only where the queue and
  // the case sit side by side: below xl they are separate screens, so the saved preference
  // waits there and the queue shows in full. `setQueueFolded` is further down.
  const [collapsedPref, setCollapsedPref] = React.useState<boolean>(readCollapsed);
  const queueCollapsed = collapsedPref && splitShown;
  const queueCollapsedRef = React.useRef(queueCollapsed);
  queueCollapsedRef.current = queueCollapsed;
  const splitShownRef = React.useRef(splitShown);
  splitShownRef.current = splitShown;
  /** The full queue (band, list and footer), hidden while the queue is folded. */
  const queueContentRef = React.useRef<HTMLDivElement | null>(null);
  /** The strip's Show queue: where focus lands when the folded queue's own controls cannot take it. */
  const stripExpandRef = React.useRef<HTMLButtonElement | null>(null);
  /** Set when "Hide queue" is chosen in the view menu, whose trigger the fold hides. */
  const focusStripOnMenuCloseRef = React.useRef(false);

  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const shortcutsOpenerRef = React.useRef<HTMLElement | null>(null);
  const openShortcuts = React.useCallback(() => {
    const active = document.activeElement;
    shortcutsOpenerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setShortcutsOpen(true);
  }, []);

  /**
   * Re-read the loaded window from the top, keeping its size (paged in server-sized
   * chunks). The server is the authority on membership, order and total, so this is the
   * answer whenever the client cannot settle a change exactly: a case that moved into
   * the loaded window, an offset page that came back shifted under a live sort, or an
   * overflowed live stream. `quiet` keeps the current rows on screen while it runs and
   * keeps them if it fails.
   */
  const resyncWindow = React.useCallback(
    async (size: number, quiet = true) => {
      const request = ++requestRef.current;
      const target = Math.max(QUEUE_PAGE_SIZE, Math.min(QUEUE_SELECT_ALL_LIMIT, size));
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const base = JSON.parse(queryKey) as Record<string, string>;
        const collected: Case[] = [];
        const seen = new Set<string>();
        let nextTotal = 0;
        for (let offset = 0; offset < target; offset += QUEUE_MAX_PAGE) {
          const limit = Math.min(QUEUE_MAX_PAGE, target - offset);
          const response = await api.listCases({ ...base, limit, offset });
          if (request !== requestRef.current) return;
          const page = response.cases || [];
          nextTotal = response.total ?? collected.length + page.length;
          for (const row of page) {
            if (seen.has(row.case_id)) continue;
            seen.add(row.case_id);
            collected.push(row);
          }
          if (page.length < limit) break;
        }
        commitRows(collected);
        commitTotal(nextTotal);
        setNewCount(0);
      } catch (nextError) {
        if (request !== requestRef.current) return;
        if (!quiet || rowsRef.current.length === 0) setError(nextError);
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [commitRows, commitTotal, queryKey],
  );
  const resyncRef = React.useRef(resyncWindow);
  resyncRef.current = resyncWindow;

  const fetchPage = React.useCallback(
    async (offset: number, mode: 'replace' | 'append', limit = QUEUE_PAGE_SIZE) => {
      const request = ++requestRef.current;
      if (mode === 'replace') {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      try {
        const response = await api.listCases({
          ...(JSON.parse(queryKey) as Record<string, string>),
          limit: Math.min(QUEUE_MAX_PAGE, Math.max(1, limit)),
          offset,
        });
        if (request !== requestRef.current) return;
        const page = response.cases || [];
        const nextTotal = response.total ?? page.length;
        if (mode === 'replace') {
          commitRows(page);
          commitTotal(nextTotal);
          setNewCount(0);
          return;
        }
        const current = rowsRef.current;
        const seen = new Set(current.map((row) => row.case_id));
        const fresh = page.filter((row) => !seen.has(row.case_id));
        // Offset paging over a live sort: a case that moved up since the window was read
        // shifts the server's order, so this page repeats rows we have (or comes back
        // empty while the total says more). Appending it would skip cases for good, so
        // re-read the whole window, one page larger, instead.
        if (fresh.length < page.length || (page.length === 0 && current.length < nextTotal)) {
          void resyncRef.current(current.length + Math.max(page.length, QUEUE_PAGE_SIZE));
          return;
        }
        commitRows([...current, ...fresh]);
        commitTotal(nextTotal);
      } catch (nextError) {
        if (request !== requestRef.current) return;
        if (mode === 'replace') setError(nextError);
        else toast.error(errorMessage(nextError, 'Could not load more cases.'));
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [commitRows, commitTotal, queryKey],
  );

  React.useEffect(() => {
    void fetchPage(0, 'replace');
  }, [fetchPage]);

  /** Re-read the loaded window in place (refresh / after bulk work), keeping its size. */
  const refreshLoaded = React.useCallback(() => {
    void resyncWindow(rowsRef.current.length, false);
  }, [resyncWindow]);

  /**
   * "N new cases · Show": re-read the window GROWN by the new cases, so they join the top
   * and every row the analyst already loaded (with Load more) stays: the open case, its
   * row and their place in the queue are never dropped back to the first page.
   */
  const showNewCases = React.useCallback(() => {
    void resyncWindow(rowsRef.current.length + newCount, false);
  }, [newCount, resyncWindow]);

  // A quiet re-read, coalesced: several live changes in a burst cost one request.
  const resyncTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleResync = React.useCallback(() => {
    if (resyncTimerRef.current) return;
    resyncTimerRef.current = setTimeout(() => {
      resyncTimerRef.current = null;
      void resyncRef.current(rowsRef.current.length);
    }, 150);
  }, []);

  // The total alone, for a change outside the loaded window (it may have joined or left
  // the view, which only moves the count). Skipped when a window read started meanwhile:
  // that read carries a total at least as fresh.
  const recountTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRecount = React.useCallback(() => {
    if (recountTimerRef.current) return;
    recountTimerRef.current = setTimeout(() => {
      recountTimerRef.current = null;
      const startedAt = requestRef.current;
      const base = JSON.parse(queryKeyRef.current) as Record<string, string>;
      void api
        .listCases({ ...base, limit: 1, offset: 0 })
        .then((response) => {
          if (startedAt !== requestRef.current || typeof response.total !== 'number') return;
          commitTotal(Math.max(response.total, rowsRef.current.length));
        })
        .catch(() => undefined);
    }, 400);
  }, [commitTotal]);

  React.useEffect(
    () => () => {
      if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
      if (recountTimerRef.current) clearTimeout(recountTimerRef.current);
    },
    [],
  );

  React.useEffect(() => {
    if (!routeCaseId) return;
    setSelectedCaseId(routeCaseId);
    setDismissedSelection(false);
  }, [routeCaseId]);

  // ---- the auto-close review summary (D6.12) ------------------------------- //
  // The Review scope's pending count. Best-effort: without it the scope is offered only
  // while a link has it open, and the queue itself is the server's answer. The review
  // client is imported on use, so it is never on this route's preload list (§3.1).
  const [reviewSummary, setReviewSummary] = React.useState<AutoCloseReviewSummary | null>(null);
  const loadReviewSummary = React.useCallback(() => {
    import('@/lib/api-reviews')
      .then((reviews) => reviews.getAutoCloseReviewSummary())
      .then((next) => setReviewSummary(next))
      .catch(() => undefined);
  }, []);
  React.useEffect(() => {
    loadReviewSummary();
  }, [loadReviewSummary]);
  const reviewSummaryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReviewSummary = React.useCallback(() => {
    if (reviewSummaryTimerRef.current) return;
    reviewSummaryTimerRef.current = setTimeout(() => {
      reviewSummaryTimerRef.current = null;
      loadReviewSummary();
    }, REVIEW_SUMMARY_MS);
  }, [loadReviewSummary]);
  React.useEffect(
    () => () => {
      if (reviewSummaryTimerRef.current) clearTimeout(reviewSummaryTimerRef.current);
    },
    [],
  );
  // A `case.review` frame for the open case asks it to read its review state again.
  const [reviewRefresh, setReviewRefresh] = React.useState(0);
  /** A review was recorded, or a case reopened from one, in the open case. */
  const onReviewChange = React.useCallback(() => {
    scheduleReviewSummary();
    if (scopeRef.current === 'review') scheduleResync();
  }, [scheduleResync, scheduleReviewSummary]);
  /** The header's Refresh: the loaded window and the review count. */
  const refreshQueue = React.useCallback(() => {
    refreshLoaded();
    loadReviewSummary();
  }, [loadReviewSummary, refreshLoaded]);

  // A link that names a closer applies it. A later route without one keeps the chip: the
  // queue's own navigation (opening or closing a case) carries the key along.
  React.useEffect(() => {
    if (!routeClosedBy) return;
    setClosedBy(routeClosedBy);
    setScope('all');
  }, [routeClosedBy]);

  // A link that names a review queue opens the Review scope on it (D6.12), and so does the
  // footer's "Show completed reviews" (it navigates). Like "Closed by", the queue's own
  // navigation carries the key along.
  React.useEffect(() => {
    if (!routeReview) return;
    reviewKeyRef.current = routeReview;
    setReview(routeReview);
    setScope('review');
  }, [routeReview]);

  /**
   * Navigate within the queue, carrying the keys that shape it: "Closed by" and, in the
   * Review scope, the review queue. Without any, the bare route (as before Round 15).
   */
  const goQueue = React.useCallback(
    (extra?: NavOpts) => {
      const keys: NavOpts = { ...(extra ?? {}) };
      if (closedByRef.current) keys.closedBy = closedByRef.current;
      if (reviewKeyRef.current) keys.review = reviewKeyRef.current;
      if (Object.keys(keys).length) route.navigate('case_manager', keys);
      else route.navigate('case_manager');
    },
    [route],
  );

  // The loaded rows, consistent with the scope (a live update may have moved a case out
  // of it) and instantly pre-filtered by the search being typed while the server query
  // is debounced.
  const visibleCases = React.useMemo(
    () =>
      rows.filter(
        (item) =>
          caseInScope(item, scope, currentUser) &&
          (searchInput === search || matchesSearch(item, searchInput)),
      ),
    [rows, scope, currentUser, searchInput, search],
  );
  const visibleRef = React.useRef(visibleCases);
  visibleRef.current = visibleCases;
  const rowsById = React.useMemo(() => new Map(rows.map((row) => [row.case_id, row])), [rows]);

  const position = React.useMemo(() => {
    if (!selectedCaseId) return null;
    const index = visibleCases.findIndex((item) => item.case_id === selectedCaseId);
    return index >= 0 ? index + 1 : null;
  }, [selectedCaseId, visibleCases]);

  // Open the first case on arrival (an explicit pane dismiss suppresses this).
  React.useEffect(() => {
    if (loading || selectedCaseId || dismissedSelection || visibleCases.length === 0) return;
    setSelectedCaseId(visibleCases[0].case_id);
  }, [loading, selectedCaseId, dismissedSelection, visibleCases]);

  // The roving tab stop follows the open case, else the first row.
  const effectiveFocusId =
    (focusId && visibleCases.some((item) => item.case_id === focusId) && focusId) ||
    (selectedCaseId && visibleCases.some((item) => item.case_id === selectedCaseId) && selectedCaseId) ||
    visibleCases[0]?.case_id ||
    null;
  const selectedIdRef = React.useRef(selectedCaseId);
  selectedIdRef.current = selectedCaseId;
  const effectiveFocusIdRef = React.useRef(effectiveFocusId);
  effectiveFocusIdRef.current = effectiveFocusId;

  /**
   * The open case's title heading (tabIndex -1), when it can take focus. Below xl the
   * detail REPLACES the queue, so this is where focus belongs once a case opens: the
   * same heading element stays mounted from case to case (CaseDetail is not remounted).
   */
  const caseTitleTarget = React.useCallback((): HTMLElement | null => {
    const title = detailRef.current?.querySelector<HTMLElement>('[data-case-title]') ?? null;
    return isFocusable(title) ? title : null;
  }, []);

  const selectCase = React.useCallback(
    (caseId: string, opts: { focusRow?: boolean } = {}) => {
      gapStopRef.current = null;
      setSelectedCaseId(caseId);
      setFocusId(caseId);
      setDismissedSelection(false);
      goQueue({ caseId });
      if (opts.focusRow) {
        // The row when the queue is on screen (the xl split); below xl the queue is
        // hidden while a case is open, so the case's title instead of <body>.
        requestAnimationFrame(() => {
          const row = buttonsRef.current.get(caseId);
          (isFocusable(row) ? row : caseTitleTarget())?.focus();
        });
      }
      // Focus on the row already reads its title and id; the announcement adds only
      // what focus does not say: where the case sits in the queue (one live region).
      const index = visibleRef.current.findIndex((row) => row.case_id === caseId);
      if (index >= 0) announce(`Opened. ${index + 1} of ${visibleRef.current.length} loaded.`);
    },
    [announce, caseTitleTarget, goQueue],
  );

  /**
   * The queue row focus should land on: the given case's row, else the roving tab stop.
   * Null when the queue is not on screen (below xl while a case is open): a row under a
   * display:none ancestor is connected but cannot take focus.
   */
  const queueRowButton = React.useCallback((caseId?: string | null): HTMLElement | null => {
    const visible = visibleRef.current;
    const listed = (id: string | null | undefined) => Boolean(id && visible.some((row) => row.case_id === id));
    const id = listed(caseId) ? caseId : listed(effectiveFocusIdRef.current) ? effectiveFocusIdRef.current : visible[0]?.case_id;
    const button = id ? buttonsRef.current.get(id) : undefined;
    return isFocusable(button) ? button : null;
  }, []);

  const closeDetail = React.useCallback(() => {
    const previous = selectedIdRef.current;
    setSelectedCaseId(null);
    setDismissedSelection(true);
    goQueue();
    // The pane that held focus is gone: land on the case's queue row (or the roving
    // stop, or the search when the queue is empty) instead of <body>. While the queue is
    // folded its rows and search are hidden, so the strip's Show queue takes focus.
    requestAnimationFrame(() => {
      const target = queueCollapsedRef.current ? stripExpandRef.current : queueRowButton(previous) ?? searchField();
      target?.focus();
    });
  }, [goQueue, queueRowButton, searchField]);

  /** "Close & next": open the case after the current one (or before it, at the end). */
  const advance = React.useCallback(() => {
    const list = visibleRef.current;
    const index = list.findIndex((row) => row.case_id === selectedCaseId);
    const next = index >= 0 ? list[index + 1] ?? list[index - 1] : list[0];
    if (next && next.case_id !== selectedCaseId) selectCase(next.case_id, { focusRow: true });
    else closeDetail();
  }, [closeDetail, selectCase, selectedCaseId]);

  /**
   * Where focus goes after a case dialog closes on a submit (CM-3/CM-4). "Close & next"
   * lands on the next case's row, which `advance` just opened, or on that case's title
   * when the queue is hidden (below xl the detail replaces it). A plain submit keeps the
   * dialog's own default (its opener) unless that opener was a queue row the action took
   * out of the view: then the row that took its place, so a keyboard user keeps their
   * place instead of falling to <body> when the row animates away.
   */
  const resolveDialogFocus = React.useCallback(
    (opener: HTMLElement | null, andNext: boolean): HTMLElement | null => {
      if (andNext) return queueRowButton(selectedIdRef.current) ?? caseTitleTarget();
      const openerRow = opener?.closest<HTMLElement>('[data-queue-row]')?.dataset.caseId;
      if (!openerRow) return null;
      if (visibleRef.current.some((row) => row.case_id === openerRow)) return null;
      // No row left to land on: the open case's title.
      return queueRowButton(effectiveFocusIdRef.current) ?? caseTitleTarget();
    },
    [caseTitleTarget, queueRowButton],
  );

  /**
   * Keep the loaded window honest after cases change (a detail mutation, or the live
   * `cases` topic). Membership is checked against the WHOLE view: scope, status, owner,
   * search and severity: not just the scope:
   *
   * - a loaded row that no longer matches leaves the window and the total;
   * - a loaded row that still matches is updated in place (keeping its read-time bands);
   * - a case we have not loaded that now matches and lists inside the window (an Undo
   *   reopen, an unloaded case put on hold under "Latest") makes the window re-read, so it
   *   appears; one that lists beyond it only moves the total;
   * - a new case that matches is counted in the "N new" prompt and the total.
   *
   * Anything the client cannot settle exactly (an action response with no read-time
   * severity band under a severity filter, a tie with the window's last row) is asked of
   * the server instead of guessed.
   */
  /**
   * {@link queueMembership} plus the "Closed by" filter: an open case is out; a case
   * whose closer the client reads differently is asked of the server (`unknown`).
   */
  const membershipOf = React.useCallback((item: Case, input: QueueQueryInput) => {
    const membership = queueMembership(item, input);
    const filter = closedByRef.current;
    if (!filter || membership === 'out') return membership;
    const closer = caseCloser(item);
    if (closer === null) return 'out';
    return closer === filter ? membership : 'unknown';
  }, []);

  const reconcileCases = React.useCallback(
    (incoming: Case[], opts: { changed: (item: Case) => boolean; created?: ReadonlySet<string> }) => {
      if (!incoming.length) return;
      const input = queueInputRef.current;
      const current = rowsRef.current;
      const loaded = new Map(current.map((row) => [row.case_id, row]));
      const updates = new Map<string, Case | null>();
      let resync = false;
      let recount = false;
      let createdIn = 0;
      for (const item of incoming) {
        const membership = membershipOf(item, input);
        const previous = loaded.get(item.case_id);
        if (previous) {
          if (membership === 'out') {
            updates.set(item.case_id, null);
            continue;
          }
          const merged = mergeQueueRow(previous, item);
          updates.set(item.case_id, merged);
          if (membership === 'unknown') resync = true;
          else if (windowPlacement(merged, current, totalRef.current, input.sort) === 'beyond') resync = true;
          continue;
        }
        if (opts.created?.has(item.case_id)) {
          if (membership !== 'out') createdIn += 1;
          continue;
        }
        if (!opts.changed(item)) continue;
        if (membership === 'out') {
          recount = true;
          continue;
        }
        const placement = membership === 'unknown' ? 'edge' : windowPlacement(item, current, totalRef.current, input.sort);
        if (placement === 'beyond') recount = true;
        else resync = true;
      }

      if (updates.size) {
        const removedIds = new Set(Array.from(updates).filter(([, value]) => value === null).map(([id]) => id));
        // The roving stop and the open row move to the row that took a removed row's place.
        const focus = effectiveFocusIdRef.current;
        if (focus && removedIds.has(focus)) {
          const list = visibleRef.current;
          const at = list.findIndex((row) => row.case_id === focus);
          const after = list.slice(at + 1).find((row) => !removedIds.has(row.case_id));
          const neighbour = after ??
            list.slice(0, Math.max(0, at)).reverse().find((row) => !removedIds.has(row.case_id));
          setFocusId(neighbour?.case_id ?? null);
          // Which side of the gap the stop now sits on, so the next J/K steps INTO the
          // gap's neighbour instead of past it (see `onListKeyDown`).
          gapStopRef.current = neighbour ? { id: neighbour.case_id, side: after ? 'after' : 'before' } : null;
        }
        commitRows(
          current.flatMap((row) => {
            if (!updates.has(row.case_id)) return [row];
            const next = updates.get(row.case_id);
            return next ? [next] : [];
          }),
        );
        if (removedIds.size) commitTotal(totalRef.current - removedIds.size);
      }
      if (createdIn) {
        setNewCount((count) => count + createdIn);
        commitTotal(totalRef.current + createdIn);
      }
      if (resync) scheduleResync();
      else if (recount) scheduleRecount();
    },
    [commitRows, commitTotal, membershipOf, scheduleRecount, scheduleResync],
  );

  /**
   * The authoritative case after a detail load or mutation. The detail reports a case on
   * every load as well as after every change, so a case outside the loaded window only
   * counts as CHANGED when it differs from the last copy the detail reported (an Undo
   * reopen does; simply opening a deep-linked case does not).
   */
  const detailSeenRef = React.useRef(new Map<string, string>());
  const syncCase = React.useCallback(
    (next: Case) => {
      const signature = [next.status, next.assignee, next.updated_at, next.disposition].map((v) => String(v ?? '')).join('|');
      const seen = detailSeenRef.current;
      const before = seen.get(next.case_id);
      seen.set(next.case_id, signature);
      while (seen.size > 200) seen.delete(seen.keys().next().value as string);
      reconcileCases([next], { changed: () => before !== undefined && before !== signature });
    },
    [reconcileCases],
  );

  // Hover prefetch (CM-5): a short-lived copy of the case fetched while the pointer
  // rests on a row, so the detail opens on the freshest record instead of the queue row.
  // The row itself is the fallback, so a failed or slow prefetch changes nothing.
  const prefetchedRef = React.useRef(new Map<string, Case>());
  const prefetchTimerRef = React.useRef<number | null>(null);
  const prefetchCase = React.useCallback((id: string) => {
    if (prefetchTimerRef.current !== null) window.clearTimeout(prefetchTimerRef.current);
    if (prefetchedRef.current.has(id)) return;
    prefetchTimerRef.current = window.setTimeout(() => {
      prefetchTimerRef.current = null;
      void api
        .getCase(id)
        .then((fresh) => {
          const cache = prefetchedRef.current;
          cache.set(id, fresh);
          // Bounded: only the most recent few hovers are worth keeping.
          while (cache.size > 24) cache.delete(cache.keys().next().value as string);
        })
        .catch(() => undefined);
    }, 150);
  }, []);
  React.useEffect(
    () => () => {
      if (prefetchTimerRef.current !== null) window.clearTimeout(prefetchTimerRef.current);
    },
    [],
  );

  // ---- live updates (CM-5) -------------------------------------------------- //
  const pendingLiveRef = React.useRef(new Map<string, boolean>());
  const liveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trackedJob, setTrackedJob] = React.useState<TrackedJob | null>(null);
  const [jobFailures, setJobFailures] = React.useState<Map<string, string>>(() => new Map());
  const trackedJobRef = React.useRef(trackedJob);
  trackedJobRef.current = trackedJob;

  const flushLive = React.useCallback(async () => {
    liveTimerRef.current = null;
    const batch = Array.from(pendingLiveRef.current.entries());
    pendingLiveRef.current.clear();
    if (!batch.length) return;
    for (const [id] of batch) prefetchedRef.current.delete(id);
    if (batch.length > 25) {
      // A burst (bulk work, a busy poller): one window re-read beats 25+ case reads.
      scheduleResync();
      return;
    }
    const created = new Set(batch.filter(([, isNew]) => isNew).map(([id]) => id));
    const fresh = await Promise.all(batch.map(([id]) => api.getCase(id).catch(() => null)));
    reconcileCases(
      fresh.filter((item): item is Case => Boolean(item)),
      { changed: () => true, created },
    );
  }, [reconcileCases, scheduleResync]);

  const finishTrackedJob = React.useCallback(
    (job: BackgroundJob) => {
      const tracked = trackedJobRef.current;
      if (!tracked || tracked.jobId !== job.job_id) return;
      const failures = new Map<string, string>();
      for (const failure of job.failures || []) {
        if (failure.item_ref) failures.set(failure.item_ref, failure.reason || 'Failed');
      }
      setJobFailures(failures);
      // Successful rows leave the selection; failures stay selected with their reason.
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of tracked.ids) if (!failures.has(id)) next.delete(id);
        return next;
      });
      const failed = failures.size || job.failure_count || 0;
      const succeeded = Math.max(0, tracked.ids.size - failed);
      setTrackedJob(null);
      setBulkOutcome(
        failed
          ? {
              kind: 'warning',
              message: `${tracked.label}: ${succeeded} of ${tracked.ids.size} done. ${failed} failed and ${failed === 1 ? 'stays' : 'stay'} selected.`,
            }
          : { kind: 'success', message: `${tracked.label}: all ${tracked.ids.size} done.` },
      );
      refreshLoaded();
    },
    [refreshLoaded],
  );

  const onStreamEvent = React.useCallback(
    (event: { type: string; data: unknown }) => {
      if (event.type === 'overflow') {
        // The bus dropped frames for this subscriber: some changes were never seen.
        scheduleResync();
        return;
      }
      if (event.type === 'case.review') {
        // D6.5, D6.12: a case was picked for review or reviewed. The count is read again,
        // the open case reads its review state again, and the Review scope re-reads its
        // window (only the server knows the ledger).
        const data = event.data as { case_id?: unknown } | null;
        const id = typeof data?.case_id === 'string' ? data.case_id : '';
        scheduleReviewSummary();
        if (id && id === selectedIdRef.current) setReviewRefresh((n) => n + 1);
        if (scopeRef.current === 'review') scheduleResync();
        return;
      }
      if (event.type === 'case.changed') {
        const data = event.data as { case_id?: unknown; created?: unknown } | null;
        const id = typeof data?.case_id === 'string' ? data.case_id : '';
        if (!id) return;
        // The Review scope lists ledger cases only: a case it has not loaded can join it
        // only through a `case.review` frame, so the other frames update loaded rows.
        if (scopeRef.current === 'review' && !rowsRef.current.some((row) => row.case_id === id)) return;
        pendingLiveRef.current.set(id, Boolean(data?.created) || pendingLiveRef.current.get(id) === true);
        if (!liveTimerRef.current) {
          liveTimerRef.current = setTimeout(() => void flushLive(), LIVE_FLUSH_MS);
        }
        return;
      }
      if (event.type === 'job') {
        const job = event.data as BackgroundJob | null;
        const tracked = trackedJobRef.current;
        if (!job || !tracked || job.job_id !== tracked.jobId) return;
        if (isTerminalJobStatus(job.status)) finishTrackedJob(job);
        else
          setTrackedJob((current) =>
            current && current.jobId === job.job_id
              ? { ...current, done: job.progress?.done ?? current.done, total: job.progress?.total || current.total, status: job.status }
              : current,
          );
      }
    },
    [finishTrackedJob, flushLive, scheduleResync, scheduleReviewSummary],
  );
  const { live } = useEventStream(['cases', 'jobs'], { enabled: true, onEvent: onStreamEvent });

  React.useEffect(
    () => () => {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    },
    [],
  );

  // Without a live stream, poll the tracked job so its rows still settle.
  React.useEffect(() => {
    if (!trackedJob || live) return undefined;
    const handle = setInterval(() => {
      void api.jobs
        .get(trackedJob.jobId)
        .then((job) => {
          if (isTerminalJobStatus(job.status)) finishTrackedJob(job);
          else
            setTrackedJob((current) =>
              current && current.jobId === job.job_id
                ? { ...current, done: job.progress?.done ?? current.done, status: job.status }
                : current,
            );
        })
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(handle);
  }, [trackedJob, live, finishTrackedJob]);

  // ---- split pane ------------------------------------------------------------ //
  const splitFrameRef = React.useRef<HTMLDivElement>(null);
  const splitDragRef = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const storedWidth = React.useRef<number | null>(readStoredQueueWidth());
  const [maxQueueWidth, setMaxQueueWidth] = React.useState(SPLIT_MAX_QUEUE_PX);
  const [queueWidth, setQueueWidth] = React.useState(storedWidth.current ?? SPLIT_DEFAULT_QUEUE_PX);
  const queueWidthRef = React.useRef(queueWidth);
  const [resizingSplit, setResizingSplit] = React.useState(false);
  const [frameWidth, setFrameWidth] = React.useState(0);

  const updateQueueWidth = React.useCallback(
    (value: number, persist = false) => {
      const next = clampQueueWidth(value, maxQueueWidth);
      queueWidthRef.current = next;
      setQueueWidth(next);
      if (persist) {
        storedWidth.current = next;
        persistQueueWidth(next);
      }
    },
    [maxQueueWidth],
  );

  React.useEffect(() => {
    const frame = splitFrameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const width = frame.getBoundingClientRect().width;
      if (width <= 0) return;
      setFrameWidth(width);
      const nextMaximum = Math.max(
        SPLIT_MIN_QUEUE_PX,
        Math.min(SPLIT_MAX_QUEUE_PX, width - SPLIT_MIN_DETAIL_PX - SPLIT_HANDLE_PX),
      );
      setMaxQueueWidth(nextMaximum);
      setQueueWidth((current) => {
        // No stored preference: follow the responsive default as the board resizes.
        const base = storedWidth.current ?? responsiveQueueWidth(width);
        const next = clampQueueWidth(storedWidth.current === null ? base : current, nextMaximum);
        queueWidthRef.current = next;
        return next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const startSplitResize = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    splitDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: queueWidthRef.current,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizingSplit(true);
    event.preventDefault();
  }, []);

  const moveSplitResize = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = splitDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      updateQueueWidth(drag.startWidth + event.clientX - drag.startX);
    },
    [updateQueueWidth],
  );

  const finishSplitResize = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = splitDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    splitDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setResizingSplit(false);
    storedWidth.current = queueWidthRef.current;
    persistQueueWidth(queueWidthRef.current);
  }, []);

  const resizeSplitWithKeyboard = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      let next: number | null = null;
      const step = event.shiftKey ? SPLIT_KEYBOARD_STEP_PX * 2 : SPLIT_KEYBOARD_STEP_PX;
      if (event.key === 'ArrowLeft') next = queueWidthRef.current - step;
      if (event.key === 'ArrowRight') next = queueWidthRef.current + step;
      if (event.key === 'Home') next = SPLIT_MIN_QUEUE_PX;
      if (event.key === 'End') next = maxQueueWidth;
      if (next === null) return;
      event.preventDefault();
      updateQueueWidth(next, true);
    },
    [maxQueueWidth, updateQueueWidth],
  );

  // ---- focus mode (Round 16, WP02; [cmux] §5.2) ------------------------------ //
  // The fold's state and refs are declared with the selection state above, so the close
  // path can land focus on the strip.
  const setQueueFolded = React.useCallback(
    (next: boolean) => {
      if (!splitShownRef.current || next === queueCollapsedRef.current) return;
      const active = document.activeElement;
      const fromQueue = active instanceof Node && Boolean(queueContentRef.current?.contains(active));
      const fromStrip = active instanceof Node && Boolean(stripExpandRef.current?.closest('[data-queue-strip]')?.contains(active));
      setCollapsedPref(next);
      persistCollapsed(next);
      announce(next ? 'Queue hidden. Press [ to show it.' : 'Queue shown.');
      // The control that held focus is about to be hidden: land on its counterpart, never
      // on <body>. Focus anywhere else (the open case) stays where it is.
      requestAnimationFrame(() => {
        if (next && fromQueue) stripExpandRef.current?.focus();
        else if (!next && fromStrip) (queueRowButton(selectedIdRef.current) ?? searchField())?.focus();
      });
    },
    [announce, queueRowButton, searchField],
  );
  const toggleQueueFolded = React.useCallback(() => setQueueFolded(!queueCollapsedRef.current), [setQueueFolded]);

  // The queue pane's width (the split column, or the whole frame where the queue is its
  // own screen). Below 400px the scope control fills band row 1, so Refresh and "About
  // Case Manager" move into the view menu. Unmeasured (0) keeps the full row.
  const queuePaneWidth = splitShown ? queueWidth : frameWidth;
  const bandCompact = queuePaneWidth > 0 && queuePaneWidth < BAND_FULL_ROW_PX;
  /** "About Case Manager" from the view menu of a compact band. */
  const [aboutOpen, setAboutOpen] = React.useState(false);

  /**
   * Previous or next case while the queue is folded (the strip's arrows, J and K). When
   * the open case has left the view, the row that took its place opens first, so a
   * close followed by J never skips a case (the list's own rule, see `onListKeyDown`).
   */
  const stepCase = React.useCallback(
    (delta: 1 | -1) => {
      const list = visibleRef.current;
      if (!list.length) return;
      const at = list.findIndex((row) => row.case_id === selectedIdRef.current);
      if (at < 0) {
        const stop = list.find((row) => row.case_id === effectiveFocusIdRef.current);
        const target = stop ?? (delta > 0 ? list[0] : list[list.length - 1]);
        selectCase(target.case_id);
        return;
      }
      const target = list[at + delta];
      if (target) selectCase(target.case_id);
    },
    [selectCase],
  );

  // ---- selection & bulk ------------------------------------------------------ //
  const [pendingBulkAction, setPendingBulkAction] = React.useState<ConfirmableBulkAction | null>(null);
  const [bulkFormAction, setBulkFormAction] = React.useState<BulkFormAction | null>(null);
  const [bulkFormValue, setBulkFormValue] = React.useState('');
  const [bulkTerminal, setBulkTerminal] = React.useState<BulkTerminalAction | null>(null);
  // The selection the bulk close dialog covers (it reads their runbook progress).
  const bulkTerminalIds = React.useMemo(
    () => (bulkTerminal ? Array.from(selectedIds).sort() : undefined),
    [bulkTerminal, selectedIds],
  );
  // The selection a status-moving bulk dialog covers (Acknowledge, Set status): its AI-run
  // note counts the selected cases with a run, as the close dialogs do.
  const bulkStatusIds = React.useMemo(
    () =>
      pendingBulkAction === 'acknowledge' || bulkFormAction === 'status' ? Array.from(selectedIds).sort() : undefined,
    [bulkFormAction, pendingBulkAction, selectedIds],
  );
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [selectingAll, setSelectingAll] = React.useState(false);
  const [bulkOutcome, setBulkOutcome] = React.useState<{ kind: 'success' | 'warning'; message: string } | null>(null);
  const [pickUsers, setPickUsers] = React.useState<PickableUser[]>([]);
  const jobIntentRef = React.useRef<JobSubmissionIntent | null>(null);
  const bulkMenuRef = React.useRef<HTMLButtonElement | null>(null);

  // GET /api/users needs `users:manage`. Without it the bulk owner field takes a typed
  // name, and the read is never sent: it could only be refused, and every refusal writes
  // an Access denied audit row (Round 14 roles-02).
  const canListUsers = hasPermission('users', 'manage');
  React.useEffect(() => {
    if (!canListUsers) {
      setPickUsers([]);
      return undefined;
    }
    let cancelled = false;
    void listPickableUsers().then((users) => {
      if (!cancelled) setPickUsers(users);
    });
    return () => {
      cancelled = true;
    };
  }, [canListUsers]);

  // Round 15 (D4.7): every case document the selection can name (the loaded window and
  // the pages "Select all N matching" read), so bulk Set status and Set disposition can
  // leave out the cases the AI agent closed.
  const seenCasesRef = React.useRef<Map<string, Case>>(new Map());
  React.useEffect(() => {
    for (const row of rows) seenCasesRef.current.set(row.case_id, row);
  }, [rows]);
  const agentClosedSelected = React.useMemo(() => {
    const out = new Set<string>();
    for (const id of selectedIds) {
      const known = seenCasesRef.current.get(id) ?? rowsById.get(id);
      if (known && isAgentClosedCase(known)) out.add(id);
    }
    return out;
  }, [selectedIds, rowsById]);

  const selectedCount = selectedIds.size;
  const visibleSelectedCount = React.useMemo(
    () => visibleCases.reduce((count, item) => count + Number(selectedIds.has(item.case_id)), 0),
    [selectedIds, visibleCases],
  );
  const allVisibleSelected = visibleCases.length > 0 && visibleSelectedCount === visibleCases.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  const toggleCaseSelection = React.useCallback((caseId: string, checked: boolean, extend = false) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const anchor = anchorIdRef.current;
      if (extend && anchor) {
        const list = visibleRef.current;
        const a = list.findIndex((row) => row.case_id === anchor);
        const b = list.findIndex((row) => row.case_id === caseId);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
            if (checked) next.add(list[i].case_id);
            else next.delete(list[i].case_id);
          }
          return next;
        }
      }
      if (checked) next.add(caseId);
      else next.delete(caseId);
      return next;
    });
    anchorIdRef.current = caseId;
    setBulkOutcome(null);
  }, []);

  const toggleVisibleSelection = React.useCallback((checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const item of visibleRef.current) {
        if (checked) next.add(item.case_id);
        else next.delete(item.case_id);
      }
      return next;
    });
    setBulkOutcome(null);
  }, []);

  const clearBulkSelection = React.useCallback(() => {
    setSelectedIds(new Set());
    setJobFailures(new Map());
    setBulkOutcome(null);
    setPendingBulkAction(null);
    setBulkFormAction(null);
    setBulkFormValue('');
  }, []);

  /** "Select all N matching": a server snapshot of every id the current query matches. */
  const selectAllMatching = React.useCallback(async () => {
    setSelectingAll(true);
    try {
      const ids = new Set<string>();
      const base = JSON.parse(queryKey) as Record<string, string>;
      for (let offset = 0; offset < Math.min(total, QUEUE_SELECT_ALL_LIMIT); offset += QUEUE_MAX_PAGE) {
        const page = await api.listCases({ ...base, limit: QUEUE_MAX_PAGE, offset });
        for (const item of page.cases || []) {
          ids.add(item.case_id);
          seenCasesRef.current.set(item.case_id, item);
        }
        if (!page.cases?.length) break;
      }
      setSelectedIds(ids);
      announce(`${ids.size} matching cases selected.`);
    } catch (nextError) {
      toast.error(errorMessage(nextError, 'Could not select every matching case.'));
    } finally {
      setSelectingAll(false);
    }
  }, [announce, queryKey, total]);

  const submitCaseJob = React.useCallback(
    async (
      kind: BackgroundJobKind,
      params: Record<string, unknown>,
      label: string,
      opts: { leaveOut?: ReadonlySet<string> } = {},
    ) => {
      const leaveOut = opts.leaveOut ?? new Set<string>();
      const targetIds = Array.from(selectedIds)
        .filter((caseId) => !leaveOut.has(caseId))
        .sort();
      const leftOut = selectedIds.size - targetIds.length;
      if (bulkBusy) return;
      if (targetIds.length === 0) {
        // Every selected case was left out: nothing to send (D4.7).
        if (leftOut > 0) {
          const message = `${label} not queued: the AI agent closed every selected case. Review those cases instead.`;
          setBulkOutcome({ kind: 'warning', message });
          toast.error(message);
        }
        return;
      }
      const materialParams = { ...params, case_ids: targetIds };
      const intent = retainJobSubmissionIntent(jobIntentRef.current, kind, materialParams);
      jobIntentRef.current = intent;
      setBulkBusy(true);
      setBulkOutcome(null);
      setJobFailures(new Map());
      try {
        const job = await api.jobs.submit({
          kind,
          idempotency_key: intent.idempotencyKey,
          params: materialParams,
        });
        jobIntentRef.current = null;
        announceJobAccepted(job);
        setTrackedJob({
          jobId: job.job_id,
          label,
          ids: new Set(targetIds),
          done: job.progress?.done ?? 0,
          total: job.progress?.total || targetIds.length,
          status: job.status,
        });
        const message = `${label} queued for ${targetIds.length} case${targetIds.length === 1 ? '' : 's'}; it is running in the background.`;
        const leftOutNote = leftOut
          ? ` ${leftOut} case${leftOut === 1 ? '' : 's'} the AI agent closed ${leftOut === 1 ? 'was' : 'were'} left out.`
          : '';
        setBulkOutcome({ kind: 'success', message: `${message}${leftOutNote} Track progress here or in Inbox.` });
        toast.success(`${message}${leftOutNote}`, {
          action: { label: 'Open Inbox', onClick: () => route.navigate('inbox') },
        });
      } catch (nextError) {
        const message = errorMessage(nextError, `Could not queue ${label.toLowerCase()}.`);
        setBulkOutcome({ kind: 'warning', message });
        toast.error(message);
      } finally {
        setBulkBusy(false);
      }
    },
    [bulkBusy, route, selectedIds],
  );

  // A `case_lifecycle` job takes the job's own params, never a single-case field (such
  // as `require_open_steps_reason`): tsc refuses one instead of the server answering 422.
  const submitLifecycle = React.useCallback(
    (input: CaseLifecycleInput, label: string, opts?: { leaveOut?: ReadonlySet<string> }) =>
      submitCaseJob('case_lifecycle', { ...input }, label, opts),
    [submitCaseJob],
  );

  const openBulkForm = React.useCallback(
    (action: BulkFormAction) => {
      setBulkFormValue(
        action === 'assign'
          ? currentUser || ''
          : action === 'status'
            ? 'investigating'
            : '',
      );
      setBulkFormAction(action);
    },
    [currentUser],
  );

  // A bulk tag over the limit is refused as it is typed, never cut to fit.
  const bulkTagError = bulkFormAction === 'tag' ? caseTagError(bulkFormValue) : null;

  const submitBulkForm = React.useCallback(() => {
    const action = bulkFormAction;
    const value = bulkFormValue.trim();
    if (!action || !value || selectedIds.size === 0 || bulkBusy) return;
    if (action === 'tag' && caseTagError(value)) return;
    setBulkFormAction(null);
    setBulkFormValue('');
    if (action === 'assign') {
      void submitCaseJob('case_assign', { assignee: value }, 'Assignment');
      return;
    }
    if (action === 'tag') {
      void submitCaseJob('case_tag', { tag: value }, 'Tag update');
      return;
    }
    // D4.7: a case the AI agent closed is reviewed, never re-labelled in bulk, so bulk
    // Set status and Set disposition leave such cases out (the backend verbs unchanged).
    if (action === 'status') {
      void submitLifecycle({ action: 'set_status', status: value }, 'Status update', {
        leaveOut: agentClosedSelected,
      });
      return;
    }
    void submitLifecycle(
      // A person picked this value in the bulk form, so it is declared (G1).
      { action: 'set_disposition', disposition: value, disposition_declared: true },
      'Disposition update',
      { leaveOut: agentClosedSelected },
    );
  }, [agentClosedSelected, bulkBusy, bulkFormAction, bulkFormValue, selectedIds.size, submitCaseJob, submitLifecycle]);

  const runConfirmedBulkAction = React.useCallback(() => {
    const action = pendingBulkAction;
    setPendingBulkAction(null);
    if (action === 'acknowledge') {
      void submitLifecycle({ action: 'acknowledge' }, 'Acknowledgement');
      return;
    }
    if (action === 'reinvestigate') {
      void submitCaseJob('case_reinvestigate', {}, 'Reinvestigation');
    }
  }, [pendingBulkAction, submitCaseJob, submitLifecycle]);

  const submitBulkTerminal = React.useCallback(
    (input: BulkCloseInput) => {
      setBulkTerminal(null);
      const { action, ...rest } = input;
      // Through the typed lifecycle submit: the bulk close and resolve params (the one
      // shared `open_steps_reason`, never `require_open_steps_reason`) are the job's own,
      // and `JobParamsPins` in types-contract-pins.ts keeps `BulkCloseInput` inside them.
      void submitLifecycle(
        {
          action,
          ...rest,
          ...(action === 'close' && !rest.resolution ? { resolution: 'Bulk-closed by analyst' } : {}),
          ...(action === 'resolve' && !rest.reason ? { reason: 'Bulk-resolved by analyst' } : {}),
        },
        action === 'close' ? 'Close' : 'Resolution',
      );
    },
    [submitLifecycle],
  );

  // ---- keyboard model (CM-4) ------------------------------------------------- //
  const moveFocus = React.useCallback(
    (delta: number | 'first' | 'last', opts: { extend?: boolean; fromId?: string } = {}) => {
      const list = visibleRef.current;
      if (!list.length) return;
      const from = opts.fromId ?? effectiveFocusId;
      const current = list.findIndex((row) => row.case_id === from);
      let index =
        delta === 'first' ? 0 : delta === 'last' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, (current < 0 ? 0 : current) + delta));
      if (index < 0) index = 0;
      const target = list[index];
      if (!target) return;
      if (opts.extend) {
        toggleCaseSelection(target.case_id, true, true);
        if (current >= 0 && !anchorIdRef.current) anchorIdRef.current = list[current].case_id;
      }
      selectCase(target.case_id, { focusRow: true });
    },
    [effectiveFocusId, selectCase, toggleCaseSelection],
  );

  const onListKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key;
      // The row the key came from (a row's open button OR its checkbox), else the
      // roving tab stop: never a different row than the one that has focus.
      const target = event.target instanceof HTMLElement ? event.target : null;
      const fromId = target?.closest<HTMLElement>('[data-queue-row]')?.dataset.caseId;
      const focused =
        visibleRef.current.find((row) => row.case_id === fromId) ??
        visibleRef.current.find((row) => row.case_id === effectiveFocusId);
      // Space on a focused checkbox is that checkbox's own toggle; let it through.
      if (key === ' ' && target?.getAttribute('role') === 'checkbox') return;
      // The open case has left the view (a plain Close, or a live change took it out of
      // the queue) and the roving stop sits on the row that took its place, which is not
      // open yet. The first step toward that row OPENS it rather than moving past it, so
      // Close → J never skips the case right after the one just closed: J/↓ when the stop
      // is the row after the gap (or there is no gap to measure from, e.g. a deep-linked
      // case outside the list), K/↑ when it is the row before (the last row was closed).
      const down = key === 'ArrowDown' || key === 'j' || key === 'J';
      const up = key === 'ArrowUp' || key === 'k' || key === 'K';
      if ((down || up) && !event.shiftKey && focused && selectedCaseId && focused.case_id !== selectedCaseId) {
        const openGone = !visibleRef.current.some((row) => row.case_id === selectedCaseId);
        const gap = gapStopRef.current;
        const side = gap && gap.id === focused.case_id ? gap.side : 'after';
        if (openGone && ((down && side === 'after') || (up && side === 'before'))) {
          event.preventDefault();
          gapStopRef.current = null;
          selectCase(focused.case_id, { focusRow: true });
          return;
        }
      }
      // Shift extends the selection only for a role that may select (roles-07).
      const extend = event.shiftKey && canBulk;
      if (down) {
        event.preventDefault();
        if (extend && focused) {
          anchorIdRef.current = anchorIdRef.current ?? focused.case_id;
          toggleCaseSelection(focused.case_id, true);
        }
        moveFocus(1, { extend, fromId: focused?.case_id });
      } else if (up) {
        event.preventDefault();
        if (extend && focused) {
          anchorIdRef.current = anchorIdRef.current ?? focused.case_id;
          toggleCaseSelection(focused.case_id, true);
        }
        moveFocus(-1, { extend, fromId: focused?.case_id });
      } else if (key === 'Home') {
        event.preventDefault();
        moveFocus('first');
      } else if (key === 'End') {
        event.preventDefault();
        moveFocus('last');
      } else if ((key === 'x' || key === 'X' || key === ' ') && focused && canBulk) {
        event.preventDefault();
        toggleCaseSelection(focused.case_id, !selectedIds.has(focused.case_id), event.shiftKey);
      } else if ((key === 'Enter' || key === 'o' || key === 'O') && focused) {
        event.preventDefault();
        if (selectedCaseId !== focused.case_id) selectCase(focused.case_id);
        requestAnimationFrame(() => {
          const title = document.querySelector<HTMLElement>('[data-case-title]');
          title?.focus();
        });
      } else if (key === 'Escape' && selectedIds.size) {
        event.preventDefault();
        clearBulkSelection();
      }
    },
    [canBulk, clearBulkSelection, effectiveFocusId, moveFocus, selectCase, selectedCaseId, selectedIds, toggleCaseSelection],
  );

  // Page-level "/" (search), "?" (shortcut sheet) and "[" (fold the queue), outside text
  // entry. While the queue is folded its list cannot take focus, so J and K step through
  // the cases from anywhere on the page instead (Round 16, WP02).
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || shortcutBlocked(event)) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      // A key a control already handled (the strip's own arrows) is not a page shortcut.
      const handled = event.defaultPrevented;
      if (event.key === '/') {
        event.preventDefault();
        if (queueCollapsedRef.current) {
          // The search is in the folded queue: show it first.
          setQueueFolded(false);
          requestAnimationFrame(() => searchField()?.focus());
        } else {
          searchField()?.focus();
        }
      } else if (event.key === '?') {
        event.preventDefault();
        openShortcuts();
      } else if (handled) {
        return;
      } else if (event.key === '[' && splitShownRef.current) {
        event.preventDefault();
        toggleQueueFolded();
      } else if (queueCollapsedRef.current && !event.shiftKey && (event.key === 'j' || event.key === 'J')) {
        event.preventDefault();
        stepCase(1);
      } else if (queueCollapsedRef.current && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        stepCase(-1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openShortcuts, searchField, setQueueFolded, stepCase, toggleQueueFolded]);

  const registerButton = React.useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) buttonsRef.current.set(id, el);
    else buttonsRef.current.delete(id);
  }, []);

  /** Drop the "Closed by" filter, and its key from the address, keeping the open case. */
  const removeClosedBy = React.useCallback(() => {
    if (!closedByRef.current) return;
    closedByRef.current = null;
    setClosedBy(null);
    const open = selectedIdRef.current;
    goQueue(open ? { caseId: open } : undefined);
  }, [goQueue]);

  /**
   * The "Closed by" filter from the Filters control (Round 15, D8.1). Only a case that
   * ended has a closer, so choosing one shows All; the key rides in the address like a
   * link's, so opening or closing a case keeps it.
   */
  const applyClosedBy = React.useCallback(
    (next: QueueCloser | null) => {
      if (!next) {
        removeClosedBy();
        return;
      }
      closedByRef.current = next;
      setClosedBy(next);
      setScope('all');
      reviewKeyRef.current = null;
      setFocusId(null);
      const open = selectedIdRef.current;
      goQueue(open ? { caseId: open } : undefined);
    },
    [goQueue, removeClosedBy],
  );

  /**
   * Change the queue scope. Leaving All drops "Closed by" (only a closed case has a
   * closer); entering Review opens its pending queue. The address changes only when a key
   * it carries does.
   */
  const changeScope = React.useCallback(
    (next: QueueScope) => {
      const hadKeys = Boolean(closedByRef.current || reviewKeyRef.current);
      setScope(next);
      setFocusId(null);
      if (next !== 'all' && closedByRef.current) {
        closedByRef.current = null;
        setClosedBy(null);
      }
      if (next === 'review') setReview('pending');
      reviewKeyRef.current = next === 'review' ? 'pending' : null;
      if (hadKeys || next === 'review') {
        const open = selectedIdRef.current;
        goQueue(open ? { caseId: open } : undefined);
      }
    },
    [goQueue],
  );

  /** Switch the Review scope's queue ("Show completed reviews", and back). */
  const showReview = React.useCallback(
    (next: QueueReview) => {
      reviewKeyRef.current = next;
      setReview(next);
      setFocusId(null);
      const open = selectedIdRef.current;
      goQueue(open ? { caseId: open } : undefined);
    },
    [goQueue],
  );

  const clearFilters = React.useCallback(() => {
    setSearchInput('');
    setSearch('');
    setSeverity(ANY_SEVERITY);
    setStatus(ANY_STATUS);
    removeClosedBy();
  }, [removeClosedBy]);

  const changeDensity = React.useCallback((next: Density) => {
    setDensity(next);
    try {
      window.localStorage?.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      /* per-viewer convenience only */
    }
  }, []);

  // ---- the empty case pane (Round 16, WP02; [cmux] §5.9) ----------------------- //
  // With no case open (and the pane on screen, so only in the split), up to three counted
  // shortcuts into the queue. Each count is the server's exact total for the filter the
  // button applies; an unknown or zero count leaves its button out. Read and offered only
  // once the pane will stay empty: a dismissed case or an empty queue, not the moment
  // before the first case opens on arrival, and not while the queue cannot be read.
  const emptyPaneShown =
    splitShown &&
    !selectedCaseId &&
    !error &&
    (dismissedSelection || (!loading && visibleCases.length === 0));
  const [paneCounts, setPaneCounts] = React.useState<{ critical: number | null; awaiting: number | null }>(
    NO_PANE_COUNTS,
  );
  React.useEffect(() => {
    if (!emptyPaneShown) {
      // A count is read afresh each time the pane shows, never carried over stale.
      setPaneCounts(NO_PANE_COUNTS);
      return undefined;
    }
    let cancelled = false;
    const count = (filter: Record<string, string>) =>
      api
        .listCases({ ...filter, limit: 1, offset: 0 })
        .then((response) => (typeof response.total === 'number' ? response.total : null))
        .catch(() => null);
    void Promise.all([
      count({ status_group: 'active', severity: 'critical' }),
      count({ status: 'needs_human' }),
    ]).then(([critical, awaiting]) => {
      if (!cancelled) setPaneCounts({ critical, awaiting });
    });
    return () => {
      cancelled = true;
    };
  }, [emptyPaneShown]);

  /** Apply a shortcut's filter to the queue (and show the queue if it was folded). */
  const applyPaneShortcut = React.useCallback(
    ({ kind, count }: { kind: PaneShortcutKind; count: number }) => {
      setSearchInput('');
      setSearch('');
      setSeverity(kind === 'critical' ? 'critical' : ANY_SEVERITY);
      setStatus(kind === 'awaiting' ? 'needs_human' : ANY_STATUS);
      changeScope(kind === 'review' ? 'review' : 'active');
      if (queueCollapsedRef.current) setQueueFolded(false);
      announce(`The queue shows ${paneShortcutLabel(kind, count)}.`);
    },
    [announce, changeScope, setQueueFolded],
  );

  const hasFilters = Boolean(
    searchInput.trim() || severity !== ANY_SEVERITY || status !== ANY_STATUS || closedBy,
  );
  // The active filters as removable chips under the search (D8.1).
  const filterChips: FilterChip[] = [
    ...(severity !== ANY_SEVERITY
      ? [{ id: 'severity', label: `Severity: ${humanizeToken(severity)}`, onRemove: () => setSeverity(ANY_SEVERITY) }]
      : []),
    ...(status !== ANY_STATUS
      ? [
          {
            id: 'status',
            label: `Status: ${QUEUE_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? humanizeToken(status)}`,
            onRemove: () => setStatus(ANY_STATUS),
          },
        ]
      : []),
    // D27: the "Closed by" filter a link opened the queue with (`#/scans` lands here as
    // "Closed by the AI agent"), removable like any chip.
    ...(closedBy ? [{ id: 'closedBy', label: CLOSED_BY_LABEL[closedBy], onRemove: removeClosedBy }] : []),
  ];
  // The Review scope behaves like All for the status options (D6.12).
  const statusOptions = QUEUE_STATUS_OPTIONS.filter(
    (option) => scope === 'all' || scope === 'review' || !option.terminal,
  );
  React.useEffect(() => {
    if (status !== ANY_STATUS && !statusOptions.some((option) => option.value === status)) setStatus(ANY_STATUS);
  }, [status, statusOptions]);
  const summary = scopeSummary(scope, rows.length, total, position, scope === 'review' ? review : null);
  // The Review scope is offered while the review is on or has waiting cases, and always
  // while a link has it open.
  const pendingReviews = reviewSummary?.pending ?? 0;
  const offerReview =
    scope === 'review' || Boolean(reviewSummary && (reviewSummary.enabled || reviewSummary.pending > 0));
  // The empty pane's counted shortcuts (the review count is the review summary's), only
  // while the pane will stay empty (see `emptyPaneShown`).
  const emptyPaneShortcuts = emptyPaneShown
    ? paneShortcuts({
        critical: paneCounts.critical,
        awaiting: paneCounts.awaiting,
        review: offerReview && reviewSummary ? reviewSummary.pending : null,
      })
    : [];
  const selectedRow = selectedCaseId ? rowsById.get(selectedCaseId) ?? null : null;
  const prefetched = selectedCaseId ? prefetchedRef.current.get(selectedCaseId) ?? null : null;
  const selectedCase =
    prefetched && (!selectedRow || millisOf(prefetched.updated_at) >= millisOf(selectedRow.updated_at))
      ? prefetched
      : selectedRow;
  const canLoadMore = rows.length < total;
  // Round 16 (WP02): every row's leading slot is its checkbox while anything is selected
  // or a bulk job runs, and always on a touch screen (no hover there); otherwise it is the
  // severity glyph until the row is hovered or focused.
  const revealCheckboxes = canBulk && (coarsePointer || selectedCount > 0 || bulkBusy || Boolean(trackedJob));
  const rowJob = (id: string): RowJobState | null => {
    const pending = Boolean(trackedJob && trackedJob.ids.has(id));
    const failure = jobFailures.get(id);
    return pending || failure ? { pending, failure } : null;
  };

  const bulkFormConfig = bulkFormAction
    ? {
        assign: {
          title: `Assign ${selectedCount} selected case${selectedCount === 1 ? '' : 's'}`,
          description: 'Set an analyst or team owner without changing case status.',
          label: 'Analyst or team',
          placeholder: 'e.g. tier-2 or analyst@example.com',
          submit: 'Assign cases',
        },
        tag: {
          title: `Tag ${selectedCount} selected case${selectedCount === 1 ? '' : 's'}`,
          description: 'Append one tag to each case; existing tags are preserved.',
          label: 'Tag to add',
          placeholder: 'e.g. needs-review',
          submit: 'Add tag',
        },
        status: {
          title: `Set status for ${selectedCount} selected case${selectedCount === 1 ? '' : 's'}`,
          description: 'The server validates each lifecycle transition independently.',
          label: 'New status',
          placeholder: '',
          submit: 'Set status',
        },
        disposition: {
          title: `Set disposition for ${selectedCount} selected case${selectedCount === 1 ? '' : 's'}`,
          description:
            'Record the outcome you confirmed without closing the cases. It is stored as your classification.',
          label: 'Disposition',
          placeholder: '',
          submit: 'Set disposition',
        },
      }[bulkFormAction]
    : null;

  const bulkConfirmConfig = pendingBulkAction
    ? {
        acknowledge: {
          title: `Acknowledge ${selectedCount} case${selectedCount === 1 ? '' : 's'}?`,
          description:
            'Move each eligible case to investigating. This submits one durable background job; progress and per-case failures stay visible here and in Inbox.',
          label: 'Acknowledge cases',
        },
        reinvestigate: {
          title: `Reinvestigate ${selectedCount} case${selectedCount === 1 ? '' : 's'}?`,
          description:
            'Each case re-runs the full AI investigation pipeline and may change its verdict, confidence, and status. This spends LLM tokens per case and continues in the background; progress and failures stay visible here and in Inbox.',
          label: 'Reinvestigate',
        },
      }[pendingBulkAction]
    : null;

  const canAssign = hasPermission('cases', 'assign');
  const canClose = hasPermission('cases', 'close');
  // Bulk work runs as durable background jobs, which the server refuses in Demo Mode.
  // Say so up front instead of letting an analyst fill a dialog that can only fail.
  const bulkUnavailable = demoActive;

  return (
    <ProtectedRoute resource="cases" action="read">
      {/* The bleed is a MATCHED PAIR with `AppShell.CONTENT_INSET`: it widens the board back
          out of the shell gutter to a constant 16px inset on every side (Round 16, WP02:
          `-my-2` takes 8px of the 24px top and bottom inset back too, and the height is the
          viewport minus the 56px top bar and the two 16px insets, so the page never
          scrolls). Keep `w-auto`: it is what makes a negative margin WIDEN the box rather
          than shift it. See `route-visual-standard.test.ts`, which asserts them together. */}
      <PageContainer
        variant="fluid"
        className="h-[calc(100dvh-5.5rem)] min-h-0 w-auto -my-2 sm:-mx-2 xl:min-h-[600px]"
        data-testid="case-manager"
      >
        <TooltipProvider delayDuration={300}>
          {/* No routed page header (Round 16, WP02; [cmux] §5.1): the top bar's breadcrumb
              already names the page, so the title is for assistive technology only, as on
              Chat, and Live, Refresh and "About Case Manager" sit in the queue's band. The
              split frame is the board. */}
          <div className="flex h-full min-h-0 flex-col" data-testid="case-manager-layout">
            <h1 className="sr-only">Case Manager</h1>
            {/* One panel holds the split (ui-audit CM1): the queue on the panel tint, the open
                case on its own surface, divided by the resize handle. */}
            <div
              ref={splitFrameRef}
              data-testid="case-manager-split-frame"
              data-queue-collapsed={queueCollapsed ? '' : undefined}
              className={cn(
                'surface-panel grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-clip',
                'xl:grid-cols-[var(--case-manager-columns)]',
                resizingSplit && 'select-none xl:cursor-col-resize',
              )}
              style={
                {
                  '--case-manager-columns': queueCollapsed
                    ? `${QUEUE_STRIP_PX}px minmax(0, 1fr)`
                    : `${queueWidth}px ${SPLIT_HANDLE_PX}px minmax(0, 1fr)`,
                } as React.CSSProperties
              }
              data-frame-width={frameWidth || undefined}
            >
              {/* Queue becomes the complete mobile/tablet state until a case is selected. */}
              <aside
                aria-label="Case queue"
                className={cn(
                  '@container/queue min-h-0 flex-col border-border xl:flex',
                  selectedCaseId ? 'hidden xl:flex' : 'flex',
                  queueCollapsed && 'border-r',
                )}
              >
                {queueCollapsed ? (
                  // Focus mode: the folded queue's strip. Show the queue, then Previous and
                  // Next (K and J work from anywhere on the page while it is folded) and
                  // where the open case sits in the loaded list.
                  // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Up and Down on the strip's own buttons step through the cases
                  <div
                    data-queue-strip=""
                    data-testid="case-queue-strip"
                    className="flex min-h-0 flex-1 flex-col items-center gap-1 py-2"
                    onKeyDown={(event) => {
                      if (event.altKey || event.ctrlKey || event.metaKey) return;
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        stepCase(event.key === 'ArrowDown' ? 1 : -1);
                      }
                    }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          ref={stripExpandRef}
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Show queue"
                          aria-keyshortcuts="["
                          aria-expanded={false}
                          onClick={() => setQueueFolded(false)}
                        >
                          <PanelLeftOpen className="size-4" aria-hidden />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">Show queue ([)</TooltipContent>
                    </Tooltip>
                    <span aria-hidden className="my-1 h-px w-6 bg-border" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn('h-8 w-8', STRIP_STEP_INERT)}
                          aria-label="Previous case"
                          aria-keyshortcuts="K ArrowUp"
                          // `aria-disabled`, not `disabled`: a button disabled while it holds
                          // focus drops focus to <body>. At the first case it does nothing.
                          aria-disabled={visibleCases.length === 0 || position === 1}
                          onClick={() => stepCase(-1)}
                        >
                          <ChevronUp className="size-4" aria-hidden />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">Previous case (K)</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn('h-8 w-8', STRIP_STEP_INERT)}
                          aria-label="Next case"
                          aria-keyshortcuts="J ArrowDown"
                          aria-disabled={visibleCases.length === 0 || position === visibleCases.length}
                          onClick={() => stepCase(1)}
                        >
                          <ChevronDown className="size-4" aria-hidden />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">Next case (J)</TooltipContent>
                    </Tooltip>
                    {position ? (
                      <p
                        data-testid="case-queue-strip-position"
                        className="mt-1 flex flex-col items-center text-2xs tabular-nums text-muted-foreground"
                        title={`${position.toLocaleString()} of ${visibleCases.length.toLocaleString()} loaded`}
                      >
                        <span className="sr-only">{`Case ${position.toLocaleString()} of ${visibleCases.length.toLocaleString()} loaded`}</span>
                        <span aria-hidden className="font-medium text-foreground">
                          {position.toLocaleString()}
                        </span>
                        <span aria-hidden>of</span>
                        <span aria-hidden>{visibleCases.length.toLocaleString()}</span>
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div
                  ref={queueContentRef}
                  data-testid="case-queue-content"
                  className={cn('min-h-0 flex-1 flex-col', queueCollapsed ? 'hidden' : 'flex')}
                >
                  {/* The control band (D8.1; Round 16, WP02): row 1 the scope, then Live,
                      Refresh, the view menu and "About Case Manager"; row 2 "Select
                      visible", the search and the Filters control with its chips. Two 32px
                      rows in 10px padding with an 8px gap: 92px. */}
                  <div className="shrink-0 border-b border-border px-3 py-2.5" data-testid="case-queue-controls">
                    {/* The scope names the list for assistive technology; the segmented
                        control shows it. */}
                    <h2 className="sr-only">{scopeHeading(scope, scope === 'review' ? review : null)}</h2>
                    <div className="flex h-8 min-w-0 items-center gap-1.5" data-testid="case-queue-band-row">
                      <SegmentedControl<QueueScope>
                        aria-label="Case queue scope"
                        size="sm"
                        value={scope}
                        onValueChange={changeScope}
                        options={[
                          { value: 'active', label: 'Active' },
                          ...(currentUser ? [{ value: 'mine' as const, label: 'Mine' }] : []),
                          ...(offerReview
                            ? [
                                {
                                  value: 'review' as const,
                                  label: (
                                    // Inline, so the name reads "Review, 2 waiting".
                                    <span data-testid="case-queue-review-scope">
                                      Review
                                      {pendingReviews ? (
                                        <span className="ml-1.5 rounded-sm bg-muted px-1.5 py-px text-2xs font-medium tabular-nums text-muted-foreground">
                                          <span className="sr-only">, </span>
                                          {pendingReviews.toLocaleString()}
                                          <span className="sr-only"> waiting</span>
                                        </span>
                                      ) : null}
                                    </span>
                                  ),
                                },
                              ]
                            : []),
                          { value: 'all', label: 'All' },
                        ]}
                      />
                      <div className="ml-auto flex shrink-0 items-center gap-1" data-band-compact={bandCompact ? '' : undefined}>
                        {/* The live state: the dot always, its word once the queue is 28rem
                            wide (the word stays for assistive technology below that). */}
                        {live ? (
                          <StatusDot
                            tone="success"
                            data-testid="case-manager-live"
                            // Dot only (no gap, no margin) until the word shows.
                            className="gap-0 text-xs @[28rem]/queue:mr-1 @[28rem]/queue:gap-1.5"
                            title="Live updates are on"
                          >
                            <span className="sr-only @[28rem]/queue:not-sr-only">Live</span>
                          </StatusDot>
                        ) : null}
                        {/* Below a 400px queue the scope fills the row, so Refresh and
                            "About Case Manager" move into the view menu (still row 1). */}
                        {bandCompact ? null : (
                          <RefreshButton
                            display="icon"
                            label="Refresh case queue"
                            onClick={refreshQueue}
                            refreshing={loading}
                            className="h-8 w-8"
                          />
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              ref={viewMenuRef}
                              variant="ghost"
                              size="sm"
                              className="h-8 min-w-8 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                              aria-label={`${QUEUE_SORT_LABEL[sort]}, sort and view options`}
                            >
                              <ArrowDownUp className="size-3.5" aria-hidden />
                              {/* The sort's name once the queue has room for it (31rem). */}
                              <span className="hidden @[31rem]/queue:inline">{QUEUE_SORT_LABEL[sort]}</span>
                              <ChevronDown className="hidden size-3.5 @[31rem]/queue:block" aria-hidden />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            sideOffset={6}
                            className="w-56"
                            onCloseAutoFocus={(event) => {
                              // "Hide queue" hid this menu's trigger: land on the strip instead.
                              if (!focusStripOnMenuCloseRef.current) return;
                              focusStripOnMenuCloseRef.current = false;
                              event.preventDefault();
                              requestAnimationFrame(() => stripExpandRef.current?.focus());
                            }}
                          >
                            {bandCompact ? (
                              <>
                                <DropdownMenuItem onSelect={refreshQueue}>
                                  <RefreshCw aria-hidden />
                                  Refresh case queue
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                              </>
                            ) : null}
                            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                            <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as QueueSort)}>
                              {(Object.keys(QUEUE_SORT_LABEL) as QueueSort[]).map((value) => (
                                <DropdownMenuRadioItem key={value} value={value}>
                                  {QUEUE_SORT_LABEL[value]}
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem
                              checked={density === 'compact'}
                              onCheckedChange={(next) => changeDensity(next === true ? 'compact' : 'comfortable')}
                            >
                              Compact rows
                            </DropdownMenuCheckboxItem>
                            {splitShown ? (
                              <DropdownMenuItem
                                aria-keyshortcuts="["
                                onSelect={() => {
                                  focusStripOnMenuCloseRef.current = true;
                                  setQueueFolded(true);
                                }}
                              >
                                <PanelLeftClose className="h-4 w-4" aria-hidden />
                                <span className="flex-1">Hide queue</span>
                                <kbd aria-hidden className="ml-auto font-sans text-xs text-muted-foreground">
                                  [
                                </kbd>
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              aria-keyshortcuts="?"
                              onSelect={() => {
                                // The dialog returns focus to the menu's trigger, not the item.
                                shortcutsOpenerRef.current = viewMenuRef.current;
                                setShortcutsOpen(true);
                              }}
                            >
                              <Keyboard className="h-4 w-4" aria-hidden />
                              <span className="flex-1">Keyboard shortcuts</span>
                              <kbd aria-hidden className="ml-auto font-sans text-xs text-muted-foreground">
                                ?
                              </kbd>
                            </DropdownMenuItem>
                            {bandCompact ? (
                              <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
                                <HelpCircle aria-hidden />
                                About Case Manager
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {bandCompact ? null : <HelpTip text={CASE_MANAGER_HELP} label="About Case Manager" />}
                      </div>
                    </div>

                    <div className="mt-2 flex items-start gap-2.5">
                      {canBulk ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="flex h-8 shrink-0 items-center pl-0.5">
                              <Checkbox
                                id="case-manager-select-visible"
                                checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                                disabled={bulkBusy || visibleCases.length === 0}
                                onCheckedChange={(next) => toggleVisibleSelection(next === true)}
                                aria-label="Select all visible cases"
                                className="bg-background"
                              />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Select visible</TooltipContent>
                        </Tooltip>
                      ) : null}
                      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- keys from the search field inside: Escape clears it, Down moves into the list */}
                      <div
                        className="min-w-0 flex-1"
                        onKeyDown={(event) => {
                          const target = event.target as HTMLElement;
                          if (!target.closest('[data-filter-search]')) return;
                          if (event.key === 'Escape' && searchInput) {
                            event.preventDefault();
                            setSearchInput('');
                          } else if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            const first = visibleRef.current[0];
                            if (first) buttonsRef.current.get(effectiveFocusId ?? first.case_id)?.focus();
                          }
                        }}
                      >
                        <FilterBar
                          ref={filterBarRef}
                          aria-label="Case queue filters"
                          primaryCount={0}
                          // The 360px queue pane: with the 12rem minimum, "Filters 1" (wider
                          // than "Filters") would wrap onto a row of its own once a filter is on.
                          searchClassName="min-w-[10rem]"
                          search={{
                            value: searchInput,
                            onChange: setSearchInput,
                            label: 'Search case queue',
                            placeholder: 'Search cases',
                            compactPlaceholder: 'Search cases',
                            // `/` focuses this field from anywhere in the queue.
                            keyShortcuts: '/',
                          }}
                          filters={[
                            {
                              id: 'severity',
                              label: 'Severity',
                              active: severity !== ANY_SEVERITY,
                              control: (
                                <Select value={severity} onValueChange={setSeverity}>
                                  <SelectTrigger className="h-8 w-full text-sm" aria-label="Severity filter">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={ANY_SEVERITY}>Any severity</SelectItem>
                                    {QUEUE_SEVERITIES.map((band) => (
                                      <SelectItem key={band} value={band}>
                                        {humanizeToken(band)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ),
                            },
                            {
                              id: 'status',
                              label: 'Status',
                              active: status !== ANY_STATUS,
                              control: (
                                <Select value={status} onValueChange={setStatus}>
                                  <SelectTrigger className="h-8 w-full text-sm" aria-label="Status filter">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={ANY_STATUS}>Any status</SelectItem>
                                    {statusOptions.map((item) => (
                                      <SelectItem key={item.value} value={item.value}>
                                        {item.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ),
                            },
                            {
                              id: 'closedBy',
                              label: 'Closed by',
                              active: Boolean(closedBy),
                              control: (
                                <Select
                                  value={closedBy ?? ANY_CLOSER}
                                  onValueChange={(value) => applyClosedBy(value === ANY_CLOSER ? null : asCloser(value))}
                                >
                                  <SelectTrigger className="h-8 w-full text-sm" aria-label="Closed by filter">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={ANY_CLOSER}>Anyone</SelectItem>
                                    {(Object.keys(CLOSED_BY_LABEL) as QueueCloser[]).map((closer) => (
                                      <SelectItem key={closer} value={closer}>
                                        {CLOSED_BY_LABEL[closer]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ),
                            },
                          ]}
                          chips={filterChips}
                          onClearAll={clearFilters}
                        />
                      </div>
                    </div>
                    {/* "N new alerts under investigation" (WP09 fills it; nothing at 0). It is
                        one 16px line at most, so the band grows by 20px at most. The wrapper
                        takes no room while it renders nothing, and the 4px gap belongs to a
                        child with content, so a live region kept in place while empty adds
                        no height either. */}
                    <div className="empty:hidden [&>*:not(:empty)]:mt-1" data-testid="case-queue-ai-notice">
                      <AiQueueNotice />
                    </div>
                  </div>

                  {/* The selection count for assistive technology, in a live region that is
                      always mounted: the bulk bar below mounts WITH the first selection, too
                      late for a region inside it to announce that one. */}
                  {canBulk ? (
                    <p className="sr-only" aria-live="polite" data-testid="case-selection-status">
                      {selectedCount
                        ? `${selectedCount.toLocaleString()} case${selectedCount === 1 ? '' : 's'} selected.`
                        : ''}
                    </p>
                  ) : null}

                  {/* The bulk bar (D8.1): only with a selection, a running bulk job or its
                      result. A role with no bulk action never has one. */}
                  {canBulk && (selectedCount > 0 || trackedJob || bulkOutcome) ? (
                    <div
                      role="region"
                      aria-label="Case selection and bulk actions"
                      aria-busy={bulkBusy || Boolean(trackedJob)}
                      className="shrink-0 space-y-1.5 border-b border-border bg-primary/[0.04] px-3 py-2 dark:bg-primary/[0.07]"
                      data-testid="case-manager-selection-row"
                    >
                      {selectedCount > 0 ? (
                        <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-xs font-medium tabular-nums text-foreground">
                            {selectedCount.toLocaleString()} selected
                          </span>
                          {total > selectedCount && total > visibleCases.length ? (
                            <Button
                              variant="link"
                              size="sm"
                              className="h-7 px-1 text-xs"
                              disabled={selectingAll || bulkBusy}
                              onClick={() => void selectAllMatching()}
                              title="Selects a snapshot of every case that matches the current filters."
                            >
                              {selectingAll
                                ? 'Selecting…'
                                : `Select all ${Math.min(total, QUEUE_SELECT_ALL_LIMIT).toLocaleString()} matching`}
                            </Button>
                          ) : null}
                          <div className="ml-auto flex flex-wrap items-center gap-1.5">
                            {canAssign ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={bulkBusy || bulkUnavailable}
                                onClick={() => openBulkForm('assign')}
                              >
                                <UserCheck className="h-3.5 w-3.5" aria-hidden />
                                Assign
                              </Button>
                            ) : null}
                            {canClose ? (
                              <Button
                                size="sm"
                                className="h-7 px-2 text-xs"
                                disabled={bulkBusy || bulkUnavailable}
                                onClick={() => setBulkTerminal('close')}
                              >
                                <Check className="h-3.5 w-3.5" aria-hidden />
                                Close…
                              </Button>
                            ) : null}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  ref={bulkMenuRef}
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  disabled={bulkBusy || bulkUnavailable}
                                  aria-label={`More bulk actions for ${selectedCount} selected case${selectedCount === 1 ? '' : 's'}`}
                                >
                                  {bulkBusy ? (
                                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                  ) : (
                                    <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                                  )}
                                  More
                                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-64">
                                <DropdownMenuLabel className="space-y-0.5">
                                  <span className="block text-foreground">{selectedCount} selected</span>
                                  <span className="block text-xs font-normal leading-4">
                                    Submitted work continues in the background and stays visible in Inbox.
                                  </span>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <Can resource="cases" action="write">
                                  <DropdownMenuItem onSelect={() => setPendingBulkAction('acknowledge')}>
                                    <Eye aria-hidden />
                                    Acknowledge
                                  </DropdownMenuItem>
                                </Can>
                                <Can resource="cases" action="assign">
                                  <DropdownMenuItem onSelect={() => openBulkForm('assign')}>
                                    <UserCheck aria-hidden />
                                    Assign
                                  </DropdownMenuItem>
                                </Can>
                                <Can resource="cases" action="write">
                                  <DropdownMenuItem onSelect={() => openBulkForm('tag')}>
                                    <TagIcon aria-hidden />
                                    Add tag
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => openBulkForm('status')}>
                                    <SlidersHorizontal aria-hidden />
                                    Set status
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => openBulkForm('disposition')}>
                                    <CircleSlash aria-hidden />
                                    Set disposition
                                  </DropdownMenuItem>
                                </Can>
                                <DropdownMenuSeparator />
                                <Can resource="cases" action="reinvestigate">
                                  <DropdownMenuItem onSelect={() => setPendingBulkAction('reinvestigate')}>
                                    <RefreshCw aria-hidden />
                                    Reinvestigate
                                  </DropdownMenuItem>
                                </Can>
                                <Can resource="cases" action="close">
                                  <DropdownMenuItem onSelect={() => setBulkTerminal('resolve')}>
                                    <CheckCircle2 aria-hidden />
                                    Resolve…
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => setBulkTerminal('close')}>
                                    <Check aria-hidden />
                                    Close…
                                  </DropdownMenuItem>
                                </Can>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={clearBulkSelection}
                              disabled={bulkBusy}
                              aria-label="Clear case selection"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden />
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {selectedCount > 0 && bulkUnavailable ? (
                        <p role="note" data-testid="case-bulk-demo-note" className="text-xs leading-5 text-muted-foreground">
                          Bulk changes run as background jobs, which are off in Demo Mode. Open a case to change it on its
                          own.
                        </p>
                      ) : null}
                      {trackedJob ? (
                        <div className="space-y-1" role="status">
                          <p className="text-xs text-foreground">
                            {trackedJob.label}: {trackedJob.done} of {trackedJob.total} done
                          </p>
                          <LoadingBar active size="sm" label={`${trackedJob.label} in progress`} />
                        </div>
                      ) : bulkOutcome ? (
                        <div className="flex items-start gap-2">
                          <p
                            role={bulkOutcome.kind === 'warning' ? 'alert' : 'status'}
                            className={cn(
                              'min-w-0 flex-1 border-l-2 pl-2 text-xs leading-5',
                              bulkOutcome.kind === 'warning'
                                ? 'border-warning text-warning-text'
                                : 'border-success text-success-text',
                            )}
                          >
                            {bulkOutcome.message}
                          </p>
                          {selectedCount === 0 ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={() => setBulkOutcome(null)}
                              aria-label="Dismiss the bulk result"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {newCount > 0 ? (
                    <div className="shrink-0 border-b border-border px-3 py-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-7 w-full text-xs"
                        onClick={showNewCases}
                        data-testid="case-queue-show-new"
                      >
                        {newCount} new case{newCount === 1 ? '' : 's'} · Show
                      </Button>
                    </div>
                  ) : null}

                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {loading && rows.length === 0 ? (
                      <QueueSkeleton />
                    ) : error ? (
                      <div className="p-3">
                        <LoadError error={error} title="Could not load cases" onRetry={refreshLoaded} />
                      </div>
                    ) : visibleCases.length === 0 ? (
                      <EmptyState
                        compact
                        icon={Inbox}
                        state={hasFilters ? 'no-results' : 'no-data'}
                        title={
                          hasFilters
                            ? 'No matching cases'
                            : scope === 'review'
                              ? REVIEW_EMPTY_TITLE[review]
                              : 'No cases in this queue'
                        }
                        description={
                          hasFilters
                            ? 'Adjust or clear the queue filters.'
                            : scope === 'review'
                              ? reviewSummary && !reviewSummary.enabled
                                ? REVIEW_OFF_DESCRIPTION
                                : REVIEW_EMPTY_DESCRIPTION
                              : scope === 'mine'
                              ? 'No active case is assigned to you.'
                              : scope === 'active'
                                ? 'There are no active cases awaiting work.'
                                : 'Cases will appear here as alerts are correlated.'
                        }
                        action={
                          hasFilters ? (
                            <Button variant="outline" size="sm" onClick={clearFilters}>
                              Clear filters
                            </Button>
                          ) : undefined
                        }
                      />
                    ) : (
                      <>
                        <LoadingBar active={loading} size="sm" label="Refreshing the queue" className="rounded-none" />
                        {/* One tab stop: the focused row's open control (roving tabindex). */}
                        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow-key handling for the roving list; each row's open control is a real button */}
                        <div
                          className="divide-y divide-border/70"
                          role="list"
                          aria-label="Cases"
                          onKeyDown={onListKeyDown}
                          data-selection-active={revealCheckboxes ? '' : undefined}
                        >
                          <AnimatePresence initial={false}>
                            {visibleCases.map((item) => (
                              <motion.div
                                role="listitem"
                                key={item.case_id}
                                exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                                transition={SPRING_UI}
                                style={{ overflow: 'hidden' }}
                              >
                                <QueueRow
                                  item={item}
                                  active={selectedCaseId === item.case_id}
                                  checked={selectedIds.has(item.case_id)}
                                  focusTarget={effectiveFocusId === item.case_id}
                                  density={density}
                                  selectable={canBulk}
                                  revealCheckbox={revealCheckboxes}
                                  selectionDisabled={bulkBusy}
                                  job={rowJob(item.case_id)}
                                  registerButton={registerButton}
                                  onOpen={() => selectCase(item.case_id)}
                                  onFocusRow={() => setFocusId(item.case_id)}
                                  onPrefetch={() => prefetchCase(item.case_id)}
                                  onCheckedChange={(checked, shift) => toggleCaseSelection(item.case_id, checked, shift)}
                                />
                              </motion.div>
                            ))}
                          </AnimatePresence>
                        </div>
                      </>
                    )}
                  </div>

                  {/* The list footer (D8.1): the scope line, loaded against total, beside Load
                      more. Not a live region: the app's one announcer already speaks the
                      position when a case opens (focus reads the row itself). */}
                  {!error && !(loading && rows.length === 0) ? (
                    <div className="flex min-h-11 shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
                      <p
                        className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground"
                        data-testid="case-queue-scope"
                      >
                        {summary}
                      </p>
                      {scope === 'review' ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-7 shrink-0 px-1 text-xs"
                          data-testid="case-queue-review-switch"
                          onClick={() => showReview(review === 'pending' ? 'completed' : 'pending')}
                        >
                          {review === 'pending' ? 'Show completed reviews' : 'Show waiting reviews'}
                        </Button>
                      ) : null}
                      {canLoadMore ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-xs"
                          disabled={loadingMore}
                          onClick={() => void fetchPage(rows.length, 'append')}
                        >
                          {loadingMore ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                          Load more
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </aside>

              {/* ARIA's focusable separator pattern is a value widget (aria-valuenow +
                  arrow keys). jsx-a11y classifies the role as static despite that spec. */}
              {/* eslint-disable-next-line jsx-a11y/no-interactive-element-to-noninteractive-role */}
              <button type="button" role="separator"
                aria-label="Resize case queue"
                aria-orientation="vertical"
                aria-valuemin={SPLIT_MIN_QUEUE_PX}
                aria-valuemax={Math.round(maxQueueWidth)}
                aria-valuenow={queueWidth}
                aria-valuetext={`${queueWidth} pixels`}
                title="Drag to resize the queue. Use Left and Right arrow keys for precise adjustment."
                data-testid="case-manager-divider"
                onPointerDown={startSplitResize}
                onPointerMove={moveSplitResize}
                onPointerUp={finishSplitResize}
                onPointerCancel={finishSplitResize}
                onKeyDown={resizeSplitWithKeyboard}
                onDoubleClick={() => {
                  storedWidth.current = null;
                  try {
                    window.localStorage?.removeItem(SPLIT_STORAGE_KEY);
                  } catch {
                    /* convenience only */
                  }
                  updateQueueWidth(responsiveQueueWidth(frameWidth));
                }}
                className={cn(
                  'group relative hidden h-full cursor-col-resize items-stretch justify-center touch-none outline-none xl:flex',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  // A folded queue has nothing to resize: the strip's own edge divides it.
                  queueCollapsed && 'xl:hidden',
                )}
              >
                <span
                  className={cn(
                    'h-full w-px bg-border transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary',
                    resizingSplit && 'w-0.5 bg-primary',
                  )}
                  aria-hidden
                />
              </button>

              {/* Detail replaces the queue below xl; desktop retains the persistent split. */}
              <section
                ref={detailRef}
                aria-label="Selected case workspace"
                className={cn(
                  'min-h-0 min-w-0 flex-col bg-background',
                  selectedCaseId ? 'flex' : 'hidden xl:flex',
                )}
              >
                {selectedCaseId ? (
                  <>
                    {/* No back bar of its own (Round 16, WP16): below xl the case header's
                        Back (marked `data-case-header-back`, WP03) is the one back path, in
                        every browser, so a phone keeps one Back and the case starts 40px
                        higher. */}
                    <div className="min-h-0 flex-1">
                      <CaseDetail
                        caseId={selectedCaseId}
                        presentation="embedded"
                        previewCase={selectedCase}
                        onClose={closeDetail}
                        onNavigate={route.navigate}
                        onCaseChange={syncCase}
                        onAdvance={advance}
                        resolveDialogFocus={resolveDialogFocus}
                        requestedTab={routeTab}
                        requestedSection={routeSection}
                        reviewRefreshKey={reviewRefresh}
                        onReviewChange={onReviewChange}
                      />
                    </div>
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center" data-testid="case-manager-empty-pane">
                    <EmptyState
                      icon={Columns3}
                      title={NO_CASE_OPEN_TITLE}
                      description={NO_CASE_OPEN_DESCRIPTION}
                      action={
                        emptyPaneShortcuts.length ? (
                          <div className="flex flex-wrap justify-center gap-2" data-testid="case-manager-pane-shortcuts">
                            {emptyPaneShortcuts.map((shortcut) => (
                              <Button
                                key={shortcut.kind}
                                variant="outline"
                                size="sm"
                                data-shortcut={shortcut.kind}
                                onClick={() => applyPaneShortcut(shortcut)}
                              >
                                {paneShortcutLabel(shortcut.kind, shortcut.count)}
                              </Button>
                            ))}
                          </div>
                        ) : undefined
                      }
                    />
                  </div>
                )}
              </section>
            </div>
          </div>
        </TooltipProvider>

        <Dialog
          open={bulkFormAction !== null}
          onOpenChange={(open) => {
            if (!open) {
              setBulkFormAction(null);
              setBulkFormValue('');
            }
          }}
        >
          <DialogContent
            className="max-w-md"
            onCloseAutoFocus={(event) => {
              if (bulkMenuRef.current?.isConnected) {
                event.preventDefault();
                bulkMenuRef.current.focus();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{bulkFormConfig?.title}</DialogTitle>
              <DialogDescription>{bulkFormConfig?.description}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-1">
              <AiRunCloseNotice caseIds={bulkStatusIds} open={bulkFormAction === 'status'} action="status" />
              <label htmlFor="case-manager-bulk-value" className="text-xs font-medium text-foreground">
                {bulkFormConfig?.label}
              </label>
              {bulkFormAction === 'status' || bulkFormAction === 'disposition' ? (
                <Select value={bulkFormValue} onValueChange={setBulkFormValue}>
                  <SelectTrigger id="case-manager-bulk-value" aria-label={bulkFormConfig?.label}>
                    <SelectValue placeholder={bulkFormAction === 'disposition' ? 'Select an outcome…' : undefined} />
                  </SelectTrigger>
                  <SelectContent>
                    {/* The disposition choices are the one schema-pinned list (D8.7). */}
                    {(bulkFormAction === 'status' ? BULK_STATUSES : DISPOSITION_OPTIONS).map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.text}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : bulkFormAction === 'assign' && pickUsers.length ? (
                <Select value={bulkFormValue || undefined} onValueChange={setBulkFormValue}>
                  <SelectTrigger id="case-manager-bulk-value" aria-label={bulkFormConfig?.label}>
                    <SelectValue placeholder="Choose an analyst" />
                  </SelectTrigger>
                  <SelectContent>
                    {pickUsers.map((user) => (
                      <SelectItem key={user.username} value={user.username}>
                        {user.username}
                        {user.role ? ` · ${user.role}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="case-manager-bulk-value"
                  value={bulkFormValue}
                  onChange={(event) => setBulkFormValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && bulkFormValue.trim()) submitBulkForm();
                  }}
                  placeholder={bulkFormConfig?.placeholder}
                  aria-invalid={bulkTagError ? true : undefined}
                  aria-describedby={bulkTagError ? 'case-manager-bulk-error' : undefined}
                />
              )}
              {bulkTagError ? (
                <p id="case-manager-bulk-error" role="alert" className="text-xs font-medium text-critical-text">
                  {bulkTagError}
                </p>
              ) : null}
              {bulkFormAction === 'status' || bulkFormAction === 'disposition' ? (
                <p className="text-xs leading-4 text-muted-foreground" data-testid="case-bulk-agent-closed-note">
                  {AGENT_CLOSED_LEFT_OUT}
                  {agentClosedSelected.size
                    ? ` ${agentClosedSelected.size.toLocaleString()} of the selected cases ${agentClosedSelected.size === 1 ? 'is' : 'are'} left out.`
                    : ''}
                </p>
              ) : null}
              <p className="text-xs leading-4 text-muted-foreground">
                The selected case IDs are snapshotted when submitted; later selection changes do not alter the job.
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setBulkFormAction(null);
                  setBulkFormValue('');
                }}
              >
                Cancel
              </Button>
              <Button onClick={submitBulkForm} disabled={!bulkFormValue.trim() || Boolean(bulkTagError) || bulkBusy}>
                {bulkFormConfig?.submit}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <BulkCloseDialog
          action={bulkTerminal}
          count={selectedCount}
          caseIds={bulkTerminalIds}
          busy={bulkBusy}
          onCancel={() => setBulkTerminal(null)}
          onSubmit={submitBulkTerminal}
          returnFocusTo={bulkMenuRef}
        />

        <ConfirmDialog
          open={pendingBulkAction !== null}
          onOpenChange={(open) => {
            if (!open) setPendingBulkAction(null);
          }}
          title={bulkConfirmConfig?.title}
          description={bulkConfirmConfig?.description}
          confirmLabel={bulkConfirmConfig?.label}
          onConfirm={runConfirmedBulkAction}
        >
          {/* Acknowledge moves the status: a run's result replaces it (D10). */}
          <AiRunCloseNotice caseIds={bulkStatusIds} open={pendingBulkAction === 'acknowledge'} action="status" />
        </ConfirmDialog>

        <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
          <DialogContent
            className="max-w-lg"
            onCloseAutoFocus={(event) => {
              // Opened from a key press or a button, never a Radix trigger: return focus
              // to whatever held it (the row, the keyboard button), not <body>.
              const opener = shortcutsOpenerRef.current;
              shortcutsOpenerRef.current = null;
              const target = isFocusable(opener) ? opener : (queueRowButton() ?? caseTitleTarget());
              if (target) {
                event.preventDefault();
                target.focus();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Keyboard shortcuts</DialogTitle>
              <DialogDescription>
                Shortcuts work when focus is not in a text field. Every case change still opens
                its dialog first.
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              {shortcuts.map((row) => (
                <React.Fragment key={row.keys}>
                  <dt className="font-mono text-xs text-foreground">{row.keys}</dt>
                  <dd className="text-muted-foreground">{row.action}</dd>
                </React.Fragment>
              ))}
            </dl>
          </DialogContent>
        </Dialog>

        {/* "About Case Manager" where the band is too narrow for its help tip (Round 16,
            WP02): the same text, from the view menu. Focus returns to the menu's trigger. */}
        <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
          <DialogContent
            className="max-w-md"
            onCloseAutoFocus={(event) => {
              if (viewMenuRef.current && isFocusable(viewMenuRef.current)) {
                event.preventDefault();
                viewMenuRef.current.focus();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>About Case Manager</DialogTitle>
              <DialogDescription>{CASE_MANAGER_HELP}</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </PageContainer>
    </ProtectedRoute>
  );
}
