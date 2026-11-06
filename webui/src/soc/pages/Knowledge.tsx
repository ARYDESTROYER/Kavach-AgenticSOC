/**
 * Knowledge / RAG: the operator-facing window into the retrieval corpus the
 * investigator draws on. Rebuilt for the new SOC console (Tailwind + shadcn-style
 * primitives) while preserving the legacy data wiring + features verbatim:
 *
 *   - a corpus-health header (KPI tiles: total chunks, documents, embedding
 *     model, vector dimensions) + a "Corpus by source" BarList,
 *   - an Import card (paste text OR upload one-or-more .txt/.md/.json/.csv files,
 *     read client-side via FileReader and submitted once to a durable server job;
 *     the title is auto-filled from the filename) + tags + bounded size/count guards,
 *   - a "Try a retrieval" card that runs GET /api/rag/search and shows the exact,
 *     score-bearing chunks RAG would return for a query, ranked highest-first,
 *   - an indexed-documents DataTable with search, a source facet, sort, a density
 *     toggle, per-row view (a drill-in Sheet of the document's CHUNKS) + delete
 *     (guarded seed sources force-delete after a confirm),
 *   - an UNTRUSTED footer note.
 *
 * Round 14 (IN2 to IN5, F19): no "Knowledge controls" band (the icon Refresh sits on
 * the indexed-documents panel; the Intelligence host owns the page header); the counts
 * are a compact `KpiStrip` and the embedding model is a plain line on the corpus panel,
 * not a numeral; corpus bars use one series colour with the value and share of the total
 * on the label row; every card is a `Panel`, and the document count pill sits in each
 * source panel's title row; delete icons are neutral at rest; no icon chips.
 *
 * Security: indexed / retrieved / source / model text is UNTRUSTED, always
 * rendered as PLAIN text or inside <CodeBlock>/<InlineCode>, never as markup.
 * Secrets are never shown.
 */
import * as React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Gauge,
  Layers,
  Loader2,
  Lock,
  Plus,
  Search,
  ShieldAlert,
  Tag,
  Trash2,
  X,
} from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

import type { Navigate } from '@/soc/router';
import { useNavigateOptional } from '@/soc/router';
import { api, ApiError } from '@/lib/api';
import type {
  PrecedentBootstrapStatus,
  RagChunk,
  RagDocument,
  RagStats,
} from '@/lib/types';
import { DASH, fmtNumber, humanizeAge } from '@/lib/format';
import { properName } from '@/lib/proper-names';
import { errorMessage } from '@/lib/errorMessage';
import { cn } from '@/lib/cn';
import { toast } from 'sonner';

import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { LoadError } from '@/soc/components/LoadError';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { Can, useCan } from '@/soc/components/Can';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { KpiTile } from '@/soc/components/KpiTile';
import { NumberField } from '@/soc/components/NumberField';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import {
  DataTable,
  type DataTableColumn,
  type SortState,
} from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { FilterBar, type FilterChip } from '@/soc/components/FilterBar';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { LoadingState, Panel } from '@/design-system';
import { TagInput, usePendingTagDraft } from '@/soc/components/TagInput';
import { headingOf, useReturnFocus } from '@/soc/hooks/useReturnFocus';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';

import { Button } from '@/ui/button';
import { Badge, type BadgeProps } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Label } from '@/ui/label';
import { Skeleton } from '@/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';

/* ------------------------------------------------------------- constants ----- */

/** Per-import size guard — exactly mirrors routes_rag._RAG_MAX_TEXT. */
const MAX_IMPORT_BYTES = 1_000_000;
const MAX_IMPORT_LABEL = '1 MB';
const MAX_IMPORT_DOCUMENTS = 20;
/** Leave headroom below the server's 8 MiB active-job registry ceiling. */
const MAX_IMPORT_PAYLOAD_BYTES = 7_500_000;
const MAX_IMPORT_TITLE_CHARS = 512;
const IMPORT_ACCEPT = '.txt,.md,.json,.csv,text/*';

const TOP_K_DEFAULT = 5;
/** Display-only similarity floor (the backend owns the real retrieval floor). */
const MIN_SIMILARITY_HINT = '0.70';

const DENSITY_LS_KEY = 'tlsoc.knowledge.density';

type Density = 'normal' | 'compact';
type SortField = 'title' | 'source' | 'chunk_count' | 'added_at';

/* ------------------------------------------------------------- helpers -------- */

/** Map a corpus source label → a semantic badge variant (stable per kind). */
function sourceBadgeVariant(source?: string): BadgeProps['variant'] {
  const s = (source || '').toLowerCase();
  if (s.includes('runbook') || s.includes('playbook')) return 'info';
  if (s.includes('case') || s.includes('resolved')) return 'success';
  if (s.includes('mitre')) return 'critical';
  if (s.includes('threat')) return 'critical';
  if (s.includes('import') || s.includes('manual') || s.includes('upload'))
    return 'default';
  if (s.includes('suppression')) return 'warning';
  return 'secondary';
}

/** Heuristic: which corpus sources are guarded seed material (force-delete only). */
function isSeedSource(source?: string): boolean {
  const s = (source || '').toLowerCase();
  return (
    s.includes('runbook') ||
    s.includes('playbook') ||
    s.includes('mitre') ||
    s.includes('suppression') ||
    s.includes('resolved')
  );
}

/** A score → semantic variant (relevance strength). */
function scoreVariant(score: number): BadgeProps['variant'] {
  if (score >= 0.66) return 'success';
  if (score >= 0.33) return 'warning';
  return 'secondary';
}

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_LS_KEY) === 'compact' ? 'compact' : 'normal';
  } catch {
    return 'normal';
  }
}

/* ------------------------------------------------------------- badges --------- */

/** A corpus source badge (UNTRUSTED label → humanized plain text). */
const SourceBadge: React.FC<{ source?: string; className?: string }> = ({
  source,
  className,
}) => {
  if (!source)
    return (
      <Badge variant="outline" className={className}>
        {DASH}
      </Badge>
    );
  return (
    <Badge variant={sourceBadgeVariant(source)} className={className}>
      <Tag className="size-3" aria-hidden />
      {properName(source)}
    </Badge>
  );
};

/** A retrieval-score badge whose color reflects relevance strength. */
const ScoreBadge: React.FC<{ score: number }> = ({ score }) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge variant={scoreVariant(score)}>
            <Gauge className="size-3" aria-hidden />
            score {score.toFixed(3)}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Hybrid retrieval relevance score (higher is a closer match)
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

/* ----------------------------------------------------------- chunk view ------- */

