/**
 * Defang the CONTENT strings of parsed answer blocks for the Print/PDF path (SPEC §9.3,
 * BLOCKS.md amendment 9): a printed or saved-as-PDF report is a document people forward,
 * so its IOCs are defanged by default, exactly like the Markdown and HTML exports.
 *
 * Only data strings are rewritten. Structural fields — enums, ids, refs, units, ISO
 * timestamps — are skipped by key, so a defanged block stays valid for the renderers
 * (defanging cannot touch an enum anyway: none contains a dot, an `@` or a scheme).
 * The live UI is never defanged; this runs only on the print copy.
 */
import { defang } from '@/lib/defang';

import type { AnswerBlock } from '../../blocks/schema';

/** Keys whose values are structure, not content. */
const SKIP_KEYS = new Set([
  'id',
  'type',
  'kind',
  'unit',
  'provenance',
  'artifact_kind',
  'allowed_views',
  'semantic',
  'ref',
  'drill',
  'doc',
  'case_id',
  'as_of',
  'at',
  'created_at',
  'first_seen',
  'last_seen',
  'generated_at',
  'language',
  'tone',
  'verdict',
  'severity',
  'status',
  'bucket',
  'display',
  'good_direction',
  'template',
  'align',
  'key',
  'expired',
  'sort',
  'bound',
]);

function walk(value: unknown, key: string | null): unknown {
  if (key !== null && SKIP_KEYS.has(key)) return value;
  if (typeof value === 'string') return defang(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, null));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k);
    return out;
  }
  return value;
}

/** A copy of `blocks` with every content string defanged. */
export function defangBlocks(blocks: readonly AnswerBlock[]): AnswerBlock[] {
  return blocks.map((b) => walk(b, null) as AnswerBlock);
}
