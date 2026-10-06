/**
 * Case Manager — dense split-pane analyst workflow adapted from the supplied Stitch
 * mission-control prototype.
 *
 * The ZIP is intentionally treated as visual direction only: its controls were static.
 * This page loads real cases, provides a keyboard-accessible Active/All queue, and
 * embeds the existing CaseDetail orchestrator so every action, RBAC check, lazy panel,
 * deterministic decision, collaboration tool, and case-scoped chat remains canonical.
 *
 * SECURITY (#9): case-derived strings are rendered only as plain React text nodes.
 */
import * as React from 'react';
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleSlash,
  Columns3,
  Eye,
  Inbox,
  LoaderCircle,
  RefreshCw,
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
import type { BackgroundJobKind, Case } from '@/lib/types';

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
import { LoadingState } from '@/design-system';

import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { Can, ProtectedRoute } from '@/soc/components/Can';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { severityBand } from '@/soc/components/badges';
import { semanticIcon } from '@/soc/components/palette';
import { useAuth } from '@/soc/auth';
import { useRoute } from '@/soc/router';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';
import { CaseDetail } from './CaseDetail';

const LIST_LIMIT = 200;
const TERMINAL_STATUSES = new Set(['closed', 'resolved']);
const ANY_SEVERITY = '__any_severity__';
const ANY_STATUS = '__any_status__';
const SPLIT_STORAGE_KEY = 'soc.caseManager.queueWidth';
const SPLIT_MIN_QUEUE_PX = 320;
const SPLIT_MAX_QUEUE_PX = 680;
const SPLIT_MIN_DETAIL_PX = 560;
const SPLIT_HANDLE_PX = 9;
const SPLIT_DEFAULT_QUEUE_PX = 400;
const SPLIT_KEYBOARD_STEP_PX = 24;

type QueueMode = 'active' | 'all';
type QueueSort = 'updated_desc' | 'risk_desc' | 'created_desc' | 'title_asc';
type ConfirmableBulkAction = 'acknowledge' | 'resolve' | 'reinvestigate';
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
] as const;

/**
 * The queue's left-edge severity rail. It REINFORCES the visible severity word (never
 * the only channel, WCAG 1.4.1): solid for the two bands that demand attention, a
 * dashed rail for medium (line style carries meaning, after Sentinel's solid/dotted
 * band), and no rail for low/info so colour appears only where it flags something.
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

function clampQueueWidth(value: number, maximum = SPLIT_MAX_QUEUE_PX): number {
  const safeMaximum = Math.max(SPLIT_MIN_QUEUE_PX, Math.min(SPLIT_MAX_QUEUE_PX, maximum));
  return Math.round(Math.min(safeMaximum, Math.max(SPLIT_MIN_QUEUE_PX, value)));
}

function readQueueWidth(): number {
  try {
    const raw = window.localStorage?.getItem(SPLIT_STORAGE_KEY);
    if (raw === null || raw === undefined || raw.trim() === '') return SPLIT_DEFAULT_QUEUE_PX;
    const value = Number(raw);
    return Number.isFinite(value)
      ? clampQueueWidth(value)
      : SPLIT_DEFAULT_QUEUE_PX;
  } catch {
    return SPLIT_DEFAULT_QUEUE_PX;
  }
}

function persistQueueWidth(value: number): void {
  try {
    window.localStorage?.setItem(SPLIT_STORAGE_KEY, String(value));
  } catch {
    /* Storage is a convenience; resizing remains fully functional without it. */
  }
}

function isActiveCase(c: Case): boolean {
  return !TERMINAL_STATUSES.has((c.status || '').toLowerCase());
}

function caseSeverity(c: Case) {
  return severityBand(c.severity_band) ?? severityBand(c.risk_score) ?? 'info';
}

function updatedAt(c: Case): string {
  return c.updated_at || c.created_at || '';
}

function caseTitle(c: Case): string {
  return c.title || c.summary || c.case_number || c.case_id;
}

/** Entity-type label in sentence case that keeps well-known acronyms intact. */
function entityTypeLabel(type: string): string {
  const t = type.trim().toLowerCase();
  if (t === 'ip' || t === 'url' || t === 'asn' || t === 'md5' || t === 'sha1' || t === 'sha256') {
    return t.toUpperCase();
  }
  return humanizeToken(type);
}

