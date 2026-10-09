/**
 * CSV export (chat revamp SPEC §9.3, BLOCKS.md §7.5).
 *
 * Per block: the block's table projection (the same rows as its "Show table" view), with
 * every STRING cell formula-defused and numeric cells left numeric (`lib/csv.ts`).
 * Whole report: one file holding every table-like block in document order, each preceded
 * by a `# <item>. <title>` label row and separated by a blank line — no ZIP dependency
 * and no burst of browser download prompts.
 *
 * CSV is a machine format and is never defanged (like JSON); the clipboard's TSV and the
 * human formats are.
 */
import { csvField } from '@/lib/csv';

import { blockTabular, toCSV, type Tabular } from '../../blocks/export-helpers';
import { leafBlocks } from '../../blocks/schema';
import type { AnswerBlock } from '../../blocks/schema';
import { blockTitle, type ReportDoc } from '../model';

/** One block as CSV, or null when it has no tabular data. */
export function blockToCsv(block: AnswerBlock): string | null {
  const tab = blockTabular(block);
  return tab ? toCSV(tab) : null;
}

/** Every table-like block of the document, labelled by item, as one CSV text. */
export function reportTablesCsv(doc: ReportDoc): string | null {
  const parts: string[] = [];
  doc.items.forEach((item, index) => {
    for (const block of leafBlocks(item.blocks)) {
      const tab: Tabular | null = blockTabular(block);
      if (!tab) continue;
      parts.push(`${csvField(`# ${index + 1}. ${blockTitle(block)}`)}\r\n${toCSV(tab)}`);
    }
  });
  return parts.length ? `${parts.join('\r\n\r\n')}\r\n` : null;
}
