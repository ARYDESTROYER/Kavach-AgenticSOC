/**
 * ReportsLibrary — the body of the Workspace's report library (chat revamp SPEC §10.6),
 * loaded lazily by the thin `pages/Reports.tsx` route shell (so the entry chunk lists
 * only that shell; the report modules stay out of the entry's preload table).
 *
 *   - List: every report the analyst built from chat answers — title, template, items,
 *     source conversation, last update — with search, open, rename, export and delete.
 *     Reports are never evicted; at 100 a new one is refused (the chat says so).
 *   - Document: the SAME renderer the exports use (`ReportDocument`), with the export
 *     menu and a link back to each item's source conversation
 *     (`navigate('chat', {conversationId, messageId})`). A deleted or evicted conversation
 *     reads "Conversation no longer available"; the report itself is unaffected.
 *
 * Every string is plain text (#9); report data is re-validated before it renders. Every
 * write carries the report's `expected_version`.
 */
import * as React from 'react';
import { ArrowLeft, Download, FileText, MessageSquare, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { CONSOLE_RELEASE_IDENTITY } from '@/lib/release';
import type { Report, ReportListEntry } from '@/lib/types';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
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
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { DataTable, type DataTableColumn, type SortState } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { useAnnouncer } from '@/soc/components/announcer';
import { useAuth } from '@/soc/auth';
import { useNavigateOptional } from '@/soc/router';
import { LoadingState } from '@/design-system';
import { deleteReport, getReport, listConversations, listReports, patchReport } from '../chat-api';
import { displayText } from '../stream-events';
import { formatUtc } from '../blocks/format';
import { ExportMenuItems, useDefangPreference } from './ExportMenu';
import { ReportDocument } from './ReportDocument';
import { SOURCE_UNAVAILABLE, TEMPLATE_LABEL, buildReportDoc, type DocItem } from './model';
import { emitReportChanged, isVersionConflict, onReportChanged, reportErrorMessage } from './report-sync';
import { loadReportSourceContext, useSourceTurns } from './useSourceTurns';
import type { ReportExportFormat, ReportExportOptions } from './export/run';

const MENU_TRIGGER = cn(
  'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
  focusRing,
);

const ORIGIN = 'reports-page';

/** The exporters load on first use (their own lazy chunk). */
async function runExport(report: Report, format: ReportExportFormat, defang: boolean, extra: ReportExportOptions) {
  const { exportReport } = await import('./export/run');
  return exportReport(report, format, { ...extra, defang });
}

/**
 * Every conversation's title, read once for the list's "Source conversation" column. The
 * listing holds all of a user's conversations (at most 50 plus 10 pinned), so an id it
 * lacks is gone (deleted or evicted); a shorter answer than the cap is complete.
 */
const CONVERSATION_LIST_CAP = 60;
interface ConversationIndex {
  titles: Map<string, string>;
  complete: boolean;
}

/* -------------------------------------------------------------------------- */
/* Rename dialog (list and document share it).                                 */
/* -------------------------------------------------------------------------- */

function RenameDialog({
  open,
  initial,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initial: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (title: string) => void;
}) {
  const [value, setValue] = React.useState(initial);
  React.useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const title = displayText(value, 120);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename report</DialogTitle>
          <DialogDescription>Up to 120 characters, one line.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title) onSubmit(title);
          }}
        >
          <Input aria-label="Report title" value={value} maxLength={120} onChange={(e) => setValue(e.target.value)} />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Document view.                                                              */
/* -------------------------------------------------------------------------- */

