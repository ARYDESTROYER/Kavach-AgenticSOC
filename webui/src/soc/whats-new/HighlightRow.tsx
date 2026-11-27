/**
 * One highlight on the Communication, What's new page (Round 16 WP07, [wn] §4.4): a
 * divider-led row with its kind, title, summary, details, screenshot and actions (Open,
 * Read more in the Help Center, Copy link). Every string is notes text rendered as text.
 */
import * as React from 'react';
import { ArrowUpRight, Link2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/cn';
import { docsArticleUrl } from '@/lib/docs-url';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import type { PageId } from '../nav';
import { pageHash, useNavigateOptional } from '../router';
import { InlineText } from './InlineText';
import { AREA_LABEL, KIND_LABEL, type HighlightKind, type NotesHighlight } from './notes';
import { ReleaseFigure } from './ReleaseFigure';

const KIND_VARIANT: Record<HighlightKind, 'info' | 'success' | 'secondary' | 'warning'> = {
  new: 'info',
  improved: 'success',
  fixed: 'secondary',
  removed: 'secondary',
  security: 'warning',
};

/** The id of a highlight's row (`#/whats_new?v=&h=` scrolls to and focuses it). */
export const highlightDomId = (version: string, id: string): string => `whats-new-${version.replace(/\./g, '-')}-${id}`;

export interface HighlightRowProps {
  highlight: NotesHighlight;
  version: string;
  runningVersion: string;
  /** Newer than the marker the person had when the page opened. */
  isNew: boolean;
  openable: boolean;
  eagerFigure: boolean;
  highlighted: boolean;
}

export function HighlightRow({
  highlight,
  version,
  runningVersion,
  isNew,
  openable,
  eagerFigure,
  highlighted,
}: HighlightRowProps): React.ReactElement {
  const navigate = useNavigateOptional();
  const titleId = `${highlightDomId(version, highlight.id)}-title`;

  const copyLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}${pageHash('whats_new', { v: version, h: highlight.id })}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };

  return (
    <article
      id={highlightDomId(version, highlight.id)}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-testid="whats-new-highlight"
      data-highlight={highlight.id}
      className={cn(
        'scroll-mt-24 border-t border-border/70 py-5 first:border-t-0 focus-visible:outline-none',
        highlighted ? 'rounded-md bg-primary/5 px-3 ring-1 ring-primary/30' : '',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={KIND_VARIANT[highlight.kind]}>{KIND_LABEL[highlight.kind]}</Badge>
        <span className="text-xs text-muted-foreground">{AREA_LABEL[highlight.area]}</span>
        {isNew ? (
          <Badge variant="default" data-testid="whats-new-new-badge">
            New to you
          </Badge>
        ) : null}
      </div>
      <h4 id={titleId} className="mt-2 text-md font-semibold text-foreground">
        {highlight.title}
      </h4>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        <InlineText text={highlight.summary} />
      </p>
      {highlight.details.length ? (
        <ul className="mt-2 max-w-3xl list-disc space-y-1 pl-5 text-sm text-foreground">
          {highlight.details.map((detail, index) => (
            <li key={index}>
              <InlineText text={detail} />
            </li>
          ))}
        </ul>
      ) : null}
      {highlight.screenshot ? (
        <ReleaseFigure
          screenshot={highlight.screenshot}
          version={runningVersion}
          eager={eagerFigure}
          className="mt-3 max-w-3xl"
        />
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {openable && highlight.open ? (
          <Button asChild variant="outline" size="sm">
            <a
              href={pageHash(highlight.open as PageId)}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                event.preventDefault();
                navigate(highlight.open as PageId);
              }}
              aria-label={`Open ${highlight.title}`}
            >
              Open
            </a>
          </Button>
        ) : null}
        {highlight.help ? (
          <Button asChild variant="ghost" size="sm">
            <a href={docsArticleUrl(highlight.help, runningVersion)} aria-label={`Read more about ${highlight.title} in the Help Center`}>
              Read more
              <ArrowUpRight aria-hidden />
            </a>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void copyLink()}
          aria-label={`Copy a link to ${highlight.title}`}
        >
          <Link2 aria-hidden />
          Copy link
        </Button>
      </div>
    </article>
  );
}
