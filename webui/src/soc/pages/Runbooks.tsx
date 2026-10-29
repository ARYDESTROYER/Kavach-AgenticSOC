/**
 * Runbooks (Round 14, SPEC §4.10.1, §4.10.12): the one place a team keeps its response
 * procedures. `#/runbooks` is the library: a key-figure strip, one table of every runbook
 * (the 12 built-ins and the team's own), and two panels, "Rules with no runbook" and
 * "Recent runs". `#/runbooks?id=<id>` and `#/runbooks?id=new` open the editor, a lazy chunk.
 *
 * The run figures come from case-derived reads (`GET /api/runbooks/metrics` needs
 * `cases:read`); without that grant, or under row-level scope, they say so and the rest of
 * the page works. A figure is never shown before it is known: a loading tile says so, a
 * failed read says "Unavailable", and a run count the ledger capped reads "at least".
 * The library and the figures are read again each time the person comes back from the
 * editor, so a runbook just created or published is there. Runbook text, rule names and
 * case titles are plain text (#9). A runbook never closes a case and never changes a
 * verdict (#3).
 */
import * as React from 'react';
import { Download, FileUp, MoreHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Callout } from '@/design-system/callout';
import { ListRow, ListRows } from '@/design-system/list-row';
import { Panel } from '@/design-system/panel';
import { StatusDot } from '@/design-system/status-dot';
import { exportRunbookMarkdown, getRunbookMetrics, importRunbook, listRunbookLibrary } from '@/lib/api-runbooks';
import { downloadBlob } from '@/lib/download-blob';
import { caseLabel, fmtDuration } from '@/lib/format';
import type {
  RunbookDetail,
  RunbookLibrary,
  RunbookMetrics,
  RunbookMigrationNotice,
  RunbookOrigin,
  RunbookState,
  RunbookSummary,
} from '@/lib/types-runbooks';
import type { NavOpts } from '@/soc/nav-types';
import { useCan } from '@/soc/components/Can';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { FilterBar, type FilterChip } from '@/soc/components/FilterBar';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { KpiTile } from '@/soc/components/KpiTile';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { RuleLink, RuleSheetHost } from '@/soc/components/RuleLink';
import { useDemo } from '@/soc/demo';
import { useMediaQuery } from '@/soc/hooks/useMediaQuery';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';
import { pageHash, useNavigateOptional, useRoute } from '@/soc/router';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Label } from '@/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Switch } from '@/ui/switch';
import { Textarea } from '@/ui/textarea';

import type { RunbookCarriedEdits } from '@/soc/runbooks/editor/RunbookEditor';
import { Mono } from '@/soc/runbooks/shared/chips';
import { formatDay, isReviewDue, reviewDueState, reviewDueWords } from '@/soc/runbooks/shared/dates';
import { isCaseFiguresHidden, runbookFailure } from '@/soc/runbooks/shared/errors';
import { ORIGIN_LABEL, RUNBOOK_LIMITS, RUNBOOK_STATE_LABEL, countNoun } from '@/soc/runbooks/shared/labels';

const RunbookEditor = React.lazy(() => import('@/soc/runbooks/editor/RunbookEditor'));

export const PAGE_TITLE = 'Runbooks';
/** The definition of SPEC §4.10.1, word for word (the Help Center page opens with it too). */
export const PAGE_HELP =
  "Runbooks are your team's step-by-step response procedures. The matching runbook is attached to each case that needs a person. Analysts work through it as a checklist; the AI runs the read-only lookups and can draft notes. A runbook never closes a case; your case policy does that.";

const STATES: ReadonlyArray<{ value: RunbookState | 'any'; label: string }> = [
  { value: 'any', label: 'Any state' },
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Draft' },
  { value: 'in_review', label: 'In review' },
  { value: 'retired', label: 'Retired' },
];
const ORIGINS: ReadonlyArray<{ value: RunbookOrigin | 'any'; label: string }> = [
  { value: 'any', label: 'Any origin' },
  { value: 'builtin', label: 'Built-in' },
  { value: 'operator', label: 'Yours' },
  { value: 'imported', label: 'Imported' },
];

