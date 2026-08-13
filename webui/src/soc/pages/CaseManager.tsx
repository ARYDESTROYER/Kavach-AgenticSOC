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
import { humanizeAge, humanizeToken } from '@/lib/format';
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
import { SeverityBadge, StatusBadge, severityBand } from '@/soc/components/badges';
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

const SEVERITY_BAR: Record<string, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
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

function primaryFact(c: Case): string {
  const value = c.entity?.value;
  if (value) {
    const type = c.entity?.type || c.entity_type;
    return type ? `${humanizeToken(type)}: ${String(value)}` : String(value);
  }
  if (c.source_name) return c.source_name;
  return c.summary || 'No primary entity recorded';
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

const QueueRow: React.FC<{
  item: Case;
  active: boolean;
  checked: boolean;
  selectionDisabled: boolean;
  onOpen: () => void;
  onCheckedChange: (checked: boolean) => void;
}> = ({ item, active, checked, selectionDisabled, onOpen, onCheckedChange }) => {
  const severity = caseSeverity(item);
  const displayId = item.case_number || item.case_id;
  const fact = primaryFact(item);

  return (
    <div
      className={cn(
        'group relative w-full overflow-hidden rounded-[4px] border bg-card/35 text-left',
        'transition-colors hover:border-border-strong hover:bg-accent/25',
        active && 'border-primary/50 bg-primary/[0.07]',
        checked && !active && 'border-primary/35 bg-primary/[0.04]',
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-[3px] opacity-60 transition-opacity group-hover:opacity-100',
          SEVERITY_BAR[severity],
          active && 'opacity-100',
        )}
        aria-hidden
      />

      {/* The checkbox is a sibling of the row-open button, never a nested button.
          Toggling selection therefore cannot trigger case navigation. */}
      <Checkbox
        checked={checked}
        disabled={selectionDisabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        aria-label={`Select ${displayId}`}
        className="absolute left-2.5 top-2.5 z-10 rounded-[3px] bg-background"
      />

      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'block w-full px-3 py-2.5 pl-9 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        )}
      >
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="truncate font-mono text-2xs font-semibold uppercase tracking-wide text-primary">
            {displayId}
          </span>
          <SeverityBadge
            severity={severity}
            icon={false}
            className="h-5 shrink-0 rounded-[3px] px-1.5 text-2xs uppercase tracking-wide"
          />
        </span>

        <span className="mt-1.5 block truncate text-sm font-semibold text-foreground">
          {caseTitle(item)}
        </span>
        <span className="mt-1 block truncate font-mono text-2xs text-muted-foreground">
          {fact}
        </span>

        <span className="mt-2 flex min-w-0 items-center justify-between gap-2">
          <StatusBadge
            status={item.status}
            className="h-5 max-w-[72%] truncate rounded-[3px] px-1.5 text-2xs"
          />
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {humanizeAge(updatedAt(item))}
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
      <PageContainer
        variant="fluid"
        className="h-[calc(100dvh-7rem)] min-h-0 w-auto sm:-mx-2 lg:-mx-4 xl:min-h-[600px] 2xl:-mx-8"
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
            <header className="shrink-0 border-b border-border px-3 pb-2.5 pt-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-primary">
                    Case Manager
                  </p>
                  <h1 className="mt-1 text-lg font-semibold tracking-tight text-foreground">
                    {queueMode === 'active' ? 'Active Cases' : 'All Cases'}
                  </h1>
                  <p className="mt-0.5 text-xs text-muted-foreground" aria-live="polite">
                    {scopeSummary}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-[4px]"
                  onClick={() => void loadCases()}
                  disabled={loading}
                  aria-label="Refresh case queue"
                >
                  <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                </Button>
              </div>

              <SegmentedControl<QueueMode>
                aria-label="Case queue scope"
                size="sm"
                fitted
                className="mt-2.5"
                value={queueMode}
                onValueChange={setQueueMode}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'all', label: 'All' },
                ]}
              />
            </header>

            <div className="shrink-0 space-y-1.5 border-b border-border p-2.5">
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
                    <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
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
            </div>

            <div
              role="region"
              aria-label="Case selection and bulk actions"
              aria-busy={bulkBusy}
              className="shrink-0 border-b border-border bg-card/25 px-2.5 py-1.5"
            >
              <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1.5">
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
                    'cursor-pointer text-xs font-medium text-foreground',
                    (bulkBusy || visibleCases.length === 0) && 'cursor-not-allowed opacity-50',
                  )}
                >
                  Select visible
                </label>
                <span className="text-2xs tabular-nums text-muted-foreground" aria-live="polite">
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
                <div className="space-y-1.5 p-2.5" role="list" aria-label="Cases">
                  {visibleCases.map((item) => (
                    <div role="listitem" key={item.case_id}>
                      <QueueRow
                        item={item}
                        active={selectedCaseId === item.case_id}
                        checked={selectedCaseIds.has(item.case_id)}
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
