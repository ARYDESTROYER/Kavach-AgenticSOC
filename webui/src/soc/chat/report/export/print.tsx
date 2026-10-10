/**
 * Print / Save as PDF (chat revamp SPEC §9.3, BLOCKS.md §7.4; Round 12 SPEC WP-REP R5,
 * R6, R8–R13): the PDF path needs no dependency — the browser's own print dialog saves
 * vector PDFs.
 *
 *   1. Preload the static block renderer (`BlockCard`, through `import()`: the blocks kit
 *      is its own lazy chunk), so the portal renders SYNCHRONOUSLY and is complete
 *      before the dialog opens.
 *   2. Mount a print root DIRECTLY under `<body>` (`#agentic-soc-report-print`) carrying the
 *      light-theme tokens as inline custom properties: every `hsl(var(--x))` inside it
 *      resolves to the paper-friendly light value even when the operator is in dark mode,
 *      and the theme provider is never touched.
 *   3. `@media print` hides every other child of `<body>`, forces a light colour scheme
 *      (a dark console would otherwise paint the page margins black), lifts the scroll lock a
 *      closing menu may still hold (`html, body` overflow/height), lays the document out
 *      on A4 and keeps only SMALL atoms unbroken (rows, KPI groups, chart plots, notes,
 *      list items) — never a whole block, which left half-empty pages; headings stay with
 *      what follows and table headers repeat on every page. Only `[data-print-hide]`
 *      elements and copy controls ({@link PRINT_HIDDEN}) are hidden: content rendered
 *      as a button (a KPI tile with a link, a case id) prints. Static data tables have
 *      a fixed layout and wrap anywhere, so none runs past the page edge.
 *      `@media screen` keeps the root invisible.
 *   4. Set `document.title` to the export file name (the dialog suggests it as the PDF
 *      name), wait until a closing menu released its scroll lock, show the caller's
 *      guidance (`onBeforePrint`: "Choose Save as PDF" must paint BEFORE the dialog,
 *      because `print()` blocks until it closes), let two frames pass, call
 *      `window.print()`, and unmount on `afterprint` after a 1 s grace once the page is
 *      no longer in print media (or after 60 s, for browsers that never fire it). The
 *      title is restored on unmount.
 *
 * `mountPrintRoot` is also the synchronous path the report document view calls from a
 * `beforeprint` listener, so Ctrl/Cmd+P on that page prints the report, not the console.
 *
 * Charts render in static mode (fixed 680 px, data tables visible, no menus). Content is
 * defanged by default (the export-menu toggle). The portal adds zero bytes to the entry
 * chunk: this module is reached only through `import()`.
 */
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { defang as defangText } from '@/lib/defang';

import { ChatMarkdown } from '../../ChatMarkdown';
import { BlocksContext, type BlocksContextValue } from '../../blocks/context';
import type { AnswerBlock } from '../../blocks/schema';
import type { DocItem, ReportDoc } from '../model';
import { ReportDocument } from '../ReportDocument';
import { defangBlocks } from './defang-blocks';
import { PRINT_ROOT_ID } from './formats';
import { tokenStyle } from './report-tokens';

export { PRINT_ROOT_ID };

const R = `#${PRINT_ROOT_ID}`;

/**
 * What print hides: elements marked `data-print-hide`, and every copy control (a button
 * named "Copy …" or "Copied": "Copy value", the code block's "Copy to clipboard", a
 * prose link's "Copy defanged link") — a control with no content value. Content drawn
 * as a button (a KPI tile with a link, a case id) still prints.
 */
export const PRINT_HIDDEN = [
  `${R} [data-print-hide]`,
  `${R} button[aria-label^="Copy"]`,
  `${R} button[aria-label^="Copied"]`,
].join(', ');

