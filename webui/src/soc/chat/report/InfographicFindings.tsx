/**
 * The infographic layout for a saved report in the Reports library (Round 12 follow-up to
 * SPEC §3.4 / D11).
 *
 * A Brief saved from chat is split by the server into one report item per section (its
 * summary as a note leaf, then its leaves). Drawn item by item, an infographic Brief came
 * back as a plain document. When the report's template is `infographic`, the library's
 * screen view re-assembles the items into ONE Brief — each item a section with its own
 * title, in report order — and draws it through the same lazy answer-blocks kit with the
 * `infographic` layout (WP-BLK's `InfographicView`: the hero KPI row with sparklines, the
 * highlight callouts and the 2-up chart grid). Nothing is invented or dropped: every leaf
 * of every item is drawn once; an item whose lookup found nothing, an item cut short and
 * every analyst note are listed under the infographic with each item's link back to its
 * source conversation.
 *
 * Only the on-screen view changes. Print / PDF and the file exports keep the document
 * layout (the static infographic stacks every chart anyway), so their behaviour and tests
 * are unchanged. A report that cannot be re-assembled (an item holding a whole Brief, which
 * a Brief cannot nest) keeps the document layout.
 */
import * as React from 'react';
import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

import type { LeafBlock, ReportBlock, ReportSection } from '../blocks/schema';
import { EMPTY_LOOKUP_TEXT, SOURCE_UNAVAILABLE, type DocItem, type ReportDoc } from './model';
import { ItemBlocks } from './ItemBlocks';

/** The heading the re-assembled Brief carries (the page header already shows the report title). */
export const INFOGRAPHIC_BRIEF_TITLE = 'At a glance';

/** Whether a report should be drawn as an infographic on screen. */
export function wantsInfographic(doc: ReportDoc): boolean {
  return doc.kind === 'report' && doc.template === 'infographic';
}

/**
 * The report's items as ONE infographic Brief (each item a section, in order), or null
 * when an item holds a whole Brief (briefs do not nest) or nothing has blocks to show.
 */
export function infographicBrief(doc: ReportDoc): ReportBlock | null {
  const sections: ReportSection[] = [];
  for (const item of doc.items) {
    if (item.blocks.some((block) => block.type === 'report')) return null;
    if (!item.blocks.length) continue;
    sections.push({ id: item.id, heading: item.title, blocks: item.blocks as LeafBlock[] });
  }
  if (!sections.length) return null;
  return {
    type: 'report',
    id: 'library-infographic',
    title: INFOGRAPHIC_BRIEF_TITLE,
    template: 'infographic',
    layout: 'infographic',
    scope: {
      ...(doc.windows.length === 1 ? { window_label: doc.windows[0] } : {}),
      sources: [...doc.sources],
      generated_at: doc.updatedAt || doc.generatedAt,
    },
    sections,
    // The container is assembled by code; every leaf keeps its own provenance.
    provenance: 'code',
    artifact_kind: null,
    allowed_views: [],
    untrusted: false,
    truncated: false,
    total: null,
    downsampled_for_storage: false,
  };
}

/** One line per item that has something the infographic does not show itself. */
interface ItemNote {
  item: DocItem;
  index: number;
  lines: string[];
}

function itemNotes(doc: ReportDoc): ItemNote[] {
  const out: ItemNote[] = [];
  doc.items.forEach((item, index) => {
    const lines: string[] = [];
    if (item.emptyType && !item.blocks.length) lines.push(EMPTY_LOOKUP_TEXT);
    if (item.truncated) lines.push('More blocks were offered than a report section holds; the first ones are shown.');
    if (item.note) lines.push(`Analyst note: ${item.note}`);
    if (lines.length) out.push({ item, index, lines });
  });
  return out;
}

/** The distinct source answers, in report order (a saved Brief is usually one). */
function sourceAnswers(doc: ReportDoc): DocItem[] {
  const seen = new Set<string>();
  const out: DocItem[] = [];
  for (const item of doc.items) {
    const key = `${item.source.conversation_id}\u0000${item.source.message_id}`;
    if (!item.source.conversation_id || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export interface InfographicFindingsProps {
  doc: ReportDoc;
  brief: ReportBlock;
  headingShift?: number;
  onOpenSource?: (item: DocItem) => void;
  unavailableConversations?: ReadonlySet<string>;
}

export function InfographicFindings({ doc, brief, headingShift = 0, onOpenSource, unavailableConversations }: InfographicFindingsProps) {
  const notes = React.useMemo(() => itemNotes(doc), [doc]);
  const sources = React.useMemo(() => sourceAnswers(doc), [doc]);
  const H3 = `h${Math.min(6, 3 + headingShift)}` as 'h3' | 'h4';
  const messageId = doc.items[0]?.source.message_id ?? 'library';
  const headingId = React.useId();
  // The block kit titles a Brief at H4 (sections H5, cards H6), like an item of the
  // document layout under its H3 item heading. The infographic has no item heading, so
  // under an H2 "Findings" a visually hidden H3 keeps the outline whole (H2 → H3 → H4).
  const bridge = 2 + headingShift < 3;
  const blocks = <ItemBlocks blocks={[brief]} messageId={messageId} headingBase={3 + headingShift} bare />;
  return (
    <div className="space-y-5" data-testid="report-infographic">
      {bridge ? (
        <section aria-labelledby={headingId}>
          <H3 id={headingId} className="sr-only">
            Infographic
          </H3>
          {blocks}
        </section>
      ) : (
        blocks
      )}
      {notes.length || sources.length ? (
        <div className="space-y-2 border-t border-border pt-3">
          <H3 className="text-sm font-semibold text-foreground">Sources and notes</H3>
          {notes.length ? (
            <ul className="space-y-1.5 text-sm" data-testid="report-infographic-notes">
              {notes.map(({ item, index, lines }) => (
                <li key={item.id} className="min-w-0">
                  <span className="font-medium text-foreground">
                    {index + 1}. {item.title}
                  </span>
                  {lines.map((line, i) => (
                    <p key={i} className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {line}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
          {sources.length ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="report-infographic-sources">
              {sources.map((item) => {
                const gone = unavailableConversations?.has(item.source.conversation_id) ?? false;
                return (
                  <li key={`${item.source.conversation_id}:${item.source.message_id}`}>
                    {gone ? (
                      <span className="text-muted-foreground">{SOURCE_UNAVAILABLE}</span>
                    ) : onOpenSource ? (
                      <button
                        type="button"
                        onClick={() => onOpenSource(item)}
                        data-print-hide=""
                        className={cn('inline-flex items-center gap-1 rounded-sm text-primary hover:underline', focusRing)}
                      >
                        <ExternalLink className="size-3" aria-hidden />
                        Open source conversation
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
