/**
 * Round 15 (SPEC D5.12): the Files section of a case, a kit WP7 mounts in the
 * Collaboration tab. A thumbnail grid (caption, who added it, when), a lightbox, a
 * download, and a delete for the uploader or someone who can close cases; uploads by
 * drop, paste or the file picker when the caller holds `cases:comment`.
 *
 * Image bytes are fetched with the shared request helpers as Blobs (never a plain
 * `<img src>` to the API), shown through object URLs, and every object URL is revoked
 * when it is no longer shown. The lightbox is a Radix dialog that always has a
 * DialogTitle: the caption when there is one, else a visually hidden "Screenshot N of
 * M". Captions, filenames and names are text a person typed: text nodes only (#9).
 */
import * as React from 'react';
import { ChevronLeft, ChevronRight, Download, ImageOff, Loader2, Trash2 } from 'lucide-react';

import { fetchCaseFileBlob, deleteCaseFile, listCaseFiles } from '@/lib/api-case-files';
import { cn } from '@/lib/cn';
import { downloadBlob } from '@/lib/download-blob';
import { errorMessage } from '@/lib/errorMessage';
import { formatTimestamp, humanizeAge } from '@/lib/format';
import { focusRing } from '@/lib/ui-recipes';
import type { CaseFileEntry, CaseFileList, CaseFileVariant } from '@/lib/types-case-files';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { EmptyState } from '@/soc/components/EmptyState';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';

import { FileDropZone } from './FileDropZone';
import { releaseShownBlob, showBlob } from './object-url';
import { useCaseFileUpload } from './useCaseFileUpload';
import type { UseCaseFileUploadOptions } from './useCaseFileUpload';

const STATUS_WORDS: Record<string, string> = {
  queued: 'waiting',
  preparing: 'preparing',
  uploading: 'uploading',
  done: 'added',
};

/** "812 KB", "1.4 MB": a stored size in plain words. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;
  }
  return `${Math.max(1, Math.ceil(bytes / 1024)).toLocaleString('en-US')} KB`;
}

/** The lightbox title: the caption, else "Screenshot N of M". */
export function screenshotTitle(entry: CaseFileEntry, index: number, total: number): string {
  return entry.caption.trim() || `Screenshot ${(index + 1).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

/** A Blob as an object URL for as long as it is shown (revoked on change and unmount). */
export function useCaseFileUrl(
  caseId: string,
  fileId: string | null,
  variant: CaseFileVariant,
  fetcher: typeof fetchCaseFileBlob = fetchCaseFileBlob,
): { url: string | null; failed: boolean } {
  const [state, setState] = React.useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  React.useEffect(() => {
    if (!fileId) {
      setState({ url: null, failed: false });
      return undefined;
    }
    const controller = new AbortController();
    let url: string | null = null;
    setState({ url: null, failed: false });
    fetcher(caseId, fileId, { variant, signal: controller.signal })
      .then(({ blob }) => {
        if (controller.signal.aborted) return;
        url = showBlob(blob);
        setState({ url, failed: url === null });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ url: null, failed: true });
      });
    return () => {
      controller.abort();
      releaseShownBlob(url);
    };
  }, [caseId, fileId, variant, fetcher]);
  return state;
}

interface ThumbProps {
  caseId: string;
  entry: CaseFileEntry;
  index: number;
  total: number;
  onOpen: () => void;
  fetcher: typeof fetchCaseFileBlob;
}

function FileThumb({ caseId, entry, index, total, onOpen, fetcher }: ThumbProps) {
  const { url, failed } = useCaseFileUrl(caseId, entry.id, 'thumb', fetcher);
  const title = screenshotTitle(entry, index, total);
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${title}`}
        className={cn(
          'flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40',
          'transition-colors hover:border-primary',
          focusRing,
        )}
      >
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : failed ? (
          <ImageOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
      </button>
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground" title={entry.caption || undefined}>
          {entry.caption || entry.filename || `Screenshot ${(index + 1).toLocaleString('en-US')}`}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {entry.uploaded_by || 'Someone'} ·{' '}
          <time dateTime={entry.uploaded_at} title={formatTimestamp(entry.uploaded_at)}>
            {humanizeAge(entry.uploaded_at)}
          </time>
        </p>
      </div>
    </li>
  );
}