/** The print stylesheet (BLOCKS.md §7.4, Round 12 R6/R8/R10/R13). */
export const PRINT_CSS = `
@media screen { ${R} { display: none !important; } }
@media print {
  @page { size: A4; margin: 14mm 12mm; }
  :root { color-scheme: light !important; }
  html, body, html body[data-scroll-locked] { background: white !important; overflow: visible !important; height: auto !important; min-height: 0 !important; max-height: none !important; }
  body > *:not(${R}) { display: none !important; }
  ${R} { display: block !important; background: hsl(var(--background)); color: hsl(var(--foreground)); font-size: 12px; }
  ${PRINT_HIDDEN} { display: none !important; }
  ${R} * { content-visibility: visible !important; contain-intrinsic-size: none !important; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  ${R} .overflow-auto, ${R} .overflow-x-auto, ${R} .overflow-y-auto, ${R} .overflow-hidden { overflow: visible !important; max-height: none !important; }
  ${R} .truncate { overflow: visible !important; text-overflow: clip !important; white-space: normal !important; }
  ${R} .line-clamp-3 { display: block !important; -webkit-line-clamp: unset !important; overflow: visible !important; }
  ${R} table { width: 100% !important; max-width: 100% !important; table-layout: auto; }
  ${R} thead { display: table-header-group; }
  ${R} th, ${R} td { white-space: normal !important; overflow-wrap: break-word; padding-left: 6px !important; padding-right: 6px !important; }
  ${R} td .font-mono, ${R} td code, ${R} td .break-all { overflow-wrap: anywhere; word-break: break-all; }
  ${R} table[data-static-table] { table-layout: fixed !important; }
  ${R} table[data-static-table] th, ${R} table[data-static-table] td { overflow-wrap: anywhere; }
  ${R} tr, ${R} li, ${R} [role="note"], ${R} [data-testid="block-kpis"], ${R} [data-testid$="-plot"], ${R} [data-testid="trend-columns"], ${R} [data-print-atom] { break-inside: avoid; }
  ${R} h1, ${R} h2, ${R} h3, ${R} h4, ${R} h5, ${R} h6, ${R} figcaption, ${R} .report-item-header { break-after: avoid; }
  ${R} p { orphans: 3; widows: 3; }
}
`.trim();

/** Wait one animation frame (a timer where rAF does not exist). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/** Is a (closing) menu or dialog still holding the page's scroll lock? */
export function scrollLocked(): boolean {
  return typeof document !== 'undefined' && !!document.body && document.body.hasAttribute('data-scroll-locked');
}

/**
 * Resolve once a closing menu released the page (its scroll lock is gone) and two
 * frames have passed, or after `maxMs` — printing never waits forever (R10).
 */
export async function settleBeforePrint(maxMs = 800): Promise<void> {
  const start = Date.now();
  await nextFrame();
  while (scrollLocked() && Date.now() - start < maxMs) await nextFrame();
  await nextFrame();
}

/** The print copy of a document: content defanged when asked. */
export function printCopy(doc: ReportDoc, defang: boolean): ReportDoc {
  if (!defang) return doc;
  return {
    ...doc,
    title: defangText(doc.title),
    items: doc.items.map((item) => ({
      ...item,
      title: defangText(item.title),
      note: item.note ? defangText(item.note) : null,
      question: item.question ? defangText(item.question) : null,
      blocks: defangBlocks(item.blocks),
    })),
  };
}

export type BlockCardComponent = React.ComponentType<{
  block: AnswerBlock;
  index: number;
  headingLevel?: 4 | 5 | 6;
  staticMode?: boolean;
}>;

/** The document inside the print root (exported for tests). */
export function PrintView({ doc, BlockCard, defang }: { doc: ReportDoc; BlockCard: BlockCardComponent; defang: boolean }) {
  const ctx = React.useMemo<BlocksContextValue>(
    () => ({
      navigate: () => undefined,
      compact: false,
      domId: 'print',
      renderMarkdown: (text: string) => <ChatMarkdown text={text} headingBase={4} />,
    }),
    [],
  );
  const renderBlocks = React.useCallback(
    (item: DocItem) => (
      <div className="space-y-3">
        {item.blocks.map((block, i) => (
          <BlockCard key={`${i}-${block.id}`} block={block} index={i} headingLevel={4} staticMode />
        ))}
      </div>
    ),
    [BlockCard],
  );
  return (
    <BlocksContext.Provider value={ctx}>
      <style>{PRINT_CSS}</style>
      <ReportDocument doc={doc} mode="print" defang={defang} renderBlocks={renderBlocks} />
    </BlocksContext.Provider>
  );
}

interface ActivePrint {
  root: Root;
  el: HTMLElement;
  /** Unmount now (cleanup, title restore). */
  done: () => void;
}

let active: ActivePrint | null = null;

