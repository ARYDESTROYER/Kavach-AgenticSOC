/**
 * The small answer blocks: `query`, `callout`, `citations`, `guide` and `markdown`.
 *
 * - `query`: CodeBlock with copy and wrap; the query text is untrusted (it can embed log
 *   values) and is only ever text.
 * - `callout`: `ui/alert` as a `role="note"` for every tone. BLOCKS.md asks for
 *   `status`/`alert` live roles, but SPEC §10.9 (which ranks above it) says the transcript
 *   has NO chat-local live regions and every announcement goes through the shell
 *   announcer: a restored conversation with several warning callouts would otherwise
 *   fire assertive announcements as they mount. The tone stays visible (variant + icon).
 *   A retention stub says what expired. The G9 fallback shows its plain `fallback_text`
 *   under the quiet notice.
 * - `citations`: a numbered list; the ONE anchored citations block per message gives
 *   each item an anchor (`#<msgDomId>-cite-n`); internal refs become router links, docs
 *   refs same-origin Help Center links; log/knowledge snippets are fenced in a CodeBlock
 *   and never link.
 * - `guide`: numbered steps, then quiet link buttons built from validated refs only.
 * - `markdown`: rendered by the host's ChatMarkdown when provided; otherwise by the
 *   console's dependency-free Markdown (bold, code, lists — React nodes only, no links).
 */
import * as React from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, Clock, Info } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { Markdown } from '@/soc/components/Markdown';

import { RefLink, citationAnchorId, useBlocks } from '../context';
import { formatValue, plainDocTitle } from '../format';
import type { CalloutBlock, CitationsBlock, GuideBlock, MarkdownBlock, QueryBlock, ToneKey } from '../schema';
import { EXPIRED_TEXT, FALLBACK_TEXT, isDocRef } from '../schema';

const LANGUAGE: Record<QueryBlock['language'], string> = {
  kql: 'KQL',
  lucene: 'Lucene',
  esql: 'ES|QL',
  dsl: 'Query DSL',
  sql: 'SQL',
};

export function queryCaption(block: QueryBlock): string {
  const parts = [LANGUAGE[block.language]];
  if (block.source_name) parts.push(block.source_name);
  if (typeof block.hits === 'number') parts.push(`${formatValue(block.hits, 'count')} hits`);
  return parts.join(' · ');
}

export function QueryView({ block }: { block: QueryBlock }) {
  return <CodeBlock value={block.query} caption={queryCaption(block)} wrap maxHeightClassName="max-h-64" data-testid="block-query" />;
}

const TONE: Record<ToneKey, { variant: 'info' | 'success' | 'warning' | 'destructive'; icon: React.ReactNode }> = {
  info: { variant: 'info', icon: <Info aria-hidden /> },
  success: { variant: 'success', icon: <CheckCircle2 aria-hidden /> },
  warning: { variant: 'warning', icon: <AlertTriangle aria-hidden /> },
  critical: { variant: 'destructive', icon: <AlertOctagon aria-hidden /> },
};

export function CalloutView({ block }: { block: CalloutBlock }) {
  if (block.expired) {
    return (
      <Alert variant="default" role="note" icon={<Clock aria-hidden />} data-testid="block-expired" className="text-muted-foreground">
        <AlertTitle className="text-sm">{block.title ?? 'Earlier result'}</AlertTitle>
        <AlertDescription className="text-xs">{EXPIRED_TEXT}</AlertDescription>
      </Alert>
    );
  }
  const fallback = block.text === FALLBACK_TEXT;
  const tone = TONE[block.tone];
  return (
    <Alert
      variant={fallback ? 'default' : tone.variant}
      role="note"
      icon={fallback ? <Info aria-hidden /> : tone.icon}
      data-testid={fallback ? 'block-fallback' : 'block-callout'}
      data-tone={block.tone}
      className={cn('py-2.5', fallback && 'text-muted-foreground')}
    >
      {block.title && !fallback ? <AlertTitle className="text-sm">{block.title}</AlertTitle> : null}
      <AlertDescription className="whitespace-pre-line break-words text-sm">{block.text}</AlertDescription>
      {fallback && block.fallback_text ? (
        <AlertDescription className="mt-1 whitespace-pre-line break-words text-sm text-foreground">{block.fallback_text}</AlertDescription>
      ) : null}
    </Alert>
  );
}

const CITE_KIND: Record<CitationsBlock['items'][number]['kind'], string> = {
  runbook: 'Runbook',
  mitre: 'ATT&CK',
  case: 'Case',
  docs: 'Help Center',
  memory: 'Memory',
  knowledge: 'Knowledge',
  log: 'Log',
};

export function CitationsView({ block, anchored = true }: { block: CitationsBlock; anchored?: boolean }) {
  const { domId } = useBlocks();
  // A repeated `n` anchors only its first item, so no DOM id is ever minted twice.
  const firstOfN = new Set<number>();
  return (
    <ol className="space-y-2 text-sm" data-testid="block-citations">
      {block.items.map((it, i) => {
        const fenced = it.kind === 'log' || it.kind === 'knowledge';
        const anchor = anchored && !firstOfN.has(it.n);
        firstOfN.add(it.n);
        return (
          <li key={`${it.n}-${i}`} id={anchor ? citationAnchorId(domId, it.n) : undefined} className="flex min-w-0 gap-2 scroll-mt-16">
            <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">[{it.n}]</span>
            <div className="min-w-0 flex-1">
              <span className="mr-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{CITE_KIND[it.kind]}</span>
              {it.ref && !fenced ? (
                <RefLink refValue={it.ref}>{it.label}</RefLink>
              ) : (
                <span className={cn(fenced && 'font-mono text-xs')}>{it.label}</span>
              )}
              {it.snippet ? (
                fenced ? (
                  <CodeBlock value={it.snippet} copyable={false} wrap maxHeightClassName="max-h-28" className="mt-1 [&_pre]:p-2 [&_pre]:text-xs" />
                ) : (
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">{it.snippet}</p>
                )
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function GuideView({ block }: { block: GuideBlock }) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="block-guide">
      {block.steps.length ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {block.steps.map((s, i) => (
            <li key={i} className="whitespace-pre-line break-words">
              {s.text}
            </li>
          ))}
        </ol>
      ) : null}
      {block.links.length ? (
        <ul className="flex flex-wrap gap-2">
          {block.links.map((l, i) => (
            <li key={i}>
              <RefLink
                refValue={l.ref}
                className="inline-flex h-7 items-center rounded-md border border-input px-2.5 text-xs text-foreground no-underline hover:bg-muted hover:no-underline"
              >
                {isDocRef(l.ref) ? `Read: ${plainDocTitle(l.label)}` : l.label}
              </RefLink>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function MarkdownView({ block }: { block: MarkdownBlock }) {
  const { renderMarkdown } = useBlocks();
  return (
    <div className="min-w-0 break-words text-sm leading-relaxed text-foreground" data-testid="block-markdown">
      {renderMarkdown ? renderMarkdown(block.text) : <Markdown text={block.text} className="space-y-0.5" />}
    </div>
  );
}