interface LightboxProps {
  caseId: string;
  files: CaseFileEntry[];
  index: number | null;
  onIndexChange: (index: number | null) => void;
  onDelete: (entry: CaseFileEntry) => void;
  fetcher: typeof fetchCaseFileBlob;
}

function Lightbox({ caseId, files, index, onIndexChange, onDelete, fetcher }: LightboxProps) {
  const open = index !== null && index >= 0 && index < files.length;
  const entry = open ? files[index as number] : null;
  const { url, failed } = useCaseFileUrl(caseId, entry?.id ?? null, 'full', fetcher);
  const [downloading, setDownloading] = React.useState(false);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const total = files.length;
  const position = (index ?? 0) + 1;

  const go = React.useCallback(
    (delta: number) => {
      if (index === null || total < 2) return;
      onIndexChange((index + delta + total) % total);
    },
    [index, total, onIndexChange],
  );

  const download = async () => {
    if (!entry) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const { blob, filename } = await fetcher(caseId, entry.id, { download: true });
      if (!downloadBlob(filename, blob)) setDownloadError('This browser cannot save files here.');
    } catch (e) {
      setDownloadError(errorMessage(e, 'The screenshot could not be downloaded.'));
    } finally {
      setDownloading(false);
    }
  };

  const title = entry ? screenshotTitle(entry, index as number, total) : 'Screenshot';
  const hasCaption = Boolean(entry?.caption.trim());

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onIndexChange(null)}>
      <DialogContent
        className="max-w-5xl"
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            go(1);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            go(-1);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className={cn('text-base', !hasCaption && 'sr-only')}>{title}</DialogTitle>
          <DialogDescription>
            {entry ? (
              <>
                {`${position.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} · `}
                {`Added by ${entry.uploaded_by || 'someone'} ${humanizeAge(entry.uploaded_at)} · `}
                {`${entry.width.toLocaleString('en-US')} by ${entry.height.toLocaleString('en-US')} pixels, ${formatFileSize(entry.bytes)}`}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-md bg-muted/40">
          {url ? (
            <img src={url} alt={title} className="max-h-[70dvh] w-auto max-w-full object-contain" />
          ) : failed ? (
            <EmptyState compact state="error" title="The screenshot could not be loaded." />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading the screenshot" />
          )}
        </div>
        {entry?.filename ? <p className="truncate text-xs text-muted-foreground">{entry.filename}</p> : null}
        {downloadError ? (
          <p role="alert" className="text-sm text-critical-text">
            {downloadError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => go(-1)} disabled={total < 2}>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Previous
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => go(1)} disabled={total < 2}>
              Next
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={download} disabled={!entry || downloading}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Download
            </Button>
            {entry?.can_delete ? (
              <Button type="button" variant="outline" size="sm" onClick={() => onDelete(entry)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface CaseFilesProps {
  caseId: string;
  /** Bump to re-read the list (a `case.activity` frame naming a file, WP7). */
  refreshKey?: number;
  /** Where a paste adds screenshots (the Collaboration tab). Defaults to the drop zone. */
  pasteScopeRef?: React.RefObject<HTMLElement | null>;
  /** Called with the live count after every read. */
  onCountChange?: (count: number) => void;
  /** Injectable for tests. */
  api?: {
    list?: typeof listCaseFiles;
    remove?: typeof deleteCaseFile;
    fetchBlob?: typeof fetchCaseFileBlob;
  };
  /** Injectable for tests (`useCaseFileUpload` options other than the case). */
  uploadOptions?: Omit<UseCaseFileUploadOptions, 'caseId' | 'onUploaded'>;
}

export function CaseFiles({ caseId, refreshKey = 0, pasteScopeRef, onCountChange, api, uploadOptions }: CaseFilesProps) {
  // Callbacks a host passes may be new on every render: read them through a ref, so
  // a re-render never re-reads the list or re-fetches an image.
  const props = React.useRef({ api, onCountChange });
  props.current = { api, onCountChange };
  const list = React.useCallback<typeof listCaseFiles>(
    (id, signal) => (props.current.api?.list ?? listCaseFiles)(id, signal),
    [],
  );
  const remove = React.useCallback<typeof deleteCaseFile>(
    (id, fileId) => (props.current.api?.remove ?? deleteCaseFile)(id, fileId),
    [],
  );
  const fetcher = React.useCallback<typeof fetchCaseFileBlob>(
    (id, fileId, options) => (props.current.api?.fetchBlob ?? fetchCaseFileBlob)(id, fileId, options),
    [],
  );
  const [data, setData] = React.useState<CaseFileList | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<CaseFileEntry | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [caption, setCaption] = React.useState('');
  const captionId = React.useId();

  React.useEffect(() => {
    const controller = new AbortController();
    list(caseId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setLoadError(null);
        props.current.onCountChange?.(next.count);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(e, 'Screenshots could not be loaded.'));
      });
    return () => controller.abort();
  }, [caseId, refreshKey, reload, list]);

  const refresh = React.useCallback(() => setReload((n) => n + 1), []);
  const uploader = useCaseFileUpload({ ...uploadOptions, caseId, onUploaded: refresh });

  const files = data?.files ?? [];
  const limits = data?.limits;
  const full = Boolean(limits && files.length >= limits.max_files);
  const canUpload = Boolean(data?.can_upload) && !full;

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await remove(caseId, pendingDelete.id);
      setPendingDelete(null);
      setOpenIndex(null);
      refresh();
    } catch (e) {
      setDeleteError(errorMessage(e, 'The screenshot could not be deleted.'));
    } finally {
      setDeleting(false);
    }
  };

  const active = uploader.items.filter((item) => item.status !== 'done');

  return (
    <section aria-labelledby={`${captionId}-heading`} className="flex flex-col gap-3" data-testid="case-files">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={`${captionId}-heading`} className="text-sm font-semibold text-foreground">
          Screenshots
        </h3>
        {limits ? (
          <span className="text-xs text-muted-foreground">
            {`${files.length.toLocaleString('en-US')} of ${limits.max_files.toLocaleString('en-US')}`}
          </span>
        ) : null}
      </div>

      {loadError ? (
        <div className="flex items-center gap-3 text-sm">
          <p role="alert" className="text-critical-text">
            {loadError}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      ) : null}

      {data?.can_upload ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={captionId} className="text-xs font-medium text-muted-foreground">
            Caption for the next screenshots (optional)
          </label>
          <Input
            id={captionId}
            value={caption}
            maxLength={limits?.max_caption_chars ?? 200}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="What this shows"
            disabled={!canUpload}
          />
          <FileDropZone
            onFiles={(picked) => {
              const room = limits ? Math.max(0, limits.max_files - files.length) : picked.length;
              void uploader.uploadFiles(picked.slice(0, room), caption).then((added) => {
                if (added.length) setCaption('');
              });
            }}
            disabled={!canUpload}
            busy={uploader.busy}
            pasteScopeRef={pasteScopeRef}
            hint={full ? 'This case has reached its screenshot limit. Delete one to add another.' : undefined}
          />
        </div>
      ) : null}

      {active.length ? (
        <ul className="flex flex-col gap-1 text-xs" aria-live="polite">
          {active.map((item) => (
            <li key={item.key} className={cn('truncate', item.status === 'error' ? 'text-critical-text' : 'text-muted-foreground')}>
              {item.status === 'error'
                ? `${item.name}: ${item.message ?? 'not added.'}`
                : `${item.name}: ${STATUS_WORDS[item.status]}`}
            </li>
          ))}
        </ul>
      ) : null}

      {data && !files.length && !data.can_upload ? (
        <EmptyState compact state="no-data" title="No screenshots on this case." />
      ) : null}

      {files.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" aria-label="Screenshots">
          {files.map((entry, index) => (
            <FileThumb
              key={entry.id}
              caseId={caseId}
              entry={entry}
              index={index}
              total={files.length}
              onOpen={() => setOpenIndex(index)}
              fetcher={fetcher}
            />
          ))}
        </ul>
      ) : null}

      <Lightbox
        caseId={caseId}
        files={files}
        index={openIndex}
        onIndexChange={setOpenIndex}
        onDelete={(entry) => {
          // One modal at a time: the lightbox closes before the confirmation opens.
          setOpenIndex(null);
          setDeleteError(null);
          setPendingDelete(entry);
        }}
        fetcher={fetcher}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next && !deleting) setPendingDelete(null);
        }}
        title="Delete this screenshot?"
        description={
          deleteError ??
          'The image is removed from the case. Its caption, who added it and when stay in the case history.'
        }
        confirmLabel="Delete screenshot"
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
