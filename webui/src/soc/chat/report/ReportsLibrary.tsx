/**
 * ReportsLibrary: the body of the Workspace's report library (chat revamp SPEC §10.6),
 * loaded lazily by the thin `pages/Reports.tsx` route shell (so the entry chunk lists
 * only that shell; the report modules stay out of the entry's preload table).
 *
 *   - List: every report the analyst built from chat answers (title, template, items,
 *     source conversation, last update) with search, open, rename, export and delete,
 *     on one "Saved reports" panel (Round 14, SPEC §4.9.1). Reports are never evicted;
 *     at 100 a new one is refused (the chat says so), and the panel says so only then.
 *   - Document: the SAME renderer the exports use (`ReportDocument`), with a visible
 *     "Download PDF", the flat Export menu and a link back to each item's source
 *     conversation (`navigate('chat', {conversationId, messageId})`). A deleted or
 *     evicted conversation reads "Conversation no longer available"; the report itself
 *     is unaffected. Ctrl/Cmd+P on this page prints the REPORT (a `beforeprint` listener
 *     mounts the same print root synchronously), never the console around it.
 *
 * Exports run through one guarded runner (`useReportExport`): progress on the button,
 * one file per pick, a toast with the file name, and an inline error with Retry.
 *
 * Round 14 (SPEC §4.9.3): both views use the Overview's page header. The list is titled
 * "Reports" with its explanation in the help tip; the document is titled by the report,
 * with an "All reports" link above the title and its item count beside it in the controls
 * slot, so it is always visible. The template and last update are stated once, in the
 * document's own meta row right under the header (the same row its exports carry), never
 * repeated beside the title. No icon, overline or description line.
 *
 * The list's columns declare their widths (SPEC §4.9.2), so the table keeps a fixed
 * layout: a search that leaves only short titles never moves the columns, and a narrow
 * screen scrolls sideways behind the right-edge fade with the title held in view. The
 * whole row opens the report by pointer; the title button is its named keyboard action.
 *
 * Every string is plain text (#9); report data is re-validated before it renders. Every
 * write carries the report's `expected_version`.
 */
import * as React from 'react';
import { FileText, MessageSquare, MoreHorizontal, Pencil, Search, Trash2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, fmtNumber } from '@/lib/format';
import { focusRing } from '@/lib/ui-recipes';
import { CONSOLE_RELEASE_IDENTITY } from '@/lib/release';
import { exportFileStem } from '@/lib/download';
import type { Report, ReportListEntry } from '@/lib/types';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { LoadingState, PANEL_PADDING_X, Panel } from '@/design-system';
import { deleteReport, getReport, listConversations, listReports, patchReport } from '../chat-api';
import { displayText } from '../stream-events';
import { formatUtc } from '../blocks/format';
import { DownloadPdfButton, ExportErrorNote, ExportMenu, useDefangPreference } from './ExportMenu';
import { ReportDocument } from './ReportDocument';
import { SOURCE_UNAVAILABLE, TEMPLATE_LABEL, buildReportDoc, type DocItem, type ReportDoc } from './model';
import { emitReportChanged, isVersionConflict, onReportChanged, reportErrorMessage } from './report-sync';
import { useSourceTurns } from './useSourceTurns';
import { useReportExport } from './useReportExport';
import type { ReportExportFormat } from './export/formats';
import { SCREEN_DOC_ID, screenPrintCss } from './print-fallback';

const MENU_TRIGGER = cn(
  'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground',
  focusRing,
);

const ORIGIN = 'reports-page';

/**
 * The page's explanation, shown in the help tip beside the title. The same words as the
 * route shell's `REPORTS_HELP` (`pages/Reports.tsx`), which shows while this body loads.
 */
export const REPORTS_LIBRARY_HELP =
  'Reports you built from chat answers. Open one to read it, export it or go back to the conversation it came from.';

/** The per-user report cap (the server refuses a new report at this count). */
export const REPORT_LIMIT = 100;

/** The link above a report's title, back to the list it was opened from (SPEC §4.9.3). */
const BACK_TO_LIBRARY = { label: 'All reports', href: '#/reports' } as const;