/** The route's opts, or none outside a router (a test that renders the page alone). */
function useRouteOpts(): NavOpts | undefined {
  try {
    return useRoute().opts;
  } catch {
    return undefined;
  }
}

/** "Published v4", "Draft v5", "In review", "Retired" for a library row. */
export function stateText(r: RunbookSummary): string {
  if (r.state === 'published' && r.live_version != null) return `Published v${r.live_version.toLocaleString()}`;
  if (r.state === 'draft' && r.draft_version != null) return `Draft v${r.draft_version.toLocaleString()}`;
  return RUNBOOK_STATE_LABEL[r.state];
}

/** "4 phases · 11 steps". */
export function stepsText(r: RunbookSummary): string {
  return `${countNoun(r.phases.length, 'phase')} · ${countNoun(r.step_count, 'step')}`;
}

/** The muted line under a runbook's name: its origin, whether a copy replaces it, its summary. */
export function nameLine(r: RunbookSummary): string {
  return [ORIGIN_LABEL[r.origin], r.replaced_by ? 'Replaced by your copy' : null, r.summary?.trim() || null]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Who attached a run, in words: the automatic selector and the system are "Agentic SOC", a
 * case-automation rule is "A case-automation rule", a person is their name, and an actor the
 * ledger could not read is left out (null).
 */
export function attachedBy(actor: string | null | undefined): string | null {
  const who = (actor ?? '').trim();
  if (!who) return null;
  if (who === 'runbook_selector' || who === 'agentic_soc') return 'Agentic SOC';
  if (who === 'threshold_automation') return 'A case-automation rule';
  return who;
}

/** "In progress · Agentic SOC · 2h 10m": a recent run's status, who attached it and how long it ran. */
export function recentRunLine(run: { status: string; attached_actor: string; duration_minutes: number | null }): string {
  const status = run.status === 'completed' ? 'Completed' : run.status === 'abandoned' ? 'Closed early' : 'In progress';
  const parts = [status, attachedBy(run.attached_actor)];
  if (run.duration_minutes != null) parts.push(fmtDuration(run.duration_minutes));
  return parts.filter(Boolean).join(' · ');
}

/** The migration intro (§4.10.17 step 8), built from the marker's counts. */
export function migrationText(m: RunbookMigrationNotice): string | null {
  const total = m.published + m.draft;
  if (total <= 0) return null;
  const parts: string[] = [];
  parts.push(
    `Your ${total.toLocaleString()} ${total === 1 ? 'procedure' : 'procedures'} from the previous version ${total === 1 ? 'is now a runbook' : 'are now runbooks'}.`,
  );
  const details: string[] = [];
  if (m.published) details.push(`${m.published.toLocaleString()} ${m.published === 1 ? 'is' : 'are'} published and due for review`);
  if (m.draft) details.push(`${m.draft.toLocaleString()} ${m.draft === 1 ? 'is a draft' : 'are drafts'} with problems to fix`);
  if (details.length) parts.push(`${details.join('; ')}.`);
  if (m.skipped) parts.push(`${m.skipped.toLocaleString()} could not be converted.`);
  parts.push('The AI now reads each step’s title and focus line, so check each imported runbook.');
  return parts.join(' ');
}

function matchesQuery(r: RunbookSummary, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return [r.title, r.summary, r.id, ...r.applies_to.rule_ids, ...r.applies_to.mitre].some((v) =>
    (v ?? '').toLowerCase().includes(needle),
  );
}

function AppliesTo({ r }: { r: RunbookSummary }) {
  const values = [...r.applies_to.rule_ids, ...r.applies_to.mitre];
  const shown = values.slice(0, 3);
  const more = values.length - shown.length + (r.applies_to.more || 0);
  if (!values.length && !more) return <span className="text-sm text-muted-foreground">Any case</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((v) => (
        <Mono key={v} title={v} className="max-w-[14rem] truncate">
          {v}
        </Mono>
      ))}
      {more > 0 ? <span className="text-xs text-muted-foreground">+{more.toLocaleString()}</span> : null}
    </span>
  );
}

