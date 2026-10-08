/**
 * ReportPanel — the chat's on-demand third zone (chat revamp SPEC §9, §10.6): the
 * conversation's draft report, edited in place while the analyst keeps chatting.
 *
 * Load it lazily (`React.lazy(() => import('@/soc/chat/report/ReportPanel'))`). It renders
 * CONTENT only: the host (the chat workspace) provides the split column or the overlay
 * Sheet and returns focus on close. In `overlay` mode the panel moves focus to its
 * heading on open; in `split` mode it never moves focus (SPEC §10.9).
 *
 * One scroll region, no tabs:
 *   header   editable title · template · n/40 · ⋯ (Open in Reports library, Export ▸,
 *            Delete) · close
 *   summary  "Generate summary · ≈ N tokens · ≈ $X" from the server's dry run; then the
 *            AI-written text, next steps, "AI-generated; verify before acting" and
 *            "Out of date — Regenerate" once `based_on_version` lags the report version
 *   items    collapsed cards (expand to see the snapshot, rendered by the lazy answer
 *            blocks), each with a note that autosaves 800 ms after typing stops, and an
 *            item menu: Move up / Move down / Move to top / Remove (moves are announced)
 *
 * Every write sends the report's `expected_version` (strict CAS). A 409 shows "This
 * report changed elsewhere — Reload" and never discards what the analyst typed. Writes
 * are serialised, so a fast sequence of edits always carries the latest version.
 * Every string shown is a React text node (G1); snapshots are re-validated with
 * `parseBlocks` before they render.
 */
import * as React from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import type { Report, ReportPatchRequest, ReportSummaryEstimate, ReportTemplateName } from '@/lib/types';
import { LoadingState } from '@/design-system';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { IconButton } from '@/soc/components/IconButton';
import { useAnnouncer } from '@/soc/components/announcer';
import { useAuth } from '@/soc/auth';
import { useNavigateOptional } from '@/soc/router';

import { ChatMarkdown } from '../ChatMarkdown';
import { deleteReport, estimateReportSummary, generateReportSummary, getReport, patchReport } from '../chat-api';
import { displayText } from '../stream-events';
import { formatUtc } from '../blocks/format';
import { ExportMenuItems, useDefangPreference } from './ExportMenu';
import { ItemBlocks } from './ItemBlocks';
import { BLOCK_TYPE_LABEL, TEMPLATE_LABEL, TEMPLATE_ORDER, itemBlocks, tokens, usd } from './model';
import {
  MAX_REPORT_ITEMS,
  REPORT_CONFLICT_MESSAGE,
  REPORT_FULL_MESSAGE,
  emitReportChanged,
  isVersionConflict,
  onReportChanged,
  reportErrorMessage,
} from './report-sync';
import { loadSourceContext, sourceConversationIds } from './useSourceTurns';
import type { ReportExportFormat } from './export/run';

export interface ReportPanelProps {
  /** The conversation whose draft this is (null for a new, unsaved chat). */
  conversationId: string | null;
  /** The report to show; null until the first "Add to report" creates the draft. */
  reportId: string | null;
  /** `split` = a docked column (never moves focus); `overlay` = inside a Sheet. */
  mode: 'split' | 'overlay';
  onClose(): void;
  /** The item count after every load and change (the toolbar's "Report · n"). */
  onCountChange?(n: number): void;
}

/** Autosave delay after the last keystroke in a note (SPEC §10.6). */
export const NOTE_AUTOSAVE_MS = 800;
const NOTE_LIMIT = 500;
const PANEL_ORIGIN = 'report-panel';
const MENU_TRIGGER = cn(
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
  focusRing,
);

type NoteState = 'saving' | 'saved' | 'unsaved' | 'error';

function newKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function ReportPanel({ conversationId, reportId, mode, onClose, onCountChange }: ReportPanelProps) {
  const announce = useAnnouncer();
  const navigate = useNavigateOptional();
  const { username } = useAuth();
  const rawId = React.useId();
  const ids = React.useMemo(() => {
    const base = `report-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    return { heading: `${base}-h`, summary: `${base}-s`, items: `${base}-i` };
  }, [rawId]);

  const [report, setReport] = React.useState<Report | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [noteState, setNoteState] = React.useState<Record<string, NoteState>>({});
  const [editingTitle, setEditingTitle] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [estimate, setEstimate] = React.useState<ReportSummaryEstimate | null>(null);
  const [summaryBusy, setSummaryBusy] = React.useState(false);
  const [summaryError, setSummaryError] = React.useState<string | null>(null);
  const [defang, setDefang] = useDefangPreference();

  const reportRef = React.useRef<Report | null>(null);
  reportRef.current = report;
  const draftsRef = React.useRef(drafts);
  draftsRef.current = drafts;
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const summaryKey = React.useRef<{ version: number; key: string } | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    // Re-armed on (StrictMode) remount; late responses after unmount are ignored.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One announcement per conflict (SPEC §10.9: the shell announcer, no local live region).
  React.useEffect(() => {
    if (conflict) announce('This report changed elsewhere. Reload to continue editing.');
  }, [conflict, announce]);
  React.useEffect(() => {
    if (actionError) announce(actionError);
  }, [actionError, announce]);

  /* ------------------------------------------------------------ loading -- */
  const load = React.useCallback(
    async (id: string | null, signal?: AbortSignal) => {
      if (!id) {
        setReport(null);
        setLoadError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const fresh = await getReport(id, signal);
        if (!alive.current || signal?.aborted) return;
        setReport(fresh);
        setConflict(false);
      } catch (err) {
        if (!alive.current || signal?.aborted) return;
        setLoadError(reportErrorMessage(err, 'The report could not be loaded.'));
      } finally {
        if (alive.current && !signal?.aborted) setLoading(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    // Another report (the host switched conversation): start from a clean slate.
    setDrafts({});
    setNoteState({});
    setExpanded(new Set());
    setConflict(false);
    setActionError(null);
    setSummaryError(null);
    setEditingTitle(null);
    const controller = new AbortController();
    void load(reportId, controller.signal);
    return () => controller.abort();
  }, [reportId, load]);

  // Another surface (the transcript's Add to report, the library, another panel) changed it.
  React.useEffect(
    () =>
      onReportChanged((detail) => {
        if (detail.origin === PANEL_ORIGIN) return;
        const current = reportRef.current?.id ?? reportId;
        const mine =
          (current && detail.reportId === current) ||
          (!current && conversationId && detail.conversationId === conversationId);
        if (!mine) return;
        if (detail.report === null) {
          setReport(null);
          return;
        }
        if (detail.report && detail.report.id) {
          const next = detail.report;
          // Never step back to an older copy than the one on screen.
          setReport((prev) => (prev && prev.id === next.id && prev.version > next.version ? prev : next));
          setConflict(false);
          return;
        }
        if (current) void load(current);
      }),
    [conversationId, reportId, load],
  );

  const count = report?.items.length ?? 0;
  React.useEffect(() => {
    onCountChange?.(count);
  }, [count, onCountChange]);

  // Overlay: the Sheet opened on purpose, so its heading takes focus (split never moves it).
  React.useEffect(() => {
    if (mode === 'overlay') headingRef.current?.focus({ preventScroll: true });
  }, [mode]);

  /* ---------------------------------------------------------- mutations -- */
  /**
   * Apply one PATCH with the latest version. Serialised: each write waits for the one
   * before it, so it always sends the version the previous write returned.
   */
  const mutate = React.useCallback(
    (body: Omit<ReportPatchRequest, 'expected_version'>): Promise<Report | 'conflict' | null> => {
      const run = async (): Promise<Report | 'conflict' | null> => {
        const current = reportRef.current;
        if (!current) return null;
        try {
          const next = await patchReport(current.id, { ...body, expected_version: current.version });
          reportRef.current = next;
          if (alive.current) {
            setReport(next);
            setActionError(null);
          }
          emitReportChanged({ reportId: next.id, conversationId: next.conversation_id ?? conversationId, report: next, origin: PANEL_ORIGIN });
          return next;
        } catch (err) {
          if (isVersionConflict(err)) {
            if (alive.current) setConflict(true);
            return 'conflict';
          }
          if (alive.current) setActionError(reportErrorMessage(err));
          return null;
        }
      };
      const next = queue.current.then(run, run);
      queue.current = next;
      return next;
    },
    [conversationId],
  );

  const reload = React.useCallback(async () => {
    const id = reportRef.current?.id ?? reportId;
    await load(id);
    // A note the analyst typed survives the reload; it is now explicitly unsaved.
    setNoteState((prev) => {
      const next: Record<string, NoteState> = {};
      for (const [k, v] of Object.entries(prev)) next[k] = v === 'saving' || v === 'error' ? 'unsaved' : v;
      for (const k of Object.keys(draftsRef.current)) next[k] = 'unsaved';
      return next;
    });
    announce('Report reloaded');
  }, [announce, load, reportId]);

  /* -------------------------------------------------------------- notes -- */
  const saveNote = React.useCallback(
    async (itemId: string) => {
      timers.current.delete(itemId);
      const text = draftsRef.current[itemId];
      const item = reportRef.current?.items.find((i) => i.id === itemId);
      if (text === undefined || !item) return;
      if (text === (item.note ?? '')) {
        setDrafts(({ [itemId]: _drop, ...rest }) => rest);
        return;
      }
      setNoteState((s) => ({ ...s, [itemId]: 'saving' }));
      const result = await mutate({ notes: { [itemId]: text.trim() ? text : null } });
      if (!alive.current) return;
      if (result && result !== 'conflict') {
        // Keep anything typed while the save was in flight.
        setDrafts((d) => {
          if (d[itemId] !== text) return d;
          const { [itemId]: _done, ...rest } = d;
          return rest;
        });
        setNoteState((s) => ({ ...s, [itemId]: 'saved' }));
      } else {
        setNoteState((s) => ({ ...s, [itemId]: result === 'conflict' ? 'unsaved' : 'error' }));
      }
    },
    [mutate],
  );

  const onNoteChange = (itemId: string, value: string) => {
    const text = value.slice(0, NOTE_LIMIT);
    setDrafts((d) => ({ ...d, [itemId]: text }));
    setNoteState((s) => ({ ...s, [itemId]: 'unsaved' }));
    const pending = timers.current.get(itemId);
    if (pending) clearTimeout(pending);
    // Never write while the report is known to be stale: the analyst reloads first.
    if (conflict) return;
    timers.current.set(
      itemId,
      setTimeout(() => void saveNote(itemId), NOTE_AUTOSAVE_MS),
    );
  };

  // Leaving the panel, or switching to another report, flushes a pending note instead of
  // dropping it (the save still targets the report the note was typed into).
  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const [itemId, timer] of pending) {
        clearTimeout(timer);
        void saveNote(itemId);
      }
      pending.clear();
    };
  }, [reportId, saveNote]);

  /* -------------------------------------------------------- item actions -- */
  const move = async (itemId: string, to: 'up' | 'down' | 'top') => {
    const current = reportRef.current;
    if (!current) return;
    const order = current.items.map((i) => i.id);
    const from = order.indexOf(itemId);
    if (from < 0) return;
    const target = to === 'top' ? 0 : to === 'up' ? from - 1 : from + 1;
    if (target < 0 || target >= order.length || target === from) return;
    order.splice(from, 1);
    order.splice(target, 0, itemId);
    const title = itemBlocks(current.items[from]).title;
    const result = await mutate({ item_order: order });
    if (result && result !== 'conflict') announce(`Moved ${title} to position ${target + 1} of ${order.length}`);
  };

  const remove = async (itemId: string) => {
    const current = reportRef.current;
    const item = current?.items.find((i) => i.id === itemId);
    if (!current || !item) return;
    const result = await mutate({ remove_items: [itemId] });
    if (result && result !== 'conflict') {
      const n = result.items.length;
      announce(`Removed from report (${n} ${n === 1 ? 'item' : 'items'})`);
      setDrafts(({ [itemId]: _gone, ...rest }) => rest);
    }
  };

  const commitTitle = async () => {
    const title = displayText(editingTitle ?? '', 120);
    setEditingTitle(null);
    if (!title || title === reportRef.current?.title) return;
    const result = await mutate({ title });
    if (result && result !== 'conflict') announce('Report renamed');
  };

  const setTemplate = async (template: ReportTemplateName) => {
    if (template === reportRef.current?.template) return;
    const result = await mutate({ template });
    if (result && result !== 'conflict') announce(`Template set to ${TEMPLATE_LABEL[template]}`);
  };

  const doDelete = async () => {
    const current = reportRef.current;
    if (!current) return;
    try {
      await deleteReport(current.id, current.version);
      setReport(null);
      reportRef.current = null;
      emitReportChanged({ reportId: current.id, conversationId: current.conversation_id ?? conversationId, report: null, origin: PANEL_ORIGIN });
      announce('Report deleted');
    } catch (err) {
      if (isVersionConflict(err)) setConflict(true);
      else setActionError(reportErrorMessage(err, 'The report could not be deleted.'));
    }
  };

  const doExport = async (format: ReportExportFormat, defangOn: boolean) => {
    const current = reportRef.current;
    if (!current) return;
    // The methodology needs the source turns' recorded steps; read them only on export.
    const [{ exportReport }, sources] = await Promise.all([
      import('./export/run'),
      format === 'json' ? null : loadSourceContext(sourceConversationIds(current)),
    ]);
    const outcome = await exportReport(current, format, {
      defang: defangOn,
      author: username,
      sourceTurns: sources?.turns ?? null,
      conversationTitles: sources?.titles ?? null,
    });
    announce(outcome.message);
    if (!outcome.ok) setActionError(outcome.message);
  };

  /* ------------------------------------------------------------ summary -- */
  const version = report?.version ?? null;
  const summary = report?.summary ?? null;
  const stale = summary !== null && version !== null && summary.based_on_version < version;
  const wantsEstimate = report !== null && count > 0 && (summary === null || stale);

  const currentId = report?.id ?? null;
  React.useEffect(() => {
    if (!wantsEstimate || !currentId) {
      setEstimate(null);
      return undefined;
    }
    const controller = new AbortController();
    estimateReportSummary(currentId, controller.signal)
      .then((e) => {
        if (!controller.signal.aborted) setEstimate(e);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEstimate(null);
      });
    return () => controller.abort();
    // The estimate depends on the content, which the version tracks.
  }, [wantsEstimate, currentId, version]);

  const generate = async () => {
    const current = reportRef.current;
    if (!current || summaryBusy) return;
    // One key per report version: a retry after a lost response replays, never re-bills.
    if (!summaryKey.current || summaryKey.current.version !== current.version) {
      summaryKey.current = { version: current.version, key: newKey() };
    }
    setSummaryBusy(true);
    setSummaryError(null);
    announce('Writing the summary');
    try {
      const result = await generateReportSummary(current.id, {
        idempotencyKey: summaryKey.current.key,
        expectedVersion: current.version,
      });
      if (!alive.current) return;
      const next = result.report ?? (result.summary ? { ...current, summary: result.summary } : null);
      if (next) {
        reportRef.current = next;
        setReport(next);
        emitReportChanged({ reportId: next.id, conversationId: next.conversation_id ?? conversationId, report: next, origin: PANEL_ORIGIN });
      }
      announce('Summary ready');
    } catch (err) {
      if (!alive.current) return;
      if (isVersionConflict(err)) setConflict(true);
      else {
        const message = reportErrorMessage(err, 'The summary could not be written. Try again.');
        setSummaryError(message);
        announce(message);
      }
    } finally {
      if (alive.current) setSummaryBusy(false);
    }
  };

  const estimateLabel = (() => {
    const parts = [stale ? 'Regenerate' : 'Generate summary'];
    if (estimate && estimate.total_tokens > 0) parts.push(`≈ ${tokens(estimate.total_tokens)} tokens`);
    if (estimate && typeof estimate.cost === 'number') parts.push(`≈ ${usd(estimate.cost)}${estimate.simulated ? ' simulated' : ''}`);
    return parts.join(' · ');
  })();

  /* ------------------------------------------------------------- render -- */
  const title = report?.title ?? 'Report';
  const full = count >= MAX_REPORT_ITEMS;

  const header = (
    <div className="flex items-start gap-1 border-b border-border px-3 pb-2 pt-3">
      <div className="min-w-0 flex-1">
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Report</p>
        <h2 ref={headingRef} id={ids.heading} tabIndex={-1} className="min-w-0 text-sm font-semibold text-foreground focus:outline-none">
          {editingTitle !== null ? (
            <Input
              aria-label="Report title"
              value={editingTitle}
              maxLength={120}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the operator just chose Rename; the field is the target
              autoFocus
              className="h-7 text-sm"
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitTitle();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditingTitle(null);
                }
              }}
            />
          ) : report ? (
            <button
              type="button"
              className={cn('block max-w-full truncate rounded-sm text-left hover:underline', focusRing)}
              title={`${title} — click to rename`}
              aria-label={`${title}, rename report`}
              onClick={() => setEditingTitle(title)}
            >
              {title}
            </button>
          ) : (
            <span>Report</span>
          )}
        </h2>
        {report ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Select value={report.template} onValueChange={(v) => void setTemplate(v as ReportTemplateName)}>
              <SelectTrigger className="h-7 w-auto min-w-[8.5rem] gap-1 px-2 text-xs" aria-label="Report template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TEMPLATE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="tabular-nums" data-testid="report-count">
              {count}/{MAX_REPORT_ITEMS}
            </span>
            {full ? <span className="text-warning-text">{REPORT_FULL_MESSAGE}</span> : null}
          </div>
        ) : null}
      </div>
      {report ? (
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Report actions" className={MENU_TRIGGER} data-testid="report-menu-trigger">
            <MoreHorizontal className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => navigate('reports', { reportId: report.id })}>
              <ExternalLink className="size-3.5" aria-hidden />
              Open in Reports library
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Download className="size-3.5" aria-hidden />
                Export
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <ExportMenuItems onExport={(f, d) => void doExport(f, d)} defang={defang} onDefangChange={setDefang} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-critical-text focus:text-critical-text" onSelect={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" aria-hidden />
              Delete report
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <IconButton label="Close report panel" onClick={onClose}>
        <X aria-hidden />
      </IconButton>
    </div>
  );

  let body: React.ReactNode;
  if (loading && !report) {
    body = <LoadingState label="Loading report" layout="panel" />;
  } else if (loadError && !report) {
    body = (
      <div className="space-y-2 px-3 py-4 text-sm">
        <p className="text-muted-foreground">{loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void load(reportId)}>
          <RefreshCw aria-hidden /> Try again
        </Button>
      </div>
    );
  } else if (!report) {
    body = (
      <div className="space-y-2 px-3 py-6 text-sm" data-testid="report-empty">
        <FileText className="size-5 text-muted-foreground" aria-hidden />
        <p className="font-medium text-foreground">No report yet</p>
        <p className="text-muted-foreground">
          {conversationId
            ? 'Use Add to report on an answer or a block. The first one starts this conversation’s report.'
            : 'Ask a question first; answers you add to the report collect here.'}
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-5 px-3 py-3">
        {/* ---- Summary ---- */}
        <section aria-labelledby={ids.summary} className="space-y-2">
          <h3 id={ids.summary} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Summary
          </h3>
          {summary ? (
            <div className="space-y-2 rounded-md border border-border bg-surface px-3 py-2" data-testid="report-summary">
              <p className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Sparkles className="size-3" aria-hidden />
                AI-written summary
              </p>
              <ChatMarkdown text={summary.executive_summary} headingBase={3} className="text-sm" />
              {summary.next_steps.length ? (
                <div>
                  <p className="text-xs font-semibold text-foreground">Next steps</p>
                  <ol className="list-decimal space-y-0.5 pl-5 text-sm marker:text-muted-foreground">
                    {summary.next_steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                AI-generated; verify before acting · {formatUtc(summary.generated_at)}
                {summary.model ? ` · ${summary.model}` : ''}
              </p>
              {stale ? (
                <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="report-summary-stale">
                  <span className="font-medium text-warning-text">Out of date</span>
                  <span className="text-muted-foreground">— the report changed after this summary was written.</span>
                  <Button variant="outline" size="sm" className="h-7" disabled={summaryBusy} onClick={() => void generate()}>
                    <RefreshCw aria-hidden className={cn(summaryBusy && 'animate-spin motion-reduce:animate-none')} />
                    {estimateLabel}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 max-w-full justify-start"
              disabled={summaryBusy || count === 0}
              onClick={() => void generate()}
              data-testid="report-generate-summary"
            >
              <Sparkles aria-hidden />
              <span className="truncate">{summaryBusy ? 'Writing the summary…' : estimateLabel}</span>
            </Button>
          )}
          {count === 0 ? <p className="text-xs text-muted-foreground">Add items before generating a summary.</p> : null}
          {summaryError ? (
            <p className="text-xs text-critical-text">
              {summaryError}
            </p>
          ) : null}
        </section>

        {/* ---- Items ---- */}
        <section aria-labelledby={ids.items} className="space-y-2">
          <h3 id={ids.items} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Items
          </h3>
          {count === 0 ? (
            <p className="text-sm text-muted-foreground">This report is empty. Use Add to report in the conversation.</p>
          ) : (
            <ol className="space-y-2">
              {report.items.map((item, index) => {
                const parsed = itemBlocks(item);
                const open = expanded.has(item.id);
                const bodyId = `${ids.items}-${index}`;
                const note = drafts[item.id] ?? item.note ?? '';
                const state = noteState[item.id];
                const kindLabel = item.kind === 'section' ? 'Answer' : BLOCK_TYPE_LABEL[parsed.blocks[0]?.type ?? 'markdown'];
                return (
                  <li key={item.id} className="rounded-lg border border-border/70 bg-card" data-report-item={item.id}>
                    <div className="flex items-start gap-1 px-2 py-1.5">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={bodyId}
                        onClick={() =>
                          setExpanded((s) => {
                            const next = new Set(s);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                        className={cn('flex min-w-0 flex-1 items-start gap-1.5 rounded-sm py-0.5 text-left', focusRing)}
                      >
                        <ChevronRight
                          className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')}
                          aria-hidden
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground" title={parsed.title}>
                            {index + 1}. {parsed.title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {kindLabel}
                            {item.scope.window ? ` · ${item.scope.window}` : ''}
                            {item.scope.sources?.length ? ` · ${item.scope.sources.join(', ')}` : ''}
                          </span>
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger aria-label={`Actions for item ${index + 1}`} className={cn(MENU_TRIGGER, 'size-6')}>
                          <MoreHorizontal className="size-3.5" aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem disabled={index === 0} onSelect={() => void move(item.id, 'up')}>
                            <ArrowUp className="size-3.5" aria-hidden />
                            Move up
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={index === count - 1} onSelect={() => void move(item.id, 'down')}>
                            <ArrowDown className="size-3.5" aria-hidden />
                            Move down
                          </DropdownMenuItem>
                          <DropdownMenuItem disabled={index === 0} onSelect={() => void move(item.id, 'top')}>
                            <ArrowUpToLine className="size-3.5" aria-hidden />
                            Move to top
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-critical-text focus:text-critical-text" onSelect={() => void remove(item.id)}>
                            <Trash2 className="size-3.5" aria-hidden />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {open ? (
                      <div id={bodyId} className="border-t border-border/60 px-2 py-2">
                        <ItemBlocks blocks={parsed.blocks} messageId={item.source.message_id} headingBase={4} compact />
                        {parsed.truncated ? (
                          <p className="mt-1 text-xs text-muted-foreground">More blocks were offered than a section holds; the first ones are shown.</p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="px-2 pb-2">
                      <Textarea
                        aria-label={`Note for item ${index + 1}`}
                        placeholder="Add a note…"
                        value={note}
                        maxLength={NOTE_LIMIT}
                        rows={note ? 2 : 1}
                        className="min-h-8 resize-y py-1.5 text-sm"
                        onChange={(e) => onNoteChange(item.id, e.target.value)}
                        onBlur={() => {
                          const pending = timers.current.get(item.id);
                          if (pending && !conflict) {
                            clearTimeout(pending);
                            void saveNote(item.id);
                          }
                        }}
                      />
                      <div className="mt-0.5 flex min-h-4 items-center justify-between gap-2 text-2xs text-muted-foreground">
                        <span>
                          {state === 'saving'
                            ? 'Saving…'
                            : state === 'saved'
                              ? 'Saved'
                              : state === 'error'
                                ? 'Not saved'
                                : state === 'unsaved' && conflict
                                  ? 'Not saved — reload first'
                                  : null}
                        </span>
                        {(state === 'unsaved' || state === 'error') && !conflict && drafts[item.id] !== undefined ? (
                          <button type="button" className={cn('rounded-sm text-primary hover:underline', focusRing)} onClick={() => void saveNote(item.id)}>
                            Save note
                          </button>
                        ) : note.length > NOTE_LIMIT - 50 ? (
                          <span className="tabular-nums">
                            {note.length}/{NOTE_LIMIT}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    );
  }

  return (
    <section
      aria-labelledby={ids.heading}
      className="flex h-full min-h-0 w-full flex-col bg-background"
      data-report-panel={mode}
      data-testid="report-panel"
    >
      {header}
      {conflict ? (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-warning/10 px-3 py-2 text-xs" data-testid="report-conflict">
          <span className="text-foreground">{REPORT_CONFLICT_MESSAGE.split(' — ')[0]}</span>
          <Button variant="outline" size="sm" className="h-7" onClick={() => void reload()}>
            <RefreshCw aria-hidden /> Reload
          </Button>
        </div>
      ) : null}
      {actionError && !conflict ? (
        <p className="border-b border-border px-3 py-1.5 text-xs text-critical-text">
          {actionError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this report?"
        description="Its items, notes and summary are removed. The conversation stays as it is."
        confirmLabel="Delete report"
        destructive
        onConfirm={() => void doDelete()}
      />
    </section>
  );
}

export default ReportPanel;
