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
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { severityBand } from '@/soc/components/badges';
import { caseOutcome } from '@/soc/components/outcome';
import { semanticIcon } from '@/soc/components/palette';
import { useAnnouncer } from '@/soc/components/announcer';
import { AnimatePresence, MotionProvider, SPRING_UI, motion, useReducedMotion } from '@/soc/components/motion';
import { useAuth } from '@/soc/auth';
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
  monogram,
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
  queueQuery,
  scopeHeading,
  scopeSummary,
  type QueueScope,
  type QueueSort,
} from './casedetail/queue';

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

function caseSeverity(c: Case) {
  return severityBand(c.severity_band) ?? severityBand(c.risk_score) ?? 'info';
}

function updatedAt(c: Case): string {
  return c.updated_at || c.created_at || '';
}

function millisOf(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** The beside-text status glyph from the ONE semantic icon map (reopened → investigating). */
function queueStatusIcon(status: string) {
  const t = status.trim().toLowerCase();
  return semanticIcon(t === 'reopened' ? 'investigating' : t) ?? Circle;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
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
    `${humanizeToken(severity)} severity${sourceAsserted ? ' (reported by the source)' : ''}`,
    risk !== null ? `risk ${risk}` : null,
    statusText,
    settled ? `outcome ${outcome.shortLabel}` : outcome.shortLabel,
    owner ? `owner ${owner}` : 'unassigned',
    `updated ${age}`,
    job?.failure ? `last bulk action failed: ${job.failure}` : null,
    chat.text || null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      data-testid="case-queue-row"
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
              {owner ? (
                <span
                  aria-hidden
                  title={owner}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-2xs font-semibold text-muted-foreground"
                >
                  {monogram(owner)}
                </span>
              ) : null}
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
                <>
                  <MetaDot />
                  <span className="min-w-0 shrink-[3] truncate @[22.5rem]/queue:inline">{fact}</span>
                </>
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

  const query = React.useMemo(
    () =>
      queueQuery({
        scope,
        username: currentUser,
        search,
        severity: severity === ANY_SEVERITY ? null : severity,
        status: status === ANY_STATUS ? null : status,
        sort,
      }),
    [scope, currentUser, search, severity, status, sort],
  );
  const queryKey = JSON.stringify(query);

  // ---- queue data ---------------------------------------------------------- //
  const [rows, setRows] = React.useState<Case[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [newCount, setNewCount] = React.useState(0);
  const requestRef = React.useRef(0);

  const [selectedCaseId, setSelectedCaseId] = React.useState<string | null>(routeCaseId || null);
  const [dismissedSelection, setDismissedSelection] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const anchorIdRef = React.useRef<string | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const buttonsRef = React.useRef(new Map<string, HTMLButtonElement>());
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

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
        setTotal(response.total ?? page.length);
        setRows((current) => {
          if (mode === 'replace') return page;
          const seen = new Set(current.map((row) => row.case_id));
          return [...current, ...page.filter((row) => !seen.has(row.case_id))];
        });
        if (mode === 'replace') setNewCount(0);
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
    [queryKey],
  );

  React.useEffect(() => {
    void fetchPage(0, 'replace');
  }, [fetchPage]);

  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;

  /** Re-read the loaded window in place (refresh / after bulk work), keeping its size. */
  const refreshLoaded = React.useCallback(() => {
    void fetchPage(0, 'replace', Math.max(QUEUE_PAGE_SIZE, Math.min(QUEUE_MAX_PAGE, rowsRef.current.length)));
  }, [fetchPage]);

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

  const selectCase = React.useCallback(
    (caseId: string, opts: { focusRow?: boolean } = {}) => {
      setSelectedCaseId(caseId);
      setFocusId(caseId);
      setDismissedSelection(false);
      route.navigate('case_manager', { caseId });
      if (opts.focusRow) {
        requestAnimationFrame(() => buttonsRef.current.get(caseId)?.focus());
      }
      const item = rowsRef.current.find((row) => row.case_id === caseId);
      if (item) {
        const index = visibleRef.current.findIndex((row) => row.case_id === caseId);
        announce(
          `Opened case ${caseDisplayId(item)}: ${caseTitle(item)}.${
            index >= 0 ? ` ${index + 1} of ${visibleRef.current.length} loaded.` : ''
          }`,
        );
      }
    },
    [announce, route],
  );

  const closeDetail = React.useCallback(() => {
    setSelectedCaseId(null);
    setDismissedSelection(true);
    route.navigate('case_manager');
  }, [route]);

  /** "Close & next": open the case after the current one (or before it, at the end). */
  const advance = React.useCallback(() => {
    const list = visibleRef.current;
    const index = list.findIndex((row) => row.case_id === selectedCaseId);
    const next = index >= 0 ? list[index + 1] ?? list[index - 1] : list[0];
    if (next && next.case_id !== selectedCaseId) selectCase(next.case_id, { focusRow: true });
    else closeDetail();
  }, [closeDetail, selectCase, selectedCaseId]);

  /**
   * The authoritative case after a detail mutation or a live refresh. A case that no
   * longer belongs in the scope (closed while viewing Active, reassigned away from Mine)
   * leaves the loaded window and the total, so "loaded vs total" stays exact.
   */
  const scopeRef = React.useRef({ scope, currentUser });
  scopeRef.current = { scope, currentUser };
  const syncCase = React.useCallback(
    (next: Case) => {
      const { scope: currentScope, currentUser: user } = scopeRef.current;
      const stillInScope = caseInScope(next, currentScope, user);
      let removed = false;
      setRows((current) => {
        const index = current.findIndex((item) => item.case_id === next.case_id);
        if (index < 0) return current;
        if (!stillInScope) {
          removed = true;
          return current.filter((item) => item.case_id !== next.case_id);
        }
        const updated = [...current];
        updated[index] = next;
        return updated;
      });
      if (!stillInScope) {
        // Functional updates run in order, so `removed` is settled by the time this runs.
        setTotal((count) => (removed ? Math.max(0, count - 1) : count));
      }
    },
    [],
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
    const loaded = new Set(rowsRef.current.map((row) => row.case_id));
    const toRefresh = batch.filter(([id]) => loaded.has(id)).map(([id]) => id);
    const created = batch.filter(([id, isNew]) => isNew && !loaded.has(id)).length;
    if (created) setNewCount((count) => count + created);
    if (toRefresh.length > 25) {
      refreshLoaded();
      return;
    }
    const fresh = await Promise.all(
      toRefresh.map((id) => api.getCase(id).catch(() => null)),
    );
    for (const item of fresh) {
      if (item) syncCase(item);
    }
  }, [refreshLoaded, syncCase]);

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
    [finishTrackedJob, flushLive],
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

  const submitBulkForm = React.useCallback(() => {
    const action = bulkFormAction;
    const value = bulkFormValue.trim();
    if (!action || !value || selectedIds.size === 0 || bulkBusy) return;
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
    (delta: number | 'first' | 'last', opts: { extend?: boolean } = {}) => {
      const list = visibleRef.current;
      if (!list.length) return;
      const current = list.findIndex((row) => row.case_id === effectiveFocusId);
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
      const focused = visibleRef.current.find((row) => row.case_id === effectiveFocusId);
      if (key === 'ArrowDown' || key === 'j' || key === 'J') {
        event.preventDefault();
        if (event.shiftKey && focused) {
          anchorIdRef.current = anchorIdRef.current ?? focused.case_id;
          toggleCaseSelection(focused.case_id, true);
        }
        moveFocus(1, { extend: event.shiftKey });
      } else if (key === 'ArrowUp' || key === 'k' || key === 'K') {
        event.preventDefault();
        if (event.shiftKey && focused) {
          anchorIdRef.current = anchorIdRef.current ?? focused.case_id;
          toggleCaseSelection(focused.case_id, true);
        }
        moveFocus(-1, { extend: event.shiftKey });
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
      if (event.ctrlKey || event.metaKey || event.altKey || isTextEntry(event.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
                    <p
                      className="text-xs tabular-nums text-muted-foreground"
                      aria-live="polite"
                      data-testid="case-queue-scope"
                    >
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
                        aria-label={density === 'compact' ? 'Show comfortable rows' : 'Show compact rows'}
                        aria-pressed={density === 'compact'}
                      >
                        {density === 'compact' ? <Rows2 className="h-4 w-4" /> : <Rows3 className="h-4 w-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => setShortcutsOpen(true)}
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
                            disabled={bulkBusy}
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
                            disabled={bulkBusy}
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
                              disabled={bulkBusy}
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
                    onClick={() => void fetchPage(0, 'replace')}
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
                      onRetry={() => void fetchPage(0, 'replace')}
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
                />
              )}
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
              <Button onClick={submitBulkForm} disabled={!bulkFormValue.trim() || bulkBusy}>
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
          <DialogContent className="max-w-lg">
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
