/**
 * Case Manager — the split queue + case workspace (Round 12 redesign, CM-1 … CM-9).
 *
 * The queue is SERVER-backed: Active / Mine / All, status, severity, search and sort
 * are answered by `GET /api/cases` over the whole corpus and paged with "Load more"
 * (the old newest-200 client filter silently dropped older open cases). The scope line
 * always states loaded vs total. Rows update live from the `cases` realtime topic, bulk
 * work shows per-row progress from the job stream, and the queue has one tab stop with
 * a roving focus: ↑/↓ or J/K move and open, X or Space toggle selection, Shift extends,
 * Enter focuses the case, / searches, ? lists the shortcuts, Esc clears the selection.
 *
 * The embedded `CaseDetail` is NOT remounted per case: it renders the queue row at once
 * and refreshes in the background, so switching cases never blanks the pane.
 *
 * SECURITY (#9): case-derived strings are rendered only as plain React text nodes.
 * #3: every bulk and single mutation is the existing analyst verb or durable job; the
 * outcome shown on a row is presentation (`caseOutcome`), never a decision.
 */
import * as React from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleSlash,
  Columns3,
  Eye,
  Inbox,
  Keyboard,
  LoaderCircle,
  RefreshCw,
  Rows2,
  Rows3,
  Search,
  SlidersHorizontal,
  Tag as TagIcon,
  UserCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errorMessage';
import { DASH, humanizeAge, humanizeToken } from '@/lib/format';
import { caseTagError } from '@/lib/tags';
import type { BackgroundJob, BackgroundJobKind, Case } from '@/lib/types';
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { LoadingBar, LoadingState } from '@/design-system';

import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { Can, ProtectedRoute } from '@/soc/components/Can';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { OwnerMonogram } from '@/soc/components/OwnerMonogram';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { caseOutcome } from '@/soc/components/outcome';
import { semanticIcon } from '@/soc/components/palette';
import { useAnnouncer } from '@/soc/components/announcer';
import { AnimatePresence, MotionProvider, SPRING_UI, motion, useReducedMotion } from '@/soc/components/motion';
import { useAuth } from '@/soc/auth';
import { useDemo } from '@/soc/demo';
import { useRoute } from '@/soc/router';
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
import {
  QUEUE_MAX_PAGE,
  QUEUE_PAGE_SIZE,
  QUEUE_SELECT_ALL_LIMIT,
  QUEUE_SEVERITIES,
  QUEUE_STATUS_OPTIONS,
  caseInScope,
  matchesSearch,
  mergeQueueRow,
  queueMembership,
  queueQuery,
  queueSeverity,
  scopeHeading,
  scopeSummary,
  windowPlacement,
  type QueueQueryInput,
  type QueueScope,
  type QueueSort,
} from './casedetail/queue';
import { shortcutBlocked } from './casedetail/keyboard';

const ANY_SEVERITY = '__any_severity__';
const ANY_STATUS = '__any_status__';
const SPLIT_STORAGE_KEY = 'soc.caseManager.queueWidth';
const DENSITY_STORAGE_KEY = 'soc.caseManager.density';
const SPLIT_MIN_QUEUE_PX = 320;
const SPLIT_MAX_QUEUE_PX = 680;
const SPLIT_MIN_DETAIL_PX = 560;
const SPLIT_HANDLE_PX = 9;
const SPLIT_DEFAULT_QUEUE_PX = 400;
const SPLIT_KEYBOARD_STEP_PX = 24;
const SEARCH_DEBOUNCE_MS = 250;
const LIVE_FLUSH_MS = 600;

type Density = 'comfortable' | 'compact';
type ConfirmableBulkAction = 'acknowledge' | 'reinvestigate';
type BulkFormAction = 'assign' | 'tag' | 'status' | 'disposition';

const BULK_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'escalated', label: 'Escalated' },
] as const;

