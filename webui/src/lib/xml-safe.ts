/**
 * The characters XML 1.0 can carry (§2.2 `Char`), for every client-side XML writer: the
 * Word and Excel exports (`soc/chat/report/export/ooxml.ts`) and the chart image
 * (`soc/chat/blocks/charts/export-svg.ts`).
 *
 * Model- and log-derived text can hold code points XML 1.0 forbids: NUL and the other
 * C0 controls except tab, line feed and carriage return, lone surrogates, and the
 * noncharacters U+FFFE and U+FFFF. The chat's display sanitiser keeps U+FFFE and U+FFFF
 * (they are not invisible), and one of them makes a whole document malformed: Word and
 * Excel refuse the file, and a browser will not open or rasterise the SVG. So every
 * writer DROPS them here, before escaping `& < > " '`.
 *
 * Dependency-free so the chart chunk and the Office export chunks share it without
 * pulling each other in.
 */

/** Anything outside XML 1.0 `Char` (the `u` flag matches a lone surrogate as one code point). */
const INVALID_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Drop the code points XML 1.0 cannot carry. */
export function xmlSafe(text: string): string {
  return text.replace(INVALID_XML, '');
}
