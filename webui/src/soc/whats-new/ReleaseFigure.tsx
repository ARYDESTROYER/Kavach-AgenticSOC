/**
 * A release-note screenshot in the current theme, with a generic lightbox (Round 16 WP07).
 *
 * The images are same-origin files of the bundled Help Center
 * (`/docs/<line>/assets/releases/<version>/...`), never part of a chunk. Width and height
 * come from the WebP header (the generator reads them), so the figure never shifts the
 * layout. The first figure on a surface is eager (it is in view); later ones are lazy. An
 * image that fails to load (no docs bundle under `npm run dev`, a partial deploy)
 * collapses to its caption. The case-files lightbox fetches blobs and is not reusable, so
 * this one is a plain dialog around the same image. The enlarge button is the dialog's
 * trigger, so closing the lightbox hands focus back to it.
 */
import * as React from 'react';
import { Maximize2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { docsAssetUrl } from '@/lib/docs-url';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/ui/dialog';
import { useTheme } from '../theme';
import type { NotesScreenshot } from './notes';

export interface ReleaseFigureProps {
  screenshot: NotesScreenshot;
  /** The running version, which names the Help Center line the image is served from. */
  version: string;
  /** In view on first paint (the dialog hero, the page's first figure). */
  eager?: boolean;
  className?: string;
}

export function ReleaseFigure({ screenshot, version, eager = false, className }: ReleaseFigureProps) {
  const { isDark } = useTheme();
  const image = isDark && screenshot.dark ? screenshot.dark : screenshot.light;
  const src = docsAssetUrl(image.src, version);
  const [broken, setBroken] = React.useState<string | null>(null);
  const [zoomed, setZoomed] = React.useState(false);
  const failed = broken === src;

  return (
    <figure className={cn('min-w-0', className)} data-testid="release-figure">
      <Dialog open={zoomed && !failed} onOpenChange={setZoomed}>
        {failed ? null : (
          <DialogTrigger asChild>
            <button
              type="button"
              className={cn(
                'group relative block w-full overflow-hidden rounded-lg border border-border bg-muted',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
              aria-label={`Enlarge screenshot: ${screenshot.caption ?? screenshot.alt}`}
            >
              {/* onError collapses a missing image to its caption; it is not a user
                  interaction, which is all the rule looks for. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
              <img
                src={src}
                alt={screenshot.alt}
                width={image.width}
                height={image.height}
                decoding="async"
                loading={eager ? 'eager' : 'lazy'}
                onError={() => setBroken(src)}
                className="block h-auto w-full"
              />
              <span
                aria-hidden
                className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md bg-card/90 text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
              >
                <Maximize2 className="size-4" />
              </span>
            </button>
          </DialogTrigger>
        )}
        <DialogContent className="max-w-[min(96vw,1440px)] gap-3 p-4 sm:p-5">
          <DialogTitle className="text-sm">{screenshot.caption ?? 'Screenshot'}</DialogTitle>
          <DialogDescription className="sr-only">{screenshot.alt}</DialogDescription>
          <img
            src={src}
            alt={screenshot.alt}
            width={image.width}
            height={image.height}
            decoding="async"
            className="block h-auto max-h-[75dvh] w-full rounded-md border border-border object-contain"
          />
        </DialogContent>
      </Dialog>
      {screenshot.caption || failed ? (
        <figcaption className={cn('text-xs text-muted-foreground', failed ? '' : 'mt-1.5')}>
          {screenshot.caption ?? screenshot.alt}
        </figcaption>
      ) : null}
    </figure>
  );
}