/**
 * The row's secondary fact — the same chain the card always used (primary entity →
 * source name → summary), minus repetition: each candidate is shown only when it adds
 * information beyond the title (demo and correlated titles usually lead with the
 * entity), and a redundant one FALLS THROUGH to the next rather than ending the chain,
 * so a row whose title names its entity still states its source. Nothing is shown,
 * rather than placeholder copy, only when no candidate has anything new to say.
 */
function primaryFact(c: Case): string | null {
  const title = caseTitle(c).toLowerCase();
  const value = c.entity?.value ? String(c.entity.value) : '';
  if (value && !title.includes(value.toLowerCase())) {
    const type = c.entity?.type || c.entity_type;
    return type ? `${entityTypeLabel(type)} ${value}` : value;
  }
  if (c.source_name && !title.includes(c.source_name.toLowerCase())) return c.source_name;
  const summary = (c.summary || '').trim();
  return summary && summary.toLowerCase() !== title ? summary : null;
}

/** Sentence-case status label (the legacy NEEDS_HUMAN alias reads as the F8 taxonomy). */
function queueStatusLabel(status: string): string {
  const t = status.trim().toLowerCase();
  if (t === 'needs_human') return 'Open · awaiting analyst';
  return humanizeToken(status);
}

/** The beside-text status glyph from the ONE semantic icon map (reopened → investigating). */
function queueStatusIcon(status: string) {
  const t = status.trim().toLowerCase();
  return semanticIcon(t === 'reopened' ? 'investigating' : t) ?? Circle;
}

function sortCases(rows: Case[], sort: QueueSort): Case[] {
  return [...rows].sort((a, b) => {
    if (sort === 'risk_desc') {
      return (b.risk_score ?? -1) - (a.risk_score ?? -1) || updatedAt(b).localeCompare(updatedAt(a));
    }
    if (sort === 'created_desc') {
      return (b.created_at || '').localeCompare(a.created_at || '');
    }
    if (sort === 'title_asc') {
      return caseTitle(a).localeCompare(caseTitle(b));
    }
    return updatedAt(b).localeCompare(updatedAt(a));
  });
}

/** A quiet separator between meta facts; decorative, so screen readers skip it. */
const MetaDot = () => (
  <span aria-hidden className="shrink-0 text-muted-foreground/60">
    ·
  </span>
);

/**
 * One queue row: a divided, two-line list item rather than a boxed card.
 *
 *   line 1  title (truncates) ······························ relative age
 *   line 2  severity word · risk · case id · fact ··········· status + glyph
 *
 * Four states never look alike: hover (neutral wash), keyboard focus (inset ring),
 * selected (checked box + light tint) and open (stronger tint + a primary edge rail +
 * `aria-current`). The left rail reinforces severity; the word carries it.
 */