/**
 * "6 items": the one fact beside the report's title. The document's meta row right under
 * the header already states the template and the last update ("Updated … · Template:
 * Investigation"), so the header never repeats them.
 */
export function reportFacts(report: Pick<Report, 'items'>): string {
  const count = report.items.length;
  return `${fmtNumber(count)} ${count === 1 ? 'item' : 'items'}`;
}


type PrintModule = typeof import('./export/print');
type BlockCardComponent = import('./export/print').BlockCardComponent;
type BlockCardModule = typeof import('../blocks/BlockCard');

/**
 * Ctrl/Cmd+P on the document view (R12): the browser prints whatever is on screen —
 * the console chrome, dark, cropped to the scroll container. While this view is open a
 * `beforeprint` listener mounts the report's print root SYNCHRONOUSLY (the print code
 * and the static block renderer are preloaded on mount), so the dialog shows the
 * report itself. A print our own Download PDF started is left alone.
 */
function usePrintShortcut(buildDoc: () => ReportDoc | null, defang: boolean) {
  const modules = React.useRef<{ print: PrintModule; blocks: BlockCardModule } | null>(null);
  const build = React.useRef(buildDoc);
  build.current = buildDoc;
  const options = React.useRef({ defang });
  options.current = { defang };
  React.useEffect(() => {
    let alive = true;
    Promise.all([import('./export/print'), import('../blocks/BlockCard')])
      .then(([print, blocks]) => {
        if (alive) modules.current = { print, blocks };
      })
      .catch(() => undefined);
    let cleanup: (() => void) | null = null;
    const before = () => {
      const loaded = modules.current;
      if (!loaded || loaded.print.printRootMounted()) return;
      const doc = build.current();
      if (!doc) return;
      try {
        cleanup = loaded.print.mountPrintRoot(doc, loaded.blocks.BlockCard as BlockCardComponent, {
          defang: options.current.defang,
          // The dialog suggests `<title>.pdf`: the export file name, stamped now.
          documentTitle: exportFileStem('report', doc.title),
        });
      } catch {
        cleanup = null;
      }
    };
    window.addEventListener('beforeprint', before);
    return () => {
      alive = false;
      window.removeEventListener('beforeprint', before);
      cleanup?.();
    };
  }, []);
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
  const exports = useReportExport({ author: username });
  // Focus returns to the control that started an export when its error note goes away.
  const pdfRef = React.useRef<HTMLButtonElement>(null);
  const exportRef = React.useRef<HTMLButtonElement>(null);

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

  // The export reads the same source context the view loaded (cached per version), and
  // waits for it when the view is still reading — never an incomplete methodology.
  const doExport = (format: ReportExportFormat, on: boolean) => {
    if (!report) return;
    setNotice(null);
    void exports.run(report.id, report, format, on);
  };

  // Ctrl/Cmd+P prints the report (an export-time document: generated now, not "updated").
  usePrintShortcut(
    () =>
      report
        ? buildReportDoc(report, {
            author: username,
            appVersion: CONSOLE_RELEASE_IDENTITY.version,
            sourceTurns: sources.turns,
            conversationTitles: sources.titles,
            conversationStatus: sources.status,
          })
        : null,
    defang,
  );

  if (loading && !report) {
    return (
      <PageContainer variant="wide">
        <PageHeader title="Report" back={BACK_TO_LIBRARY} />
        <LoadingState label="Loading report" layout="page" />
      </PageContainer>
    );
  }
  if (!report || !doc) {
    return (
      <PageContainer variant="wide">
        <PageHeader title="Report" back={BACK_TO_LIBRARY} />
        {error ? (
          <LoadError error={error} title="Could not open the report" fallback={reportErrorMessage(error, 'The report could not be loaded.')} onRetry={() => void load()} />
        ) : (
          <EmptyState icon={FileText} state="unavailable" title="This report no longer exists" description="It was deleted. Other reports are in the library." />
        )}
      </PageContainer>
    );
  }

  const busy = exports.exporting(report.id);
  const actions = (
    <div className="flex flex-wrap items-center gap-1">
      <DownloadPdfButton buttonRef={pdfRef} busy={busy} onClick={() => doExport('print', defang)} />
      <ExportMenu
        triggerRef={exportRef}
        busy={busy}
        onOpen={() => exports.warm(report)}
        onExport={doExport}
        defang={defang}
        onDefangChange={setDefang}
        testId="report-export-trigger"
      />
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
    <PageContainer variant="wide">
      <PageHeader
        title={report.title}
        back={BACK_TO_LIBRARY}
        controls={
          <span className="text-sm tabular-nums text-muted-foreground" data-testid="report-facts">
            {reportFacts(report)}
          </span>
        }
        actions={actions}
      />
      {notice ? <p className="text-sm text-critical-text">{notice}</p> : null}
      {exports.error && exports.error.reportId === report.id ? (
        <ExportErrorNote
          error={exports.error}
          onRetry={exports.retry}
          onDismiss={exports.dismissError}
          returnFocus={() => (exports.error?.format === 'print' ? pdfRef.current : exportRef.current)}
        />
      ) : null}
      {/* Ctrl/Cmd+P fallback: prints this document, never the console (R12). */}
      <style>{screenPrintCss()}</style>
      <div className="mx-auto w-full max-w-5xl" id={SCREEN_DOC_ID}>
        {/* The page header is not printed by the fallback: paper keeps the title (a copy
            of the page heading, so it is hidden from assistive technology). */}
        <p aria-hidden="true" className="hidden pb-2 text-xl font-semibold text-foreground print:block" data-testid="report-print-title">
          {report.title}
        </p>
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
  const exports = useReportExport({ author: username });
  // Each row's Export trigger: focus returns there when its error note goes away.
  const triggers = React.useRef(new Map<string, HTMLButtonElement>());

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

  // The row holds a summary: read the report first, then the same methodology as the
  // document view (the source context is cached per report version).
  const doExport = (entry: ReportListEntry, format: ReportExportFormat, on: boolean) => {
    setNotice(null);
    void exports.run(entry.id, () => getReport(entry.id), format, on, { title: entry.title });
  };

  // Declared widths keep the table in a fixed layout (SPEC §4.9.2): the title takes the
  // spare width, every other column holds its own, so filtering never moves a column.
  const columns: DataTableColumn<ReportListEntry>[] = [
    {
      id: 'title',
      header: 'Title',
      sortable: true,
      lockVisible: true,
      minWidth: '12rem',
      cell: (r) => (
        <button
          type="button"
          onClick={() => onOpen(r.id)}
          // The row's named action: a 44px target on a phone (SPEC §3.3), the row's own
          // height from `sm` up. The fixed column caps it, so it truncates in place.
          className={cn(
            'block min-h-11 max-w-full truncate rounded-sm py-2 text-left font-medium text-foreground hover:underline sm:min-h-0 sm:py-0',
            focusRing,
          )}
          title={r.title}
        >
          {r.title}
        </button>
      ),
    },
    { id: 'template', header: 'Template', sortable: true, width: '10rem', cell: (r) => TEMPLATE_LABEL[r.template] },
    {
      id: 'items',
      header: 'Items',
      sortable: true,
      align: 'right',
      width: '6rem',
      cell: (r) => <span className="tabular-nums">{fmtNumber(r.item_count)}</span>,
    },
    {
      id: 'conversation',
      header: 'Source conversation',
      width: '14rem',
      cell: (r) => {
        // A draft's own conversation, else the one its items came from (a report saved
        // from an answer or a whole conversation is not that conversation's draft).
        const sourceId = r.conversation_id ?? r.source_conversation_id ?? null;
        if (!sourceId) return <span className="text-muted-foreground">{DASH}</span>;
        const known = conversations?.titles.get(sourceId);
        if (!known && conversations?.complete) return <span className="text-muted-foreground">{SOURCE_UNAVAILABLE}</span>;
        // A report started from a conversation is titled after it: never print the same
        // sentence twice side by side; the link (and its accessible name) still names it.
        const label = !known || known === r.title ? 'Open conversation' : known;
        return (
          <button
            type="button"
            onClick={() => navigate('chat', { conversationId: sourceId })}
            className={cn('inline-flex max-w-full items-center gap-1 rounded-sm text-primary hover:underline', focusRing)}
            aria-label={`Open the source conversation of ${r.title}${known ? `: ${known}` : ''}`}
            title={known}
          >
            <MessageSquare className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
          </button>
        );
      },
    },
    {
      id: 'updated',
      header: 'Updated (UTC)',
      sortable: true,
      width: '13rem',
      className: 'whitespace-nowrap',
      headerClassName: 'whitespace-nowrap',
      cell: (r) => <span className="tabular-nums text-muted-foreground">{formatUtc(r.updated_at)}</span>,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      menuLabel: 'Actions',
      align: 'right',
      lockVisible: true,
      // Two 32px icon buttons and the panel's trailing inset.
      width: '7rem',
      cell: (r) => (
        <div className="flex items-center justify-end gap-0.5">
        <ExportMenu
          triggerRef={(el) => {
            if (el) triggers.current.set(r.id, el);
            else triggers.current.delete(r.id);
          }}
          variant="icon"
          label={`Export ${r.title}`}
          busy={exports.exporting(r.id)}
          onOpen={() => exports.warm(null)}
          onExport={(f, d) => doExport(r, f, d)}
          defang={defang}
          onDefangChange={setDefang}
        />
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
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-critical-text focus:text-critical-text" onSelect={() => setDeleting(r)}>
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      ),
    },
  ];

  const filtered = query.trim().length > 0;
  const atLimit = (rows?.length ?? 0) >= REPORT_LIMIT;
  const firstUse = rows !== null && rows.length === 0;

  return (
    <PageContainer variant="wide">
      <PageHeader title="Reports" help={REPORTS_LIBRARY_HELP} />
      {notice ? <p className="text-sm text-critical-text">{notice}</p> : null}
      {exports.error ? (
        <ExportErrorNote
          error={exports.error}
          onRetry={exports.retry}
          onDismiss={exports.dismissError}
          showTitle
          returnFocus={() => (exports.error ? triggers.current.get(exports.error.reportId) : null)}
        />
      ) : null}
      {error ? (
        <LoadError error={error} title="Could not load reports" fallback={reportErrorMessage(error, 'Reports could not be loaded.')} onRetry={() => void load()} />
      ) : (
        // One panel from the first paint: while the list loads it holds the table's own
        // loading rows, so nothing jumps when the reports arrive.
        <Panel
          title="Saved reports"
          padding="none"
          // The stored count, or "n of m" while a search narrows the list.
          count={
            rows === null || firstUse
              ? undefined
              : filtered
                ? `${fmtNumber(visible.length)} of ${fmtNumber(rows.length)}`
                : rows.length
          }
          // Said only when it matters: at the cap a new report is refused.
          caption={atLimit ? `Limit of ${fmtNumber(REPORT_LIMIT)} reached. Delete a report to save a new one.` : undefined}
          actions={
            rows === null || firstUse ? undefined : (
              <div className="relative w-64 max-w-full">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  className="h-8 pl-9"
                  placeholder="Search reports"
                  aria-label="Search reports"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )
          }
          data-testid="reports-panel"
        >
          <DataTable
            surface="panel"
            columns={columns}
            rows={visible}
            getRowId={(r) => r.id}
            sort={sort}
            onSortChange={setSort}
            ariaLabel="Reports"
            loading={rows === null}
            loadingRows={5}
            // The whole row opens the report by pointer; the title button in the row is
            // its named keyboard action, so no second "Open" button is added.
            onRowClick={(r) => onOpen(r.id)}
            showRowAction={false}
            // Narrow screens scroll sideways; the title stays in view.
            stickyFirstColumn
            // Nothing saved yet: the first-use state replaces the table, header row included.
            emptyState={
              firstUse ? (
                <div className={cn(PANEL_PADDING_X, 'pb-4 xl:pb-5 3xl:pb-6')}>
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
                </div>
              ) : undefined
            }
            // A search that matches nothing keeps the columns in view.
            empty={<EmptyState icon={Search} state="no-results" compact title="No matching reports" description="Try another search." />}
          />
        </Panel>
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