/** Is a print root mounted (a print in progress)? */
export function printRootMounted(): boolean {
  return typeof document !== 'undefined' && !!document.getElementById(PRINT_ROOT_ID);
}

/** Unmount a pending print root (a second Print click replaces the first). */
export function clearPrintRoot(): void {
  active?.done();
  active = null;
  if (typeof document !== 'undefined') document.getElementById(PRINT_ROOT_ID)?.remove();
}

export interface MountOptions {
  /** Defang content (default true). */
  defang?: boolean;
  /** `document.title` while the root is mounted (the dialog's suggested PDF name). */
  documentTitle?: string;
  /** Fallback unmount delay when `afterprint` never fires (ms). */
  timeoutMs?: number;
  /** Grace after `afterprint` before unmounting (ms; R11). */
  graceMs?: number;
}

/**
 * Mount the print root SYNCHRONOUSLY (flushSync) and arm its cleanup: on `afterprint`
 * it unmounts after the grace once the page left print media; after `timeoutMs`
 * regardless of events. Returns the cleanup.
 */
export function mountPrintRoot(doc: ReportDoc, BlockCard: BlockCardComponent, options: MountOptions = {}): () => void {
  const defang = options.defang !== false;
  const graceMs = options.graceMs ?? 1_000;
  clearPrintRoot();

  const el = document.createElement('div');
  el.id = PRINT_ROOT_ID;
  el.setAttribute('aria-hidden', 'true');
  for (const [name, value] of Object.entries(tokenStyle())) el.style.setProperty(name, value);
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() => {
    root.render(<PrintView doc={printCopy(doc, defang)} BlockCard={BlockCard} defang={defang} />);
  });

  const previousTitle = document.title;
  if (options.documentTitle) document.title = options.documentTitle;

  let fallback: ReturnType<typeof setTimeout> | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener('afterprint', onAfterPrint);
    if (fallback !== null) clearTimeout(fallback);
    if (grace !== null) clearTimeout(grace);
    fallback = null;
    grace = null;
    if (active?.el === el) active = null;
    if (options.documentTitle && document.title === options.documentTitle) document.title = previousTitle;
    // Unmount after the current task so React is never unmounted mid-render.
    setTimeout(() => {
      root.unmount();
      el.remove();
    }, 0);
  };
  const stillPrinting = () => {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia('print').matches;
    } catch {
      return false;
    }
  };
  const settle = () => {
    grace = null;
    // A browser that fires afterprint before it has finished reading the page: wait more.
    if (stillPrinting()) grace = setTimeout(settle, graceMs);
    else done();
  };
  function onAfterPrint() {
    if (grace !== null) clearTimeout(grace);
    grace = setTimeout(settle, graceMs);
  }
  active = { root, el, done };
  window.addEventListener('afterprint', onAfterPrint);
  fallback = setTimeout(done, options.timeoutMs ?? 60_000);
  return done;
}

export interface PrintOptions extends MountOptions {
  /** How long to wait for a closing menu to release the page (ms). */
  settleMs?: number;
  /**
   * Called once the print root is mounted and BEFORE the two frames that precede
   * `window.print()` (R17): guidance shown here ("Choose Save as PDF") paints before the
   * dialog opens. In Chromium and Firefox `print()` blocks until the dialog closes, so a
   * message shown after it returns would arrive too late (and after a Cancel).
   */
  onBeforePrint?: () => void;
}

/**
 * Print the document (the browser's dialog offers "Save as PDF"). Resolves true once
 * `window.print()` returned (the dialog closed: saved or cancelled); false where printing
 * is unavailable, before any guidance was shown.
 */
export async function printDocument(doc: ReportDoc, options: PrintOptions = {}): Promise<boolean> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  if (typeof window.print !== 'function') return false;
  const { BlockCard } = await import('../../blocks/BlockCard');
  // The export menu is still closing: print only once it released the page (R10).
  await settleBeforePrint(options.settleMs);
  mountPrintRoot(doc, BlockCard as BlockCardComponent, options);
  try {
    options.onBeforePrint?.();
  } catch {
    /* guidance is best effort: printing goes ahead */
  }
  // Two frames: the print root and the guidance paint before the dialog blocks the page.
  await nextFrame();
  await nextFrame();
  window.print();
  return true;
}
