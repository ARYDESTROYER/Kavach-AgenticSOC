/**
 * JSON export (chat revamp SPEC §9.3, BLOCKS.md §7.5): the report exactly as received —
 * `{ blocks_version, report }` — for re-use and sharing. Never defanged (a machine format
 * must round-trip), never re-rendered.
 */
import type { Report } from '@/lib/types';

import { BLOCKS_VERSION } from '../../blocks/schema';

/** `{ blocks_version, report }`, pretty-printed and deterministic for the same report. */
export function reportToJson(report: Report): string {
  return `${JSON.stringify({ blocks_version: BLOCKS_VERSION, report }, null, 2)}\n`;
}