const BULK_DISPOSITIONS = [
  { value: 'true_positive', label: 'True positive' },
  { value: 'false_positive', label: 'False positive' },
  { value: 'benign', label: 'Benign' },
  { value: 'suspicious', label: 'Suspicious' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'undetermined', label: 'Undetermined' },
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

/** Risk number tone: coloured by its OWN band, so a Risk 7 is never red (CM-6). */
const RISK_WORD: Record<string, string> = {
  critical: 'font-medium text-critical-text',
  high: 'font-medium text-high-text',
  medium: 'text-muted-foreground',
  low: 'text-muted-foreground',
};

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

/** The responsive default queue width: 28% of the board, 360–520px (casemanager §4.1). */
function responsiveQueueWidth(frameWidth: number): number {
  if (!frameWidth) return SPLIT_DEFAULT_QUEUE_PX;
  return Math.round(Math.min(520, Math.max(360, frameWidth * 0.28)));
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
const MetaDot = () => (
  <span aria-hidden className="shrink-0 text-muted-foreground/60">
    ·
  </span>
);

interface RowJobState {
  /** The case is in a bulk job that is still running. */
  pending: boolean;
  /** The reason a bulk job failed for this case, when it did. */
  failure?: string;
}

/**
 * One queue row. Comfortable (default) is three short lines:
 *
 *   line 1  title (truncates) ··························· relative age
 *   line 2  severity · risk · outcome ············· owner  status + glyph
 *   line 3  case id (middle-ellipsis) · primary fact
 *
 * Compact is one line: title · risk · outcome or status · age. The checkbox is ALWAYS
 * visible (bulk work is discoverable) and is a sibling of the open control, never nested.
 * The open control is the row's single tab stop (roving tabindex on the list).
 */
const QueueRow: React.FC<{
  item: Case;
  active: boolean;
  checked: boolean;
  focusTarget: boolean;
  density: Density;
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
  const riskBand = risk === null ? null : risk >= 74 ? 'critical' : risk >= 48 ? 'high' : risk >= 22 ? 'medium' : 'low';
  const SeverityGlyph = semanticIcon(severity);
  const StatusGlyph = item.status ? queueStatusIcon(item.status) : null;
  const outcome = caseOutcome(item);
  const settled = outcome.source !== 'pending';
  const owner = (item.assignee || '').trim();
  const age = humanizeAge(updatedAt(item));
  const sourceAsserted = item.severity_source === 'source_asserted';
  const statusText = item.status ? statusWords(item.status) : 'Unknown status';
  // A case-scoped chat answer being written, unread, waiting or failed (SPEC D13).
  const chat = useCaseChatActivity(item.case_id);
  const accessibleName = [
    title,
    displayId,
    fact,
    `${humanizeToken(severity)} severity${sourceAsserted ? ' (reported by the source)' : ''}`,
    risk !== null ? `risk ${risk}` : null,
    statusText,
    settled ? `outcome ${outcome.shortLabel}` : outcome.shortLabel,
    owner ? `assigned to ${owner}` : 'unassigned',
    `updated ${age}`,
    job?.failure ? `last bulk action failed: ${job.failure}` : null,
    chat.text || null,
  ]
    .filter(Boolean)
    .join(', ');

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

      {/* The checkbox is a sibling of the row-open button, never a nested button, so
          toggling selection cannot open the case. Always visible; X / Space toggles it
          from the keyboard (roving focus keeps the queue to ONE tab stop). */}
      <Checkbox
        checked={checked}
        disabled={selectionDisabled}
        tabIndex={-1}
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
          density === 'compact' ? 'top-[0.5625rem]' : 'top-[0.6875rem]',
          "before:absolute before:-inset-1 before:content-['']",
        )}
      />

      <button
        type="button"
        ref={(el) => registerButton(item.case_id, el)}
        tabIndex={focusTarget ? 0 : -1}
        onClick={onOpen}
        onFocus={onFocusRow}
        onPointerEnter={onPrefetch}
        aria-current={active ? 'true' : undefined}
        aria-label={accessibleName}
        aria-keyshortcuts="ArrowUp ArrowDown J K X Enter"
        className={cn(
          'block w-full pl-10 pr-3 text-left',
          density === 'compact' ? 'py-1.5' : 'py-2.5',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
      >
        {density === 'compact' ? (
          <span className="flex min-w-0 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={title}>
              {title}
            </span>
            {risk !== null ? (
              <span className={cn('shrink-0 tabular-nums', riskBand ? RISK_WORD[riskBand] : '')}>
                Risk {risk}
              </span>
            ) : null}
            <span
              data-testid="case-queue-status"
              className="inline-flex shrink-0 items-center gap-1 text-foreground/80"
            >
              {StatusGlyph ? <StatusGlyph className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
              <span className="max-w-[9rem] truncate">{settled && outcome.terminal ? outcome.shortLabel : statusText}</span>
            </span>
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

            <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  data-testid="case-queue-severity"
                  className={cn('inline-flex shrink-0 items-center gap-1', SEVERITY_WORD[severity])}
                  title={sourceAsserted ? 'Severity reported by the source' : 'Severity derived from the risk score'}
                >
                  {SeverityGlyph ? <SeverityGlyph className="size-3 shrink-0" aria-hidden /> : null}
                  {humanizeToken(severity)}
                </span>
                {risk !== null ? (
                  <>
                    <MetaDot />
                    <span className={cn('shrink-0 tabular-nums', riskBand ? RISK_WORD[riskBand] : '')}>
                      Risk {risk}
                    </span>
                  </>
                ) : null}
                <MetaDot />
                <span
                  data-testid="case-queue-outcome"
                  data-outcome-source={outcome.source}
                  className={cn(
                    'min-w-0 truncate',
                    settled ? 'font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {outcome.shortLabel}
                </span>
              </span>
              <OwnerMonogram name={owner} />
              <span
                data-testid="case-queue-status"
                className="inline-flex shrink-0 items-center gap-1 text-foreground/80"
              >
                {job?.pending ? (
                  <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" aria-hidden />
                ) : job?.failure ? (
                  <AlertTriangle className="size-3 shrink-0 text-warning-text" aria-hidden />
                ) : StatusGlyph ? (
                  <StatusGlyph className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                ) : null}
                {item.status ? <span>{statusText}</span> : <span className="text-muted-foreground">{DASH}</span>}
              </span>
            </span>

            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-[1] truncate font-mono" title={displayId}>
                {middleEllipsis(displayId)}
              </span>
              {fact ? (
                /* The fact shrinks first and hides in a queue narrower than 360px; it
                   stays in the row's accessible name, the hover card and the header. */
                <span
                  data-testid="case-queue-fact"
                  className="hidden min-w-0 shrink-[3] items-center gap-1.5 @[22.5rem]/queue:flex"
                >
                  <MetaDot />
                  <span className="min-w-0 truncate">{fact}</span>
                </span>
              ) : null}
            </span>
            {job?.failure ? (
              <span className="mt-0.5 block truncate text-xs text-warning-text">{job.failure}</span>
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

const SHORTCUTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: '↑ ↓  or  K J', action: 'Move through the queue and open the case' },
  { keys: 'Home  End', action: 'First or last loaded case' },
  { keys: 'X  or  Space', action: 'Select or clear the focused case' },
  { keys: 'Shift + ↑ ↓  or  Shift + X', action: 'Extend the selection' },
  { keys: 'Enter', action: 'Move focus into the open case' },
  { keys: 'Esc', action: 'Clear the selection' },
  { keys: '/', action: 'Search the queue' },
  { keys: '?', action: 'Show these shortcuts' },
  { keys: 'A  C  E  H', action: 'Acknowledge, close, escalate or hold the open case' },
  { keys: 'R', action: 'Reinvestigate the open case' },
  { keys: 'M  T', action: 'Change the owner or edit tags' },
  { keys: 'Alt + 1 … 6', action: 'Switch case tabs' },
];

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
  const { active: demoActive } = useDemo();
  const routeCaseId = initialCaseId ?? route.opts?.caseId;

  // ---- queue query --------------------------------------------------------- //
  const [scope, setScope] = React.useState<QueueScope>('active');
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
      username: currentUser,
      search,
      severity: severity === ANY_SEVERITY ? null : severity,
      status: status === ANY_STATUS ? null : status,
      sort,
    }),
    [scope, currentUser, search, severity, status, sort],
  );
  const query = React.useMemo(() => queueQuery(queueInput), [queueInput]);
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
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  /** The selected-case workspace; its case title is the focus target when the queue is hidden. */
  const detailRef = React.useRef<HTMLElement | null>(null);
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
   * and every row the analyst already loaded (with Load more) stays — the open case, its
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
      route.navigate('case_manager', { caseId });
      if (opts.focusRow) {
        // The row when the queue is on screen (the xl split); below xl the queue is
        // hidden while a case is open, so the case's title instead of <body>.
        requestAnimationFrame(() => {
          const row = buttonsRef.current.get(caseId);
          (isFocusable(row) ? row : caseTitleTarget())?.focus();
        });
      }
      // Focus on the row already reads its title and id; the announcement adds only
      // what focus does not say — where the case sits in the queue (one live region).
      const index = visibleRef.current.findIndex((row) => row.case_id === caseId);
      if (index >= 0) announce(`Opened. ${index + 1} of ${visibleRef.current.length} loaded.`);
    },
    [announce, caseTitleTarget, route],
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
    route.navigate('case_manager');
    // The pane that held focus is gone: land on the case's queue row (or the roving
    // stop, or the search when the queue is empty) instead of <body>.
    requestAnimationFrame(() => {
      const target = queueRowButton(previous) ?? searchRef.current;
      target?.focus();
    });
  }, [queueRowButton, route]);

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
   * `cases` topic). Membership is checked against the WHOLE view — scope, status, owner,
   * search and severity — not just the scope:
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
        const membership = queueMembership(item, input);
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
    [commitRows, commitTotal, scheduleRecount, scheduleResync],
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
      if (event.type === 'case.changed') {
        const data = event.data as { case_id?: unknown; created?: unknown } | null;
        const id = typeof data?.case_id === 'string' ? data.case_id : '';
        if (!id) return;
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
    [finishTrackedJob, flushLive, scheduleResync],
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

  // ---- selection & bulk ------------------------------------------------------ //
  const [pendingBulkAction, setPendingBulkAction] = React.useState<ConfirmableBulkAction | null>(null);
  const [bulkFormAction, setBulkFormAction] = React.useState<BulkFormAction | null>(null);
  const [bulkFormValue, setBulkFormValue] = React.useState('');
  const [bulkTerminal, setBulkTerminal] = React.useState<BulkTerminalAction | null>(null);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [selectingAll, setSelectingAll] = React.useState(false);
  const [bulkOutcome, setBulkOutcome] = React.useState<{ kind: 'success' | 'warning'; message: string } | null>(null);
  const [pickUsers, setPickUsers] = React.useState<PickableUser[]>([]);
  const jobIntentRef = React.useRef<JobSubmissionIntent | null>(null);
  const bulkMenuRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void listPickableUsers().then((users) => {
      if (!cancelled) setPickUsers(users);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        for (const item of page.cases || []) ids.add(item.case_id);
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
    async (kind: BackgroundJobKind, params: Record<string, unknown>, label: string) => {
      const targetIds = Array.from(selectedIds).sort();
      if (targetIds.length === 0 || bulkBusy) return;
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
        setBulkOutcome({ kind: 'success', message: `${message} Track progress here or in Inbox.` });
        toast.success(message, {
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
    if (action === 'status') {
      void submitCaseJob('case_lifecycle', { action: 'set_status', status: value }, 'Status update');
      return;
    }
    void submitCaseJob(
      'case_lifecycle',
      // A person picked this value in the bulk form, so it is declared (G1).
      { action: 'set_disposition', disposition: value, disposition_declared: true },
      'Disposition update',
    );
  }, [bulkBusy, bulkFormAction, bulkFormValue, selectedIds.size, submitCaseJob]);

  const runConfirmedBulkAction = React.useCallback(() => {
    const action = pendingBulkAction;
    setPendingBulkAction(null);
    if (action === 'acknowledge') {
      void submitCaseJob('case_lifecycle', { action: 'acknowledge' }, 'Acknowledgement');
      return;
    }
    if (action === 'reinvestigate') {
      void submitCaseJob('case_reinvestigate', {}, 'Reinvestigation');
    }
  }, [pendingBulkAction, submitCaseJob]);

  const submitBulkTerminal = React.useCallback(
    (input: BulkCloseInput) => {
      setBulkTerminal(null);
      const { action, ...rest } = input;
      void submitCaseJob(
        'case_lifecycle',
        {
          action,
          ...rest,
          ...(action === 'close' && !rest.resolution ? { resolution: 'Bulk-closed by analyst' } : {}),
          ...(action === 'resolve' && !rest.reason ? { reason: 'Bulk-resolved by analyst' } : {}),
        },
        action === 'close' ? 'Close' : 'Resolution',
      );
    },
    [submitCaseJob],
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
      // roving tab stop — never a different row than the one that has focus.
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
      if (down) {
        event.preventDefault();
        if (event.shiftKey && focused) {
          anchorIdRef.current = anchorIdRef.current ?? focused.case_id;
          toggleCaseSelection(focused.case_id, true);
        }
        moveFocus(1, { extend: event.shiftKey, fromId: focused?.case_id });
      } else if (up) {
        event.preventDefault();
        if (event.shiftKey && focused) {
          anchorIdRef.current = anchorIdRef.current ?? focused.case_id;
          toggleCaseSelection(focused.case_id, true);
        }
        moveFocus(-1, { extend: event.shiftKey, fromId: focused?.case_id });
      } else if (key === 'Home') {
        event.preventDefault();
        moveFocus('first');
      } else if (key === 'End') {
        event.preventDefault();
        moveFocus('last');
      } else if ((key === 'x' || key === 'X' || key === ' ') && focused) {
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
    [clearBulkSelection, effectiveFocusId, moveFocus, selectCase, selectedCaseId, selectedIds, toggleCaseSelection],
  );

  // Page-level "/" (search) and "?" (shortcut sheet), outside text entry.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || shortcutBlocked(event)) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === '?') {
        event.preventDefault();
        openShortcuts();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openShortcuts]);

  const registerButton = React.useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) buttonsRef.current.set(id, el);
    else buttonsRef.current.delete(id);
  }, []);

  const clearFilters = React.useCallback(() => {
    setSearchInput('');
    setSearch('');
    setSeverity(ANY_SEVERITY);
    setStatus(ANY_STATUS);
  }, []);

  const changeDensity = React.useCallback((next: Density) => {
    setDensity(next);
    try {
      window.localStorage?.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      /* per-viewer convenience only */
    }
  }, []);

  const hasFilters = Boolean(searchInput.trim() || severity !== ANY_SEVERITY || status !== ANY_STATUS);
  const statusOptions = QUEUE_STATUS_OPTIONS.filter((option) => scope === 'all' || !option.terminal);
  React.useEffect(() => {
    if (status !== ANY_STATUS && !statusOptions.some((option) => option.value === status)) setStatus(ANY_STATUS);
  }, [status, statusOptions]);
  const summary = scopeSummary(scope, rows.length, total, position);
  const selectedRow = selectedCaseId ? rowsById.get(selectedCaseId) ?? null : null;
  const prefetched = selectedCaseId ? prefetchedRef.current.get(selectedCaseId) ?? null : null;
  const selectedCase =
    prefetched && (!selectedRow || millisOf(prefetched.updated_at) >= millisOf(selectedRow.updated_at))
      ? prefetched
      : selectedRow;
  const canLoadMore = rows.length < total;
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
          out of the shell gutter to a constant 16px inset at every width. Keep `w-auto` —
          it is what makes a negative margin WIDEN the box rather than shift it. See
          `route-visual-standard.test.ts`, which asserts them together. */}
      <PageContainer
        variant="fluid"
        className="h-[calc(100dvh-7rem)] min-h-0 w-auto sm:-mx-2 xl:min-h-[600px]"
        data-testid="case-manager"
      >
        <TooltipProvider delayDuration={300}>
          <div
            ref={splitFrameRef}
            data-testid="case-manager-split-frame"
            className={cn(
              'grid h-full min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden border border-border bg-background',
              'xl:grid-cols-[var(--case-manager-columns)]',
              resizingSplit && 'select-none xl:cursor-col-resize',
            )}
            style={
              {
                '--case-manager-columns': `${queueWidth}px ${SPLIT_HANDLE_PX}px minmax(0, 1fr)`,
              } as React.CSSProperties
            }
            data-frame-width={frameWidth || undefined}
          >
            {/* Queue becomes the complete mobile/tablet state until a case is selected. */}
            <aside
              aria-label="Case queue"
              className={cn(
                '@container/queue min-h-0 flex-col border-border bg-card/20 xl:flex',
                selectedCaseId ? 'hidden xl:flex' : 'flex',
              )}
            >
              <header className="shrink-0 space-y-2 border-b border-border px-3 pb-3 pt-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                      {scopeHeading(scope)}
                    </h1>
                    {/* Not a live region: the app's one announcer already speaks the
                        position when a case opens (focus reads the row itself). */}
                    <p className="text-xs tabular-nums text-muted-foreground" data-testid="case-queue-scope">
                      {summary}
                    </p>
                  </div>
                  {live ? (
                    <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <span aria-hidden className="size-1.5 rounded-full bg-success" />
                      Live
                    </span>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => changeDensity(density === 'compact' ? 'comfortable' : 'compact')}
                        aria-label="Compact rows"
                        aria-pressed={density === 'compact'}
                      >
                        {density === 'compact' ? <Rows2 className="h-4 w-4" /> : <Rows3 className="h-4 w-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {density === 'compact' ? 'Compact rows: on' : 'Compact rows: off'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={openShortcuts}
                        aria-label="Keyboard shortcuts"
                        aria-keyshortcuts="?"
                      >
                        <Keyboard className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Keyboard shortcuts (?)</TooltipContent>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={refreshLoaded}
                    disabled={loading}
                    aria-label="Refresh case queue"
                  >
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  </Button>
                </div>

                <SegmentedControl<QueueScope>
                  aria-label="Case queue scope"
                  size="sm"
                  fitted
                  value={scope}
                  onValueChange={(next) => {
                    setScope(next);
                    setFocusId(null);
                  }}
                  options={[
                    { value: 'active', label: 'Active' },
                    ...(currentUser ? [{ value: 'mine' as const, label: 'Mine' }] : []),
                    { value: 'all', label: 'All' },
                  ]}
                />

                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    ref={searchRef}
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && searchInput) {
                        event.preventDefault();
                        setSearchInput('');
                      } else if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        const first = visibleRef.current[0];
                        if (first) buttonsRef.current.get(effectiveFocusId ?? first.case_id)?.focus();
                      }
                    }}
                    placeholder="Search all cases, entities…"
                    aria-label="Search case queue"
                    aria-keyshortcuts="/"
                    className="h-8 pl-8 pr-8 text-xs"
                  />
                  <kbd
                    aria-hidden
                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border border-border px-1 font-mono text-2xs text-muted-foreground"
                  >
                    /
                  </kbd>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6.75rem] gap-2">
                  <Select value={severity} onValueChange={setSeverity}>
                    <SelectTrigger className="h-8 min-w-0 px-2 text-xs" aria-label="Severity filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_SEVERITY}>Severity</SelectItem>
                      {QUEUE_SEVERITIES.map((band) => (
                        <SelectItem key={band} value={band}>
                          {humanizeToken(band)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="h-8 min-w-0 px-2 text-xs" aria-label="Status filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_STATUS}>Status</SelectItem>
                      {statusOptions.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select value={sort} onValueChange={(value) => setSort(value as QueueSort)}>
                    <SelectTrigger className="h-8 min-w-0 px-2 text-xs" aria-label="Sort case queue">
                      <ArrowDownUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="updated_desc">Latest</SelectItem>
                      <SelectItem value="risk_desc">Highest risk</SelectItem>
                      <SelectItem value="created_desc">Newest</SelectItem>
                      <SelectItem value="title_asc">Title A–Z</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </header>

              {/* Selection row. With anything selected it becomes the bulk toolbar. */}
              <div
                role="region"
                aria-label="Case selection and bulk actions"
                aria-busy={bulkBusy || Boolean(trackedJob)}
                className="shrink-0 border-b border-border px-3 py-1.5"
              >
                <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
                  <Checkbox
                    id="case-manager-select-visible"
                    checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                    disabled={bulkBusy || visibleCases.length === 0}
                    onCheckedChange={(next) => toggleVisibleSelection(next === true)}
                    aria-label="Select all visible cases"
                    className="bg-background"
                  />
                  {selectedCount === 0 ? (
                    <>
                      <label
                        htmlFor="case-manager-select-visible"
                        className={cn(
                          'ml-1 cursor-pointer text-xs font-medium text-foreground',
                          (bulkBusy || visibleCases.length === 0) && 'cursor-not-allowed opacity-50',
                        )}
                      >
                        Select visible
                      </label>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {visibleCases.length} visible
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="ml-1 text-xs font-medium tabular-nums text-foreground" aria-live="polite">
                        {selectedCount} selected
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
                    </>
                  )}
                </div>

                {selectedCount > 0 && bulkUnavailable ? (
                  <p role="note" data-testid="case-bulk-demo-note" className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    Bulk changes run as background jobs, which are off in Demo Mode. Open a case to
                    change it on its own.
                  </p>
                ) : null}
                {trackedJob ? (
                  <div className="mt-1.5 space-y-1" role="status">
                    <p className="text-xs text-foreground">
                      {trackedJob.label}: {trackedJob.done} of {trackedJob.total} done
                    </p>
                    <LoadingBar active size="sm" label={`${trackedJob.label} in progress`} />
                  </div>
                ) : bulkOutcome ? (
                  <p
                    role={bulkOutcome.kind === 'warning' ? 'alert' : 'status'}
                    className={cn(
                      'mt-1.5 border-l-2 pl-2 text-xs leading-5',
                      bulkOutcome.kind === 'warning'
                        ? 'border-warning text-warning-text'
                        : 'border-success text-success-text',
                    )}
                  >
                    {bulkOutcome.message}
                  </p>
                ) : null}
              </div>

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
                    <LoadError
                      error={error}
                      title="Could not load cases"
                      onRetry={refreshLoaded}
                    />
                  </div>
                ) : visibleCases.length === 0 ? (
                  <EmptyState
                    compact
                    icon={Inbox}
                    title={hasFilters ? 'No matching cases' : 'No cases in this queue'}
                    description={
                      hasFilters
                        ? 'Adjust or clear the queue filters.'
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
                      className="divide-y divide-border/70 border-b border-border/70"
                      role="list"
                      aria-label="Cases"
                      onKeyDown={onListKeyDown}
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
                    {canLoadMore ? (
                      <div className="p-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          disabled={loadingMore}
                          onClick={() => void fetchPage(rows.length, 'append')}
                        >
                          {loadingMore ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
                          Load more · {rows.length.toLocaleString()} of {total.toLocaleString()} loaded
                        </Button>
                      </div>
                    ) : (
                      <p className="px-3 py-3 text-center text-xs text-muted-foreground">
                        All {total.toLocaleString()} loaded
                      </p>
                    )}
                  </>
                )}
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
              className={cn('min-h-0 min-w-0 flex-col bg-background', selectedCaseId ? 'flex' : 'hidden xl:flex')}
            >
              {selectedCaseId ? (
                <>
                  <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card/35 px-3 xl:hidden">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={closeDetail}
                      aria-label="Back to case queue"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Cases
                    </Button>
                    {/* The display id and title, never the raw id (CM-9 below xl). */}
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {selectedCase ? (
                        <>
                          <span className="font-mono">{caseDisplayId(selectedCase)}</span>
                          {' · '}
                          {caseTitle(selectedCase)}
                        </>
                      ) : null}
                    </span>
                  </div>
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
                    />
                  </div>
                </>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <EmptyState
                    icon={Columns3}
                    title="Select a case"
                    description="Choose a case from the queue to open the complete investigation workspace."
                  />
                </div>
              )}
            </section>
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
              <label htmlFor="case-manager-bulk-value" className="text-xs font-medium text-foreground">
                {bulkFormConfig?.label}
              </label>
              {bulkFormAction === 'status' || bulkFormAction === 'disposition' ? (
                <Select value={bulkFormValue} onValueChange={setBulkFormValue}>
                  <SelectTrigger id="case-manager-bulk-value" aria-label={bulkFormConfig?.label}>
                    <SelectValue placeholder={bulkFormAction === 'disposition' ? 'Select an outcome…' : undefined} />
                  </SelectTrigger>
                  <SelectContent>
                    {(bulkFormAction === 'status' ? BULK_STATUSES : BULK_DISPOSITIONS).map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
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
        />

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
              {SHORTCUTS.map((row) => (
                <React.Fragment key={row.keys}>
                  <dt className="font-mono text-xs text-foreground">{row.keys}</dt>
                  <dd className="text-muted-foreground">{row.action}</dd>
                </React.Fragment>
              ))}
            </dl>
          </DialogContent>
        </Dialog>
      </PageContainer>
    </ProtectedRoute>
  );
}
