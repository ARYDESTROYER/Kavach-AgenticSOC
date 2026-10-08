/**
 * ReportDocument — the ONE report renderer (chat revamp SPEC §9.3): the Reports library's
 * document view on screen and the Print/PDF portal both draw it, and the static exports
 * serialise the same document nodes (`export/walker.ts`), so every surface carries:
 *
 *   header (title, author, generated-at, app version, source conversation, item windows
 *   and sources) → the AI summary with "AI-generated; verify before acting" → the items
 *   with their notes → a deterministic "Methodology & limitations" → an appendix of
 *   queries.
 *
 * Modes: `screen` renders items through the lazy `AnswerBlocks` (interactive charts);
 * `print` receives a synchronous block renderer (the preloaded static `BlockCard`) so
 * the portal is complete before `window.print()` runs. The live UI is never defanged.
 */
import * as React from 'react';
import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

import { BLOCK_TYPE_LABEL, SOURCE_UNAVAILABLE, type DocItem, type ReportDoc } from './model';
import { NodesView } from './NodesView';
import { ItemBlocks } from './ItemBlocks';
import { formatUtc } from '../blocks/format';
import { sectionNodes, type WalkOptions } from './export/walker';

export interface ReportDocumentProps {
  doc: ReportDoc;
  mode?: 'screen' | 'print';
  /** Print: renders an item's blocks synchronously (static mode). Screen: lazy AnswerBlocks. */
  renderBlocks?: (item: DocItem, index: number) => React.ReactNode;
  /** Defang content (print only; the screen view is never defanged). */
  defang?: boolean;
  /** Heading shift: 1 under a page `<h1>` (the library view), 0 for print. */
  headingShift?: number;
  /** Screen: open the item's source conversation (the link back). */
  onOpenSource?: (item: DocItem) => void;
  /** Conversation ids known to be unavailable (deleted or evicted). */
  unavailableConversations?: ReadonlySet<string>;
  /** Render the document title (false when the host page's `<h1>` already shows it). */
  showTitle?: boolean;
  className?: string;
}

export function ReportDocument({
  doc,
  mode = 'screen',
  renderBlocks,
  defang = false,
  headingShift = 0,
  onOpenSource,
  unavailableConversations,
  showTitle = true,
  className,
}: ReportDocumentProps) {
  const defangOn = mode === 'print' && defang;
  const nodes = React.useMemo(() => {
    const opts: WalkOptions = { defang: defangOn, screen: mode === 'screen' };
    const head = sectionNodes(doc, 'header', opts);
    return {
      header: showTitle ? head : head.filter((n, i) => !(i === 0 && n.k === 'heading')),
      summary: sectionNodes(doc, 'summary', opts),
      methodology: sectionNodes(doc, 'methodology', opts),
      appendix: sectionNodes(doc, 'appendix', opts),
    };
  }, [doc, defangOn, showTitle]);
  const { header, summary, methodology, appendix } = nodes;
  const H2 = `h${Math.min(6, 2 + headingShift)}` as 'h2' | 'h3';
  const H3 = `h${Math.min(6, 3 + headingShift)}` as 'h3' | 'h4';

  return (
    <article className={cn('min-w-0 space-y-6', className)} data-report-document={mode}>
      <header>
        <NodesView nodes={header} shift={headingShift} />
      </header>
      {summary.length ? (
        <section aria-label="Summary">
          <NodesView nodes={summary} shift={headingShift} />
        </section>
      ) : null}
      <section aria-label={doc.kind === 'conversation' ? 'Conversation' : 'Findings'} className="space-y-6">
        <H2 className="border-t border-border pt-4 text-base font-semibold text-foreground">
          {doc.kind === 'conversation' ? 'Conversation' : 'Findings'}
        </H2>
        {doc.items.length === 0 ? <p className="text-sm text-muted-foreground">This report has no items yet.</p> : null}
        {doc.items.map((item, index) => {
          const gone = unavailableConversations?.has(item.source.conversation_id) ?? false;
          const meta: string[] = [item.kind === 'section' ? 'Answer' : BLOCK_TYPE_LABEL[item.blocks[0]?.type ?? 'markdown']];
          if (item.scope.window) meta.push(`Window: ${item.scope.window}`);
          if (item.scope.sources?.length) meta.push(`Sources: ${item.scope.sources.join(', ')}`);
          if (item.addedAt) meta.push(`${doc.kind === 'conversation' ? 'Asked' : 'Added'} ${formatUtc(item.addedAt)}`);
          return (
            <div key={item.id} className="report-block min-w-0 space-y-2" data-report-item={item.id}>
              <H3 className="text-sm font-semibold text-foreground">
                {index + 1}. {item.title}
              </H3>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{meta.join(' · ')}</span>
                {mode === 'screen' && item.source.conversation_id ? (
                  gone ? (
                    <span>{SOURCE_UNAVAILABLE}</span>
                  ) : onOpenSource ? (
                    <button
                      type="button"
                      onClick={() => onOpenSource(item)}
                      className={cn('inline-flex items-center gap-1 rounded-sm text-primary hover:underline', focusRing)}
                    >
                      <ExternalLink className="size-3" aria-hidden />
                      Open source conversation
                    </button>
                  ) : null
                ) : null}
              </p>
              {item.question ? (
                <div role="note" className="whitespace-pre-wrap rounded-md border border-l-4 border-border border-l-info bg-surface px-3 py-2 text-sm">
                  <span className="font-semibold">Question: </span>
                  {item.question}
                </div>
              ) : null}
              {renderBlocks ? (
                renderBlocks(item, index)
              ) : (
                <ItemBlocks blocks={item.blocks} messageId={item.source.message_id} headingBase={3 + headingShift} />
              )}
              {item.truncated ? (
                <p className="text-xs text-muted-foreground">
                  More blocks were offered than a report section holds; the first ones are shown.
                </p>
              ) : null}
              {item.note ? (
                <div role="note" className="whitespace-pre-wrap rounded-md border border-l-4 border-border border-l-info bg-surface px-3 py-2 text-sm">
                  <span className="font-semibold">Analyst note: </span>
                  {item.note}
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
      <section aria-label="Methodology and limitations">
        <NodesView nodes={methodology} shift={headingShift} />
      </section>
      {appendix.length ? (
        <section aria-label="Appendix: queries">
          <NodesView nodes={appendix} shift={headingShift} />
        </section>
      ) : null}
      {mode === 'print' ? (
        <footer className="border-t border-border pt-2 text-xs text-muted-foreground">
          Generated by Agentic SOC · {formatUtc(doc.generatedAt)} · Provenance: measured values come from read-only lookups;
          AI-stated values are labelled.
        </footer>
      ) : null}
    </article>
  );
}

export default ReportDocument;