/** The runbook's name, a link to its editor; a plain click goes through the router. */
function RunbookTitleLink({ r }: { r: RunbookSummary }) {
  const href = safeRouteHref(pageHash('runbooks', { id: r.id }));
  const onClick = useRouteLinkClick(href);
  return (
    <a
      href={href}
      onClick={onClick}
      className="rounded-sm font-medium text-foreground underline-offset-2 [overflow-wrap:anywhere] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-runbook-link={r.id}
    >
      {r.title}
    </a>
  );
}

function StateCell({ r }: { r: RunbookSummary }) {
  const text = stateText(r);
  if (r.state === 'in_review') return <StatusDot tone="warning">{text}</StatusDot>;
  if (r.state === 'retired') return <StatusDot tone="neutral">{text}</StatusDot>;
  return (
    <span className="flex flex-col">
      <span className="text-sm text-foreground">{text}</span>
      {r.state === 'published' && r.draft_version != null ? (
        <span className="text-xs text-muted-foreground">{`Draft v${r.draft_version.toLocaleString()} in progress`}</span>
      ) : null}
    </span>
  );
}

function ReviewCell({ r }: { r: RunbookSummary }) {
  if (!r.review_due_at) return <span className="text-sm text-muted-foreground">Not scheduled</span>;
  const state = reviewDueState(r.review_due_at);
  const words = reviewDueWords(r.review_due_at);
  const urgent = state === 'overdue' || state === 'today';
  return (
    <span className={urgent ? 'text-sm font-medium text-warning-text' : 'text-sm text-foreground'} title={formatDay(r.review_due_at)}>
      {words || formatDay(r.review_due_at)}
    </span>
  );
}

type CaseFigures = { kind: 'ready'; metrics: RunbookMetrics } | { kind: 'hidden'; why: 'forbidden' | 'scope' } | { kind: 'loading' } | { kind: 'error'; message: string };

/** A figure that is still being read: a quiet placeholder, never a number. */
function LoadingNumeral() {
  return <span className="inline-block h-[0.9em] w-12 animate-pulse rounded bg-muted align-middle motion-reduce:animate-none" aria-hidden />;
}

/** The lower bound a capped ledger leaves on a run figure. */
const PARTIAL_BOUND = 'At least this many: some runs in this window are not counted.';

const HIDDEN_TEXT = { forbidden: 'You do not have access to cases.', scope: 'Hidden while row-level scope is on.' } as const;

