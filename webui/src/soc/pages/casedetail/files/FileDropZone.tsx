/**
 * Round 15 (SPEC D4.6, D5.12): the one way to hand screenshots to a case: drop them
 * here, paste them while the surrounding surface has focus, or choose them with the
 * file picker. It only collects image files and calls `onFiles`; preparing and
 * uploading them is `useCaseFileUpload`'s job, so the same zone serves the Files
 * section and the close dialog.
 *
 * Paste: the listener sits on `pasteScopeRef` (the Collaboration tab or the close
 * dialog, WP7 passes it) or, without one, on the zone itself. A paste that carries no
 * image is left alone, so pasting text into a field inside the scope still works.
 */
import * as React from 'react';
import { ImagePlus } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Button } from '@/ui/button';

/** What the picker offers; the browser redraws any of them into an accepted type. */
export const PICKER_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

export interface FileSourceLike {
  files?: FileList | readonly File[] | null;
  items?: DataTransferItemList | null;
}

/** The image files in a paste or a drop (non-images are ignored). */
export function imageFilesFrom(data: FileSourceLike | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  const seen = new Set<File>();
  const push = (file: File | null | undefined) => {
    if (file && file.type.startsWith('image/') && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  };
  for (const file of Array.from(data.files ?? [])) push(file);
  if (!files.length) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind === 'file') push(item.getAsFile());
    }
  }
  return files;
}

export interface FileDropZoneProps {
  onFiles: (files: File[]) => void;
  /** Uploads are not allowed (no `cases:comment`, or the limit is reached). */
  disabled?: boolean;
  /** An upload is running (the zone stays usable; files queue). */
  busy?: boolean;
  /** Where a paste is caught. Defaults to the zone itself. */
  pasteScopeRef?: React.RefObject<HTMLElement | null>;
  /** One line for the space the zone has (the close dialog uses it). */
  compact?: boolean;
  /** Overrides the hint under the button. */
  hint?: string;
  className?: string;
}

export function FileDropZone({
  onFiles,
  disabled = false,
  busy = false,
  pasteScopeRef,
  compact = false,
  hint,
  className,
}: FileDropZoneProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const hintId = React.useId();
  const onFilesRef = React.useRef(onFiles);
  onFilesRef.current = onFiles;

  React.useEffect(() => {
    const scope = pasteScopeRef?.current ?? rootRef.current;
    if (!scope || disabled) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const files = imageFilesFrom(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      onFilesRef.current(files);
    };
    scope.addEventListener('paste', onPaste);
    return () => scope.removeEventListener('paste', onPaste);
  }, [pasteScopeRef, disabled]);

  // Dragging is a pointer extra on the zone (the button and paste are the keyboard ways
  // in), so its listeners are attached here rather than as JSX handlers on a group.
  React.useEffect(() => {
    const zone = rootRef.current;
    if (!zone) return undefined;
    const onDragOver = (event: DragEvent) => {
      if (disabled) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = () => setDragging(false);
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (disabled) return;
      const files = imageFilesFrom(event.dataTransfer);
      if (files.length) onFilesRef.current(files);
    };
    zone.addEventListener('dragover', onDragOver);
    zone.addEventListener('dragleave', onDragLeave);
    zone.addEventListener('drop', onDrop);
    return () => {
      zone.removeEventListener('dragover', onDragOver);
      zone.removeEventListener('dragleave', onDragLeave);
      zone.removeEventListener('drop', onDrop);
    };
  }, [disabled]);

  const text =
    hint ??
    (disabled
      ? 'You cannot add screenshots to this case.'
      : 'Drop, paste or choose PNG, JPEG or WebP images. Each is resized to fit 2 MB.');

  return (
    // A group: the button and the hint belong together.
    <div
      ref={rootRef}
      role="group"
      aria-label="Screenshot upload"
      data-testid="file-drop-zone"
      data-dragging={dragging ? 'true' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md border border-dashed border-border bg-muted/30 text-sm transition-colors',
        compact ? 'px-3 py-2' : 'flex-col justify-center px-4 py-6 text-center',
        dragging && 'border-primary bg-primary/5',
        disabled && 'opacity-60',
        className,
      )}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-describedby={hintId}
        onClick={() => inputRef.current?.click()}
        className={cn(focusRing)}
      >
        <ImagePlus className="h-4 w-4" aria-hidden="true" />
        {busy ? 'Adding screenshots' : 'Add screenshots'}
      </Button>
      <p id={hintId} className="text-xs text-muted-foreground">
        {text}
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={PICKER_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onChange={(event) => {
          const files = imageFilesFrom({ files: event.currentTarget.files });
          if (files.length) onFiles(files);
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
}