function ReportDocumentView({ reportId, onBack }: { reportId: string; onBack: () => void }) {
  const navigate = useNavigateOptional();
  const announce = useAnnouncer();
  const { username } = useAuth();
  const [report, setReport] = React.useState<Report | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const [renaming, setRenaming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [defang, setDefang] = useDefangPreference();
  const sources = useSourceTurns(report);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const fresh = await getReport(reportId, signal);
        if (signal?.aborted) return;
        setReport(fresh);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [reportId],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  React.useEffect(
    () =>
      onReportChanged((detail) => {
        if (detail.origin === ORIGIN || detail.reportId !== reportId) return;
        if (detail.report === null) setReport(null);
        else if (detail.report) setReport(detail.report);
        else void load();
      }),
    [reportId, load],
  );

  const doc = React.useMemo(
    () =>
      report
        ? buildReportDoc(report, {
            author: username,
            appVersion: CONSOLE_RELEASE_IDENTITY.version,
            // The screen view is stamped with the report's last change, so it is stable.
            generatedAt: report.updated_at || undefined,
            sourceTurns: sources.turns,
            conversationTitles: sources.titles,
            conversationStatus: sources.status,
          })
        : null,
    [report, username, sources.turns, sources.titles, sources.status],
  );

  const openSource = React.useCallback(
    (item: DocItem) => {
      navigate('chat', { conversationId: item.source.conversation_id, messageId: item.source.message_id });
    },
    [navigate],
  );

  const rename = async (title: string) => {
    if (!report) return;
    setRenaming(false);
    try {
      const next = await patchReport(report.id, { expected_version: report.version, title });
      setReport(next);
      emitReportChanged({ reportId: next.id, conversationId: next.conversation_id, report: next, origin: ORIGIN });
      announce('Report renamed');
    } catch (err) {
      setNotice(reportErrorMessage(err));
      if (isVersionConflict(err)) void load();
    }
  };

  const remove = async () => {
    if (!report) return;
    try {
      await deleteReport(report.id, report.version);
      emitReportChanged({ reportId: report.id, conversationId: report.conversation_id, report: null, origin: ORIGIN });
      announce('Report deleted');
      onBack();
    } catch (err) {
      setNotice(reportErrorMessage(err, 'The report could not be deleted.'));
      if (isVersionConflict(err)) void load();
    }
  };

  const doExport = async (format: ReportExportFormat, on: boolean) => {
    if (!report) return;
    const outcome = await runExport(report, format, on, {
      author: username,
      sourceTurns: sources.turns,
      conversationTitles: sources.titles,
      conversationStatus: sources.status,
    });
    announce(outcome.message);
    setNotice(outcome.ok ? null : outcome.message);
  };

  const back = (
    <Button variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft aria-hidden /> All reports
    </Button>
  );

  if (loading && !report) {
    return (
      <PageContainer variant="wide" className="space-y-6">
        <PageHeader icon={FileText} eyebrow="Reports" title="Report" actions={back} />
        <LoadingState label="Loading report" layout="page" />
      </PageContainer>
    );
  }
  if (!report || !doc) {
    return (
      <PageContainer variant="wide" className="space-y-6">
        <PageHeader icon={FileText} eyebrow="Reports" title="Report" actions={back} />
        {error ? (
          <LoadError error={error} title="Could not open the report" fallback={reportErrorMessage(error, 'The report could not be loaded.')} onRetry={() => void load()} />
        ) : (
          <EmptyState icon={FileText} state="unavailable" title="This report no longer exists" description="It was deleted. Other reports are in the library." />
        )}
      </PageContainer>
    );
  }

  const actions = (
    <div className="flex items-center gap-1">
      {back}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Download aria-hidden /> Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <ExportMenuItems onExport={(f, d) => void doExport(f, d)} defang={defang} onDefangChange={setDefang} />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="More report actions" className={MENU_TRIGGER}>
          <MoreHorizontal className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {report.conversation_id && !sources.unavailable.has(report.conversation_id) ? (
            <DropdownMenuItem onSelect={() => navigate('chat', { conversationId: report.conversation_id ?? undefined })}>
              <MessageSquare className="size-3.5" aria-hidden />
              Open conversation
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil className="size-3.5" aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-critical-text focus:text-critical-text" onSelect={() => setDeleting(true)}>
            <Trash2 className="size-3.5" aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={FileText}
        eyebrow="Reports"
        title={report.title}
        description={`${TEMPLATE_LABEL[report.template]} · ${report.items.length} ${report.items.length === 1 ? 'item' : 'items'} · updated ${formatUtc(report.updated_at)}`}
        actions={actions}
      />
      {notice ? <p className="text-sm text-critical-text">{notice}</p> : null}
      <div className="mx-auto w-full max-w-5xl">
        <ReportDocument
          doc={doc}
          mode="screen"
          showTitle={false}
          onOpenSource={openSource}
          unavailableConversations={sources.unavailable}
        />
      </div>
      <RenameDialog open={renaming} initial={report.title} onOpenChange={setRenaming} onSubmit={(t) => void rename(t)} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this report?"
        description="Its items, notes and summary are removed. Source conversations are not affected."
        confirmLabel="Delete report"
        destructive
        onConfirm={() => void remove()}
      />
    </PageContainer>
  );
}

/* -------------------------------------------------------------------------- */
/* List view.                                                                  */
/* -------------------------------------------------------------------------- */

function sortRows(rows: ReportListEntry[], sort: SortState): ReportListEntry[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const key = (r: ReportListEntry): string | number => {
    switch (sort.id) {
      case 'title':
        return r.title.toLowerCase();
      case 'template':
        return TEMPLATE_LABEL[r.template];
      case 'items':
        return r.item_count;
      default:
        return Date.parse(r.updated_at) || 0;
    }
  };
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return a.id.localeCompare(b.id);
  });
}

function ReportList({ onOpen }: { onOpen: (id: string) => void }) {
  const navigate = useNavigateOptional();
  const announce = useAnnouncer();
  const { username } = useAuth();
  const [rows, setRows] = React.useState<ReportListEntry[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<SortState>({ id: 'updated', dir: 'desc' });
  const [renaming, setRenaming] = React.useState<ReportListEntry | null>(null);
  const [deleting, setDeleting] = React.useState<ReportListEntry | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [defang, setDefang] = useDefangPreference();
  const [conversations, setConversations] = React.useState<ConversationIndex | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const list = await listReports(signal);
      if (!signal?.aborted) setRows(list);
    } catch (err) {
      if (!signal?.aborted) setError(err);
    }
  }, []);

  // Conversation titles for the source column; without them the column still links.
  React.useEffect(() => {
    const controller = new AbortController();
    listConversations({ limit: CONVERSATION_LIST_CAP }, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setConversations({
          titles: new Map(list.conversations.map((c) => [c.id, displayText(c.title, 120) || 'Untitled conversation'])),
          complete: list.conversations.length < CONVERSATION_LIST_CAP,
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  React.useEffect(() => onReportChanged((detail) => detail.origin !== ORIGIN && void load()), [load]);

  const visible = React.useMemo(() => {
    const term = query.trim().toLowerCase();
    const filtered = (rows ?? []).filter(
      (r) => !term || r.title.toLowerCase().includes(term) || TEMPLATE_LABEL[r.template].toLowerCase().includes(term),
    );
    return sortRows(filtered, sort);
  }, [rows, query, sort]);

  const rename = async (entry: ReportListEntry, title: string) => {
    setRenaming(null);
    try {
      const next = await patchReport(entry.id, { expected_version: entry.version, title });
      emitReportChanged({ reportId: next.id, conversationId: next.conversation_id, report: next, origin: ORIGIN });
      announce('Report renamed');
      setNotice(null);
    } catch (err) {
      setNotice(reportErrorMessage(err));
    }
    void load();
  };

  const remove = async (entry: ReportListEntry) => {
    try {
      await deleteReport(entry.id, entry.version);
      emitReportChanged({ reportId: entry.id, conversationId: entry.conversation_id, report: null, origin: ORIGIN });
      announce('Report deleted');
      setNotice(null);
    } catch (err) {
      setNotice(reportErrorMessage(err, 'The report could not be deleted.'));
    }
    void load();
  };

  const doExport = async (entry: ReportListEntry, format: ReportExportFormat, on: boolean) => {
    try {
      const report = await getReport(entry.id);
      // The same methodology as the document view: read the source turns first.
      const sources = format === 'json' ? null : await loadReportSourceContext(report);
      const outcome = await runExport(report, format, on, {
        author: username,
        sourceTurns: sources?.turns ?? null,
        conversationTitles: sources?.titles ?? null,
        conversationStatus: sources?.status ?? null,
      });
      announce(outcome.message);
      setNotice(outcome.ok ? null : outcome.message);
    } catch (err) {
      setNotice(reportErrorMessage(err, 'The report could not be exported.'));
    }
  };

  const columns: DataTableColumn<ReportListEntry>[] = [
    {
      id: 'title',
      header: 'Title',
      sortable: true,
      lockVisible: true,
      cell: (r) => (
        <button
          type="button"
          onClick={() => onOpen(r.id)}
          className={cn('max-w-full truncate rounded-sm text-left font-medium text-foreground hover:underline', focusRing)}
          title={r.title}
        >
          {r.title}
        </button>
      ),
    },
    { id: 'template', header: 'Template', sortable: true, cell: (r) => TEMPLATE_LABEL[r.template] },
    {
      id: 'items',
      header: 'Items',
      sortable: true,
      align: 'right',
      cell: (r) => <span className="tabular-nums">{r.item_count}</span>,
    },
    {
      id: 'conversation',
      header: 'Source conversation',
      cell: (r) => {
        if (!r.conversation_id) return <span className="text-muted-foreground">—</span>;
        const known = conversations?.titles.get(r.conversation_id);
        if (!known && conversations?.complete) return <span className="text-muted-foreground">{SOURCE_UNAVAILABLE}</span>;
        return (
          <button
            type="button"
            onClick={() => navigate('chat', { conversationId: r.conversation_id ?? undefined })}
            className={cn('inline-flex max-w-full items-center gap-1 rounded-sm text-primary hover:underline', focusRing)}
            aria-label={`Open the source conversation of ${r.title}${known ? `: ${known}` : ''}`}
            title={known}
          >
            <MessageSquare className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{known ?? 'Open conversation'}</span>
          </button>
        );
      },
    },
    {
      id: 'updated',
      header: 'Updated (UTC)',
      sortable: true,
      cell: (r) => <span className="tabular-nums text-muted-foreground">{formatUtc(r.updated_at)}</span>,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      menuLabel: 'Actions',
      align: 'right',
      lockVisible: true,
      cell: (r) => (
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`Actions for ${r.title}`} className={MENU_TRIGGER}>
            <MoreHorizontal className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => onOpen(r.id)}>
              <FileText className="size-3.5" aria-hidden />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRenaming(r)}>
              <Pencil className="size-3.5" aria-hidden />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Download className="size-3.5" aria-hidden />
                Export
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <ExportMenuItems onExport={(f, d) => void doExport(r, f, d)} defang={defang} onDefangChange={setDefang} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-critical-text focus:text-critical-text" onSelect={() => setDeleting(r)}>
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        icon={FileText}
        eyebrow="Workspace"
        title="Reports"
        description="Reports you built from chat answers. Open one to read it, export it or go back to the conversation it came from."
      />
      {error ? (
        <LoadError error={error} title="Could not load reports" fallback={reportErrorMessage(error, 'Reports could not be loaded.')} onRetry={() => void load()} />
      ) : rows === null ? (
        <LoadingState label="Loading reports" layout="table" shape="rows" shapeRows={5} />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                className="h-9 pl-9"
                placeholder="Search reports"
                aria-label="Search reports"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {/* The stored count against the per-user cap (a new report is refused at 100). */}
            <span className="text-xs text-muted-foreground" title="You can keep up to 100 reports.">
              <span className="tabular-nums">{rows.length}</span> {rows.length === 1 ? 'report' : 'reports'} · limit 100
            </span>
          </div>
          {notice ? <p className="text-sm text-critical-text">{notice}</p> : null}
          <DataTable
            columns={columns}
            rows={visible}
            getRowId={(r) => r.id}
            sort={sort}
            onSortChange={setSort}
            density="compact"
            ariaLabel="Reports"
            empty={
              rows.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  state="first-use"
                  compact
                  title="No reports yet"
                  description="In Chat, use Add to report on an answer or a block. Each conversation keeps a draft report."
                  action={
                    <Button variant="outline" size="sm" onClick={() => navigate('chat', { newChat: true })}>
                      Open Chat
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={Search} state="no-results" compact title="No matching reports" description="Try another search." />
              )
            }
          />
        </div>
      )}
      <RenameDialog
        open={renaming !== null}
        initial={renaming?.title ?? ''}
        onOpenChange={(o) => !o && setRenaming(null)}
        onSubmit={(t) => renaming && void rename(renaming, t)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this report?"
        description="Its items, notes and summary are removed. Source conversations are not affected."
        confirmLabel="Delete report"
        destructive
        onConfirm={() => deleting && void remove(deleting)}
      />
    </PageContainer>
  );
}

/* -------------------------------------------------------------------------- */
/* The library (list ↔ document).                                              */
/* -------------------------------------------------------------------------- */

const REPORT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ReportsLibraryProps {
  /** The report to open (`#/reports?reportId=…`, router-validated; checked again here). */
  reportId?: string | null;
}

export default function ReportsLibrary({ reportId }: ReportsLibraryProps) {
  const navigate = useNavigateOptional();
  const requested = typeof reportId === 'string' && REPORT_ID_RE.test(reportId) ? reportId : null;
  const [openId, setOpenId] = React.useState<string | null>(requested);
  React.useEffect(() => setOpenId(requested), [requested]);

  const open = React.useCallback(
    (id: string) => {
      setOpenId(id);
      navigate('reports', { reportId: id });
    },
    [navigate],
  );
  const back = React.useCallback(() => {
    setOpenId(null);
    navigate('reports');
  }, [navigate]);

  return openId ? <ReportDocumentView key={openId} reportId={openId} onBack={back} /> : <ReportList onOpen={open} />;
}