/** Render a single retrieval chunk — text is UNTRUSTED, always fenced. */
const ChunkBlock: React.FC<{ chunk: RagChunk; index: number; rank?: number }> = ({
  chunk,
  index,
  rank,
}) => {
  const chunkIdx = typeof chunk.chunk_index === 'number' ? chunk.chunk_index : index;
  return (
    <div className="rounded-md border border-border bg-surface p-3.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {typeof rank === 'number' ? (
          <Badge variant="default">#{rank}</Badge>
        ) : null}
        <Badge variant="outline">
          <Layers className="size-3" aria-hidden />
          chunk {chunkIdx}
        </Badge>
        <SourceBadge source={chunk.source} />
        {typeof chunk.score === 'number' ? <ScoreBadge score={chunk.score} /> : null}
      </div>
      <CodeBlock value={chunk.text || ''} wrap copyable />
    </div>
  );
};

/* ----------------------------------------------------------- document drill --- */

const DocumentSheet: React.FC<{
  documentId: string | null;
  onClose: () => void;
  /** Hands focus back to the control that opened the sheet (SPEC §3.3). */
  onCloseAutoFocus?: (event: Event) => void;
}> = ({ documentId, onClose, onCloseAutoFocus }) => {
  const [doc, setDoc] = React.useState<RagDocument | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [filter, setFilter] = React.useState('');

  React.useEffect(() => {
    if (!documentId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setDoc(null);
    setFilter('');
    void (async () => {
      try {
        const res = await api.ragDocument(documentId);
        if (alive) setDoc(res);
      } catch (e) {
        if (alive) setError(e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [documentId]);

  const chunks = React.useMemo(() => doc?.chunks ?? [], [doc?.chunks]);
  const shownChunks = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return chunks;
    return chunks.filter((c) => (c.text || '').toLowerCase().includes(q));
  }, [chunks, filter]);

  const chunkCount = doc?.chunk_count ?? chunks.length;

  return (
    <Sheet open={!!documentId} onOpenChange={(o) => !o && onClose()}>
      {/* Pinned header (with the built-in close X) + an inner scroll region — never
          overflow-y-auto on SheetContent itself or the absolute X scrolls away (#19). */}
      <SheetContent side="right" size="lg" className="flex flex-col p-0" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader>
          {/* Title is UNTRUSTED — plain text. */}
          <SheetTitle className="pr-8 break-words">
            {doc?.title || 'Document'}
          </SheetTitle>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <SourceBadge source={doc?.source} />
            <Badge variant="outline">
              <FileText className="size-3" aria-hidden />
              {fmtNumber(chunkCount)} chunk{chunkCount === 1 ? '' : 's'}
            </Badge>
            {doc?.embedding_model ? (
              <Badge variant="outline">
                {doc.embedding_model}
                {typeof doc.dim === 'number' ? ` · ${doc.dim}d` : ''}
              </Badge>
            ) : null}
            {isSeedSource(doc?.source) ? (
              <Badge variant="warning">
                <Lock className="size-3" aria-hidden />
                Seed source
              </Badge>
            ) : null}
            {doc?.added_at ? (
              <span className="text-xs text-muted-foreground">
                Added {humanizeAge(doc.added_at)}
              </span>
            ) : null}
          </div>
          {doc?.tags && doc.tags.length ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {doc.tags.map((t) => (
                <Badge key={t} variant="outline">
                  <Tag className="size-3" aria-hidden />
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
          {error ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Could not load document</AlertTitle>
              <AlertDescription>{errorMessage(error, 'Request failed.')}</AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : chunks.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No chunks"
              description="This document produced no retrievable chunks."
            />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                These are the exact units the retriever returns. The investigator sees
                the highest-scoring chunks for a query, and the text is treated as
                untrusted evidence.
              </p>
              {chunks.length > 4 ? (
                <div className="space-y-1.5">
                  <Input
                    placeholder="Filter chunks by text…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter chunks"
                  />
                  <p className="text-xs text-muted-foreground">
                    {fmtNumber(shownChunks.length)} of {fmtNumber(chunks.length)} chunks
                  </p>
                </div>
              ) : null}
              <div className="flex flex-col gap-3">
                {shownChunks.map((ch, i) => (
                  <ChunkBlock
                    key={i}
                    chunk={ch}
                    index={ch.chunk_index ?? i}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

/* ------------------------------------------------------------------- import --- */

/**
 * Whether the import button should be enabled, keyed to the SAME signal `submit()`
 * indexes: when files are queued it indexes the queue (`queueValid`), otherwise the
 * pasted title+text (`hasPasted && !tooBig`). Branching on `hasPasted` alone let an
 * oversized queued file slip through / blocked a valid batch behind pasted text.
 */
export function computeImportCanSubmit(s: {
  batching: boolean;
  queueValid: boolean;
  hasPasted: boolean;
  tooBig: boolean;
  submitting: boolean;
}): boolean {
  return (s.batching ? s.queueValid : s.hasPasted && !s.tooBig) && !s.submitting;
}

/** One queued file waiting to be (or being) indexed. */
interface QueuedFile {
  name: string;
  text: string;
  bytes: number;
  tooBig: boolean;
}

export const ImportCard: React.FC<{ onImported?: () => void }> = () => {
  const navigate = useNavigateOptional();
  const jobSubmissionIntentRef = React.useRef<JobSubmissionIntent | null>(null);
  const [title, setTitle] = React.useState('');
  const [text, setText] = React.useState('');
  const [source, setSource] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);
  const tagDraft = usePendingTagDraft();
  const { settled: settleTags, reset: resetTagDraft } = tagDraft;
  const [submitting, setSubmitting] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [queue, setQueue] = React.useState<QueuedFile[]>([]);
  // The file <input> is uncontrolled — bump this key to reset its value after a read.
  const [pickerKey, setPickerKey] = React.useState(0);

  const bytes = React.useMemo(() => new Blob([text]).size, [text]);
  const tooBig = bytes > MAX_IMPORT_BYTES;
  const batching = queue.length > 0;
  const normalizedTags = React.useMemo(
    () => tags.map((tag) => tag.trim()).filter(Boolean),
    [tags],
  );
  const normalizedSource = source.trim() || undefined;
  const documents = React.useMemo(
    () =>
      batching
        ? queue.map((queued) => ({
            title: queued.name.replace(/\.[^.]+$/, ''),
            text: queued.text,
            source: normalizedSource,
            tags: normalizedTags,
          }))
        : [
            {
              title: title.trim(),
              text,
              source: normalizedSource,
              tags: normalizedTags,
            },
          ],
    [batching, normalizedSource, normalizedTags, queue, text, title],
  );
  const payloadBytes = React.useMemo(
    () => new Blob([JSON.stringify({ documents })]).size,
    [documents],
  );
  const titlesValid = documents.every(
    (document) =>
      document.title.length > 0 && document.title.length <= MAX_IMPORT_TITLE_CHARS,
  );
  const payloadValid = payloadBytes <= MAX_IMPORT_PAYLOAD_BYTES;
  const hasPasted =
    title.trim().length > 0 && text.trim().length > 0 && titlesValid && payloadValid;
  const queueValid =
    queue.length > 0 &&
    queue.length <= MAX_IMPORT_DOCUMENTS &&
    queue.every((queued) => !queued.tooBig) &&
    titlesValid &&
    payloadValid;
  const canSubmit = computeImportCanSubmit({ batching, queueValid, hasPasted, tooBig, submitting });

  const readFile = (file: File): Promise<QueuedFile> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const content = String(reader.result || '');
        const b = new Blob([content]).size;
        resolve({ name: file.name, text: content, bytes: b, tooBig: b > MAX_IMPORT_BYTES });
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsText(file);
    });

  const onPick = React.useCallback(
    async (files: FileList | null) => {
      setFileError(null);
      const list = files ? Array.from(files) : [];
      if (list.length === 0) {
        setQueue([]);
        return;
      }
      if (list.length > MAX_IMPORT_DOCUMENTS) {
        setQueue([]);
        setFileError(`Select at most ${MAX_IMPORT_DOCUMENTS} documents per import job.`);
        return;
      }
      // Single file + empty paste area → fill the paste fields inline (legacy flow).
      // Multiple files → queue them for sequential indexing.
      if (list.length === 1 && !text.trim()) {
        try {
          const qf = await readFile(list[0]);
          if (qf.tooBig) {
            setFileError(
              `"${qf.name}" is ${fmtNumber(qf.bytes)} bytes. Keep documents under ${MAX_IMPORT_LABEL}.`,
            );
            return;
          }
          setText(qf.text);
          setTitle((prev) => prev.trim() || list[0].name.replace(/\.[^.]+$/, ''));
          setQueue([]);
        } catch (e) {
          setFileError(errorMessage(e, 'Could not read file.'));
        }
        return;
      }
      try {
        const read = await Promise.all(list.map(readFile));
        setQueue(read);
      } catch (e) {
        setFileError(errorMessage(e, 'Could not read files.'));
      }
    },
    [text],
  );

  const reset = React.useCallback(() => {
    setTitle('');
    setText('');
    setSource('');
    resetTagDraft();
    setTags([]);
    setQueue([]);
    setFileError(null);
    setPickerKey((k) => k + 1);
  }, [resetTagDraft]);

  const submit = React.useCallback(async () => {
    // Text typed into Tags but not added is never dropped silently: stop and ask.
    if (!settleTags()) return;
    const params = { documents };
    const intent = retainJobSubmissionIntent(
      jobSubmissionIntentRef.current,
      'rag_import',
      params,
    );
    jobSubmissionIntentRef.current = intent;
    setSubmitting(true);
    try {
      const job = await api.jobs.submit({
        kind: 'rag_import',
        idempotency_key: intent.idempotencyKey,
        params,
      });
      jobSubmissionIntentRef.current = null;
      announceJobAccepted(job);
      reset();
      toast.success(
        `${documents.length} document${documents.length === 1 ? '' : 's'} queued for indexing.`,
        {
          description: 'Indexing continues on the server after navigation or reload. Track progress in Inbox.',
          action: { label: 'Open Inbox', onClick: () => navigate('inbox') },
        },
      );
    } catch (e) {
      toast.error(errorMessage(e, 'Could not start the import job.'));
    } finally {
      setSubmitting(false);
    }
  }, [documents, navigate, reset, settleTags]);

  return (
    <Panel
      title="Import knowledge"
      caption="Paste text, or upload .txt, .md, .json or .csv files; each file becomes its own document the investigator can retrieve."
      className="flex h-full flex-col"
      data-testid="knowledge-import"
    >
      <div className="flex flex-1 flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rag-title">Title</Label>
            <Input
              id="rag-title"
              placeholder={batching ? 'From each filename' : 'e.g. Internal IP allocation guide'}
              value={batching ? '' : title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={batching}
            />
            {!batching && title.trim().length > MAX_IMPORT_TITLE_CHARS ? (
              <p className="text-xs text-critical">
                Keep the title to {MAX_IMPORT_TITLE_CHARS} characters or fewer.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rag-source">Source (optional)</Label>
            <Input
              id="rag-source"
              placeholder="manual"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A label that groups these in the corpus.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rag-text">Document text</Label>
          <Textarea
            id="rag-text"
            rows={6}
            placeholder="Paste the document text here, or upload files below…"
            value={batching ? '' : text}
            onChange={(e) => setText(e.target.value)}
            disabled={batching}
            className={cn(tooBig && 'border-critical focus-visible:ring-critical')}
          />
          <p className={cn('text-xs', tooBig ? 'text-critical' : 'text-muted-foreground')}>
            {batching
              ? 'Disabled while files are queued.'
              : tooBig
                ? `Too large. Keep documents under ${MAX_IMPORT_LABEL}.`
                : !payloadValid
                  ? 'This document and its metadata are too large for one durable job.'
                : `${fmtNumber(bytes)} bytes`}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="rag-files">Or upload files</Label>
          <Input
            id="rag-files"
            key={pickerKey}
            type="file"
            multiple
            accept={IMPORT_ACCEPT}
            onChange={(e) => void onPick(e.target.files)}
            className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border file:border-border file:bg-muted file:px-2 file:py-0.5"
          />
          <p className={cn('text-xs', fileError ? 'text-critical' : 'text-muted-foreground')}>
            {fileError ?? `Select one file to fill the editor, or up to ${MAX_IMPORT_DOCUMENTS} to batch-index.`}
          </p>
        </div>

        {batching ? (
          <div className="rounded-md bg-muted p-3.5">
            <p className="mb-2 text-sm font-medium text-foreground">
              {fmtNumber(queue.length)} file{queue.length === 1 ? '' : 's'} queued
            </p>
            <ul className="flex flex-col gap-1.5">
              {queue.map((q, i) => (
                <li key={`${q.name}-${i}`} className="flex items-center gap-2 text-xs">
                  <Badge variant={q.tooBig ? 'critical' : 'success'}>
                    {q.tooBig ? 'too big' : 'ready'}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono break-all">
                    {q.name}
                  </span>
                  <span className={cn(q.tooBig ? 'text-critical' : 'text-muted-foreground')}>
                    {fmtNumber(q.bytes)} B
                  </span>
                </li>
              ))}
            </ul>
            {!queueValid ? (
              <p className="mt-2 text-xs text-critical">
                {!titlesValid
                  ? `Every filename-derived title must be ${MAX_IMPORT_TITLE_CHARS} characters or fewer.`
                  : !payloadValid
                    ? 'This batch is too large for one durable job. Split it into smaller imports.'
                    : `Some files exceed ${MAX_IMPORT_LABEL}. Remove them and select again.`}
              </p>
            ) : null}
          </div>
        ) : null}

        <TagInput
          label="Tags (optional)"
          description="Applied to every imported document."
          placeholder="Type a tag and press Enter"
          value={tags}
          onChange={setTags}
          {...tagDraft.bind}
        />

        <div className="mt-auto flex items-center justify-end gap-2 pt-2">
          {hasPasted || batching ? (
            <Button variant="ghost" size="sm" onClick={reset} disabled={submitting}>
              <X aria-hidden />
              Clear
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            <Plus aria-hidden />
            {batching
              ? `Queue ${fmtNumber(queue.length)} document${queue.length === 1 ? '' : 's'}`
              : 'Queue document'}
          </Button>
        </div>
      </div>
    </Panel>
  );
};

/* --------------------------------------------------------- threat-intel import */

/**
 * Import a threat-intel note into the RAG corpus as source="threat_context". It is
 * retrieved + injected into investigations as a clearly-labelled TRUSTED fenced
 * block (the content itself is UNTRUSTED corpus material). Gated by rag:manage.
 */
export const ThreatIntelImportCard: React.FC<{ onImported?: () => void }> = () => {
  const navigate = useNavigateOptional();
  const jobSubmissionIntentRef = React.useRef<JobSubmissionIntent | null>(null);
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);
  const tagDraft = usePendingTagDraft();
  const { settled: settleTags, reset: resetTagDraft } = tagDraft;
  const [submitting, setSubmitting] = React.useState(false);

  const bytes = React.useMemo(() => new Blob([content]).size, [content]);
  const tooBig = bytes > MAX_IMPORT_BYTES;
  const titleTooLong = title.trim().length > MAX_IMPORT_TITLE_CHARS;
  const canSubmit =
    title.trim().length > 0 &&
    content.trim().length > 0 &&
    !titleTooLong &&
    !tooBig &&
    !submitting;

  const submit = React.useCallback(async () => {
    // Text typed into Tags but not added is never dropped silently: stop and ask.
    if (!settleTags()) return;
    const params = {
      documents: [
        {
          title: title.trim(),
          text: content,
          source: 'threat_context',
          tags: tags.map((tag) => tag.trim()).filter(Boolean),
        },
      ],
    };
    const intent = retainJobSubmissionIntent(
      jobSubmissionIntentRef.current,
      'rag_import',
      params,
    );
    jobSubmissionIntentRef.current = intent;
    setSubmitting(true);
    try {
      const job = await api.jobs.submit({
        kind: 'rag_import',
        idempotency_key: intent.idempotencyKey,
        params,
      });
      jobSubmissionIntentRef.current = null;
      announceJobAccepted(job);
      toast.success('Threat-intel indexing job accepted.', {
        description: 'Indexing continues on the server after navigation or reload.',
        action: { label: 'Open Inbox', onClick: () => navigate('inbox') },
      });
      setTitle('');
      setContent('');
      setTags([]);
      resetTagDraft();
    } catch (e) {
      toast.error(errorMessage(e, 'Could not start the threat-intel import job.'));
    } finally {
      setSubmitting(false);
    }
  }, [content, navigate, resetTagDraft, settleTags, tags, title]);

  return (
    <Panel
      title="Import threat intel"
      className="flex h-full flex-col"
      data-testid="knowledge-threat-import"
    >
      <div className="flex flex-1 flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Add a threat-intel note (actor TTPs, IOC writeups, advisories). It is indexed as{' '}
          <code className="font-mono text-xs">threat_context</code> and given to
          investigations in a clearly labelled, fenced block. The content is treated as
          untrusted evidence, never run as instructions.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="ti-title">Title</Label>
          <Input
            id="ti-title"
            placeholder="e.g. APT-XX credential-stuffing advisory"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          {titleTooLong ? (
            <p className="text-xs text-critical">
              Keep the title to {MAX_IMPORT_TITLE_CHARS} characters or fewer.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ti-content">Content</Label>
          <Textarea
            id="ti-content"
            rows={6}
            placeholder="Paste the threat-intel writeup, IOC list or advisory text"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className={cn(tooBig && 'border-critical focus-visible:ring-critical')}
          />
          <p className={cn('text-xs', tooBig ? 'text-critical' : 'text-muted-foreground')}>
            {tooBig ? `Too large. Keep notes under ${MAX_IMPORT_LABEL}.` : `${fmtNumber(bytes)} bytes`}
          </p>
        </div>
        <TagInput
          label="Tags (optional)"
          placeholder="Type a tag and press Enter"
          value={tags}
          onChange={setTags}
          {...tagDraft.bind}
        />
        <div className="mt-auto flex items-center justify-end gap-2 pt-2">
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            <Plus aria-hidden />
            Queue threat intel
          </Button>
        </div>
      </div>
    </Panel>
  );
};

/** Explicit lower-trust precedent ratification, executed as one durable server job. */
const PrecedentBootstrapCard: React.FC = () => {
  const navigate = useNavigateOptional();
  const jobSubmissionIntentRef = React.useRef<JobSubmissionIntent | null>(null);
  const [preview, setPreview] = React.useState<PrecedentBootstrapStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [acknowledgement, setAcknowledgement] = React.useState('');

  React.useEffect(() => {
    let live = true;
    void api
      .get<PrecedentBootstrapStatus>('rag/precedent/bootstrap')
      .then((next) => {
        if (live) setPreview(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  if (loading || !preview) return null;
  const exact = preview.acknowledgement_required;
  const ready = preview.tier_enabled && preview.pending > 0 && acknowledgement.trim() === exact;

  const submit = async () => {
    if (!ready || submitting) return;
    const params = {
      acknowledgement: acknowledgement.trim(),
      limit: Math.min(200, Math.max(1, preview.max_batch)),
      dry_run: false,
    };
    const intent = retainJobSubmissionIntent(
      jobSubmissionIntentRef.current,
      'precedent_bootstrap',
      params,
    );
    jobSubmissionIntentRef.current = intent;
    setSubmitting(true);
    try {
      const job = await api.jobs.submit({
        kind: 'precedent_bootstrap',
        idempotency_key: intent.idempotencyKey,
        params,
      });
      jobSubmissionIntentRef.current = null;
      announceJobAccepted(job);
      setAcknowledgement('');
      toast.success('Precedent bootstrap job accepted.', {
        description: 'Ratification and embedding continue server-side. Progress and the final lower-trust counts remain in Inbox.',
        action: { label: 'Open Inbox', onClick: () => navigate('inbox') },
      });
    } catch (cause) {
      toast.error(errorMessage(cause, 'Could not start the precedent bootstrap job.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Panel title="Lower-trust precedent bootstrap" data-testid="knowledge-precedent">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Ratify eligible model outcomes only into the explicitly capped{' '}
          <code className="font-mono text-xs">{preview.trust_class}</code> tier. This never
          fabricates analyst feedback, promotes trust or changes case decisions.
        </p>
        <div className="flex flex-wrap gap-2">
          <Badge variant={preview.tier_enabled ? 'success' : 'warning'}>
            {preview.tier_enabled ? 'Tier enabled' : 'Tier disabled'}
          </Badge>
          <Badge variant="outline">{fmtNumber(preview.pending)} pending</Badge>
          <Badge variant="outline">{fmtNumber(preview.eligible)} eligible</Badge>
        </div>
        {preview.does_not.slice(0, 3).map((statement) => (
          <p key={statement} className="text-xs leading-relaxed text-muted-foreground">
            {statement}
          </p>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="precedent-bootstrap-ack">
            Type the exact acknowledgement to start
          </Label>
          <code className="block break-words bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
            {exact}
          </code>
          <Input
            id="precedent-bootstrap-ack"
            value={acknowledgement}
            onChange={(event) => setAcknowledgement(event.target.value)}
            disabled={!preview.tier_enabled || preview.pending <= 0 || submitting}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex justify-end">
          <Button onClick={() => void submit()} disabled={!ready || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Start bootstrap job
          </Button>
        </div>
      </div>
    </Panel>
  );
};

/* ----------------------------------------------- threat-intel / resolved lists */

/** A compact, filtered list of corpus documents for one source kind. */
const CorpusSourceSection: React.FC<{
  icon: LucideIcon;
  title: string;
  description: string;
  match: (source?: string) => boolean;
  documents: RagDocument[];
  loading: boolean;
  emptyHint: string;
  onOpen: (id: string) => void;
}> = ({ icon: Icon, title, description, match, documents, loading, emptyHint, onOpen }) => {
  const rows = React.useMemo(
    () => documents.filter((d) => match(d.source)),
    [documents, match],
  );
  // F19: the document count sits in the title row (the panel's count), never beside the
  // description, so it cannot collide with a wrapped line.
  return (
    <Panel
      title={title}
      count={`${fmtNumber(rows.length)} ${rows.length === 1 ? 'doc' : 'docs'}`}
      data-testid={`knowledge-source-${title.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <p className="-mt-1 mb-3 text-sm text-muted-foreground">{description}</p>
      {loading && documents.length === 0 ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Icon} compact title="Nothing here yet" description={emptyHint} />
      ) : (
        <ul className="divide-y divide-border/70">
          {rows.map((d) => (
            <li
              key={d.document_id}
              className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0"
            >
              <button
                type="button"
                onClick={() => onOpen(d.document_id)}
                className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title={d.title || d.document_id}
              >
                {/* UNTRUSTED title → plain text. */}
                {d.title || d.document_id}
              </button>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {fmtNumber(d.chunk_count)} chunk{d.chunk_count === 1 ? '' : 's'}
              </span>
              {d.added_at ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {humanizeAge(d.added_at)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};

const isThreatContextSource = (s?: string): boolean =>
  (s || '').toLowerCase().includes('threat_context') ||
  (s || '').toLowerCase().includes('threat-context') ||
  (s || '').toLowerCase() === 'threat_intel';
const isResolvedCaseSource = (s?: string): boolean =>
  (s || '').toLowerCase().includes('resolved_case') ||
  (s || '').toLowerCase().includes('resolved-case');

/* ------------------------------------------------------------------- search --- */

const SearchCard: React.FC = () => {
  const [q, setQ] = React.useState('');
  const [lastQuery, setLastQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [results, setResults] = React.useState<RagChunk[] | null>(null);
  const [topK, setTopK] = React.useState(TOP_K_DEFAULT);

  const run = React.useCallback(async () => {
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    setLastQuery(query);
    try {
      const res = await api.ragSearch(query, topK);
      setResults(res.chunks ?? []);
    } catch (e) {
      setError(e);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [q, topK]);

  return (
    <Panel
      title="Try a retrieval"
      caption="The same chunks the investigator gets for a query, ranked by relevance."
      className="flex h-full flex-col"
      data-testid="knowledge-search"
    >
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="rag-query">Query</Label>
            <Input
              id="rag-query"
              placeholder="e.g. brute force from a known scanner"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void run();
                }
              }}
              aria-label="Retrieval query"
            />
          </div>
          <Button
            size="sm"
            onClick={() => void run()}
            disabled={!q.trim() || loading}
          >
            <Search aria-hidden />
            Run
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* NumberField keeps raw text while editing and clamps to [1,20] on blur, so
              the operator can clear/edit mid-entry (a raw type=number clamps per
              keystroke, snapping an empty field to 1). DESIGN_STANDARD §5.2. */}
          <NumberField
            label="Top-K results"
            description="How many ranked chunks to return."
            value={topK}
            onChange={setTopK}
            min={1}
            max={20}
            defaultValue={TOP_K_DEFAULT}
          />
          <div className="space-y-1.5">
            <Label htmlFor="rag-minsim">Min. similarity</Label>
            <Input id="rag-minsim" value={MIN_SIMILARITY_HINT} disabled aria-label="Minimum similarity" />
            <p className="text-xs text-muted-foreground">
              Retrieval floor (set on the backend).
            </p>
          </div>
        </div>

        <div className="flex-1">
          {error ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Search failed</AlertTitle>
              <AlertDescription>{errorMessage(error, 'Request failed.')}</AlertDescription>
            </Alert>
          ) : loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : results === null ? (
            <p className="text-xs text-muted-foreground">
              Run a query to preview the retrieved chunks.
            </p>
          ) : results.length === 0 ? (
            <EmptyState
              icon={Search}
              compact
              title="No matches"
              description="Nothing in the corpus scored above the retrieval floor for this query."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="default">
                  <Search className="size-3" aria-hidden />
                  {fmtNumber(results.length)} hit{results.length === 1 ? '' : 's'}
                </Badge>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  for "{lastQuery}", ranked highest-first
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {results.map((ch, i) => (
                  <ChunkBlock key={i} chunk={ch} index={i} rank={i + 1} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
};

/* -------------------------------------------------------------- documents ----- */

const DocumentsSection: React.FC<{
  documents: RagDocument[];
  loading: boolean;
  onOpen: (id: string) => void;
  /** `opener` is the row's Delete button, where focus returns if the delete is cancelled. */
  onDelete: (doc: RagDocument, opener: HTMLElement) => void;
  /** Whether the current user may delete (rag:manage); gates the per-row Delete. */
  canManage: boolean;
  /** Extra title-row actions (the page Refresh while the host owns the header). */
  actions?: React.ReactNode;
  /** The documents panel: the host finds the next row (or the heading) after a delete. */
  panelRef?: React.Ref<HTMLElement>;
}> = ({ documents, loading, onOpen, onDelete, canManage, actions, panelRef }) => {
  const [search, setSearch] = React.useState('');
  const [sourceFilter, setSourceFilter] = React.useState<string>('all');
  const [sort, setSort] = React.useState<SortState>({ id: 'added_at', dir: 'desc' });
  const [density, setDensity] = React.useState<Density>(readDensity);

  const changeDensity = React.useCallback((id: Density) => {
    setDensity(id);
    try {
      localStorage.setItem(DENSITY_LS_KEY, id);
    } catch {
      /* private mode / quota — density is non-critical, ignore */
    }
  }, []);

  const sourceFacet = React.useMemo(() => {
    const set = new Set<string>();
    for (const d of documents) if (d.source) set.add(d.source);
    return Array.from(set).sort();
  }, [documents]);

  // Drop a selected source that no longer exists so the list can't silently empty.
  React.useEffect(() => {
    if (sourceFilter !== 'all' && !sourceFacet.includes(sourceFilter)) {
      setSourceFilter('all');
    }
  }, [sourceFacet, sourceFilter]);

  const filteredSorted = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = documents.filter((d) => {
      if (sourceFilter !== 'all' && d.source !== sourceFilter) return false;
      if (!q) return true;
      const hay =
        `${d.title} ${d.source} ${(d.tags || []).join(' ')} ${d.document_id}`.toLowerCase();
      return hay.includes(q);
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    const field = sort.id as SortField;
    return [...rows].sort((a, b) => {
      switch (field) {
        case 'title':
          return (a.title || a.document_id).localeCompare(b.title || b.document_id) * dir;
        case 'source':
          return (a.source || '').localeCompare(b.source || '') * dir;
        case 'chunk_count':
          return ((a.chunk_count ?? 0) - (b.chunk_count ?? 0)) * dir;
        case 'added_at':
        default:
          return (a.added_at || '').localeCompare(b.added_at || '') * dir;
      }
    });
  }, [documents, search, sourceFilter, sort]);

  const compact = density === 'compact';
  const anyFilter = search.trim().length > 0 || sourceFilter !== 'all';

  const clearFilters = React.useCallback(() => {
    setSearch('');
    setSourceFilter('all');
  }, []);

  const columns = React.useMemo<DataTableColumn<RagDocument>[]>(() => {
    const cols: DataTableColumn<RagDocument>[] = [
      {
        id: 'title',
        header: 'Title',
        sortable: true,
        cell: (d) => (
          <div className="min-w-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(d.document_id);
              }}
              className="text-left font-semibold text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              {/* UNTRUSTED title → plain text. */}
              {d.title || d.document_id}
            </button>
            {!compact && d.tags && d.tags.length ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {d.tags.slice(0, 4).map((t) => (
                  <Badge key={t} variant="outline">
                    <Tag className="size-3" aria-hidden />
                    {t}
                  </Badge>
                ))}
                {d.tags.length > 4 ? (
                  <Badge variant="outline">+{d.tags.length - 4}</Badge>
                ) : null}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        sortable: true,
        width: '12rem',
        cell: (d) => (
          <div className="flex items-center gap-1.5">
            <SourceBadge source={d.source} />
            {isSeedSource(d.source) ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex text-warning">
                      <Lock className="size-3.5" aria-hidden />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Guarded seed corpus. Deleting it needs a second confirmation.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        ),
      },
      {
        id: 'chunk_count',
        header: 'Chunks',
        sortable: true,
        width: '6rem',
        align: 'right',
        cell: (d) => (
          <span className="tabular-nums">{fmtNumber(d.chunk_count)}</span>
        ),
      },
    ];

    if (!compact) {
      cols.push({
        id: 'embedding_model',
        header: 'Model',
        cell: (d) =>
          d.embedding_model ? (
            <span className="font-mono text-xs">
              {d.embedding_model}
              {typeof d.dim === 'number' ? ` · ${d.dim}d` : ''}
            </span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
      });
    }

    cols.push(
      {
        id: 'added_at',
        header: 'Added',
        sortable: true,
        width: '7rem',
        cell: (d) => (
          <span className="text-muted-foreground">{humanizeAge(d.added_at)}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        width: '6rem',
        align: 'right',
        cell: (d) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(d.document_id);
              }}
              aria-label="View document chunks"
            >
              <Search className="size-4" aria-hidden />
            </Button>
            {canManage ? (
              <Button
                variant="ghost"
                size="icon"
                // Neutral at rest; red only on hover, focus and in the confirm dialog.
                className="size-7 text-muted-foreground hover:text-critical-text focus-visible:text-critical-text"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(d, e.currentTarget);
                }}
                data-doc-delete=""
                aria-label="Delete from the corpus"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
        ),
      },
    );

    return cols;
  }, [compact, onOpen, onDelete, canManage]);

  const chips: FilterChip[] =
    sourceFilter !== 'all'
      ? [{ id: 'source', label: `Source: ${properName(sourceFilter)}`, onRemove: () => setSourceFilter('all') }]
      : [];
  const filtered = filteredSorted.length !== documents.length;

  return (
    <Panel
      ref={panelRef}
      title="Indexed documents"
      count={
        loading && documents.length === 0
          ? undefined
          : filtered
            ? `${fmtNumber(filteredSorted.length)} of ${fmtNumber(documents.length)} shown`
            : documents.length
      }
      padding="none"
      data-testid="knowledge-documents"
      actions={
        <>
          <SegmentedControl<Density>
            aria-label="Table density"
            size="sm"
            className="shrink-0"
            value={density}
            onValueChange={changeDensity}
            options={[
              { value: 'normal', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
          {actions}
        </>
      }
    >
      <div className="px-4 pb-3 xl:px-5 3xl:px-6">
        <FilterBar
          aria-label="Document filters"
          search={{
            value: search,
            onChange: setSearch,
            label: 'Search documents',
            placeholder: 'Search title, source, tags',
          }}
          filters={
            sourceFacet.length > 1
              ? [
                  {
                    id: 'source',
                    label: 'Source',
                    active: sourceFilter !== 'all',
                    control: ({ placement }) => (
                      <Select value={sourceFilter} onValueChange={setSourceFilter}>
                        <SelectTrigger
                          className={placement === 'bar' ? 'h-8 w-44' : 'h-9 w-full'}
                          aria-label="Filter by source"
                        >
                          <SelectValue placeholder="Source" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All sources</SelectItem>
                          {sourceFacet.map((src) => (
                            <SelectItem key={src} value={src}>
                              {properName(src)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ),
                  },
                ]
              : []
          }
          chips={chips}
          onClearAll={anyFilter ? clearFilters : undefined}
        />
      </div>

      {!loading && documents.length === 0 ? (
        <div className="border-t border-border/70">
          <EmptyState
            icon={FileText}
            title="The corpus is empty"
            description="Import a document above, or publish runbooks to populate retrieval knowledge."
          />
        </div>
      ) : !loading && filteredSorted.length === 0 ? (
        <div className="border-t border-border/70">
          <EmptyState
            icon={Search}
            title="No documents match"
            description="No indexed documents match the current filters. Clear them to see all documents."
            action={
              <Button size="sm" variant="outline" onClick={clearFilters}>
                <X aria-hidden />
                Clear filters
              </Button>
            }
          />
        </div>
      ) : (
        <DataTable<RagDocument>
          columns={columns}
          rows={filteredSorted}
          getRowId={(d) => d.document_id}
          sort={sort}
          onSortChange={setSort}
          onRowClick={(d) => onOpen(d.document_id)}
          // The visible "View document chunks" button already provides the named
          // keyboard action; avoid duplicating it with the shared trailing chevron.
          showRowAction={false}
          loading={loading && documents.length === 0}
          density={density}
          surface="panel"
          ariaLabel="Indexed RAG documents"
        />
      )}
    </Panel>
  );
};

/* ------------------------------------------------------------- delete dialog -- */

interface PendingDelete {
  doc: RagDocument;
  force: boolean;
  guard: string | null;
}

const DeleteDialog: React.FC<{
  pending: PendingDelete | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** Hands focus back to the Delete button that opened the dialog (SPEC §3.3). */
  onCloseAutoFocus?: (event: Event) => void;
}> = ({ pending, deleting, onCancel, onConfirm, onCloseAutoFocus }) => {
  if (!pending) return null;
  const { doc, force, guard } = pending;
  const seed = isSeedSource(doc.source);
  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          {/* UNTRUSTED title → plain text. */}
          <DialogTitle className="break-words">Delete "{doc.title}"?</DialogTitle>
          <DialogDescription>
            Remove this document and its {fmtNumber(doc.chunk_count)} chunk
            {doc.chunk_count === 1 ? '' : 's'} from the retrieval corpus. The agents will
            no longer retrieve it.
          </DialogDescription>
        </DialogHeader>

        {force && !guard && seed ? (
          <Alert variant="warning">
            <Lock aria-hidden />
            <AlertTitle>Guarded seed source</AlertTitle>
            <AlertDescription>
              This is built-in seed knowledge ({properName(doc.source)}). Deleting it
              force-removes it from the corpus until the backend re-seeds.
            </AlertDescription>
          </Alert>
        ) : null}
        {guard ? (
          <Alert variant="warning">
            <Lock aria-hidden />
            <AlertTitle>Guarded source</AlertTitle>
            <AlertDescription>
              {/* guard message is backend-derived → plain text */}
              <p>{guard}</p>
              <p>Confirm again to force-delete it anyway.</p>
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            <Trash2 aria-hidden />
            {force ? 'Force delete' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* -------------------------------------------------------------------- page ---- */

export interface KnowledgeProps {
  onNavigate?: Navigate;
  /**
   * When hosted as a tab inside the Intelligence scaffold (Round-2 W4 consolidation),
   * suppress the page's own PageHeader and width container. The host owns the one
   * page title and width authority; this leaf contributes only a labelled control row.
   */
  embedded?: boolean;
}

/** The standalone page help (the Intelligence host has its own). */
const PAGE_HELP =
  'The retrieval corpus the investigator draws on. Import, inspect and search the index ' +
  'to see exactly what the agents know. Retrieved text is treated as untrusted evidence: ' +
  'it is fenced when shown to the investigator and never run as instructions.';

export default function Knowledge({ embedded = false }: KnowledgeProps = {}) {
  const [stats, setStats] = React.useState<RagStats | null>(null);
  const [documents, setDocuments] = React.useState<RagDocument[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const [selectedDoc, setSelectedDoc] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, d] = await Promise.all([api.ragStats(), api.ragDocuments()]);
      setStats(s);
      setDocuments(d.documents ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The document sheet and the delete dialog open from state, so each remembers the
  // control that opened it and hands focus back on close (SPEC §3.3).
  const docOpener = useReturnFocus();
  const deleteOpener = useReturnFocus();
  const openDocument = React.useCallback(
    (documentId: string) => {
      docOpener.remember();
      setSelectedDoc(documentId);
    },
    [docOpener],
  );

  // A confirmed delete removes the row (and its Delete button) when the list reloads,
  // after the dialog has closed: focus then moves to the next row's Delete, else the
  // documents heading, never to the page body.
  const documentsRef = React.useRef<HTMLElement>(null);
  const requestDelete = React.useCallback((doc: RagDocument, opener: HTMLElement) => {
    deleteOpener.remember(opener, {
      peers: () => documentsRef.current?.querySelectorAll('[data-doc-delete]') ?? [],
      empty: () => headingOf(documentsRef.current),
    });
    setPending({ doc, force: isSeedSource(doc.source), guard: null });
  }, [deleteOpener]);

  const runDelete = React.useCallback(async () => {
    if (!pending) return;
    const { doc, force } = pending;
    setDeleting(true);
    try {
      await api.ragDeleteDocument(doc.document_id, force);
      toast.success(`Deleted "${doc.title}".`);
      deleteOpener.expectRemoval();
      setPending(null);
      void load();
    } catch (e) {
      // A 400 on a guarded seed source: keep the dialog open and offer a force retry.
      if (e instanceof ApiError && e.status === 400 && !force) {
        setPending({
          doc,
          force: true,
          guard: e.message || 'This document is a guarded seed source.',
        });
      } else {
        toast.error(errorMessage(e, 'Delete failed.'));
        setPending(null);
      }
    } finally {
      setDeleting(false);
    }
  }, [pending, load, deleteOpener]);

  /* ---- derived ---- */
  // IN4: one series colour (the shared accent bar), never a colour per source name.
  const bySourceItems = React.useMemo<BarListItem[]>(() => {
    const by = stats?.by_source ?? {};
    return Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({
        label: properName(label),
        value,
      }));
  }, [stats]);

  const totalDocs = stats?.document_count ?? documents.length;
  const totalChunks = stats?.total_chunks ?? 0;
  const avgChunks = totalDocs > 0 ? Math.round(totalChunks / totalDocs) : 0;
  const corpusTotalChunks = React.useMemo(
    () => bySourceItems.reduce((s, x) => s + Math.max(0, x.value), 0) || totalChunks,
    [bySourceItems, totalChunks],
  );

  const showHealthSkeleton = loading && !stats;
  const canManageRag = useCan('rag', 'manage');
  const canWriteCases = useCan('cases', 'write');
  // A hard load failure with NO cached data: show one clean LoadError instead of
  // zeroed KPIs + a false "corpus is empty" state below it.
  const hardLoadFail = !!error && !stats;

  const refreshAction = (
    <RefreshButton
      onClick={() => void load()}
      refreshing={loading}
      label="Refresh knowledge"
      display="icon"
    />
  );
  const shareOf = (n: number) =>
    corpusTotalChunks > 0 ? `${fmtNumber(n)} · ${Math.round((n / corpusTotalChunks) * 100)}%` : fmtNumber(n);

  const content = (
    <>
      {embedded ? null : (
        <PageHeader title="Knowledge & RAG" help={PAGE_HELP} controls={refreshAction} />
      )}

      {error ? (
        <LoadError
          error={error}
          title="Could not load the knowledge corpus"
          fallback="Request failed."
          onRetry={() => void load()}
        />
      ) : null}

      {showHealthSkeleton ? (
        <LoadingState
          layout="panel"
          shape="panel"
          label="Loading knowledge corpus"
          description="Preparing corpus health, sources, and indexed documents."
        />
      ) : hardLoadFail ? null : (
        <>
      {/* ---- corpus health counts ---- */}
      <KpiStrip label="Corpus summary" density="compact" data-testid="knowledge-summary">
        <KpiTile
          label="Total chunks"
          value={fmtNumber(totalChunks)}
          context={avgChunks > 0 ? `about ${fmtNumber(avgChunks)} per document` : undefined}
        />
        <KpiTile
          label="Documents"
          value={fmtNumber(totalDocs)}
          context={
            bySourceItems.length
              ? `${fmtNumber(bySourceItems.length)} source${bySourceItems.length === 1 ? '' : 's'}`
              : undefined
          }
        />
        <KpiTile
          label="Vector dimensions"
          value={typeof stats?.dim === 'number' ? fmtNumber(stats.dim) : DASH}
        />
      </KpiStrip>

      {/* ---- corpus by source (with the embedding model as a plain line) ---- */}
      <Panel
        title="Corpus by source"
        count={`${fmtNumber(corpusTotalChunks)} chunk${corpusTotalChunks === 1 ? '' : 's'}`}
        aside={
          <span data-testid="knowledge-embedding-model">
            Embedding model{' '}
            <span className="font-mono text-foreground">{stats?.embedding_model || DASH}</span>
          </span>
        }
        data-testid="knowledge-by-source"
      >
        {bySourceItems.length ? (
          <BarList items={bySourceItems} format={shareOf} />
        ) : (
          <p className="text-sm text-muted-foreground">No sources indexed yet.</p>
        )}
      </Panel>

      {/* ---- threat intel + resolved cases (F11) ---- */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:gap-5 3xl:gap-6">
        <CorpusSourceSection
          icon={ShieldAlert}
          title="Threat intel"
          description="Imported threat-intel notes (source threat_context) the investigator can retrieve."
          match={isThreatContextSource}
          documents={documents}
          loading={loading}
          emptyHint="Import a threat-intel note below to seed this corpus."
          onOpen={openDocument}
        />
        <CorpusSourceSection
          icon={CheckCircle2}
          title="Resolved cases"
          description="Closed and resolved cases, indexed automatically (source resolved_case) so future triage learns from them."
          match={isResolvedCaseSource}
          documents={documents}
          loading={loading}
          emptyHint="Resolved cases are indexed automatically when a case closes."
          onOpen={openDocument}
        />
      </div>

      {/* ---- import + search ---- */}
      {/* Import is rag:manage; read-only roles (auditor/tier1/tier2/responder) get
          search only, with no import affordance that always 403s. */}
      {canManageRag ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:gap-5 3xl:gap-6">
          <ImportCard onImported={load} />
          <SearchCard />
        </div>
      ) : (
        <SearchCard />
      )}

      {/* ---- threat-intel import (rag:manage) ---- */}
      {canManageRag ? (
        <Can resource="rag" action="manage">
          <ThreatIntelImportCard onImported={load} />
        </Can>
      ) : null}

      {canManageRag && canWriteCases ? <PrecedentBootstrapCard /> : null}

      {/* ---- documents table ---- */}
      <DocumentsSection
        documents={documents}
        loading={loading}
        onOpen={openDocument}
        onDelete={requestDelete}
        canManage={canManageRag}
        panelRef={documentsRef}
        actions={embedded ? refreshAction : undefined}
      />

      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>
          Retrieved text is treated as untrusted evidence. It is fenced when shown to the
          investigator and never run as instructions.
        </p>
      </div>
        </>
      )}

      <DocumentSheet
        documentId={selectedDoc}
        onClose={() => setSelectedDoc(null)}
        onCloseAutoFocus={docOpener.onCloseAutoFocus}
      />
      <DeleteDialog
        pending={pending}
        deleting={deleting}
        onCloseAutoFocus={deleteOpener.onCloseAutoFocus}
        onCancel={() => setPending(null)}
        onConfirm={() => void runDelete()}
      />
    </>
  );

  if (embedded) {
    return (
      <section className="flex flex-col gap-4 xl:gap-5 3xl:gap-6" aria-label="Knowledge corpus workspace">
        {content}
      </section>
    );
  }

  return <PageContainer variant="wide">{content}</PageContainer>;
}
