/**
 * Round 15 (SPEC D4.6, D5.12): "Add screenshots" in the close dialog. Each file is
 * prepared and uploaded at once, one at a time, through the case files API; the close
 * never waits for an upload and never rolls one back (an upload still running when the
 * dialog closes finishes on its own and the Files section picks it up). A paste anywhere
 * in the dialog adds the pasted image (`pasteScopeRef`, the dialog's content).
 *
 * Mounted lazily by the case workspace only for a viewer who holds `cases:comment`, the
 * grant the upload route checks; the server's refusal (a full case, a busy uploader) is
 * shown under the zone in plain words.
 */
import * as React from 'react';
import { CheckCircle2, LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { CaseFileEntry } from '@/lib/types-case-files';

import { FileDropZone } from './FileDropZone';
import { useCaseFileUpload } from './useCaseFileUpload';
import type { UseCaseFileUploadOptions } from './useCaseFileUpload';

const STATUS_WORDS: Record<string, string> = {
  queued: 'waiting',
  preparing: 'preparing',
  uploading: 'uploading',
  done: 'added to the case',
};

export interface CloseScreenshotsProps {
  caseId: string;
  /** Where a paste adds screenshots: the dialog's content. */
  pasteScopeRef?: React.RefObject<HTMLElement | null>;
  /** Called after each upload, so the Files section can read the list again. */
  onUploaded?: (entry: CaseFileEntry) => void;
  /** Injectable for tests (`useCaseFileUpload` options other than the case). */
  uploadOptions?: Omit<UseCaseFileUploadOptions, 'caseId' | 'onUploaded'>;
}

export function CloseScreenshots({ caseId, pasteScopeRef, onUploaded, uploadOptions }: CloseScreenshotsProps) {
  const onUploadedRef = React.useRef(onUploaded);
  onUploadedRef.current = onUploaded;
  const handleUploaded = React.useCallback((entry: CaseFileEntry) => onUploadedRef.current?.(entry), []);
  const uploader = useCaseFileUpload({ ...uploadOptions, caseId, onUploaded: handleUploaded });
  return (
    <div className="space-y-2" data-testid="close-screenshots">
      <FileDropZone
        compact
        onFiles={(files) => void uploader.uploadFiles(files)}
        busy={uploader.busy}
        pasteScopeRef={pasteScopeRef}
        hint="Drop, paste or choose PNG, JPEG or WebP images. Each is added to the case as soon as it is ready."
        // The dialog's column is narrow: the hint sits under the button, not beside it.
        className="flex-col items-start gap-2 py-3"
      />
      {/* Always in the page, so the first status is announced too. */}
      <ul aria-live="polite" className="space-y-1 text-xs" data-testid="close-screenshots-status">
        {uploader.items.map((item) => (
          <li
            key={item.key}
            className={cn(
              'flex min-w-0 items-center gap-1.5',
              item.status === 'error' ? 'text-critical-text' : 'text-muted-foreground',
            )}
          >
            {item.status === 'done' ? (
              <CheckCircle2 className="size-3.5 shrink-0 text-success-text" aria-hidden />
            ) : item.status === 'error' ? null : (
              <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
            )}
            <span className="truncate">
              {item.status === 'error'
                ? `${item.name}: ${item.message ?? 'not added.'}`
                : `${item.name}: ${STATUS_WORDS[item.status]}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default CloseScreenshots;
