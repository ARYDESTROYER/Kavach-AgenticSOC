# D6 Report downloads diagnosis (sub-agent report, recorded by the orchestrator)

The file downloads work, but Print / Save as PDF loses data and looks broken. I could not write `diag/reports.md`: the harness blocks report files from subagents, so the findings are below.

All tests ran in headless Chromium on the live demo against a 4-item report with an AI summary, through every entry point (report panel, library row, library document view, per-block menu). Firefox and Safari were not available, so the Safari/Firefox items are code-level risks only.

**What works.** Markdown, HTML, CSV and JSON, plus per-block CSV/JSON:
- One download per click, 45–560 ms.
- Filenames follow `agentic-soc-report-<slug>-<yyyymmdd-hhmm>Z.<ext>`.
- No popups, no console errors, no double downloads.
- No dark-theme leak into print (light print tokens apply).

**P0 – data lost or misread in the PDF**
1. Real content is hidden in print. `print.tsx:45` hides every `<button>` in the print root, and some content is rendered as buttons:
   - Table column headers disappear: `TableView.tsx:142` keeps `sortable: true` in static mode, and `DataTable.tsx:431` renders sortable headers as buttons.
   - The shift brief's "Contents" prints as an empty `1. 2. 3. 4.` list: the TOC opens by default (`ReportView.tsx:55`) and its entries are buttons (`ReportView.tsx:95-101`).
   - Latent: a KPI with a `ref` becomes a clickable button tile (`KpiTile.tsx:~885`) and would vanish entirely.
2. Wide tables are cut at A4 width. The scroll wrapper at `ui/table.tsx:36` (`overflow-auto`) doesn't paginate sideways, so "Open campaigns" lost its Last seen / Shared entities / Techniques columns (`pdftotext` finds no `T1078` or `user:pnair`).
3. KPI numbers get truncated ("Open cases 1…"; the operator's screenshot 4 shows the same "≥…" on screen). `KpiGroupView.tsx:103,116` pairs compact density with a long delta chip, which `KpiTile.tsx:732-752` explicitly warns against.

**P1 – the PDF layout reads as glitchy**
4. Large blank half-pages. `print.tsx:46` sets `break-inside: avoid` on whole items and every figure, including the 2,421 px brief. Pages 1 and 5 are mostly blank, and the h4/h5 headings "Open work" and "Key metrics" are stranded at page bottoms.
5. Every chart prints twice: static mode always adds the full data table (`ChartShell.tsx:122`, `HBarChart.tsx:113`, `SparklineChart.tsx:155`). Result: 12 A4 pages for 4 items.
6. The saved PDF is always named "Agentic SOC.pdf", because `document.title` is "Agentic SOC" when `print()` runs (`print.tsx:~130-171` never changes it).
7. Titles are cut mid-word ("…how things tr…") in the PDF, HTML, Markdown and filenames. The draft title is the conversation title (`routes_reports.py:667`), clipped to 80 characters plus "…" (`chat_conversations.py:226-232`).
8. From the document view, `print()` fires about 95 ms after the click while the export menu is still mounted and the page is scroll-locked (`overflow: hidden`). Chromium still paginates; Safari/Firefox may print only one page.

**P1 – robustness and feedback**
9. The panel export (`ReportPanel.tsx:523-540`) and document-view export (`ReportsLibrary.tsx:231-241`) have no try/catch around the dynamic imports. After a redeploy or network blip, the click silently does nothing. Only the library-row path catches errors.
10. There is no busy state and no visible success message (screen-reader announcement only; the existing sonner toasts aren't used). While up to 10 source conversations load, a second click produces a duplicate export.
11. `lib/download.ts:23-24` revokes the object URL immediately after `a.click()` on a detached anchor. This is known to break downloads in Safari and older Firefox. Downloads and print also run after awaits, outside the click's user-activation window.
12. Document-view Export is enabled while its sources are still loading, so the methodology section can be incomplete.

**P2 – format gaps**
13. CSV has no UTF-8 BOM but contains "—", so Excel shows mojibake (`csv.ts:283`). All tables land in one sheet with mixed shapes.
14. HTML export has no charts (0 SVG): they become tables by design (`walker.ts:8-10`).
15. Markdown over-escapes (`markdown.ts:26-29`), giving `&amp;` and `\(32\)` in the raw text.
16. The document view's page height jumps while scrolling (`BlockCard.tsx:528`: `content-visibility: auto` with a 320 px placeholder; height swung 6136 → 5847 over 12 scroll steps).
17. Export is two menu levels deep, with no visible "Download PDF" button.

**Fix list, in order**
1. Fix the print stylesheet and static rendering (print stylesheet plus each component's print/static mode):
   - Hide only elements marked `[data-print-hide]` instead of all buttons.
   - Render table headers, the brief TOC and KPI tiles as plain text in static mode.
   - Let tables wrap and remove the horizontal scroll in print.
   - Keep `break-inside: avoid` only on small parts (rows, KPI frames, chart images); keep h4–h6 with their content.
   - Cap the data table under each chart (or make it optional).
   - Put KPI deltas on their own line so the number is never truncated.
   - Set `document.title` to the export filename during print and restore it afterwards.
   - Call `print()` only after the menu has closed, and override the scroll lock and `height: 100%` in print.
2. Export runner: try/catch with a visible toast for success and failure; a busy state that blocks repeat clicks; prefetch the export code and sources when the menu opens; one retry on chunk-load errors.
3. `downloadText`: attach the anchor to the page, click, remove it, and revoke the URL after a delay of at least 1 s (FileSaver.js uses 40 s).
4. Formats: CSV BOM, inline SVG charts in HTML, lighter Markdown escaping, a clean default report title.
5. A visible "Download PDF" button and a flat export menu. From my own knowledge, not researched this session: Splunk, XSIAM/XSOAR, Qualys and Sentinel give a one-click .pdf with cover page, contents and page numbers, which would mean a backend PDF job here.
6. Tests: no hidden-content buttons in the static tree, table header text present, KPI with delta not truncated, async revoke, failure toast, single export on double-click.

**Evidence** (under `(scratch)/`):
- PDF: `diag/rep-dl/panel-dark-print.pdf`
- Shots: `shots/diag-rep-print-p1-4.png`, `p5-8.png`, `p9-12.png`, `diag-rep-print-p6-brief.png`, `diag-rep-print-campaigns-dark.png`, `diag-rep-html-panel.png`, `diag-rep-12/13-docview-*.png`, `diag-rep-20-panel-export-submenu-dark.png`
- Downloads: `diag/rep-dl/`
- Scripts: `diag/scripts/rep/s1…s9*.mjs` (run with cwd `../qa`)
- Test data: conversation `chat-442118f8da1e498f929b0d2615aa9cd2`, report `rpt-e002f07ee90c4a2b807e3f6a90c5589c`. Other agents share the Admin account and create conversations with the same title, so target these by id.
