/**
 * `report` block, labelled **Brief** in the chat (BLOCKS.md `report`, SPEC §10.6): a
 * scope line, provenance summary chips ("12 measured · 1 AI-stated"), a collapsible table
 * of contents, then each section's heading, summary and leaf blocks rendered with the
 * SAME block renderers (a report never nests another report).
 *
 * The contents list scrolls to an in-message section with a button, never a `#fragment`
 * link: the console router owns `location.hash` (`#/<page>`), so a fragment href would
 * navigate away from the chat.
 *
 * Each section is a labelled `role="group"`, not a `<section aria-labelledby>`: a named
 * section is a region LANDMARK, and a transcript of Briefs would flood the landmark list
 * (and fail axe `landmark-unique` whenever two Briefs share a section heading).
 */
import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { ProvenanceTag } from '@/soc/components/ProvenanceTag';

import { sectionAnchorId, useBlocks } from '../context';
import { formatUtc } from '../format';
import type { LeafBlock, ReportBlock } from '../schema';

/** Leaf counts by provenance: measured = code or source; AI-stated = ai. */
export function provenanceSummary(block: ReportBlock): { measured: number; ai: number } {
  let measured = 0;
  let ai = 0;
  for (const s of block.sections) {
    for (const b of s.blocks) {
      if (b.type === 'markdown' || b.type === 'callout') continue;
      if (b.provenance === 'ai') ai += 1;
      else measured += 1;
    }
  }
  return { measured, ai };
}

export function reportScopeLine(block: ReportBlock): string {
  const parts: string[] = [];
  if (block.scope.window_label) parts.push(`Window: ${block.scope.window_label}`);
  if (block.scope.sources.length) parts.push(`Sources: ${block.scope.sources.join(', ')}`);
  parts.push(`Generated ${formatUtc(block.scope.generated_at)}`);
  return parts.join(' · ');
}

export interface ReportViewProps {
  block: ReportBlock;
  blockIndex: number;
  renderLeaf: (leaf: LeafBlock, key: string) => React.ReactNode;
}

export function ReportView({ block, blockIndex, renderLeaf }: ReportViewProps) {
  const { domId } = useBlocks();
  const [tocOpen, setTocOpen] = React.useState(block.sections.length > 3);
  const rawId = React.useId();
  const tocId = `toc-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const prov = provenanceSummary(block);

  const jump = (si: number) => {
    const el = typeof document !== 'undefined' ? document.getElementById(sectionAnchorId(domId, blockIndex, si)) : null;
    if (!el) return;
    el.scrollIntoView?.({ block: 'start' });
    el.focus({ preventScroll: true });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="block-report">
      {block.subtitle ? <p className="text-sm text-muted-foreground">{block.subtitle}</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="report-provenance">
        <span className="inline-flex items-center gap-1">
          <ProvenanceTag kind="code" variant="icon" />
          {prov.measured} measured
        </span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-1">
          <ProvenanceTag kind="ai" variant="icon" />
          {prov.ai} AI-stated
        </span>
      </div>

      {block.sections.length > 1 ? (
        <div className="rounded-md border border-border/70">
          <button
            type="button"
            aria-expanded={tocOpen}
            aria-controls={tocId}
            onClick={() => setTocOpen((o) => !o)}
            className={cn('flex w-full items-center justify-between gap-2 px-3 py-1.5 text-xs font-medium text-foreground', focusRing)}
          >
            Contents ({block.sections.length} sections)
            <ChevronDown className={cn('size-3.5 transition-transform motion-reduce:transition-none', tocOpen && 'rotate-180')} aria-hidden />
          </button>
          <ol id={tocId} hidden={!tocOpen} className="list-decimal space-y-0.5 border-t border-border/70 py-1.5 pl-8 pr-3 text-xs">
            {block.sections.map((s, si) => (
              <li key={s.id}>
                <button type="button" onClick={() => jump(si)} className={cn('rounded-sm text-left text-primary hover:underline', focusRing)}>
                  {s.heading}
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {block.sections.map((s, si) => {
        const headingId = sectionAnchorId(domId, blockIndex, si);
        return (
          <div key={s.id} role="group" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
            <h5 id={headingId} tabIndex={-1} className="scroll-mt-16 text-sm font-semibold text-foreground outline-none">
              {s.heading}
            </h5>
            {s.summary ? <p className="whitespace-pre-line break-words text-sm text-muted-foreground">{s.summary}</p> : null}
            {s.blocks.map((leaf, li) => (
              <React.Fragment key={`${leaf.id}-${li}`}>{renderLeaf(leaf, `${si}-${li}`)}</React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}
