/**
 * The report document view's Ctrl/Cmd+P FALLBACK stylesheet (Round 12 SPEC WP-REP R12).
 * A dependency-free module: the library loads it with the page, never the print code.
 */
import { PRINT_ROOT_ID } from './export/formats';
import { tokenDeclarations } from './export/report-tokens';

/** The on-screen report document's element id (the print fallback below keeps only it). */
export const SCREEN_DOC_ID = 'agentic-soc-report-screen';

/**
 * Ctrl/Cmd+P FALLBACK on the document view (R12). The primary path is the `beforeprint`
 * root (`usePrintShortcut` in `ReportsLibrary`); when it could not mount — the event
 * fired before the print code or the report finished loading, or a headless/emulated
 * print never fires it — the browser would print the console: sidebar and top bar, dark, cropped to the
 * scroll container. While this view is mounted, this stylesheet prints only the
 * on-screen document instead: every element that neither is, holds nor sits inside it
 * is hidden, its ancestors drop their fixed heights and scroll clipping, and it takes
 * the light tokens. It stands down whenever the report's own print root is present.
 */
export function screenPrintCss(): string {
  const D = `#${SCREEN_DOC_ID}`;
  const off = `body:not(:has(> #${PRINT_ROOT_ID}))`;
  return `
@media print {
  @page { size: A4; margin: 14mm 12mm; }
  ${off} { background: white !important; }
  html:has(${D}), ${off} { height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; }
  ${off} *:not(:has(${D})):not(${D}):not(${D} *) { display: none !important; }
  ${off} *:has(${D}) { display: block !important; position: static !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; margin: 0 !important; padding: 0 !important; border: 0 !important; width: auto !important; max-width: none !important; transform: none !important; box-shadow: none !important; background: white !important; }
  ${off} ${D} { ${tokenDeclarations()} color-scheme: light; background: hsl(var(--background)); color: hsl(var(--foreground)); max-width: none !important; margin: 0 !important; }
  ${off} ${D} [data-print-hide], ${off} ${D} button[aria-label^="Copy"], ${off} ${D} button[aria-label^="Copied"] { display: none !important; }
  ${off} ${D} * { content-visibility: visible !important; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  ${off} ${D} .overflow-auto, ${off} ${D} .overflow-x-auto, ${off} ${D} .overflow-hidden { overflow: visible !important; max-height: none !important; }
  ${off} ${D} table { width: 100% !important; }
  ${off} ${D} th, ${off} ${D} td { white-space: normal !important; overflow-wrap: anywhere; }
  ${off} ${D} tr, ${off} ${D} li { break-inside: avoid; }
}
`.trim();
}