const QueueRow: React.FC<{
  item: Case;
  active: boolean;
  checked: boolean;
  /** Something in the queue is selected, so every row keeps its checkbox visible. */
  selecting: boolean;
  selectionDisabled: boolean;
  onOpen: () => void;
  onCheckedChange: (checked: boolean) => void;
}> = ({ item, active, checked, selecting, selectionDisabled, onOpen, onCheckedChange }) => {
  const severity = caseSeverity(item);
  const displayId = item.case_number || item.case_id;
  const title = caseTitle(item);
  const fact = primaryFact(item);
  const risk =
    typeof item.risk_score === 'number' && Number.isFinite(item.risk_score)
      ? Math.round(Math.max(0, Math.min(100, item.risk_score)))
      : null;
  const SeverityGlyph = semanticIcon(severity);
  const StatusGlyph = item.status ? queueStatusIcon(item.status) : null;

  return (
    <div
      data-testid="case-queue-row"
      data-row-state={active ? 'open' : checked ? 'selected' : 'idle'}
      className={cn(
        'group/row relative transition-colors duration-fast',
        active
          ? 'bg-primary/[0.09] dark:bg-primary/[0.12]'
          : checked
            ? 'bg-primary/[0.04] hover:bg-primary/[0.06] dark:bg-primary/[0.06]'
            : 'hover:bg-muted/70',
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

      {/* The checkbox is a sibling of the row-open button, never a nested button.
          Toggling selection therefore cannot trigger case navigation. It is revealed
          on row hover or its own keyboard focus, always shown on touch (no hover) and
          once anything is selected; the before: pseudo widens the target to 24px. */}
      <Checkbox
        checked={checked}
        disabled={selectionDisabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-label={`Select ${displayId}`}
        className={cn(
          'absolute left-3 top-[0.6875rem] z-10 rounded-[3px] bg-background transition-opacity duration-fast',
          "before:absolute before:-inset-1 before:content-['']",
          !selecting &&
            'opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100',
        )}
      />

      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'block w-full py-2.5 pl-10 pr-3 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
      >
        <span className="flex min-w-0 items-baseline gap-3">
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            title={title}
          >
            {title}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {humanizeAge(updatedAt(item))}
          </span>
        </span>

        <span className="mt-1 flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              data-testid="case-queue-severity"
              className={cn('inline-flex shrink-0 items-center gap-1', SEVERITY_WORD[severity])}
            >
              {SeverityGlyph ? <SeverityGlyph className="size-3 shrink-0" aria-hidden /> : null}
              {humanizeToken(severity)}
            </span>
            {risk !== null ? (
              <>
                <MetaDot />
                <span className="shrink-0 tabular-nums">Risk {risk}</span>
              </>
            ) : null}
            <MetaDot />
            <span className="min-w-0 truncate font-mono" title={displayId}>
              {displayId}
            </span>
            {fact ? (
              <>
                <MetaDot />
                <span className="min-w-0 truncate">{fact}</span>
              </>
            ) : null}
          </span>
          <span
            data-testid="case-queue-status"
            className="inline-flex max-w-[45%] shrink-0 items-center gap-1 text-foreground/80"
          >
            {item.status && StatusGlyph ? (
              <>
                <StatusGlyph className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{queueStatusLabel(item.status)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{DASH}</span>
            )}
          </span>
        </span>
      </button>
    </div>
  );
};

const QueueSkeleton = () => (
  <LoadingState
    label="Loading cases"
    description="Preparing the active case queue."
    layout="panel"
    shape="rows"
    shapeRows={5}
    className="min-h-[28rem]"
  />
);

export interface CaseManagerProps {
  /** Fresh-tab/deep-link case selection supplied by the route registry. */
  initialCaseId?: string;
}

export default function CaseManager({ initialCaseId }: CaseManagerProps) {
  const route = useRoute();
  const { username: currentUser } = useAuth();
  const routeCaseId = initialCaseId ?? route.opts?.caseId;

  const [cases, setCases] = React.useState<Case[]>([]);
  const [totalCases, setTotalCases] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [queueMode, setQueueMode] = React.useState<QueueMode>('active');
  const [search, setSearch] = React.useState('');
  const [severity, setSeverity] = React.useState(ANY_SEVERITY);
  const [status, setStatus] = React.useState(ANY_STATUS);
  const [sort, setSort] = React.useState<QueueSort>('updated_desc');
  const [selectedCaseId, setSelectedCaseId] = React.useState<string | null>(
    routeCaseId || null,
  );
  const [selectedCaseIds, setSelectedCaseIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [dismissedSelection, setDismissedSelection] = React.useState(false);
  const [pendingBulkAction, setPendingBulkAction] =
    React.useState<ConfirmableBulkAction | null>(null);
  const [bulkFormAction, setBulkFormAction] = React.useState<BulkFormAction | null>(null);
  const [bulkFormValue, setBulkFormValue] = React.useState('');
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkOutcome, setBulkOutcome] = React.useState<
    { kind: 'success' | 'warning'; message: string } | null
  >(null);
  const jobIntentRef = React.useRef<JobSubmissionIntent | null>(null);
  const splitFrameRef = React.useRef<HTMLDivElement>(null);
  const splitDragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [maxQueueWidth, setMaxQueueWidth] = React.useState(SPLIT_MAX_QUEUE_PX);
  const [queueWidth, setQueueWidth] = React.useState(readQueueWidth);
  const queueWidthRef = React.useRef(queueWidth);
  const [resizingSplit, setResizingSplit] = React.useState(false);

  const updateQueueWidth = React.useCallback(
    (value: number, persist = false) => {
      const next = clampQueueWidth(value, maxQueueWidth);
      queueWidthRef.current = next;
      setQueueWidth(next);
      if (persist) persistQueueWidth(next);
    },
    [maxQueueWidth],
  );

  React.useEffect(() => {
    const frame = splitFrameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const width = frame.getBoundingClientRect().width;
      if (width <= 0) return;
      const nextMaximum = Math.max(
        SPLIT_MIN_QUEUE_PX,
        Math.min(SPLIT_MAX_QUEUE_PX, width - SPLIT_MIN_DETAIL_PX - SPLIT_HANDLE_PX),
      );
      setMaxQueueWidth(nextMaximum);
      setQueueWidth((current) => {
        const next = clampQueueWidth(current, nextMaximum);
        queueWidthRef.current = next;
        return next;
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const startSplitResize = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      splitDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: queueWidthRef.current,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setResizingSplit(true);
      event.preventDefault();
    },
    [],
  );

  const moveSplitResize = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = splitDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      updateQueueWidth(drag.startWidth + event.clientX - drag.startX);
    },
    [updateQueueWidth],
  );

  const finishSplitResize = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = splitDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      splitDragRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setResizingSplit(false);
      persistQueueWidth(queueWidthRef.current);
    },
    [],
  );

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

  const loadCases = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listCases({ limit: LIST_LIMIT });
      const nextCases = response.cases || [];
      setCases(nextCases);
      setTotalCases(response.total ?? nextCases.length);
      // Preserve selection across queue filters/sorts, but never retain an id that
      // disappeared from the authoritative loaded set after a refresh.
      setSelectedCaseIds((current) => {
        if (current.size === 0) return current;
        const available = new Set(nextCases.map((item) => item.case_id));
        const retained = new Set(Array.from(current).filter((id) => available.has(id)));
        return retained.size === current.size ? current : retained;
      });
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadCases();
  }, [loadCases]);

  React.useEffect(() => {
    if (!routeCaseId) return;
    setSelectedCaseId(routeCaseId);
    setDismissedSelection(false);
  }, [routeCaseId]);

  const scopedCases = React.useMemo(
    () => (queueMode === 'active' ? cases.filter(isActiveCase) : cases),
    [cases, queueMode],
  );

  const statuses = React.useMemo(
    () =>
      Array.from(new Set(scopedCases.map((item) => item.status).filter(Boolean) as string[])).sort(
        (a, b) => a.localeCompare(b),
      ),
    [scopedCases],
  );

  React.useEffect(() => {
    if (status !== ANY_STATUS && !statuses.includes(status)) setStatus(ANY_STATUS);
  }, [status, statuses]);

  const visibleCases = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = scopedCases.filter((item) => {
      if (severity !== ANY_SEVERITY && caseSeverity(item) !== severity) return false;
      if (status !== ANY_STATUS && item.status !== status) return false;
      if (!q) return true;
      const haystack = [
        item.case_id,
        item.case_number,
        item.title,
        item.summary,
        item.status,
        item.verdict,
        item.entity?.type,
        item.entity?.value,
        item.source_name,
        item.assignee,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
    return sortCases(rows, sort);
  }, [scopedCases, search, severity, status, sort]);

  const selectedCases = React.useMemo(
    () => cases.filter((item) => selectedCaseIds.has(item.case_id)),
    [cases, selectedCaseIds],
  );
  const visibleSelectedCount = React.useMemo(
    () => visibleCases.reduce((count, item) => count + Number(selectedCaseIds.has(item.case_id)), 0),
    [selectedCaseIds, visibleCases],
  );
  const allVisibleSelected =
    visibleCases.length > 0 && visibleSelectedCount === visibleCases.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  const toggleCaseSelection = React.useCallback((caseId: string, checked: boolean) => {
    setSelectedCaseIds((current) => {
      const next = new Set(current);
      if (checked) next.add(caseId);
      else next.delete(caseId);
      return next;
    });
    setBulkOutcome(null);
  }, []);

  const toggleVisibleSelection = React.useCallback(
    (checked: boolean) => {
      setSelectedCaseIds((current) => {
        const next = new Set(current);
        for (const item of visibleCases) {
          if (checked) next.add(item.case_id);
          else next.delete(item.case_id);
        }
        return next;
      });
      setBulkOutcome(null);
    },
    [visibleCases],
  );

  const clearBulkSelection = React.useCallback(() => {
    setSelectedCaseIds(new Set());
    setBulkOutcome(null);
    setPendingBulkAction(null);
    setBulkFormAction(null);
    setBulkFormValue('');
  }, []);

  // Open the newest visible active case on first arrival, mirroring the reference's
  // always-ready mission-control posture. An explicit pane dismiss suppresses this.
  React.useEffect(() => {
    if (loading || selectedCaseId || dismissedSelection || visibleCases.length === 0) return;
    setSelectedCaseId(visibleCases[0].case_id);
  }, [loading, selectedCaseId, dismissedSelection, visibleCases]);

  const selectCase = React.useCallback(
    (caseId: string) => {
      setSelectedCaseId(caseId);
      setDismissedSelection(false);
      route.navigate('case_manager', { caseId });
    },
    [route],
  );

  const closeDetail = React.useCallback(() => {
    setSelectedCaseId(null);
    setDismissedSelection(true);
    route.navigate('case_manager');
  }, [route]);

  const syncCase = React.useCallback((next: Case) => {
    setCases((current) => {
      const index = current.findIndex((item) => item.case_id === next.case_id);
      if (index < 0) return [next, ...current];
      const updated = [...current];
      updated[index] = next;
      return updated;
    });
  }, []);

  const submitCaseJob = React.useCallback(
    async (
      kind: BackgroundJobKind,
      params: Record<string, unknown>,
      targets: readonly Case[],
      label: string,
    ) => {
      if (targets.length === 0 || bulkBusy) return;
      const targetIds = targets.map((item) => item.case_id).sort();
      const materialParams = { ...params, case_ids: targetIds };
      const intent = retainJobSubmissionIntent(jobIntentRef.current, kind, materialParams);
      jobIntentRef.current = intent;
      setBulkBusy(true);
      setBulkOutcome(null);
      try {
        const job = await api.jobs.submit({
          kind,
          idempotency_key: intent.idempotencyKey,
          params: materialParams,
        });
        jobIntentRef.current = null;
        announceJobAccepted(job);
        setSelectedCaseIds((current) => {
          const next = new Set(current);
          targetIds.forEach((id) => next.delete(id));
          return next;
        });
        const message = `${label} queued for ${targetIds.length} case${targetIds.length === 1 ? '' : 's'}; it is running in the background.`;
        setBulkOutcome({ kind: 'success', message: `${message} Track progress in Inbox.` });
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
    [bulkBusy, route],
  );

  const openBulkForm = React.useCallback(
    (action: BulkFormAction) => {
      setBulkFormValue(
        action === 'assign'
          ? currentUser || ''
          : action === 'status'
            ? 'investigating'
            : action === 'disposition'
              ? 'true_positive'
              : '',
      );
      setBulkFormAction(action);
    },
    [currentUser],
  );

  const submitBulkForm = React.useCallback(() => {
    const action = bulkFormAction;
    const value = bulkFormValue.trim();
    const targets = selectedCases;
    if (!action || !value || targets.length === 0 || bulkBusy) return;
    setBulkFormAction(null);
    setBulkFormValue('');

    if (action === 'assign') {
      void submitCaseJob('case_assign', { assignee: value }, targets, 'Assignment');
      return;
    }
    if (action === 'tag') {
      void submitCaseJob('case_tag', { tag: value }, targets, 'Tag update');
      return;
    }
    if (action === 'status') {
      void submitCaseJob(
        'case_lifecycle',
        { action: 'set_status', status: value },
        targets,
        'Status update',
      );
      return;
    }
    void submitCaseJob(
      'case_lifecycle',
      { action: 'set_disposition', disposition: value },
      targets,
      'Disposition update',
    );
  }, [bulkBusy, bulkFormAction, bulkFormValue, selectedCases, submitCaseJob]);

  const runConfirmedBulkAction = React.useCallback(() => {
    const action = pendingBulkAction;
    setPendingBulkAction(null);
    if (action === 'acknowledge') {
      void submitCaseJob('case_lifecycle', { action: 'acknowledge' }, selectedCases, 'Acknowledgement');
      return;
    }
    if (action === 'resolve') {
      void submitCaseJob(
        'case_lifecycle',
        { action: 'resolve', reason: 'Bulk-resolved by analyst' },
        selectedCases,
        'Resolution',
      );
      return;
    }
    if (action === 'reinvestigate') {
      void submitCaseJob('case_reinvestigate', {}, selectedCases, 'Reinvestigation');
    }
  }, [pendingBulkAction, selectedCases, submitCaseJob]);

  const clearFilters = React.useCallback(() => {
    setSearch('');
    setSeverity(ANY_SEVERITY);
    setStatus(ANY_STATUS);
  }, []);

  const hasFilters = Boolean(search.trim() || severity !== ANY_SEVERITY || status !== ANY_STATUS);
  const scopeSummary =
    queueMode === 'active'
      ? `${visibleCases.length.toLocaleString()} shown · ${scopedCases.length.toLocaleString()} active / ${cases.length.toLocaleString()} loaded`
      : `${visibleCases.length.toLocaleString()} shown · ${cases.length.toLocaleString()} loaded${
          totalCases > cases.length ? ` / ${totalCases.toLocaleString()} total` : ''
        }`;

  const bulkFormConfig = bulkFormAction
    ? {
        assign: {
          title: `Assign ${selectedCases.length} selected case${selectedCases.length === 1 ? '' : 's'}`,
          description: 'Set an analyst or team owner without changing case status.',
          label: 'Analyst or team',
          placeholder: 'e.g. tier-2 or analyst@example.com',
          submit: 'Assign cases',
        },
        tag: {
          title: `Tag ${selectedCases.length} selected case${selectedCases.length === 1 ? '' : 's'}`,
          description: 'Append one tag to each case; existing tags are preserved.',
          label: 'Tag to add',
          placeholder: 'e.g. needs-review',
          submit: 'Add tag',
        },
        status: {
          title: `Set status for ${selectedCases.length} selected case${selectedCases.length === 1 ? '' : 's'}`,
          description: 'The server validates each lifecycle transition independently.',
          label: 'New status',
          placeholder: '',
          submit: 'Set status',
        },
        disposition: {
          title: `Set disposition for ${selectedCases.length} selected case${selectedCases.length === 1 ? '' : 's'}`,
          description: 'Record the investigative outcome without silently closing a case.',
          label: 'Disposition',
          placeholder: '',
          submit: 'Set disposition',
        },
      }[bulkFormAction]
    : null;

  const bulkConfirmConfig = pendingBulkAction
    ? {
        acknowledge: {
          title: `Acknowledge ${selectedCases.length} case${selectedCases.length === 1 ? '' : 's'}?`,
          description:
            'Move each eligible case to INVESTIGATING. This submits one durable background job; progress and per-case failures remain visible in Inbox.',
          label: 'Acknowledge cases',
        },
        resolve: {
          title: `Resolve ${selectedCases.length} case${selectedCases.length === 1 ? '' : 's'}?`,
          description:
            'Mark each eligible case resolved through the canonical analyst lifecycle action. Progress and per-case failures remain visible in Inbox.',
          label: 'Resolve cases',
        },
        reinvestigate: {
          title: `Reinvestigate ${selectedCases.length} case${selectedCases.length === 1 ? '' : 's'}?`,
          description:
            'Each case re-runs the full AI investigation pipeline and may change its verdict, confidence, and status. This spends LLM tokens per case and continues in the background; progress and failures remain in Inbox.',
          label: 'Reinvestigate',
        },
      }[pendingBulkAction]
    : null;

  return (
    <ProtectedRoute resource="cases" action="read">
      {/* The bleed is a MATCHED PAIR with `AppShell.CONTENT_INSET`: it widens the board back
          out of the shell gutter to a constant 16px inset at every width. The shell gutter is
          now flat (px-4, sm:px-6), so the bleed is flat too (0, then -8). Keep `w-auto` — it
          is what makes a negative margin WIDEN the box rather than shift it. If either side
          changes alone the board overflows `<main class="… overflow-x-hidden">`; see
          `route-visual-standard.test.ts`, which asserts them together. */}
      <PageContainer
        variant="fluid"
        className="h-[calc(100dvh-7rem)] min-h-0 w-auto sm:-mx-2 xl:min-h-[600px]"
        data-testid="case-manager"
      >
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
        >
          {/* Queue becomes the complete mobile/tablet state until a case is selected. */}
          <aside
            aria-label="Case queue"
            className={cn(
              'min-h-0 flex-col border-border bg-card/20 xl:flex',
              selectedCaseId ? 'hidden xl:flex' : 'flex',
            )}
          >
            {/* One quiet band: title + scope + refresh, then search and filters. No
                eyebrow — the h1 already names the queue. */}
            <header className="shrink-0 space-y-2 border-b border-border px-3 pb-3 pt-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                    {queueMode === 'active' ? 'Active cases' : 'All cases'}
                  </h1>
                  <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                    {scopeSummary}
                  </p>
                </div>
                <SegmentedControl<QueueMode>
                  aria-label="Case queue scope"
                  size="sm"
                  className="shrink-0"
                  value={queueMode}
                  onValueChange={setQueueMode}
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'all', label: 'All' },
                  ]}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-[4px]"
                  onClick={() => void loadCases()}
                  disabled={loading}
                  aria-label="Refresh case queue"
                >
                  <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                </Button>
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search cases, entities…"
                  aria-label="Search case queue"
                  className="h-8 rounded-[4px] pl-8 text-xs"
                />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6.25rem] gap-2">
                <Select value={severity} onValueChange={setSeverity}>
                  <SelectTrigger className="h-8 min-w-0 rounded-[4px] px-2 text-xs" aria-label="Severity filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY_SEVERITY}>Severity</SelectItem>
                    {['critical', 'high', 'medium', 'low', 'info'].map((band) => (
                      <SelectItem key={band} value={band}>{humanizeToken(band)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="h-8 min-w-0 rounded-[4px] px-2 text-xs" aria-label="Status filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY_STATUS}>Status</SelectItem>
                    {statuses.map((item) => (
                      <SelectItem key={item} value={item}>{humanizeToken(item)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={sort} onValueChange={(value) => setSort(value as QueueSort)}>
                  <SelectTrigger className="h-8 min-w-0 rounded-[4px] px-2 text-xs" aria-label="Sort case queue">
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

            {/* The list's column header: its checkbox sits on the same x as every row
                checkbox, so selection reads as one column. */}
            <div
              role="region"
              aria-label="Case selection and bulk actions"
              aria-busy={bulkBusy}
              className="shrink-0 border-b border-border px-3 py-1"
            >
              <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
                <Checkbox
                  id="case-manager-select-visible"
                  checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                  disabled={bulkBusy || visibleCases.length === 0}
                  onCheckedChange={(next) => toggleVisibleSelection(next === true)}
                  aria-label="Select all visible cases"
                  className="rounded-[3px] bg-background"
                />
                <label
                  htmlFor="case-manager-select-visible"
                  className={cn(
                    'ml-1 cursor-pointer text-xs font-medium text-foreground',
                    (bulkBusy || visibleCases.length === 0) && 'cursor-not-allowed opacity-50',
                  )}
                >
                  Select visible
                </label>
                <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                  {selectedCaseIds.size > 0
                    ? `${selectedCaseIds.size} selected`
                    : `${visibleCases.length} visible`}
                </span>

                {selectedCaseIds.size > 0 ? (
                  <div className="ml-auto flex items-center gap-1.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 max-w-[12rem] rounded-[4px] px-2 text-xs"
                          disabled={bulkBusy}
                          aria-label={`Bulk actions for ${selectedCaseIds.size} selected case${selectedCaseIds.size === 1 ? '' : 's'}`}
                        >
                          {bulkBusy ? (
                            <LoaderCircle className="mr-1.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                          ) : (
                            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                          )}
                          <span className="truncate">
                            {bulkBusy ? 'Submitting…' : 'Bulk actions'}
                          </span>
                          {!bulkBusy ? (
                            <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0" aria-hidden />
                          ) : null}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64 rounded-[4px]">
                        <DropdownMenuLabel className="space-y-0.5">
                          <span className="block text-foreground">
                            {selectedCaseIds.size} selected
                          </span>
                          <span className="block text-2xs font-normal leading-4">
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
                          <DropdownMenuItem onSelect={() => setPendingBulkAction('resolve')}>
                            <Check aria-hidden />
                            Resolve
                          </DropdownMenuItem>
                        </Can>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-[4px]"
                      onClick={clearBulkSelection}
                      disabled={bulkBusy}
                      aria-label="Clear case selection"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                ) : null}
              </div>

              {bulkOutcome ? (
                <p
                  role={bulkOutcome.kind === 'warning' ? 'alert' : 'status'}
                  className={cn(
                    'mt-1.5 border-l-2 pl-2 text-2xs leading-5',
                    bulkOutcome.kind === 'warning'
                      ? 'border-warning text-warning-text'
                      : 'border-success text-success-text',
                  )}
                >
                  {bulkOutcome.message}
                </p>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <QueueSkeleton />
              ) : error ? (
                <div className="p-3">
                  <LoadError
                    error={error}
                    title="Could not load cases"
                    onRetry={() => void loadCases()}
                    className="rounded-[4px]"
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
                      : queueMode === 'active'
                        ? 'There are no active cases awaiting work.'
                        : 'Cases will appear here as alerts are correlated.'
                  }
                  action={
                    hasFilters ? (
                      <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>
                    ) : undefined
                  }
                />
              ) : (
                <div
                  className="divide-y divide-border/70 border-b border-border/70"
                  role="list"
                  aria-label="Cases"
                >
                  {visibleCases.map((item) => (
                    <div role="listitem" key={item.case_id}>
                      <QueueRow
                        item={item}
                        active={selectedCaseId === item.case_id}
                        checked={selectedCaseIds.has(item.case_id)}
                        selecting={selectedCaseIds.size > 0}
                        selectionDisabled={bulkBusy}
                        onOpen={() => selectCase(item.case_id)}
                        onCheckedChange={(checked) => toggleCaseSelection(item.case_id, checked)}
                      />
                    </div>
                  ))}
                </div>
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
            onDoubleClick={() => updateQueueWidth(SPLIT_DEFAULT_QUEUE_PX, true)}
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
            className={cn(
              'min-h-0 min-w-0 flex-col bg-background',
              selectedCaseId ? 'flex' : 'hidden xl:flex',
            )}
          >
            {selectedCaseId ? (
              <>
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card/35 px-3 xl:hidden">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-[4px] px-2"
                    onClick={closeDetail}
                    aria-label="Back to case queue"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Cases
                  </Button>
                  <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
                    {selectedCaseId}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <CaseDetail
                    key={selectedCaseId}
                    caseId={selectedCaseId}
                    presentation="embedded"
                    onClose={closeDetail}
                    onNavigate={route.navigate}
                    onCaseChange={syncCase}
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

        <Dialog
          open={bulkFormAction !== null}
          onOpenChange={(open) => {
            if (!open) {
              setBulkFormAction(null);
              setBulkFormValue('');
            }
          }}
        >
          <DialogContent className="max-w-md rounded-[4px]">
            <DialogHeader>
              <DialogTitle>{bulkFormConfig?.title}</DialogTitle>
              <DialogDescription>{bulkFormConfig?.description}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-1">
              <label
                htmlFor="case-manager-bulk-value"
                className="text-xs font-medium text-foreground"
              >
                {bulkFormConfig?.label}
              </label>
              {bulkFormAction === 'status' || bulkFormAction === 'disposition' ? (
                <Select value={bulkFormValue} onValueChange={setBulkFormValue}>
                  <SelectTrigger
                    id="case-manager-bulk-value"
                    className="rounded-[4px]"
                    aria-label={bulkFormConfig?.label}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(bulkFormAction === 'status' ? BULK_STATUSES : BULK_DISPOSITIONS).map(
                      (option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ),
                    )}
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
                  className="rounded-[4px]"
                />
              )}
              <p className="text-2xs leading-4 text-muted-foreground">
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
      </PageContainer>
    </ProtectedRoute>
  );
}
