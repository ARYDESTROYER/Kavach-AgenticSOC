/**
 * Print / Save as PDF (chat revamp SPEC §9.3, BLOCKS.md §7.4): the PDF path needs no
 * dependency — the browser's own print dialog saves vector PDFs.
 *
 *   1. Preload the static block renderer (`BlockCard`, through `import()`: the blocks kit
 *      is its own lazy chunk), so the portal renders SYNCHRONOUSLY and is complete
 *      before the dialog opens.
 *   2. Mount a print root DIRECTLY under `<body>` (`#agentic-soc-report-print`) carrying the
 *      light-theme tokens as inline custom properties: every `hsl(var(--x))` inside it
 *      resolves to the paper-friendly light value even when the operator is in dark mode,
 *      and the theme provider is never touched.
 *   3. `@media print` hides every other child of `<body>` and lays the document out on
 *      A4; `@media screen` keeps the root invisible, so nothing flashes in the console.
 *   4. Wait two animation frames (layout settles), call `window.print()`, and unmount on
 *      `afterprint` (or after 60 s, for browsers that never fire it).
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
import { tokenStyle } from './report-tokens';

export const PRINT_ROOT_ID = 'agentic-soc-report-print';

/** The print stylesheet (BLOCKS.md §7.4). */
export const PRINT_CSS = `
@media screen { #${PRINT_ROOT_ID} { display: none !important; } }
@media print {
  @page { size: A4; margin: 14mm 12mm; }
  html, body { background: white !important; }
  body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
  #${PRINT_ROOT_ID} { display: block !important; background: hsl(var(--background)); color: hsl(var(--foreground)); font-size: 12px; }
  #${PRINT_ROOT_ID} button, #${PRINT_ROOT_ID} [data-print-hide] { display: none !important; }
  #${PRINT_ROOT_ID} .report-block, #${PRINT_ROOT_ID} figure, #${PRINT_ROOT_ID} table, #${PRINT_ROOT_ID} [role="note"] { break-inside: avoid; }
  #${PRINT_ROOT_ID} h2, #${PRINT_ROOT_ID} h3 { break-after: avoid; }
  #${PRINT_ROOT_ID} * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
`.trim();

/** Wait one animation frame (a timer where rAF does not exist). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
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

type BlockCardComponent = React.ComponentType<{
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

let active: { root: Root; el: HTMLElement; done: () => void } | null = null;

/** Unmount a pending print root (a second Print click replaces the first). */
export function clearPrintRoot(): void {
  active?.done();
  active = null;
  document.getElementById(PRINT_ROOT_ID)?.remove();
}

export interface PrintOptions {
  /** Defang content (default true). */
  defang?: boolean;
  /** Fallback unmount delay when `afterprint` never fires (ms). */
  timeoutMs?: number;
}

/**
 * Print the document (the browser's dialog offers "Save as PDF"). Resolves true once
 * `window.print()` was called; false where printing is unavailable.
 */
export async function printDocument(doc: ReportDoc, options: PrintOptions = {}): Promise<boolean> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  const defang = options.defang !== false;
  const { BlockCard } = await import('../../blocks/BlockCard');
  clearPrintRoot();

  const el = document.createElement('div');
  el.id = PRINT_ROOT_ID;
  el.setAttribute('aria-hidden', 'true');
  for (const [name, value] of Object.entries(tokenStyle())) el.style.setProperty(name, value);
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() => {
    root.render(<PrintView doc={printCopy(doc, defang)} BlockCard={BlockCard as BlockCardComponent} defang={defang} />);
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const done = () => {
    window.removeEventListener('afterprint', done);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (active?.el === el) active = null;
    // Unmount after the current task so React is never unmounted mid-render.
    setTimeout(() => {
      root.unmount();
      el.remove();
    }, 0);
  };
  active = { root, el, done };
  window.addEventListener('afterprint', done);
  timer = setTimeout(done, options.timeoutMs ?? 60_000);

  await nextFrame();
  await nextFrame();
  if (typeof window.print !== 'function') {
    done();
    return false;
  }
  window.print();
  return true;
}