/** A case number that opens the case; a plain click goes through the router. */
function CaseLink({ caseId, label }: { caseId: string; label: string }) {
  const href = safeRouteHref(pageHash('case_manager', { caseId }));
  const onClick = useRouteLinkClick(href);
  return (
    <a
      href={href}
      onClick={onClick}
      className="rounded-sm font-mono text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
    </a>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  onImported,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (detail: RunbookDetail) => void;
  /** The control that opened the dialog (a menu item's trigger); focus returns to it on cancel. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!open) {
      setText('');
      setError(null);
    }
  }, [open]);
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > RUNBOOK_LIMITS.sourceBytes) {
      setError(`That file is ${file.size.toLocaleString()} bytes; the limit is ${RUNBOOK_LIMITS.sourceBytes.toLocaleString()}.`);
      return;
    }
    setText(await file.text());
    setError(null);
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const detail = await importRunbook(text);
      onImported(detail);
    } catch (err) {
      const failure = runbookFailure(err, 'Could not import that runbook.');
      setError(failure.issues.length ? failure.issues.slice(0, 5).map((i) => i.message).join(' ') : failure.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target || !target.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Import Markdown</DialogTitle>
          <DialogDescription>
            Paste a runbook in its Markdown form, or choose a .md file. It always lands as a draft you can check before
            publishing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <FileUp aria-hidden />
              Choose a file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".md,text/markdown,text/plain"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
          </div>
          <Label htmlFor="runbook-import-text">Markdown</Label>
          <Textarea
            id="runbook-import-text"
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="font-mono text-xs"
            spellCheck={false}
          />
          {error ? (
            <p role="alert" className="text-sm text-critical-text">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!text.trim() || busy}>
            Import as draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A Blob's bytes, through `arrayBuffer` where the browser has it and a FileReader where not. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsArrayBuffer(blob);
  });
}

async function exportAll(runbooks: RunbookSummary[]): Promise<void> {
  const { zipStore } = await import('@/soc/chat/report/export/zip');
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const queue = [...runbooks];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const file = await exportRunbookMarkdown(next.id);
      entries.push({ name: `${next.id}.md`, data: await blobBytes(file.blob) });
    }
  });
  await Promise.all(workers);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const bytes = zipStore(entries);
  const day = new Date().toISOString().slice(0, 10);
  if (!downloadBlob(`runbooks-${day}.zip`, new Blob([bytes], { type: 'application/zip' }))) {
    throw new Error('This browser could not start the download.');
  }
}

export interface RunbooksProps {
  /** Kept for the Intelligence host's older call; the page always draws its own header. */
  embedded?: boolean;
}

export default function Runbooks(_props: RunbooksProps = {}) {
  const opts = useRouteOpts();
  const navigate = useNavigateOptional();
  const openId = typeof opts?.id === 'string' && opts.id ? opts.id : null;
  const inLibrary = openId === null;
  const seedRule = typeof opts?.rule === 'string' ? opts.rule : null;
  /**
   * A detail a create, copy or import already returned, handed to the editor of that one id
   * so it skips a read, with any edits typed while that create ran (the editor opens with
   * them unsaved). It is dropped as soon as the page shows anything else (another id, the
   * library), so a later visit to the same address, by Back or Forward, reads it again
   * rather than reopening a stale revision.
   */
  const handoff = React.useRef<{ id: string; detail: RunbookDetail; edits: RunbookCarriedEdits | null } | null>(null);
  React.useEffect(() => {
    if (handoff.current && handoff.current.id !== openId) handoff.current = null;
  }, [openId]);

  const [library, setLibrary] = React.useState<RunbookLibrary | null>(null);
  const [libraryState, setLibraryState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [libraryError, setLibraryError] = React.useState<unknown>(null);
  const [showReplaced, setShowReplaced] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const canCases = useCan('cases', 'read');
  const [figures, setFigures] = React.useState<CaseFigures>(
    canCases ? { kind: 'loading' } : { kind: 'hidden', why: 'forbidden' },
  );

  // The library is read when the page opens and again on each return from the editor (the
  // page stays mounted between the two, so a runbook created or published there is listed).
  // While the editor is open it is read only if it never was, for the editor's id checks.
  React.useEffect(() => {
    if (!inLibrary && library) return;
    const ctrl = new AbortController();
    setLibraryState((s) => (library ? s : 'loading'));
    listRunbookLibrary({ show_replaced: showReplaced || undefined }, ctrl.signal)
      .then((lib) => {
        setLibrary(lib);
        setLibraryState('ready');
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setLibraryError(err);
        setLibraryState('error');
      });
    return () => ctrl.abort();
    // `library` is read only to keep rows on screen while a reload runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showReplaced, tick, inLibrary]);

  const figuresRead = React.useRef(false);
  React.useEffect(() => {
    if (!canCases) {
      setFigures({ kind: 'hidden', why: 'forbidden' });
      return;
    }
    if (!inLibrary && figuresRead.current) return;
    figuresRead.current = true;
    const ctrl = new AbortController();
    getRunbookMetrics(undefined, ctrl.signal)
      .then((metrics) => setFigures({ kind: 'ready', metrics }))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        const failure = runbookFailure(err, 'Could not read the run figures.');
        const hidden = isCaseFiguresHidden(failure);
        setFigures(hidden ? { kind: 'hidden', why: hidden } : { kind: 'error', message: failure.message });
      });
    return () => ctrl.abort();
  }, [canCases, tick, inLibrary]);

  const openRunbook = React.useCallback(
    (id: string, detail?: RunbookDetail, edits?: RunbookCarriedEdits) => {
      handoff.current = detail ? { id, detail, edits: edits ?? null } : null;
      navigate('runbooks', { id });
    },
    [navigate],
  );
  const backToLibrary = React.useCallback(() => navigate('runbooks'), [navigate]);

  if (openId) {
    const handed = handoff.current && handoff.current.id === openId ? handoff.current : null;
    const recentRules = figures.kind === 'ready' ? figures.metrics.rules_without_runbook.map((r) => r.rule) : [];
    return (
      <PageContainer variant="wide" data-testid="runbook-editor-page">
        <React.Suspense
          fallback={
            <div className="space-y-4" aria-busy="true">
              <PageHeader title="Runbook" back={{ label: 'All runbooks', href: '#/runbooks' }} />
              <div className="surface-panel h-64 animate-pulse" />
            </div>
          }
        >
          <RunbookEditor
            key={openId}
            runbookId={openId}
            initialDetail={handed?.detail ?? null}
            initialEdits={handed?.edits ?? null}
            seedRule={openId === 'new' ? seedRule : null}
            library={library?.runbooks ?? []}
            recentRules={recentRules}
            onOpenRunbook={openRunbook}
            onBackToLibrary={backToLibrary}
          />
        </React.Suspense>
      </PageContainer>
    );
  }

  return (
    <RunbookLibraryView
      library={library}
      libraryState={libraryState}
      libraryError={libraryError}
      figures={figures}
      showReplaced={showReplaced}
      onShowReplaced={setShowReplaced}
      onRetry={() => setTick((t) => t + 1)}
      onOpen={openRunbook}
      onCreate={(rule) => navigate('runbooks', rule ? { id: 'new', rule } : { id: 'new' })}
    />
  );
}

interface LibraryViewProps {
  library: RunbookLibrary | null;
  libraryState: 'loading' | 'ready' | 'error';
  libraryError: unknown;
  figures: CaseFigures;
  showReplaced: boolean;
  onShowReplaced: (on: boolean) => void;
  onRetry: () => void;
  onOpen: (id: string, detail?: RunbookDetail) => void;
  onCreate: (rule?: string) => void;
}

function RunbookLibraryView({
  library,
  libraryState,
  libraryError,
  figures,
  showReplaced,
  onShowReplaced,
  onRetry,
  onOpen,
  onCreate,
}: LibraryViewProps) {
  const canManage = useCan('runbooks', 'manage');
  const demo = useDemo().active;
  const isPhone = useMediaQuery('(max-width: 767px)');
  const [q, setQ] = React.useState('');
  const [state, setState] = React.useState<RunbookState | 'any'>('any');
  const [origin, setOrigin] = React.useState<RunbookOrigin | 'any'>('any');
  const [importOpen, setImportOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const moreTriggerRef = React.useRef<HTMLButtonElement>(null);
  const canWrite = canManage && !demo;

  const runbooks = React.useMemo(() => library?.runbooks ?? [], [library]);
  const rows = React.useMemo(
    () =>
      runbooks
        .filter((r) => (state === 'any' ? true : r.state === state))
        .filter((r) => (origin === 'any' ? true : r.origin === origin))
        .filter((r) => matchesQuery(r, q.trim()))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [runbooks, state, origin, q],
  );
  const metrics = figures.kind === 'ready' ? figures.metrics : null;
  const runsBy = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const row of metrics?.per_runbook ?? []) map.set(row.id, row.started);
    return map;
  }, [metrics]);

  // The strip counts the library as it is, never as the table is filtered: a built-in that a
  // published copy replaces is listed only with "Show replaced built-ins" on and is never counted.
  const counted = runbooks.filter((r) => !r.replaced_by);
  const published = counted.filter((r) => r.live_version != null && !r.retired);
  const builtins = published.filter((r) => r.origin === 'builtin').length;
  const reviewDue = counted.filter((r) => !r.retired && isReviewDue(r.review_due_at)).length;
  const inReview = counted.filter((r) => r.state === 'in_review').length;
  const libraryReady = !!library;
  const partial = !!metrics?.partial;
  const started = metrics?.per_runbook.reduce((n, r) => n + r.started, 0) ?? 0;
  const completed = metrics?.per_runbook.reduce((n, r) => n + r.completed, 0) ?? 0;
  const coverage = metrics?.coverage ?? null;
  const coveragePct =
    coverage && coverage.human_handled_cases > 0
      ? Math.round((coverage.cases_with_run / coverage.human_handled_cases) * 100)
      : null;
  const hiddenText = figures.kind === 'hidden' ? HIDDEN_TEXT[figures.why] : figures.kind === 'error' ? figures.message : null;
  /** A run figure that is not known yet: loading, hidden (no access) or unavailable (failed). */
  const unknownFigure =
    figures.kind === 'loading'
      ? { value: <LoadingNumeral />, sub: 'Loading' }
      : figures.kind === 'hidden'
        ? { value: 'Hidden', sub: HIDDEN_TEXT[figures.why] }
        : figures.kind === 'error'
          ? { value: 'Unavailable', sub: figures.message }
          : null;
  /** A run count: exact, or a floor (the ≥ mark and its sentence) when the ledger was capped. */
  const runCount = (count: number, context: string) =>
    unknownFigure ??
    (partial
      ? { value: count.toLocaleString(), countTo: count, format: (n: number) => n.toLocaleString(), roll: false, bound: PARTIAL_BOUND }
      : { value: count.toLocaleString(), context });
  const windowLabel = metrics?.window_label ?? 'Last 30 days';

  const filtersActive = state !== 'any' || origin !== 'any' || q.trim() !== '' || showReplaced;
  const clearFilters = () => {
    setQ('');
    setState('any');
    setOrigin('any');
    onShowReplaced(false);
  };
  const chips: FilterChip[] = [];
  if (state !== 'any') chips.push({ id: 'state', label: `State: ${STATES.find((s) => s.value === state)?.label}`, onRemove: () => setState('any') });
  if (origin !== 'any') chips.push({ id: 'origin', label: `Origin: ${ORIGIN_LABEL[origin]}`, onRemove: () => setOrigin('any') });
  if (showReplaced) chips.push({ id: 'replaced', label: 'Showing replaced built-ins', onRemove: () => onShowReplaced(false) });

  const runExportAll = async () => {
    setExporting(true);
    try {
      await exportAll(runbooks);
      toast.success(`Exported ${countNoun(runbooks.length, 'runbook')}.`);
    } catch (err) {
      toast.error(runbookFailure(err, 'Could not export the runbooks.').message);
    } finally {
      setExporting(false);
    }
  };

  const showRuns = !!metrics || runbooks.some((r) => r.runs_30d != null);
  // The name and its line wrap (two lines at most for the line); the rule chips wrap; the short
  // columns take a fixed width each, so the two text columns share what is left.
  const columns: DataTableColumn<RunbookSummary>[] = [
    {
      id: 'name',
      header: 'Name',
      wrap: true,
      minWidth: '14rem',
      cell: (r) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <RunbookTitleLink r={r} />
          <span className="line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-runbook-line="">
            {nameLine(r)}
          </span>
        </span>
      ),
      text: (r) => r.title,
    },
    { id: 'applies', header: 'Applies to', width: '24%', wrap: true, cell: (r) => <AppliesTo r={r} /> },
    { id: 'state', header: 'State', width: '8rem', wrap: true, cell: (r) => <StateCell r={r} />, text: stateText },
    {
      id: 'steps',
      header: 'Steps',
      width: '9.5rem',
      cell: (r) => <span className="whitespace-nowrap tabular-nums">{stepsText(r)}</span>,
      text: stepsText,
    },
    ...(showRuns
      ? [
          {
            id: 'runs',
            header: 'Runs (30 days)',
            width: '7.5rem',
            align: 'right' as const,
            kind: 'number' as const,
            cell: (r: RunbookSummary) => {
              const n = (r.runs_30d ?? runsBy.get(r.id) ?? 0).toLocaleString();
              return <span className="tabular-nums">{partial ? `at least ${n}` : n}</span>;
            },
          },
        ]
      : []),
    { id: 'review', header: 'Review due', width: '9rem', wrap: true, cell: (r) => <ReviewCell r={r} /> },
  ];

  const headerActions = (
    <div className="flex items-center gap-2">
      {canWrite ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button ref={moreTriggerRef} type="button" variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                <FileUp aria-hidden />
                Import Markdown
              </DropdownMenuItem>
              <DropdownMenuItem disabled={exporting || !runbooks.length} onSelect={() => void runExportAll()}>
                <Download aria-hidden />
                Export all as Markdown
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" onClick={() => onCreate()}>
            <Plus aria-hidden />
            New runbook
          </Button>
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="More actions">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem disabled={exporting || !runbooks.length} onSelect={() => void runExportAll()}>
              <Download aria-hidden />
              Export all as Markdown
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  const migration = library?.migration ? migrationText(library.migration) : null;

  return (
    <PageContainer variant="wide" data-testid="runbooks-library">
      <PageHeader title={PAGE_TITLE} help={PAGE_HELP} actions={headerActions} />

      {demo ? (
        <p className="text-sm text-muted-foreground">Runbooks cannot be edited in Demo Mode. The cases show Demo runs.</p>
      ) : null}

      {migration ? (
        <Callout
          intent="intro"
          introId="runbook-migration"
          title="Your procedures are now runbooks"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => setOrigin('imported')}>
              Show imported
            </Button>
          }
        >
          {migration}
        </Callout>
      ) : null}

      <KpiStrip label="Runbook figures" density="comfortable">
        <KpiTile
          label="Published runbooks"
          {...(libraryReady
            ? {
                value: published.length.toLocaleString(),
                context: `${builtins.toLocaleString()} built-in · ${(published.length - builtins).toLocaleString()} yours`,
              }
            : libraryState === 'error'
              ? { value: 'Unavailable', sub: 'The library could not be read.' }
              : { value: <LoadingNumeral />, sub: 'Loading' })}
        />
        <KpiTile label="Runs (30 days)" {...runCount(started, windowLabel)} />
        <KpiTile
          label="Completed"
          {...runCount(
            completed,
            started > 0 ? `${Math.round((completed / started) * 100)}% of ${countNoun(started, 'run')}` : 'No runs yet',
          )}
        />
        <KpiTile
          label="Cases with a runbook"
          {...(unknownFigure ??
            (coveragePct == null
              ? { value: 'None yet', context: coverage ? `0 of ${countNoun(coverage.human_handled_cases, 'human-handled case')}` : '' }
              : {
                  value: partial ? `at least ${coveragePct}%` : `${coveragePct}%`,
                  context: coverage
                    ? `${coverage.cases_with_run.toLocaleString()} of ${countNoun(coverage.human_handled_cases, 'human-handled case')}`
                    : '',
                }))}
        />
        <KpiTile
          label="Needs attention"
          {...(libraryReady
            ? {
                value: (reviewDue + inReview).toLocaleString(),
                context: `${reviewDue.toLocaleString()} review due · ${inReview.toLocaleString()} in review`,
              }
            : libraryState === 'error'
              ? { value: 'Unavailable', sub: 'The library could not be read.' }
              : { value: <LoadingNumeral />, sub: 'Loading' })}
        />
      </KpiStrip>

      <Panel
        title="Library"
        count={libraryState === 'ready' ? rows.length : undefined}
        caption={partial ? 'Run counts are lower bounds: some runs in this window are not counted.' : undefined}
        padding="none"
        data-testid="runbooks-table-panel"
      >
        <div className="px-4 pb-3 xl:px-5">
          <FilterBar
            aria-label="Runbook filters"
            search={{ value: q, onChange: setQ, label: 'Search runbooks', placeholder: 'Search by name, rule or technique' }}
            filters={[
              {
                id: 'state',
                label: 'State',
                active: state !== 'any',
                control: ({ placement }) => (
                  <Select value={state} onValueChange={(v) => setState(v as RunbookState | 'any')}>
                    <SelectTrigger aria-label="State" className={placement === 'bar' ? 'h-9 w-36' : 'h-9 w-full'}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ),
              },
              {
                id: 'origin',
                label: 'Origin',
                active: origin !== 'any',
                control: ({ placement }) => (
                  <Select value={origin} onValueChange={(v) => setOrigin(v as RunbookOrigin | 'any')}>
                    <SelectTrigger aria-label="Origin" className={placement === 'bar' ? 'h-9 w-36' : 'h-9 w-full'}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ORIGINS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ),
              },
              {
                id: 'replaced',
                label: 'Show replaced built-ins',
                active: showReplaced,
                control: (
                  <label className="inline-flex h-9 items-center gap-2 text-sm text-foreground">
                    <Switch checked={showReplaced} onCheckedChange={onShowReplaced} aria-label="Show replaced built-ins" />
                    Show replaced built-ins
                  </label>
                ),
              },
            ]}
            chips={chips}
            onClearAll={filtersActive ? clearFilters : undefined}
          />
        </div>
        {libraryState === 'error' && !library ? (
          <div className="px-4 pb-4 xl:px-5">
            <LoadError title="Could not load the runbooks" error={libraryError} onRetry={onRetry} fallback="The library could not be read right now." />
          </div>
        ) : isPhone ? (
          libraryState === 'loading' && !library ? (
            <div className="space-y-2 px-4 pb-4" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-md bg-muted/60" />
              ))}
            </div>
          ) : rows.length ? (
            <ListRows aria-label="Runbooks" className="px-2 pb-2">
              {rows.map((r) => (
                <ListRow
                  key={r.id}
                  title={r.title}
                  description={`${ORIGIN_LABEL[r.origin]} · ${stateText(r)} · ${stepsText(r)}`}
                  href={pageHash('runbooks', { id: r.id })}
                />
              ))}
            </ListRows>
          ) : (
            <div className="px-4 pb-4">
              <EmptyState
                state="no-results"
                title="No runbooks match these filters."
                action={
                  <Button type="button" variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            </div>
          )
        ) : (
          <DataTable<RunbookSummary>
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            surface="panel"
            loading={libraryState === 'loading' && !library}
            loadingRows={6}
            onRowClick={(r) => onOpen(r.id)}
            showRowAction={false}
            ariaLabel="Runbooks"
            emptyState={
              <EmptyState
                state="no-results"
                title="No runbooks match these filters."
                action={
                  <Button type="button" variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            }
          />
        )}
      </Panel>

      <RuleSheetHost>
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Rules with no runbook" caption={hiddenText ? undefined : windowLabel} data-testid="rules-without-runbook">
            {hiddenText ? (
              <p className="text-sm text-muted-foreground">{hiddenText}</p>
            ) : figures.kind === 'loading' ? (
              <p className="text-sm text-muted-foreground" aria-busy="true">
                Reading the rules seen recently.
              </p>
            ) : metrics && metrics.rules_without_runbook.length ? (
              <ul className="divide-y divide-border/70">
                {metrics.rules_without_runbook.map((row) => (
                  <li key={row.rule} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                    <span className="min-w-0 text-sm">
                      <RuleLink rule={row.rule} origin="Runbooks" className="text-sm text-foreground" />
                      <span className="ml-2 text-muted-foreground">{countNoun(row.cases, 'case')}</span>
                    </span>
                    {canWrite ? (
                      <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => onCreate(row.rule)}>
                        <Plus aria-hidden />
                        Create a runbook
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Every rule seen recently has a published runbook.</p>
            )}
          </Panel>
          <Panel title="Recent runs" caption={hiddenText ? undefined : windowLabel} data-testid="recent-runs">
            {hiddenText ? (
              <p className="text-sm text-muted-foreground">{hiddenText}</p>
            ) : figures.kind === 'loading' ? (
              <p className="text-sm text-muted-foreground" aria-busy="true">
                Reading recent runs.
              </p>
            ) : metrics && metrics.recent_runs.length ? (
              <ul className="divide-y divide-border/70">
                {metrics.recent_runs.slice(0, 10).map((run) => (
                  <li key={run.run_id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
                    <span className="min-w-0">
                      <CaseLink caseId={run.case_id} label={caseLabel({ case_number: run.case_number, case_id: run.case_id })} />
                      <span className="ml-2 text-foreground [overflow-wrap:anywhere]">{run.title}</span>
                      {run.version != null ? <span className="ml-1 text-muted-foreground">v{run.version.toLocaleString()}</span> : null}
                    </span>
                    <span className="text-muted-foreground" data-recent-run-line="">
                      {recentRunLine(run)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No runs in this window yet.</p>
            )}
          </Panel>
        </div>
      </RuleSheetHost>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        returnFocusRef={moreTriggerRef}
        onImported={(detail) => {
          setImportOpen(false);
          toast.success('Imported as a draft.');
          onOpen(detail.summary.id, detail);
        }}
      />
    </PageContainer>
  );
}

