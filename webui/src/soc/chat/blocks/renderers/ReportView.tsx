/**
 * `report` block, labelled **Brief** in the chat (BLOCKS.md `report`, SPEC §10.6): its
 * title row reads "Brief: {title}", a scope line, a provenance note only when the Brief
 * holds figures stated by the model ("Includes 2 figures stated by the model"), a
 * collapsible table of contents from four sections, then each section's heading,
 * summary and leaf blocks rendered with the SAME block renderers (a report never nests
 * another report).
 *
 * The window is stated ONCE, in the scope line (Round 13, SPEC-chat T29): the Brief's
 * own window label, else a subtitle that is the window its figures are captioned with
 * ("last 7 days (since 11 Oct 2026)"). The title then drops a trailing ", last 7 days",
 * and every leaf's caption drops that window and the "as of" minute the scope line's
 * "Generated" time already gives (`reportLeafScope`). Print keeps every caption whole.
 *
 * The contents list scrolls to an in-message section with a button, never a `#fragment`
 * link: the console router owns `location.hash` (`#/<page>`), so a fragment href would
 * navigate away from the chat.
 *
 * Each section is a labelled `role="group"`, not a `<section aria-labelledby>`: a named
 * section is a region LANDMARK, and a transcript of Briefs would flood the landmark list
 * (and fail axe `landmark-unique` whenever two Briefs share a section heading).
 *
 * `staticMode` (print / static export, Round 12 WP-REP R6): the contents list is plain
 * text — no toggle and no jump buttons, which a printed page cannot use (and which the
 * old print stylesheet hid, leaving an empty "1. 2. 3." list).
 *
 * Templates and layouts (Round 12 SPEC §3.4, D11): the Brief names its template beside the
 * provenance chips ("Monthly SOC report"); an executive summary or a monthly report opens
 * with its first section's summary as the lead; the `infographic` layout (or template)
 * draws the hero KPI row, the highlights and the 2-up chart grid (`InfographicView`).
 *
 * In both layouts a section whose first card is titled like the section ("AI cost" over a
 * card titled "AI cost") does not say it twice: the card's title stays and takes the
 * heading's place, and the heading is kept for assistive tech and the contents jump
 * (`headingRepeatsLeaf`, the same rule the exports follow).
 */
import * as React from 'react';
import { Bot, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

import { sectionAnchorId, useBlocks } from '../context';
import { INVESTIGATION_BRIEF_ADVISORY, formatUtc } from '../format';
import { CAPTION_SEPARATOR, captionParts, type SharedScope } from '../layout';
import type { LeafBlock, ReportBlock, ReportLayout, ReportTemplate } from '../schema';
import { headingRepeatsLeaf } from '../report-headings';
import { InfographicView } from './InfographicView';

/** A template's name on the Brief (the Reports library's `TEMPLATE_LABEL` words). */
export const TEMPLATE_NAME: Readonly<Record<ReportTemplate, string>> = {
  investigation: 'Investigation',
  hunt: 'Threat hunt',
  ioc: 'Indicator report',
  shift: 'Shift handoff',
  posture: 'Posture review',
  custom: 'Custom',
  executive: 'Executive summary',
  monthly: 'Monthly SOC report',
  infographic: 'Infographic',
  investigation_brief: 'Investigation brief',
};

// The investigation brief's label (P1-3, #3) lives with the pure format helpers, so the
// report document and every static export (export/walker.ts) print the same words.
export { INVESTIGATION_BRIEF_ADVISORY } from '../format';

/** Templates whose first section summary is the lead (an executive reads it first). */
const LEAD_TEMPLATES: ReadonlyArray<ReportTemplate> = ['executive', 'monthly', 'investigation_brief'];

/** The layout a Brief is drawn in: its own, else the infographic template's, else a document. */
export function reportLayout(block: ReportBlock): ReportLayout {
  return block.layout ?? (block.template === 'infographic' ? 'infographic' : 'document');
}

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

const lower = (text: string) => text.trim().toLowerCase();

/** Every caption part the Brief's leaves carry (lower case): engine-written window words. */
function leafCaptionParts(block: ReportBlock): Set<string> {
  const out = new Set<string>();
  for (const s of block.sections) for (const leaf of s.blocks) for (const part of captionParts(leaf.caption)) out.add(lower(part));
  return out;
}

/** A subtitle's parts (split on " · ", like a caption). */
const subtitleParts = (subtitle: string) => captionParts(subtitle);

/** The Brief's window as the scope line states it, and the subtitle left once that is folded out. */
export interface ReportWindow {
  /** The window the scope line states, or null. */
  text: string | null;
  /** The whole subtitle was the window: it is not shown on its own line. */
  subtitleFolded: boolean;
  /** The subtitle to show on its own line (model text), or null. */
  subtitleRest: string | null;
}

/**
 * The Brief's window as its scope line states it (SPEC-chat T29), from ENGINE text only:
 * the scope's own `window_label`, or, without one, a window the Brief's leaves caption
 * their figures with. The subtitle is model-written (`ReportEnvelopeRequest.subtitle`), so
 * it never becomes the scope line's words (#9): a subtitle part ("Last shift · last 24
 * hours" splits on " · ") is folded out only when it IS the engine's window (equal to the
 * label, or a leaf caption part, ignoring case), or the label's dated form ("last 7 days
 * (since 11 Oct 2026)") that a leaf caption carries word for word. Every other subtitle
 * part stays on its own line as model text ("last 7 days (since 1 Oct 2026), all response
 * targets met" stays whole under a scope line that says "Last 7 days").
 */
export function reportWindow(block: ReportBlock): ReportWindow {
  const label = block.scope.window_label?.trim() || null;
  const subtitle = block.subtitle?.trim() || null;
  const parts = subtitle ? subtitleParts(subtitle) : [];
  const leaves = leafCaptionParts(block);
  let window: string | null = label;
  let folded = -1;
  if (label) {
    const want = lower(label);
    folded = parts.findIndex((p) => lower(p) === want);
    if (folded < 0) {
      // The dated form of the label, only when an engine caption says exactly that.
      folded = parts.findIndex((p) => {
        const low = lower(p);
        return low.startsWith(`${want} (`) && low.endsWith(')') && leaves.has(low);
      });
      if (folded >= 0) window = parts[folded];
    }
  } else {
    // No label: the last subtitle part that a leaf caption carries is the window.
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (leaves.has(lower(parts[i]))) {
        folded = i;
        window = parts[i];
        break;
      }
    }
  }
  const rest = folded >= 0 ? parts.filter((_, i) => i !== folded) : parts;
  return {
    text: window,
    subtitleFolded: Boolean(subtitle) && folded >= 0 && rest.length === 0,
    subtitleRest: rest.length ? (folded >= 0 ? rest.join(CAPTION_SEPARATOR) : subtitle) : null,
  };
}

