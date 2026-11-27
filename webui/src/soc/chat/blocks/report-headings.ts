/**
 * When a Brief section heading would be read twice in a row (pure, no React).
 *
 * A section whose first card is titled like the section ("Response times" over a card
 * titled "Response times") must not say it twice: on screen the card's title stays and
 * takes the heading's place (the heading is kept for assistive tech and the section
 * anchor), and a static export (PDF, Word, Markdown, HTML) keeps the section heading and
 * leaves the card's repeated title out. One rule for the document layout, the infographic
 * layout and every export, so a model-written Brief never doubles a heading either.
 *
 * Kept free of renderer imports: the report exports (`report/export/walker.ts`) reach it
 * statically, and the report UI must never pull the block renderers into its chunk.
 */
import type { CalloutBlock, LeafBlock } from './schema';
import { FALLBACK_TEXT } from './schema';

/**
 * The title a callout draws on screen, or null: a retention stub always draws one
 * ("Earlier result" when it has none); a G9 fallback notice and an untitled note draw
 * none. Shared with the Brief layouts, which hide a section heading only when the leaf
 * under it visibly says the same thing.
 */
export function calloutTitle(block: CalloutBlock): string | null {
  if (block.expired) return block.title ?? 'Earlier result';
  return block.title && block.text !== FALLBACK_TEXT ? block.title : null;
}

/**
 * The title a leaf DRAWS on screen, or null. Prose (`markdown`) renders its text only,
 * whatever title it carries; a note draws its own title unless it is a fallback notice
 * (`calloutTitle`); every other leaf is a card whose heading is its title. Only a
 * title the leaf states itself counts: an untitled card's generic heading ("Key
 * figures") never stands in for a section heading.
 */
export function leafVisibleTitle(leaf: LeafBlock): string | null {
  if (leaf.type === 'markdown') return null;
  if (leaf.type === 'callout') return calloutTitle(leaf);
  return 'title' in leaf && typeof leaf.title === 'string' ? leaf.title : null;
}

/**
 * The section heading would be read twice in a row: the section's first remaining leaf
 * visibly draws the same title (case and spacing aside) and no summary stands between
 * them. A leaf that carries the title but does not draw it (prose) never hides the
 * heading: the section would lose its only visible heading.
 */
export function headingRepeatsLeaf(heading: string, leaves: readonly LeafBlock[], summary?: string | null): boolean {
  if (!leaves.length || (summary ?? '').trim()) return false;
  const title = leafVisibleTitle(leaves[0]);
  const norm = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
  return title !== null && title.trim() !== '' && norm(title) === norm(heading);
}
