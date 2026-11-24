/**
 * Round 15 (SPEC D4.6, D5.12): upload screenshots to a case. Each file is prepared in
 * the browser (`image-encode.ts`: redraw, metadata gone, the 2 MB ladder, a thumbnail)
 * and posted at once, one at a time (a second batch waits for the first), through
 * `lib/api-case-files.ts`. The close dialog
 * never waits for an upload and never rolls one back: a caller only reads `items` to
 * show progress.
 *
 * `prepare` and `upload` are injectable so the hook is testable without a canvas.
 */
import * as React from 'react';

import { ApiError } from '@/lib/api';
import { uploadCaseFile } from '@/lib/api-case-files';
import { errorMessage } from '@/lib/errorMessage';
import type { CaseFileEntry, CaseFileUploadBody, CaseFileUploadResult } from '@/lib/types-case-files';

import { blobToBase64, prepareScreenshot, ScreenshotPrepError } from './image-encode';
import type { PreparedScreenshot } from './image-encode';

export type UploadStatus = 'queued' | 'preparing' | 'uploading' | 'done' | 'error';

export interface UploadItem {
  key: string;
  /** The picked file's name, shown as plain text. */
  name: string;
  status: UploadStatus;
  /** Plain Console copy for an error. */
  message?: string;
  entry?: CaseFileEntry;
  deduplicated?: boolean;
}

export interface UseCaseFileUploadOptions {
  caseId: string;
  /** Called after each successful upload (also for the same image again). */
  onUploaded?: (entry: CaseFileEntry, deduplicated: boolean) => void;
  prepare?: (file: Blob) => Promise<PreparedScreenshot>;
  upload?: (caseId: string, body: CaseFileUploadBody) => Promise<CaseFileUploadResult>;
  toBase64?: (blob: Blob) => Promise<string>;
}

/** Plain copy for the refusals a person can act on; anything else uses the server text. */
const CODE_MESSAGES: Record<string, string> = {
  case_files_busy: 'Too many uploads at once. Try again in a moment.',
  case_files_case_full: 'This case has reached its screenshot limit. Delete one to add another.',
  case_files_storage_full: 'Screenshot storage is full. Ask an administrator to free space.',
  case_files_body_too_large: 'That image is too large to upload.',
};

function codeOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { detail?: { code?: unknown } } | undefined;
  const code = body?.detail?.code;
  return typeof code === 'string' ? code : null;
}

export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ScreenshotPrepError) return error.message;
  const code = codeOf(error);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  return errorMessage(error, 'The screenshot could not be added.');
}

let counter = 0;
const nextKey = () => `upload-${Date.now().toString(36)}-${(counter += 1)}`;

export interface CaseFileUploader {
  items: UploadItem[];
  busy: boolean;
  /** Prepare and upload `files` in order; resolves with the entries that were added. */
  uploadFiles: (files: readonly File[], caption?: string) => Promise<CaseFileEntry[]>;
  /** Forget finished items (done and failed). */
  clearFinished: () => void;
}

export function useCaseFileUpload(options: UseCaseFileUploadOptions): CaseFileUploader {
  const { caseId, onUploaded } = options;
  const prepare = options.prepare ?? prepareScreenshot;
  const upload = options.upload ?? uploadCaseFile;
  const toBase64 = options.toBase64 ?? blobToBase64;
  const [items, setItems] = React.useState<UploadItem[]>([]);
  const [running, setRunning] = React.useState(0);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const patch = React.useCallback((key: string, change: Partial<UploadItem>) => {
    if (!mounted.current) return;
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  /** Prepare and post one batch, one file at a time. */
  const runBatch = React.useCallback(
    async (queued: ReadonlyArray<{ file: File; key: string }>, caption: string): Promise<CaseFileEntry[]> => {
      const added: CaseFileEntry[] = [];
      try {
        for (const { file, key } of queued) {
          patch(key, { status: 'preparing' });
          try {
            const prepared = await prepare(file);
            patch(key, { status: 'uploading' });
            const body: CaseFileUploadBody = {
              data_base64: await toBase64(prepared.image.blob),
              content_type: prepared.image.type,
              thumbnail_base64: prepared.thumbnail ? await toBase64(prepared.thumbnail.blob) : null,
              filename: file.name || '',
              caption: caption.trim().slice(0, 200),
            };
            const result = await upload(caseId, body);
            patch(key, { status: 'done', entry: result.file, deduplicated: result.deduplicated });
            added.push(result.file);
            onUploaded?.(result.file, result.deduplicated);
          } catch (error) {
            patch(key, { status: 'error', message: uploadErrorMessage(error) });
          }
        }
      } finally {
        if (mounted.current) setRunning((n) => Math.max(0, n - 1));
      }
      return added;
    },
    [caseId, onUploaded, patch, prepare, toBase64, upload],
  );

  // Batches run one after another (a drop while an upload runs waits its turn), so a
  // person never has more uploads in flight than the server allows.
  const chain = React.useRef<Promise<unknown>>(Promise.resolve());

  const uploadFiles = React.useCallback(
    (files: readonly File[], caption = ''): Promise<CaseFileEntry[]> => {
      const queued = files.map((file) => ({ file, key: nextKey() }));
      if (!queued.length) return Promise.resolve([]);
      setItems((current) => [
        ...current,
        ...queued.map(({ file, key }) => ({ key, name: file.name || 'Pasted image', status: 'queued' as const })),
      ]);
      setRunning((n) => n + 1);
      const run = chain.current.then(() => runBatch(queued, caption));
      chain.current = run.catch(() => undefined);
      return run;
    },
    [runBatch],
  );

  const clearFinished = React.useCallback(() => {
    setItems((current) => current.filter((item) => item.status !== 'done' && item.status !== 'error'));
  }, []);

  return { items, busy: running > 0, uploadFiles, clearFinished };
}