const capitalise = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

export function reportScopeLine(block: ReportBlock): string {
  const parts: string[] = [];
  const window = reportWindow(block).text;
  if (window) parts.push(capitalise(window));
  if (block.scope.sources.length) parts.push(`Sources: ${block.scope.sources.join(', ')}`);
  parts.push(`Generated ${formatUtc(block.scope.generated_at)}`);
  return parts.join(' · ');
}

/** Joiners a title uses before a trailing window ("Cases report, last 7 days"). */
const TITLE_WINDOW_JOINERS = [', ', ' · ', ' - ', ' – ', ': '];

/**
 * The Brief's title without a trailing window the scope line already states ("Cases
 * report, last 7 days" → "Cases report"); the title as written otherwise, and always
 * when only the window would be left.
 */
export function briefTitle(block: ReportBlock): string {
  const title = block.title;
  const window = reportWindow(block).text;
  if (!window) return title;
  const forms = Array.from(new Set([window, window.split(' (')[0]].map((w) => w.trim()).filter(Boolean)));
  const low = title.toLowerCase();
  for (const form of forms) {
    const f = form.toLowerCase();
    for (const joiner of TITLE_WINDOW_JOINERS) {
      if (low.endsWith(`${joiner}${f}`) && title.length > joiner.length + f.length) {
        return title.slice(0, title.length - joiner.length - f.length).trimEnd();
      }
    }
    const paren = `(${f})`;
    if (low.endsWith(` ${paren}`) && title.length > paren.length + 1) return title.slice(0, title.length - paren.length - 1).trimEnd();
  }
  return title;
}

/**
 * The Brief's title row (SPEC-chat T29): "Brief: {title}", unless the title already names
 * itself a brief ("Shift brief", "Investigation brief: …"), which would read twice.
 */
export function briefHeading(block: ReportBlock): string {
  const title = briefTitle(block);
  return /\bbrief\b/i.test(title) ? title : `Brief: ${title}`;
}

/**
 * What a leaf's caption need not repeat inside this Brief (SPEC-chat T29): the window and
 * the "as of" minute of the scope line's "Generated" time. Shaped like an answer's shared
 * scope (`layout.ts`), so the card applies it the same way.
 */
export function reportLeafScope(block: ReportBlock): SharedScope | null {
  const window = reportWindow(block).text;
  const generated = formatUtc(block.scope.generated_at);
  const asOf = generated ? `as of ${generated}` : null;
  if (!window && !asOf) return null;
  return { line: '', parts: window ? [window] : [], asOf, members: [] };
}

/** "Includes 2 figures stated by the model" (only when there is at least one). */
export function aiFiguresNote(count: number): string | null {
  if (count <= 0) return null;
  return `Includes ${count.toLocaleString('en-US')} ${count === 1 ? 'figure' : 'figures'} stated by the model`;
}

/** The interactive contents control appears from this many sections (SPEC-chat T29). */
export const CONTENTS_MIN_SECTIONS = 4;

export interface ReportViewProps {
  block: ReportBlock;
  blockIndex: number;
  renderLeaf: (leaf: LeafBlock, key: string) => React.ReactNode;
  /** Print / static export: a plain-text contents list, nothing interactive. */
  staticMode?: boolean;
  /**
   * The Brief sits in a block card's frame (0.75rem padding): its infographic hero then
   * draws no frame of its own (no card in a card, T29) and hangs to the frame's edge.
   */
  inFrame?: boolean;
}

export function ReportView({ block, blockIndex, renderLeaf, staticMode = false, inFrame = false }: ReportViewProps) {
  const { domId } = useBlocks();
  const layout = reportLayout(block);
  const [tocOpen, setTocOpen] = React.useState(block.sections.length > 3);
  const lead = block.template !== undefined && LEAD_TEMPLATES.includes(block.template);
  const rawId = React.useId();
  const tocId = `toc-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const prov = provenanceSummary(block);
  const aiNote = aiFiguresNote(prov.ai);
  const named = !!block.template && block.template !== 'custom';
  const { subtitleRest } = reportWindow(block);

  const jump = (si: number) => {
    const el = typeof document !== 'undefined' ? document.getElementById(sectionAnchorId(domId, blockIndex, si)) : null;
    if (!el) return;
    el.scrollIntoView?.({ block: 'start' });
    el.focus({ preventScroll: true });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="block-report" data-layout={layout} data-template={block.template}>
      {subtitleRest ? (
        <p className="text-sm text-muted-foreground" data-testid="report-subtitle">
          {subtitleRest}
        </p>
      ) : null}
      {named || aiNote ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="report-provenance">
          {named && block.template ? (
            <span className="rounded-sm border border-border/70 px-1.5 py-0.5 font-medium text-foreground" data-testid="report-template">
              {TEMPLATE_NAME[block.template]}
            </span>
          ) : null}
          {named && aiNote ? <span aria-hidden>·</span> : null}
          {aiNote ? (
            <span className="inline-flex items-center gap-1" data-testid="report-ai-note">
              <Bot className="size-3.5 shrink-0" aria-hidden />
              {aiNote}
            </span>
          ) : null}
        </div>
      ) : null}
      {block.template === 'investigation_brief' ? (
        // Round 12 P1-3 (#3): a brief recommends; the case decision is the policy's.
        <p className="text-xs font-medium text-foreground" data-testid="report-advisory">
          {INVESTIGATION_BRIEF_ADVISORY}
        </p>
      ) : null}

      {layout === 'infographic' ? (
        <InfographicView block={block} blockIndex={blockIndex} renderLeaf={renderLeaf} staticMode={staticMode} inFrame={inFrame} />
      ) : null}

      {layout === 'infographic' ? null : block.sections.length > 1 && staticMode ? (
        <div className="rounded-md border border-border/70 px-3 py-1.5 text-xs" data-testid="report-toc-static">
          <p className="font-medium text-foreground">Contents ({block.sections.length} sections)</p>
          <ol className="mt-0.5 list-decimal space-y-0.5 pl-5 text-foreground">
            {block.sections.map((s) => (
              <li key={s.id}>{s.heading}</li>
            ))}
          </ol>
        </div>
      ) : block.sections.length >= CONTENTS_MIN_SECTIONS ? (
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

      {layout === 'infographic' ? null : block.sections.map((s, si) => {
        const headingId = sectionAnchorId(domId, blockIndex, si);
        // "AI cost" over a card titled "AI cost": the card's title says it.
        const repeats = headingRepeatsLeaf(s.heading, s.blocks, s.summary);
        return (
          <div key={s.id} role="group" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
            <h5
              id={headingId}
              tabIndex={staticMode ? undefined : -1}
              className={cn('scroll-mt-16 text-sm font-semibold text-foreground outline-none', repeats && 'sr-only')}
              data-repeats-leaf={repeats || undefined}
            >
              {s.heading}
            </h5>
            {s.summary ? (
              <p
                className={cn(
                  'whitespace-pre-line break-words',
                  lead && si === 0 ? 'text-md text-foreground' : 'text-sm text-muted-foreground',
                )}
                data-testid={lead && si === 0 ? 'report-lead' : undefined}
              >
                {s.summary}
              </p>
            ) : null}
            {s.blocks.map((leaf, li) => (
              <React.Fragment key={`${leaf.id}-${li}`}>{renderLeaf(leaf, `${si}-${li}`)}</React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}
